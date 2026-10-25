// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * source-url.ts
 *
 * Pulling a source document from a caller-supplied URL.
 *
 * This is the same server-side request forgery primitive as `X-Callback-URL`:
 * the service issues an outbound request to an address the *caller* chose. The
 * controls, applied to the initial URL and to every redirect hop:
 *
 *   1. Only `http`/`https`, never credentials in the URL.
 *   2. Link-local and cloud-metadata host names are refused unconditionally
 *      (`FORBIDDEN_HOST_PATTERNS`, shared with the callback module).
 *   3. `SOURCE_URL_ALLOWED_HOSTS`, when set, is an allowlist with the same
 *      `.example.com`-matches-subdomains rule (`isHostAllowed`). Left unset it
 *      permits any host minus the forbidden set, and the production gate flags
 *      the empty list. The allowlist is applied in addition to 4.
 *   4. The host is resolved (all A/AAAA records) and refused when ANY address
 *      is private, loopback, link-local, ULA, CGNAT, unspecified, multicast or
 *      an IPv4-mapped/embedded form of one of those (`isForbiddenAddress`).
 *   5. The connection is pinned to the validated address through the socket
 *      `lookup` hook, so a second DNS answer (DNS rebinding) can never redirect
 *      the actual TCP connection. TLS still verifies against the host name.
 *   6. Redirects are followed manually up to a small bound; each hop repeats
 *      1–5, so a permitted host cannot 302 the request onto a forbidden one.
 *
 * The body is streamed straight into the `SourceStore`, hashing as it goes and
 * enforcing `SOURCE_URL_MAX_BYTES`, so a multi-gigabyte pull never buffers in
 * memory — the same guarantee the chunked upload path gives.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import type { Logger } from "pino";
import { sourceFetchFailed, validationError } from "../errors.js";
import { injectTraceHeaders } from "../trace-context.js";
import {
  SourceChecksumError,
  SourceTooLargeError,
  type SourceStore,
  type StoredSource,
} from "../source-store.js";
import { FORBIDDEN_HOST_PATTERNS, isHostAllowed } from "./callback.js";

export interface SourceUrlConfig {
  /** Empty means "any host" (minus the forbidden set); the gate flags that. */
  allowedHosts: string[];
  maxBytes: number;
  timeoutMs: number;
}

/** How many redirects a pull follows before giving up. */
const MAX_REDIRECTS = 3;

// ── Address classification ──────────────────────────────────────────────────

/** IPv4 CIDR blocks that are never a legitimate pull target. */
const FORBIDDEN_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network" (incl. 0.0.0.0)
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT (incl. 100.100.100.200 metadata)
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local / cloud metadata
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved (incl. 255.255.255.255)
];

function parseIPv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function isForbiddenIPv4(value: number): boolean {
  return FORBIDDEN_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** Expand an IPv6 literal (optionally with an embedded IPv4 tail) to 8 hextets. */
function parseIPv6(address: string): number[] | undefined {
  let text = address.replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === undefined) return undefined;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = `${text.slice(0, lastColon + 1)}${tail.length > 0 ? "0:0" : ""}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string | undefined) =>
    part === undefined || part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array.from({ length: fill }, () => 0), ...rest];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return undefined;
  }
  if (tail.length === 2) {
    groups[6] = tail[0] ?? 0;
    groups[7] = tail[1] ?? 0;
  }
  return groups;
}

function isForbiddenIPv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedV4 = ((g6 << 16) >>> 0) + g7;
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: (unspecified) and ::1 (loopback).
  if (upperZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4.
  if (upperZero && (g5 === 0xffff || g5 === 0)) return isForbiddenIPv4(embeddedV4);
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 too.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isForbiddenIPv4(embeddedV4);
  }
  // 6to4 (2002::/16) embeds the IPv4 in the second and third hextets.
  if (g0 === 0x2002) return isForbiddenIPv4(((g1 << 16) >>> 0) + g2);
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA (incl. fd00:ec2::254)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Whether an IP address literal is outside the public unicast space and so
 * never a legitimate `source_url` target. Anything that does not parse as an
 * IP address is treated as forbidden (fail closed).
 */
export function isForbiddenAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0] ?? bare);
  if (family === 4) {
    const value = parseIPv4(bare);
    return value === undefined || isForbiddenIPv4(value);
  }
  if (family === 6) {
    const groups = parseIPv6(bare);
    return groups === undefined || isForbiddenIPv6(groups);
  }
  return true;
}

/**
 * Whether an IP address literal is link-local or a cloud-metadata address —
 * the set that is never a legitimate target even for an operator-allowlisted
 * host (169.254.0.0/16, 100.100.100.200, fe80::/10, fd00:ec2::254, and their
 * IPv4-mapped / NAT64 forms). Narrower than {@link isForbiddenAddress}, which
 * also refuses private and loopback space. Unparseable input is treated as
 * forbidden (fail closed).
 */
export function isLinkLocalOrMetadataAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const isMetaV4 = (value: number) =>
    ((value & 0xffff0000) >>> 0) === 0xa9fe0000 || value === 0x646464c8;
  const family = isIP(bare.split("%")[0] ?? bare);
  if (family === 4) {
    const value = parseIPv4(bare);
    return value === undefined || isMetaV4(value);
  }
  if (family === 6) {
    const groups = parseIPv6(bare);
    if (groups === undefined) return true;
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
    const embeddedV4 = ((g6 << 16) >>> 0) + g7;
    const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    if (upperZero && g5 === 0xffff) return isMetaV4(embeddedV4);
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isMetaV4(embeddedV4);
    }
    if ((g0 & 0xffc0) === 0xfe80) return true;
    // AWS IPv6 instance metadata endpoint.
    return (
      g0 === 0xfd00 && g1 === 0x0ec2 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 &&
      g6 === 0 && g7 === 0x0254
    );
  }
  return true;
}

// ── URL validation ──────────────────────────────────────────────────────────

/**
 * Validate a caller-supplied source URL against the static SSRF controls
 * (scheme, credentials, forbidden host names, literal forbidden IPs, the
 * allowlist). The DNS-based check happens in {@link resolvePinnedAddress}.
 *
 * Throws a client error (400) rather than declining silently, because a caller
 * whose URL was rejected needs to know the pull will never happen.
 */
export function resolveSourceUrl(raw: string, config: SourceUrlConfig): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validationError("source_url must be an absolute http(s) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw validationError(
      `source_url must use http or https, not "${url.protocol.replace(":", "")}"`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw validationError("source_url must not contain credentials");
  }

  const host = url.hostname;
  if (FORBIDDEN_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw validationError("source_url points at a link-local or metadata address");
  }
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0 && isForbiddenAddress(literal)) {
    throw validationError("source_url points at a private, loopback or reserved address");
  }
  if (config.allowedHosts.length > 0 && !isHostAllowed(host, config.allowedHosts)) {
    throw validationError(`source_url host "${host}" is not in SOURCE_URL_ALLOWED_HOSTS`);
  }

  return url;
}

/** One resolved address of a host. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves every A/AAAA address of a host name. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

/** The node:dns resolver (all A/AAAA records), shared with the callback path. */
export const defaultHostResolver: HostResolver = defaultResolver;

/**
 * Resolve the URL's host and return the single address the connection is
 * pinned to. Every resolved address must be public: a host that answers with
 * one public and one private address is refused, because the resolver of the
 * HTTP client could otherwise pick the private one.
 */
export async function resolvePinnedAddress(
  url: URL,
  resolver: HostResolver = defaultResolver,
): Promise<ResolvedAddress> {
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(literal);
  if (literalFamily !== 0) {
    if (isForbiddenAddress(literal)) {
      throw validationError("source_url points at a private, loopback or reserved address");
    }
    return { address: literal, family: literalFamily === 6 ? 6 : 4 };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(literal);
  } catch (err) {
    throw sourceFetchFailed(
      `Could not resolve source_url host: ${err instanceof Error ? err.message : String(err)}`,
      { host: url.hostname },
    );
  }
  if (addresses.length === 0) {
    throw sourceFetchFailed("source_url host has no A/AAAA records", { host: url.hostname });
  }
  if (addresses.some((entry) => isForbiddenAddress(entry.address))) {
    throw validationError(
      `source_url host "${url.hostname}" resolves to a private, loopback or reserved address`,
    );
  }
  const first = addresses[0];
  if (first === undefined) {
    throw sourceFetchFailed("source_url host has no A/AAAA records", { host: url.hostname });
  }
  return first;
}

// ── Pinned HTTP request ─────────────────────────────────────────────────────

/** The part of an HTTP response the pull needs. */
export interface SourceResponse {
  status: number;
  header(name: string): string | undefined;
  body: Readable;
}

/**
 * Issues one GET to `url`, connecting to `pinned` instead of re-resolving the
 * host. Injectable for tests; the default uses node:http(s) with a `lookup`
 * hook that only ever returns the validated address.
 */
export type PinnedRequester = (
  url: URL,
  pinned: ResolvedAddress,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<SourceResponse>;

/** A `lookup` hook that always answers with the pre-validated address. */
export function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return ((_hostname, options, callback) => {
    if (options.all === true) {
      (callback as (err: null, addresses: ResolvedAddress[]) => void)(null, [pinned]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  }) as LookupFunction;
}

export const pinnedRequest: PinnedRequester = (url, pinned, init) =>
  new Promise<SourceResponse>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        headers: init.headers,
        signal: init.signal,
        lookup: pinnedLookup(pinned),
        // A fresh socket per request: a pooled keep-alive socket was connected
        // under an earlier validation and must not be reused for this one.
        agent: false,
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          header: (name) => {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
          body: response,
        });
      },
    );
    request.on("error", reject);
    request.end();
  });

export interface FetchSourceArgs {
  rawUrl: string;
  store: SourceStore;
  config: SourceUrlConfig;
  logger: Logger;
  /** Optional whole-file sha256 the caller expects; rejects a mismatch. */
  expectedSha256?: string;
  /** Injectable for tests; defaults to DNS resolution via node:dns. */
  resolver?: HostResolver;
  /** Injectable for tests; defaults to {@link pinnedRequest}. */
  requestImpl?: PinnedRequester;
}

/**
 * Pull the source, following redirects manually so each hop is re-validated
 * (URL rules, DNS resolution, pinning), and stream the body into the store.
 *
 * A non-2xx response, a network or DNS failure, or a body over the ceiling is
 * a `SOURCE_FETCH_FAILED` (502, retryable); a checksum mismatch or a rejected
 * URL/address is a client error, because those will not change on retry.
 */
/** A pulled source: the stored bytes plus what the response said about them. */
export interface PulledSource extends StoredSource {
  /** The response's `Content-Type`, when it sent one. */
  contentType?: string;
  /** The URL the bytes finally came from, after redirects. */
  finalUrl: string;
}

export async function fetchSourceToStore(args: FetchSourceArgs): Promise<PulledSource> {
  const { store, config, logger, expectedSha256 } = args;
  const doRequest = args.requestImpl ?? pinnedRequest;

  let current = resolveSourceUrl(args.rawUrl, config);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const pinned = await resolvePinnedAddress(current, args.resolver);
    const controller = new AbortController();
    const timeout =
      config.timeoutMs > 0 ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    let response: SourceResponse;
    try {
      const headers: Record<string, string> = { accept: "*/*" };
      injectTraceHeaders(headers);
      response = await doRequest(current, pinned, { headers, signal: controller.signal });
      // Like before, the timeout bounds connecting and receiving the response
      // head; the body stream is bounded by SOURCE_URL_MAX_BYTES instead.
      if (timeout !== null) clearTimeout(timeout);
    } catch (err) {
      if (timeout !== null) clearTimeout(timeout);
      throw sourceFetchFailed(
        `Could not fetch source_url: ${err instanceof Error ? err.message : String(err)}`,
        { host: current.hostname },
      );
    }

    // A permitted host must not be able to bounce us onto a forbidden one, so
    // every redirect target is re-validated before it is followed.
    if (response.status >= 300 && response.status < 400) {
      response.body.resume();
      const location = response.header("location");
      if (location === undefined) {
        throw sourceFetchFailed("source_url redirected without a Location header");
      }
      if (hop === MAX_REDIRECTS) {
        throw sourceFetchFailed("source_url exceeded the redirect limit");
      }
      current = resolveSourceUrl(new URL(location, current).toString(), config);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.body.resume();
      throw sourceFetchFailed(`source_url returned HTTP ${response.status}`, {
        status: response.status,
        host: current.hostname,
      });
    }

    // A declared Content-Length over the ceiling is refused before a single
    // byte is read; the streamed check below is the real enforcement.
    const declaredLength = Number(response.header("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > config.maxBytes) {
      response.body.destroy();
      throw validationError(
        `source_url declares ${declaredLength} bytes, over the ${config.maxBytes} byte limit`,
      );
    }

    try {
      const stored = await store.putStream(response.body, {
        maxBytes: config.maxBytes,
        ...(expectedSha256 !== undefined ? { expected: expectedSha256 } : {}),
      });
      logger.info(
        {
          host: current.hostname,
          address: pinned.address,
          sha256: stored.sha256,
          size: stored.size,
          deduped: stored.deduped,
        },
        "Pulled source from source_url",
      );
      const contentType = response.header("content-type");
      return {
        ...stored,
        ...(typeof contentType === "string" && contentType !== "" ? { contentType } : {}),
        finalUrl: current.toString(),
      };
    } catch (err) {
      response.body.destroy();
      if (err instanceof SourceChecksumError) {
        throw validationError(
          `source_url content sha256 ${err.actual} does not match the expected ${err.expected}`,
        );
      }
      if (err instanceof SourceTooLargeError) {
        throw validationError(`source_url body exceeds the ${err.maxBytes} byte limit`);
      }
      throw sourceFetchFailed(
        `Failed while storing source_url body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Unreachable: the loop either returns or throws on the final hop.
  throw sourceFetchFailed("source_url could not be resolved");
}
