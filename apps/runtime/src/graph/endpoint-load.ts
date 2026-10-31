// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Endpoint load tracking for busy-aware model pools (`src/graph/endpoint-load.ts`)
 *
 * Small self-hosted inference servers often run ONE slot (llama.cpp with
 * `--parallel 1`): a second request does not fail, it queues behind the first.
 * A model pool that rotates or sticks without knowing this sends a request to a
 * server that is busy while another pool member sits idle.
 *
 * A provider instance opts in with `maxConcurrent` in `PROVIDERS`. Its load is
 * then the sum of
 *   - requests this process has in flight to it (counted at the HTTP transport,
 *     from request start until the response body is consumed, errors or is
 *     cancelled),
 *   - pending claims: a pool selected it as primary but its request has not
 *     started yet (bounded by {@link CLAIM_TTL_MS}), and
 *   - with `loadProbe: "llama-slots"`: the live slot state from the server's
 *     `GET /slots`, which also sees requests from OTHER clients. The probe is
 *     cached for {@link PROBE_CACHE_MS}; requests and claims started after a
 *     probe (or shortly before it, {@link PROBE_LAG_MS}) are added on top
 *     because the probe could not see them yet. A failed probe falls back to the
 *     process-local count.
 *
 * The endpoint is BUSY when its load reaches its capacity (`maxConcurrent`,
 * capped by the probed slot count). Instances without `maxConcurrent` are never
 * busy. All state is process-local and only steers selection — losing it on a
 * restart is harmless; the server still queues what it gets.
 *
 * No `any` at module boundaries.
 */

import { getProviderInstance } from "../config/providers.js";
import { egressFetch } from "../security/egress.js";

/** How long a `/slots` probe result is reused. */
export const PROBE_CACHE_MS = 500;
/** Timeout of one `/slots` probe. */
export const PROBE_TIMEOUT_MS = 400;
/**
 * A request or claim that started at most this long before a probe counts on
 * top of the probe result: it may not have reached the server yet.
 */
export const PROBE_LAG_MS = 300;
/** A pool claim without a following request expires after this long. */
export const CLAIM_TTL_MS = 3_000;
/** An in-flight entry is forgotten after this long (leak guard). */
export const IN_FLIGHT_MAX_AGE_MS = 15 * 60 * 1000;

interface ProbeResult {
  /** Slots that are processing a request. */
  processing: number;
  /** Total slots. */
  total: number;
  /** When the probe was sent (ms epoch). */
  probedAt: number;
}

/** provider -> entry id -> start time (ms epoch). */
const inFlight = new Map<string, Map<number, number>>();
/** provider -> claim start times (ms epoch), oldest first. */
const claims = new Map<string, number[]>();
/** provider -> last probe (undefined result = probe failed). */
const probes = new Map<string, { at: number; result: ProbeResult | undefined }>();
/** provider -> in-progress probe, so concurrent refreshes share one request. */
const pendingProbes = new Map<string, Promise<void>>();
let nextEntryId = 0;

/** Capacity of a provider, or `undefined` when it has no limit. */
export function endpointCapacity(provider: string): number | undefined {
  const value = getProviderInstance(provider)?.maxConcurrent;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** True when at least one of `providers` has a concurrency limit. */
export function hasLoadLimitedProvider(providers: Iterable<string>): boolean {
  for (const provider of providers) {
    if (endpointCapacity(provider) !== undefined) return true;
  }
  return false;
}

/**
 * `GET /slots` URL of a llama.cpp provider: the instance URL without a trailing
 * `/v1`, plus `/slots`. `undefined` when the provider has no slots probe.
 */
export function slotsProbeUrl(provider: string): string | undefined {
  const instance = getProviderInstance(provider);
  if (instance?.loadProbe !== "llama-slots" || instance.url === undefined) {
    return undefined;
  }
  const base = instance.url.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${base}/slots`;
}

function pruneClaims(provider: string, now: number): number[] {
  const list = (claims.get(provider) ?? []).filter(
    (startedAt) => now - startedAt < CLAIM_TTL_MS,
  );
  if (list.length > 0) claims.set(provider, list);
  else claims.delete(provider);
  return list;
}

function pruneInFlight(provider: string, now: number): Map<number, number> {
  const entries = inFlight.get(provider) ?? new Map<number, number>();
  for (const [id, startedAt] of entries) {
    if (now - startedAt > IN_FLIGHT_MAX_AGE_MS) entries.delete(id);
  }
  return entries;
}

/**
 * Records that a pool picked `provider` as primary. The claim counts as load
 * until the request starts ({@link acquireEndpointSlot} consumes it) or it
 * expires, so two executions selecting at the same moment do not both pick
 * the same idle single-slot server. No-op for providers without a limit.
 */
export function claimEndpoint(provider: string, now: number = Date.now()): void {
  if (endpointCapacity(provider) === undefined) return;
  const list = pruneClaims(provider, now);
  list.push(now);
  claims.set(provider, list);
}

/**
 * Marks one request to `provider` as in flight and returns its idempotent
 * release function. Consumes the oldest pending claim of the provider. Cheap
 * no-op (release does nothing) for providers without a limit.
 */
export function acquireEndpointSlot(
  provider: string,
  now: number = Date.now(),
): () => void {
  if (endpointCapacity(provider) === undefined) return () => {};
  const pending = pruneClaims(provider, now);
  pending.shift();
  if (pending.length === 0) claims.delete(provider);
  const entries = pruneInFlight(provider, now);
  const id = nextEntryId++;
  entries.set(id, now);
  inFlight.set(provider, entries);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = inFlight.get(provider);
    current?.delete(id);
    if (current !== undefined && current.size === 0) inFlight.delete(provider);
  };
}

/** Current load figures of a provider (diagnostics and tests). */
export function endpointLoad(
  provider: string,
  now: number = Date.now(),
): {
  inFlight: number;
  claims: number;
  probe: ProbeResult | undefined;
} {
  const probe = probes.get(provider);
  return {
    inFlight: pruneInFlight(provider, now).size,
    claims: pruneClaims(provider, now).length,
    probe:
      probe !== undefined && now - probe.at < PROBE_CACHE_MS * 10
        ? probe.result
        : undefined,
  };
}

/**
 * Whether `provider` is at capacity. Providers without `maxConcurrent` are
 * never busy. Uses the cached probe (see {@link refreshEndpointLoad}); a stale
 * or failed probe falls back to the process-local count.
 */
export function isEndpointBusy(provider: string, now: number = Date.now()): boolean {
  const capacity = endpointCapacity(provider);
  if (capacity === undefined) return false;
  const entries = [...pruneInFlight(provider, now).values()];
  const pending = pruneClaims(provider, now);
  const cached = probes.get(provider);
  // A probe older than ten cache periods (refresh skipped or failing) is not
  // trusted any more; the local count decides.
  const probe =
    cached !== undefined && now - cached.at < PROBE_CACHE_MS * 10
      ? cached.result
      : undefined;
  if (probe !== undefined) {
    const threshold = probe.probedAt - PROBE_LAG_MS;
    const unseen =
      entries.filter((startedAt) => startedAt > threshold).length +
      pending.filter((startedAt) => startedAt > threshold).length;
    return probe.processing + unseen >= Math.min(probe.total, capacity);
  }
  return entries.length + pending.length >= capacity;
}

async function probeSlots(
  provider: string,
  url: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const probedAt = Date.now();
  let result: ProbeResult | undefined;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      const slots: unknown = await response.json();
      if (Array.isArray(slots) && slots.length > 0) {
        const processing = slots.filter(
          (slot) =>
            slot !== null &&
            typeof slot === "object" &&
            (slot as { is_processing?: unknown }).is_processing === true,
        ).length;
        result = { processing, total: slots.length, probedAt };
      }
    } else {
      await response.body?.cancel();
    }
  } catch {
    // Unreachable, timed out or not a llama.cpp server: local count decides.
    result = undefined;
  }
  probes.set(provider, { at: probedAt, result });
}

/**
 * Refreshes the `/slots` probes of the given providers whose cached result is
 * older than {@link PROBE_CACHE_MS}. Providers without a limit or without a
 * probe are skipped; concurrent callers share one in-progress probe. Never
 * throws.
 */
export async function refreshEndpointLoad(
  providers: Iterable<string>,
  fetchImpl: typeof fetch = egressFetch,
): Promise<void> {
  const now = Date.now();
  const waits: Promise<void>[] = [];
  for (const provider of new Set(providers)) {
    if (endpointCapacity(provider) === undefined) continue;
    const url = slotsProbeUrl(provider);
    if (url === undefined) continue;
    const pending = pendingProbes.get(provider);
    if (pending !== undefined) {
      waits.push(pending);
      continue;
    }
    const cached = probes.get(provider);
    if (cached !== undefined && now - cached.at < PROBE_CACHE_MS) continue;
    const probe = probeSlots(provider, url, fetchImpl).finally(() => {
      pendingProbes.delete(provider);
    });
    pendingProbes.set(provider, probe);
    waits.push(probe);
  }
  await Promise.all(waits);
}

/**
 * Wraps a fetch so every request is counted as in flight for `provider` until
 * its response body is fully read, errors or is cancelled (or the request
 * itself fails). Returns `baseFetch` unchanged for providers without a limit.
 */
export function trackEndpointLoad(
  provider: string,
  baseFetch: typeof fetch,
): typeof fetch {
  if (endpointCapacity(provider) === undefined) return baseFetch;
  const tracked = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const release = acquireEndpointSlot(provider);
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      release();
      throw error;
    }
    const body = response.body;
    if (body === null) {
      release();
      return response;
    }
    const reader = body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        release();
        await reader.cancel(reason);
      },
    });
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return tracked as unknown as typeof fetch;
}

/** Clears all load state. For tests. */
export function resetEndpointLoad(): void {
  inFlight.clear();
  claims.clear();
  probes.clear();
  pendingProbes.clear();
  nextEntryId = 0;
}

/**
 * Load options for `buildPoolCandidateChain`: refreshes the probes of the
 * pool's load-limited leaves, then returns the `isBusy` check. `undefined`
 * when no leaf has a limit, so pools without limits pay nothing.
 */
export async function poolLoadOptions(
  leafProviders: readonly string[],
  fetchImpl: typeof fetch = egressFetch,
): Promise<{ isBusy: (candidate: { provider: string }) => boolean } | undefined> {
  if (!hasLoadLimitedProvider(leafProviders)) return undefined;
  await refreshEndpointLoad(leafProviders, fetchImpl);
  const now = Date.now();
  return { isBusy: (candidate) => isEndpointBusy(candidate.provider, now) };
}
