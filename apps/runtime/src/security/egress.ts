// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Runtime Egress_Guard (Req 7.1, 7.2).
 *
 * Every outbound HTTP call the runtime makes must go through
 * {@link RuntimeEgress.fetch} (exposed at call sites as `ctx.egress.fetch`).
 * The guard:
 *
 * - refuses non-http(s) schemes, URL credentials, cloud-metadata hostnames and
 *   `localhost`/`.localhost` (unless the exact host is allow-listed, see below);
 * - resolves the destination itself and blocks private, loopback, link-local,
 *   CGNAT and metadata addresses via the shared `@atf/security-kit` catalog
 *   (fail-closed on resolution failure);
 * - pins the validated address to the socket via a connect-time `lookup` hook,
 *   closing the validate-then-connect TOCTOU window (DNS rebinding);
 * - re-validates every redirect hop before re-issuing the request
 *   (Redirect-Revalidierung, Req 7.2);
 * - enforces a maximum response body size (size limit, Req 7.2);
 * - streams the response body (no buffering) so SSE/LLM streaming keeps working.
 *
 * A host listed in `EGRESS_ALLOW_PRIVATE_HOSTS` (exact match, split-DNS
 * exceptions) may resolve to RFC1918/ULA addresses — and, when `allowLoopback`
 * is set (development), to loopback. Link-local, CGNAT and cloud-metadata
 * ranges (`isAlwaysForbiddenAddress`) stay closed even for allow-listed hosts.
 *
 * The transport mirrors `apps/gate/src/tools/outbound.ts` (node:http(s) with a
 * pinned `lookup` hook, `Readable.toWeb` streaming body, real `Response`),
 * extended with redirect-following-with-revalidation and the size limit.
 * Request bodies must be buffered (string/Buffer/Uint8Array/URLSearchParams);
 * a `Request` input carrying a stream body is rejected.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  isAlwaysForbiddenAddress,
  isForbiddenAddress as kitIsForbiddenAddress,
} from "@atf/security-kit";

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

/** Default response body ceiling: 64 MiB. `0` disables the limit. */
export const DEFAULT_EGRESS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface RuntimeEgressOptions {
  /**
   * Exact hostnames (split-DNS exceptions) permitted to resolve to
   * RFC1918/ULA — and, with `allowLoopback`, loopback — addresses.
   */
  allowedPrivateHosts?: readonly string[];
  /** Optional destination allow-list; empty means "any public host". */
  allowedHosts?: readonly string[];
  /** Maximum response body size in bytes; `0` disables the limit. */
  maxResponseBytes?: number;
  /**
   * Default request timeout in ms applied when the caller supplies no signal.
   * `0` (default) disables it — long-lived streaming calls keep their own
   * caller-provided signals.
   */
  timeoutMs?: number;
  /**
   * Allow allow-listed hosts to resolve to loopback (127.0.0.0/8, ::1).
   * Enabled for non-production `APP_ENV` by the composition root.
   */
  allowLoopback?: boolean;
  /** Default redirect policy when the caller does not set `init.redirect`. */
  redirect?: "follow" | "manual" | "error";
}

export interface RuntimeEgress {
  /** Guarded `fetch` — drop-in replacement for the global. */
  readonly fetch: typeof fetch;
  /** Synchronous URL validation (scheme/credentials/allow-list/metadata). */
  readonly checkUrl: (urlString: string) => string | null;
}

/**
 * Synchronous URL/protocol/allow-list validation. Address checks happen at
 * connect time inside the pinned `lookup` hook.
 */
function checkUrl(
  urlString: string,
  allowedHosts: readonly string[],
): string | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return `invalid outbound URL: ${urlString}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `outbound protocol not allowed: ${url.protocol}`;
  }
  if (url.username || url.password) return "outbound URL credentials are not allowed";

  const host = normalizeHost(url.hostname);
  if (allowedHosts.length > 0) {
    const allowed = allowedHosts.some((entry) => {
      const candidate = entry.trim().toLowerCase().replace(/\.$/, "");
      if (!candidate) return false;
      return candidate.startsWith(".")
        ? host === candidate.slice(1) || host.endsWith(candidate)
        : host === candidate;
    });
    if (!allowed) return `outbound host not allowed: ${host}`;
  }
  return null;
}

/** Create a guarded fetch with the given policy. Pure — no global state. */
export function createRuntimeEgress(
  options: RuntimeEgressOptions = {},
): RuntimeEgress {
  const allowedPrivateHosts = (options.allowedPrivateHosts ?? [])
    .map((entry) => normalizeHost(entry.trim()))
    .filter((entry) => entry.length > 0);
  const allowedHosts = options.allowedHosts ?? [];
  const maxBytes = options.maxResponseBytes ?? DEFAULT_EGRESS_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? 0;
  const allowLoopback = options.allowLoopback ?? false;
  const defaultRedirect = options.redirect ?? "follow";

  const validate = (url: URL): string | null => {
    const blocked = checkUrl(url.toString(), allowedHosts);
    if (blocked) return blocked;
    const host = normalizeHost(url.hostname);
    if (
      !isExactHostAllowed(host, allowedPrivateHosts) &&
      (METADATA_HOSTS.has(host) || host === "localhost" || host.endsWith(".localhost"))
    ) {
      return `outbound host not allowed: ${host}`;
    }
    // IP literals must be checked eagerly: some runtimes (Bun) bypass the
    // connect-time `lookup` hook for literal addresses, so the hook alone
    // would not guard them.
    if (isIP(host) && addressBlocked(host, privateAllowedFor(host), allowLoopback)) {
      return `outbound address not allowed: ${host}`;
    }
    return null;
  };

  const privateAllowedFor = (host: string): boolean =>
    isExactHostAllowed(host, allowedPrivateHosts);

  const singleRequest = (
    url: URL,
    method: string,
    headers: Headers,
    body: Buffer | string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const host = normalizeHost(url.hostname);
      const privateAllowed = privateAllowedFor(host);
      const requestHeaders: Record<string, string> = {};
      headers.forEach((value, key) => {
        requestHeaders[key] = value;
      });

      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers: requestHeaders,
          signal,
          lookup: async (
            _hostname: string,
            lookupOptions: { all?: boolean },
            callback: (
              err: Error | null,
              address: string | { address: string; family: 4 | 6 }[],
              family?: number,
            ) => void,
          ) => {
            const returnAll = lookupOptions.all === true;
            try {
              if (isIP(host)) {
                if (addressBlocked(host, privateAllowed, allowLoopback)) {
                  throw new Error(`outbound address not allowed: ${host}`);
                }
                const selected = { address: host, family: isIP(host) as 4 | 6 };
                if (returnAll) callback(null, [selected]);
                else callback(null, selected.address, selected.family);
                return;
              }
              const addresses = await dnsLookup(host, {
                all: true,
                verbatim: true,
              });
              if (addresses.length === 0) {
                throw new Error(`outbound host did not resolve: ${host}`);
              }
              const forbidden = addresses.find(({ address }) =>
                addressBlocked(address, privateAllowed, allowLoopback),
              );
              if (forbidden) {
                throw new Error(`outbound address not allowed: ${forbidden.address}`);
              }
              if (returnAll) {
                callback(
                  null,
                  addresses.map((entry) => ({
                    address: entry.address,
                    family: entry.family as 4 | 6,
                  })),
                );
              } else {
                // DNS-Pinning: the socket connects to exactly the address that
                // passed the policy check above.
                const selected = addresses[0];
                callback(null, selected.address, selected.family);
              }
            } catch (cause) {
              const error = cause instanceof Error ? cause : new Error(String(cause));
              if (returnAll) callback(error, []);
              else callback(error, "", 0);
            }
          },
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else if (value !== undefined) {
              responseHeaders.set(key, value);
            }
          }
          const status = incoming.statusCode ?? 500;
          const bodyless =
            REDIRECT_STATUSES.has(status) || [204, 205, 304].includes(status);
          const responseBody = bodyless
            ? null
            : (Readable.toWeb(incoming) as unknown as ReadableStream);
          if (bodyless) incoming.resume();
          resolve(
            new Response(responseBody, {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            }),
          );
        },
      );
      request.once("error", reject);
      if (body !== undefined) request.write(body);
      request.end();
    });

  const guardedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url = new URL(
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url,
    );
    let method =
      init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method);
    const headers = new Headers(
      typeof input === "string" || input instanceof URL ? undefined : input.headers,
    );
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });

    let body = normalizeRequestBody(
      init?.body ??
        (typeof input === "string" || input instanceof URL ? null : input.body),
      typeof input === "string" || input instanceof URL ? undefined : input,
    );

    const redirectMode = init?.redirect ?? defaultRedirect;
    const signal =
      init?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

    for (let hop = 0; ; hop += 1) {
      const blocked = validate(url);
      if (blocked) throw new Error(blocked);
      const response = await singleRequest(url, method, headers, body, signal);
      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || location === null) {
        return limitResponseSize(response, maxBytes);
      }
      if (redirectMode === "error") {
        void response.body?.cancel();
        throw new Error("outbound redirects are disabled");
      }
      if (redirectMode === "manual") {
        return limitResponseSize(response, maxBytes);
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        void response.body?.cancel();
        throw new Error("outbound redirect limit exceeded");
      }
      void response.body?.cancel();
      // Redirect-Revalidierung (Req 7.2): the next hop is validated — scheme,
      // allow-list, metadata hosts and addresses — before the request is re-issued.
      url = new URL(location, url);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-length");
        headers.delete("content-type");
      }
    }
  };

  return {
    fetch: guardedFetch as typeof fetch,
    checkUrl: (urlString: string) => checkUrl(urlString, allowedHosts),
  };
}

function normalizeRequestBody(
  body: BodyInit | null | undefined,
  requestInput?: Request,
): Buffer | string | undefined {
  if (body === undefined || body === null) {
    // A Request input may still carry a stream body we cannot buffer.
    if (requestInput !== undefined && requestInput.body !== null) {
      throw new Error("egress transport only accepts buffered request bodies");
    }
    return undefined;
  }
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("egress transport only accepts buffered request bodies");
}

/** Enforce the response size limit on the (streaming) body. */
function limitResponseSize(response: Response, maxBytes: number): Response {
  if (maxBytes <= 0 || response.body === null) return response;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body.cancel();
    throw new Error(
      `outbound response exceeds the ${maxBytes} byte egress limit`,
    );
  }
  const reader = response.body.getReader();
  let total = 0;
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel();
        controller.error(
          new Error(`outbound response exceeds the ${maxBytes} byte egress limit`),
        );
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  return new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isExactHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((entry) => entry === host);
}

/**
 * Combined check: an address is blocked when the shared Security_Kit catalog
 * forbids it, unless a configured split-DNS exception opens exactly this host
 * AND the address is a plain RFC1918/ULA (plus loopback in development)
 * target. Link-local, CGNAT and cloud metadata ranges
 * (`isAlwaysForbiddenAddress`) stay closed even under the exception.
 */
function addressBlocked(
  address: string,
  privateAllowed: boolean,
  allowLoopback: boolean,
): boolean {
  if (!kitIsForbiddenAddress(address)) return false;
  return !(
    privateAllowed &&
    isAllowedPrivateAddress(address, allowLoopback) &&
    !isAlwaysForbiddenAddress(address)
  );
}

/**
 * Split-DNS exceptions may open RFC1918 IPv4 and unique-local IPv6 — and,
 * in development (`allowLoopback`), loopback. This intentionally widens the
 * gate's stricter rule: the runtime legitimately talks to local sidecars
 * (ollama, OTLP collectors) that operators explicitly allow-list.
 */
function isAllowedPrivateAddress(address: string, allowLoopback: boolean): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) {
    return isAllowedPrivateAddress(normalized.slice(7), allowLoopback);
  }
  if (allowLoopback && (normalized === "::1" || normalized.startsWith("127."))) {
    return true;
  }
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(normalized) === 6 && (normalized.startsWith("fc") || normalized.startsWith("fd"));
}

// ---------------------------------------------------------------------------
// Process-wide default (configured once by the composition root, index.ts).
// ---------------------------------------------------------------------------

let defaultEgress: RuntimeEgress | undefined;

/** Install the process-wide Egress_Guard built from the loaded AppConfig. */
export function initRuntimeEgress(
  options: RuntimeEgressOptions = {},
): RuntimeEgress {
  defaultEgress = createRuntimeEgress(options);
  return defaultEgress;
}

/** Current default; a fail-closed guard (no private hosts) before init. */
export function getRuntimeEgress(): RuntimeEgress {
  defaultEgress ??= createRuntimeEgress({});
  return defaultEgress;
}

/**
 * The guarded fetch every call site uses by default (`ctx.egress.fetch`).
 * Resolves the current default lazily so construction order does not matter.
 * Typed as `typeof fetch` (which carries static members such as
 * `preconnect`); the guard itself only implements the callable part.
 */
export const egressFetch: typeof fetch = ((
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => getRuntimeEgress().fetch(input, init)) as typeof fetch;
