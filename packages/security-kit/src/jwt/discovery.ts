// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * discovery.ts
 *
 * OIDC provider-metadata discovery with the caching behaviour every service
 * needs and none of them had consistently:
 *
 *   - Single-flight: concurrent callers share one in-flight request instead of
 *     stampeding the IdP.
 *   - Positive cache: TTL taken from the response's `Cache-Control: max-age`,
 *     floored at {@link DEFAULT_MIN_POSITIVE_TTL_MS} (5 min) so a provider
 *     sending `no-cache` cannot turn every request into an IdP round-trip.
 *   - Negative cache: a failed discovery is remembered for
 *     {@link DEFAULT_NEGATIVE_TTL_MS} (30 s) and the entry doubles on every
 *     consecutive failure up to 5 min, so a broken IdP is not hammered.
 *
 * The fetch implementation is injectable (tests, or an egress-guarded fetch).
 */

export interface OidcDiscoveryDocument {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  end_session_endpoint?: string;
  [key: string]: unknown;
}

export const DEFAULT_MIN_POSITIVE_TTL_MS = 5 * 60_000;
export const DEFAULT_NEGATIVE_TTL_MS = 30_000;
export const DEFAULT_MAX_NEGATIVE_TTL_MS = 5 * 60_000;

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export interface DiscoveryOptions {
  /** Minimum positive-cache TTL regardless of `Cache-Control` (default 5 min). */
  minPositiveTtlMs?: number;
  /** Initial negative-cache TTL after one failure (default 30 s). */
  negativeTtlMs?: number;
  /** Upper bound for the exponentially growing negative TTL (default 5 min). */
  maxNegativeTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** HTTP client injection (tests / egress-guarded fetch). */
  fetchImpl?: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
}

export interface DiscoveryClient {
  /** Resolved metadata document; served from cache while fresh. */
  getMetadata(): Promise<OidcDiscoveryDocument>;
  /** Well-known URL used for discovery. */
  readonly discoveryUrl: string;
}

/** Parse `max-age` from a Cache-Control header value; undefined when absent/invalid. */
export function parseMaxAgeMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  for (const directive of header.split(",")) {
    const [name, value] = directive.trim().split("=", 2);
    if (name?.toLowerCase() === "max-age" && value !== undefined) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
  }
  return undefined;
}

export function createDiscoveryClient(issuer: string, options: DiscoveryOptions = {}): DiscoveryClient {
  const minPositiveTtlMs = options.minPositiveTtlMs ?? DEFAULT_MIN_POSITIVE_TTL_MS;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const maxNegativeTtlMs = options.maxNegativeTtlMs ?? DEFAULT_MAX_NEGATIVE_TTL_MS;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url));

  // Normalise: discovery is always <issuer>/.well-known/openid-configuration
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const discoveryUrl = `${base}/.well-known/openid-configuration`;

  let cached: { document: OidcDiscoveryDocument; expiresAt: number } | null = null;
  let failureCount = 0;
  let negativeExpiresAt = 0;
  let inFlight: Promise<OidcDiscoveryDocument> | null = null;

  const fetchMetadata = async (): Promise<{ document: OidcDiscoveryDocument; maxAgeMs: number | undefined }> => {
    let response: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      response = await fetchImpl(discoveryUrl, { headers: { accept: "application/json" } });
    } catch (err) {
      throw new DiscoveryError(
        `discovery request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new DiscoveryError(`discovery responded with HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DiscoveryError("discovery response is not valid JSON");
    }
    if (typeof body !== "object" || body === null) {
      throw new DiscoveryError("discovery response is not an object");
    }
    const document = body as OidcDiscoveryDocument;
    if (typeof document.issuer !== "string" || typeof document.jwks_uri !== "string") {
      throw new DiscoveryError("discovery document is missing issuer or jwks_uri");
    }
    if (document.issuer !== issuer) {
      throw new DiscoveryError(
        `discovery document issuer "${document.issuer}" does not match configured issuer`,
      );
    }
    return { document, maxAgeMs: parseMaxAgeMs(response.headers.get("cache-control")) };
  };

  const getMetadata = async (): Promise<OidcDiscoveryDocument> => {
    const currentTime = now();
    if (cached !== null && cached.expiresAt > currentTime) return cached.document;
    if (negativeExpiresAt > currentTime) {
      throw new DiscoveryError("issuer discovery is in a back-off window after a recent failure");
    }
    if (inFlight !== null) return inFlight; // single-flight: share, no new attempt
    const attempt = (async (): Promise<OidcDiscoveryDocument> => {
      try {
        const { document, maxAgeMs } = await fetchMetadata();
        const ttl = Math.max(maxAgeMs ?? 0, minPositiveTtlMs);
        cached = { document, expiresAt: now() + ttl };
        // A fresh document means the issuer is reachable again — clear the back-off.
        failureCount = 0;
        negativeExpiresAt = 0;
        return document;
      } catch (err) {
        failureCount += 1;
        const ttl = Math.min(negativeTtlMs * 2 ** (failureCount - 1), maxNegativeTtlMs);
        negativeExpiresAt = now() + ttl;
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    inFlight = attempt;
    return attempt;
  };

  return { getMetadata, discoveryUrl };
}
