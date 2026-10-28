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
 *
 * Every accepted document is validated (Req 7.3): the `issuer` must match the
 * configured issuer exactly, and the `jwks_uri` must use HTTPS whenever
 * discovery itself ran over HTTPS with its host equal to the issuer host (or
 * on an explicit allowlist) — a compromised or hostile discovery document can
 * therefore never redirect key fetching to an attacker-controlled plaintext
 * endpoint.
 */

import { isHostAllowed } from "../egress/addresses.ts";
import { trimTrailingSlashes } from "../url-trim.ts";

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
  /**
   * Explicit discovery URL. Defaults to
   * `<issuer>/.well-known/openid-configuration`; services whose configuration
   * carries a non-standard discovery path (e.g. a realm-prefixed well-known
   * URL) pass it here. The exact-issuer check still applies.
   */
  discoveryUrl?: string;
  /** Minimum positive-cache TTL regardless of `Cache-Control` (default 5 min). */
  minPositiveTtlMs?: number;
  /** Initial negative-cache TTL after one failure (default 30 s). */
  negativeTtlMs?: number;
  /** Upper bound for the exponentially growing negative TTL (default 5 min). */
  maxNegativeTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /**
   * Hosts that may serve `jwks_uri` in addition to the issuer host — exact
   * names or `.example.com`-style subdomain entries (see `isHostAllowed`).
   */
  allowedJwksHosts?: readonly string[];
  /**
   * Permit a non-HTTPS `jwks_uri` even when discovery ran over HTTPS.
   * Development-only escape hatch against plain-HTTP IdPs; production must
   * leave this off (Req 7.3).
   */
  allowInsecureJwksUri?: boolean;
  /**
   * How strictly the document's `issuer` must match the configured issuer.
   *
   * - `exact` (default, Req 7.3): byte-identical or the document is rejected.
   * - `trailing-slash`: additionally accepts a document issuer that differs
   *   from the configured one only by a trailing slash — providers such as
   *   Authentik embed one in `iss`. Services using this mode MUST verify
   *   tokens against `document.issuer` (the canonical value), never against
   *   the configured string, or the signature check fails on the `iss` claim.
   */
  issuerMatch?: "exact" | "trailing-slash";
  /** HTTP client injection (tests / egress-guarded fetch). */
  fetchImpl?: (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{
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

/**
 * Validate the `jwks_uri` of a discovery document (Req 7.3): HTTPS is
 * required whenever the discovery URL itself is HTTPS (a plain-HTTP IdP in
 * development may still hand out a plain-HTTP JWKS), and the host must be
 * the issuer host or an entry of the optional allowlist. Throws
 * {@link DiscoveryError} on any violation.
 */
export function validateJwksUri(
  jwksUri: string,
  issuer: string,
  discoveryUrl: string,
  options: {
    allowedJwksHosts?: readonly string[];
    allowInsecureJwksUri?: boolean;
  } = {},
): void {
  let jwks: URL;
  try {
    jwks = new URL(jwksUri);
  } catch {
    throw new DiscoveryError(
      `discovery document jwks_uri "${jwksUri}" is not a valid URL`,
    );
  }
  let discoveryProtocol: string | undefined;
  try {
    discoveryProtocol = new URL(discoveryUrl).protocol;
  } catch {
    discoveryProtocol = undefined;
  }
  if (
    options.allowInsecureJwksUri !== true &&
    discoveryProtocol === "https:" &&
    jwks.protocol !== "https:"
  ) {
    throw new DiscoveryError(
      `discovery document jwks_uri "${jwksUri}" must use HTTPS`,
    );
  }
  let issuerHost: string | undefined;
  try {
    issuerHost = new URL(issuer).hostname;
  } catch {
    issuerHost = undefined;
  }
  // The host serving the discovery document itself is implicitly trusted —
  // with a non-standard `discoveryUrl` it may legitimately differ from the
  // issuer host and host the JWKS.
  let discoveryHost: string | undefined;
  try {
    discoveryHost = new URL(discoveryUrl).hostname;
  } catch {
    discoveryHost = undefined;
  }
  const allowed = options.allowedJwksHosts ?? [];
  const host = jwks.hostname;
  if (
    host !== issuerHost &&
    host !== discoveryHost &&
    !isHostAllowed(host, allowed)
  ) {
    throw new DiscoveryError(
      `discovery document jwks_uri host "${host}" matches neither the issuer host nor the allowlist`,
    );
  }
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

export function createDiscoveryClient(
  issuer: string,
  options: DiscoveryOptions = {},
): DiscoveryClient {
  const minPositiveTtlMs =
    options.minPositiveTtlMs ?? DEFAULT_MIN_POSITIVE_TTL_MS;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const maxNegativeTtlMs =
    options.maxNegativeTtlMs ?? DEFAULT_MAX_NEGATIVE_TTL_MS;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url));

  // Normalise: discovery is <issuer>/.well-known/openid-configuration unless
  // an explicit discoveryUrl overrides it.
  const discoveryUrl =
    options.discoveryUrl ??
    (() => {
      const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
      return `${base}/.well-known/openid-configuration`;
    })();

  let cached: { document: OidcDiscoveryDocument; expiresAt: number } | null =
    null;
  let failureCount = 0;
  let negativeExpiresAt = 0;
  let inFlight: Promise<OidcDiscoveryDocument> | null = null;

  const fetchMetadata = async (): Promise<{
    document: OidcDiscoveryDocument;
    maxAgeMs: number | undefined;
  }> => {
    let response: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      response = await fetchImpl(discoveryUrl, {
        headers: { accept: "application/json" },
      });
    } catch (err) {
      throw new DiscoveryError(
        `discovery request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new DiscoveryError(
        `discovery responded with HTTP ${response.status}`,
      );
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
    if (
      typeof document.issuer !== "string" ||
      typeof document.jwks_uri !== "string"
    ) {
      throw new DiscoveryError(
        "discovery document is missing issuer or jwks_uri",
      );
    }
    const issuerMatches =
      document.issuer === issuer ||
      (options.issuerMatch === "trailing-slash" &&
        trimTrailingSlashes(document.issuer) === trimTrailingSlashes(issuer));
    if (!issuerMatches) {
      throw new DiscoveryError(
        `discovery document issuer "${document.issuer}" does not match configured issuer`,
      );
    }
    validateJwksUri(document.jwks_uri, issuer, discoveryUrl, {
      allowedJwksHosts: options.allowedJwksHosts,
      allowInsecureJwksUri: options.allowInsecureJwksUri,
    });
    return {
      document,
      maxAgeMs: parseMaxAgeMs(response.headers.get("cache-control")),
    };
  };

  const getMetadata = async (): Promise<OidcDiscoveryDocument> => {
    const currentTime = now();
    if (cached !== null && cached.expiresAt > currentTime)
      return cached.document;
    if (negativeExpiresAt > currentTime) {
      throw new DiscoveryError(
        "issuer discovery is in a back-off window after a recent failure",
      );
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
        const ttl = Math.min(
          negativeTtlMs * 2 ** (failureCount - 1),
          maxNegativeTtlMs,
        );
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
