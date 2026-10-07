// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * guard.ts
 *
 * The shared Egress Guard: one implementation of "the server issues an
 * outbound HTTP request to an address somebody else chose", with the controls
 * every service needs:
 *
 *   1. Only `http`/`https`, never credentials in the URL.
 *   2. Metadata host names refused unconditionally ({@link FORBIDDEN_HOST_PATTERNS}).
 *   3. Optional host allowlist (`allowedHosts`, `.example.com` = subdomains).
 *   4. Every DNS answer must be a permitted address — a host with one public
 *      and one private record is refused, because the HTTP client could pick
 *      the private one. `allowPrivateHosts` relaxes private/loopback space for
 *      development, never link-local/metadata space.
 *   5. The connection is pinned to the validated address through the socket
 *      `lookup` hook, so a second DNS answer (DNS rebinding) cannot redirect
 *      the TCP connection. TLS still verifies against the host name.
 *   6. Redirects are followed manually; every hop repeats 1–5.
 *   7. `maxBytes` bounds the response body, `timeoutMs` bounds each hop.
 *
 * Works identically under Bun and Node: the request goes through
 * `node:http`/`node:https` with a pinned `lookup` and `agent: false` (no
 * pooled socket from an earlier validation).
 */

import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import {
  FORBIDDEN_HOST_PATTERNS,
  isAlwaysForbiddenAddress,
  isForbiddenAddress,
  isHostAllowed,
} from "./addresses.ts";

export interface EgressGuardOptions {
  /** When non-empty, only these hosts may be contacted (`.example.com` matches subdomains). */
  allowedHosts?: readonly string[];
  /**
   * Permit RFC1918/loopback targets (development against local services).
   * Link-local and cloud-metadata space stays forbidden either way.
   */
  allowPrivateHosts?: boolean;
  /** Maximum response body size in bytes; the stream is destroyed past it. */
  maxBytes?: number;
  /** Maximum redirect hops followed (default 3). */
  maxRedirects?: number;
  /** Per-hop timeout in milliseconds (default 30 000; 0 disables). */
  timeoutMs?: number;
  /** DNS resolver override (tests); defaults to all A/AAAA records via node:dns. */
  resolver?: HostResolver;
}

export type EgressRejectionReason =
  | "invalid_url"
  | "forbidden_host"
  | "forbidden_address"
  | "host_not_allowed"
  | "resolution_failed"
  | "too_large"
  | "timeout"
  | "redirect_limit"
  | "network";

/**
 * Plain field assignment (no constructor parameter properties) keeps this
 * file erasable by Node's native type-stripping, so the guard runs under
 * both Bun and Node unchanged.
 */
export class EgressError extends Error {
  readonly reason: EgressRejectionReason;
  readonly status?: number;
  constructor(message: string, reason: EgressRejectionReason, status?: number) {
    super(message);
    this.name = "EgressError";
    this.reason = reason;
    this.status = status;
  }
}

/** The subset of the fetch Response the guarded client guarantees. */
export interface GuardedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Final URL after redirects. */
  url: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface GuardedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal;
}

/** One resolved address of a host. Injectable for tests. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

export interface EgressGuard {
  /** Fetch with all SSRF controls applied to the URL and every redirect hop. */
  fetch(url: string | URL, init?: GuardedRequestInit): Promise<GuardedResponse>;
  /** Validate a URL statically (scheme, credentials, host patterns, literal IP, allowlist). */
  validateUrl(url: string | URL): URL;
  /** Resolve and validate every address of the URL's host; returns the pin target. */
  resolvePinned(url: URL): Promise<ResolvedAddress>;
}

export function createEgressGuard(options: EgressGuardOptions = {}): EgressGuard {
  const allowedHosts = options.allowedHosts ?? [];
  const allowPrivateHosts = options.allowPrivateHosts ?? false;
  const maxBytes = options.maxBytes ?? 0; // 0 = unbounded
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const resolver = options.resolver ?? defaultResolver;

  const addressAllowed = (address: string): boolean => {
    if (isAlwaysForbiddenAddress(address)) return false;
    if (allowPrivateHosts) return true;
    return !isForbiddenAddress(address);
  };

  const validateUrl = (raw: string | URL): URL => {
    let url: URL;
    try {
      url = raw instanceof URL ? raw : new URL(raw);
    } catch {
      throw new EgressError("URL must be absolute", "invalid_url");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new EgressError(
        `URL must use http or https, not "${url.protocol.replace(":", "")}"`,
        "invalid_url",
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new EgressError("URL must not contain credentials", "invalid_url");
    }
    const host = url.hostname;
    if (FORBIDDEN_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
      throw new EgressError("URL points at a link-local or metadata address", "forbidden_host");
    }
    const literal = host.replace(/^\[|\]$/g, "");
    if (isIP(literal) !== 0 && !addressAllowed(literal)) {
      throw new EgressError(
        "URL points at a private, loopback or reserved address",
        "forbidden_address",
      );
    }
    if (allowedHosts.length > 0 && !isHostAllowed(host, allowedHosts)) {
      throw new EgressError(`host "${host}" is not in the egress allowlist`, "host_not_allowed");
    }
    return url;
  };

  const resolvePinned = async (url: URL): Promise<ResolvedAddress> => {
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(literal);
    if (family !== 0) {
      if (!addressAllowed(literal)) {
        throw new EgressError(
          "URL points at a private, loopback or reserved address",
          "forbidden_address",
        );
      }
      return { address: literal, family: family === 6 ? 6 : 4 };
    }
    let addresses: ResolvedAddress[];
    try {
      addresses = await resolver(literal);
    } catch (err) {
      throw new EgressError(
        `could not resolve host: ${err instanceof Error ? err.message : String(err)}`,
        "resolution_failed",
      );
    }
    if (addresses.length === 0) {
      throw new EgressError("host has no A/AAAA records", "resolution_failed");
    }
    if (!addresses.every((entry) => addressAllowed(entry.address))) {
      throw new EgressError(
        `host "${url.hostname}" resolves to a private, loopback or reserved address`,
        "forbidden_address",
      );
    }
    const first = addresses[0];
    if (first === undefined) throw new EgressError("host has no A/AAAA records", "resolution_failed");
    return first;
  };

  const pinnedLookup = (pinned: ResolvedAddress): LookupFunction =>
    ((_hostname: string, opts: unknown, callback: (...args: unknown[]) => void) => {
      if (typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all === true) {
        callback(null, [pinned]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    }) as LookupFunction;

  const requestOnce = (
    url: URL,
    pinned: ResolvedAddress,
    init: GuardedRequestInit,
  ): Promise<{ status: number; headers: Headers; body: NodeJS.ReadableStream }> =>
    new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(
        url,
        {
          method: init.method ?? "GET",
          headers: init.headers ?? {},
          signal: init.signal,
          lookup: pinnedLookup(pinned),
          agent: false,
        },
        (response) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.append(name, value);
            }
          }
          resolve({ status: response.statusCode ?? 0, headers, body: response });
        },
      );
      request.on("error", (err: Error) => reject(err));
      if (init.body !== undefined && init.body !== null) request.end(init.body);
      else request.end();
    });

  const readBounded = async (body: NodeJS.ReadableStream): Promise<Uint8Array> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
      total += chunk.length;
      if (maxBytes > 0 && total > maxBytes) {
        (body as { destroy?: () => void }).destroy?.();
        throw new EgressError(
          `response body exceeds the ${maxBytes} byte limit`,
          "too_large",
        );
      }
      chunks.push(Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  };

  const fetchGuarded = async (
    url: string | URL,
    init: GuardedRequestInit = {},
  ): Promise<GuardedResponse> => {
    let current = validateUrl(url);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const pinned = await resolvePinned(current);
      const controller = new AbortController();
      const timeout =
        timeoutMs > 0 ? setTimeout(() => controller.abort(new EgressError("egress timeout", "timeout")), timeoutMs) : null;
      const outerSignal = init.signal;
      const onOuterAbort = () => controller.abort(outerSignal?.reason);
      outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
      let response: { status: number; headers: Headers; body: NodeJS.ReadableStream };
      try {
        response = await requestOnce(current, pinned, { ...init, signal: controller.signal });
      } catch (err) {
        if (timeout !== null) clearTimeout(timeout);
        outerSignal?.removeEventListener("abort", onOuterAbort);
        if (err instanceof EgressError) throw err;
        if (outerSignal?.aborted) {
          throw new EgressError("egress request aborted", "network");
        }
        if (controller.signal.aborted) {
          throw new EgressError(`egress request timed out after ${timeoutMs}ms`, "timeout");
        }
        throw new EgressError(
          `egress request failed: ${err instanceof Error ? err.message : String(err)}`,
          "network",
        );
      }
      if (timeout !== null) clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", onOuterAbort);

      if (response.status >= 300 && response.status < 400) {
        (response.body as { resume?: () => void }).resume?.();
        (response.body as { destroy?: () => void }).destroy?.();
        const location = response.headers.get("location");
        if (location === null) {
          throw new EgressError("redirect without Location header", "invalid_url");
        }
        if (hop === maxRedirects) {
          throw new EgressError("redirect limit exceeded", "redirect_limit");
        }
        current = validateUrl(new URL(location, current));
        continue;
      }

      const bytes = await readBounded(response.body);
      const outHeaders = new Headers(response.headers);
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: outHeaders,
        url: current.toString(),
        async text() {
          return new TextDecoder().decode(bytes);
        },
        async json() {
          return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        },
        async arrayBuffer() {
          const copy = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(copy).set(bytes);
          return copy;
        },
      };
    }
    throw new EgressError("redirect limit exceeded", "redirect_limit");
  };

  return { fetch: fetchGuarded, validateUrl, resolvePinned };
}
