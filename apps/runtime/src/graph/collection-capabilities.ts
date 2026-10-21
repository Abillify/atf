// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Search exposes a `capabilities` object in its `collection_stats` tool result
 * (`apps/search/src/pg-methods-collections.ts`) telling consumers which
 * navigation features a collection can actually serve. The agent tool builder
 * uses it to hide navigation tools (`get_outline`, `get_section`, `get_pages`,
 * `get_context`, `follow_ref`) whose capability the pinned collection reports
 * as unavailable, instead of letting the model call a tool that always returns
 * empty. Hiding is strictly fail-open: any error, timeout, or unparseable
 * answer keeps the tool visible.
 */

export type CollectionCapability = "outline" | "pages" | "unitGraph";

/**
 * Fixed mapping from a bare MCP tool name to the collection capability it
 * needs. Tools outside this map are never hidden.
 */
export const NAVIGATION_TOOL_CAPABILITY: Readonly<
  Record<string, CollectionCapability>
> = {
  get_outline: "outline",
  get_section: "outline",
  get_pages: "pages",
  get_context: "unitGraph",
  follow_ref: "unitGraph",
};

export interface CollectionCapabilities {
  unitGraph: boolean;
  outline: boolean;
  pages: boolean;
}

/** How long a `collection_stats` fetch may take before it counts as failed. */
const FETCH_TIMEOUT_MS = 2000;

/** Default TTL for negative results (error / timeout / unparseable). */
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

function readCapabilities(value: unknown): CollectionCapabilities | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const caps = (value as Record<string, unknown>).capabilities;
  if (typeof caps !== "object" || caps === null) return undefined;
  const { unitGraph, outline, pages } = caps as Record<string, unknown>;
  if (
    typeof unitGraph !== "boolean" ||
    typeof outline !== "boolean" ||
    typeof pages !== "boolean"
  ) {
    return undefined;
  }
  return { unitGraph, outline, pages };
}

/**
 * Parse a `collection_stats` tool result. Accepts the capabilities object
 * directly on the JSON root or nested under a `result` key (the shape some
 * MCP proxies wrap tool output in). Returns `undefined` for anything that is
 * not JSON with three boolean capability fields — callers treat that as
 * fail-open.
 */
export function parseCollectionStats(
  text: string,
): CollectionCapabilities | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return (
    readCapabilities(parsed) ??
    readCapabilities((parsed as Record<string, unknown>).result)
  );
}

interface CacheEntry {
  /** `undefined` marks a negative entry (fetch failed / unparseable). */
  capabilities: CollectionCapabilities | undefined;
  expiresAt: number;
}

/**
 * Caches `collection_stats` capabilities per `(server, collection)`. Positive
 * results live for `ttlMs`, negative ones for `negativeTtlMs` (default 30 s)
 * so a broken or slow Search does not cause a fetch storm on every tool
 * build. Concurrent requests for the same key share one in-flight fetch, and
 * each fetch is raced against a 2000 ms timeout.
 */
export class CollectionCapabilityCache {
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<CollectionCapabilities | undefined>
  >();

  constructor(opts: {
    ttlMs: number;
    negativeTtlMs?: number;
    now?: () => number;
  }) {
    this.ttlMs = opts.ttlMs;
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return the capabilities for `(server, collection)`, fetching through
   * `fetch` on a cache miss. Never throws: a failing, timing-out, or
   * unparseable fetch resolves to `undefined` and is cached negatively.
   */
  async get(
    server: string,
    collection: string,
    fetch: () => Promise<string>,
  ): Promise<CollectionCapabilities | undefined> {
    const key = `${server}${"\u0000"}${collection}`;
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.capabilities;
    }
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const promise = this.fetchAndStore(key, fetch);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchAndStore(
    key: string,
    fetch: () => Promise<string>,
  ): Promise<CollectionCapabilities | undefined> {
    const capabilities = await this.fetchWithTimeout(fetch);
    this.entries.set(key, {
      capabilities,
      expiresAt:
        this.now() +
        (capabilities !== undefined ? this.ttlMs : this.negativeTtlMs),
    });
    return capabilities;
  }

  private async fetchWithTimeout(
    fetchStats: () => Promise<string>,
  ): Promise<CollectionCapabilities | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const text = await Promise.race([
        fetchStats(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), FETCH_TIMEOUT_MS);
        }),
      ]);
      return text === undefined ? undefined : parseCollectionStats(text);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * The capability that hides `bareName`, or `undefined` when the tool stays
 * visible: unknown tools are never hidden, unknown capabilities (no stats)
 * are fail-open, and a capability reported as `true` keeps its tools.
 */
export function shouldHideTool(
  bareName: string,
  caps: CollectionCapabilities | undefined,
): CollectionCapability | undefined {
  const capability = NAVIGATION_TOOL_CAPABILITY[bareName];
  if (capability === undefined || caps === undefined) return undefined;
  return caps[capability] === false ? capability : undefined;
}
