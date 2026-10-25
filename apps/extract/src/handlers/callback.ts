// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * callback.ts
 *
 * Delivering the result of an asynchronous conversion to a caller-supplied URL.
 *
 * ## This is a server-side request forgery primitive, so it is gated
 *
 * `X-Callback-URL` makes the service issue an HTTP request to an address the
 * *caller* chose. Unconstrained, that turns an authenticated conversion request
 * into a way to reach anything the container can reach: the cloud metadata
 * endpoint at `169.254.169.254`, an unauthenticated admin port on a neighbouring
 * pod, a database's HTTP interface. The response body is a conversion result the
 * attacker already has, so this is a blind SSRF — which is still enough to
 * enumerate internal services by timing and status.
 *
 * Two controls, chosen so the common case stays usable:
 *
 *   1. **Link-local and metadata addresses are refused unconditionally.** No
 *      legitimate callback lives at `169.254.0.0/16`; the only thing there is
 *      cloud instance credentials.
 *   2. **`CALLBACK_ALLOWED_HOSTS`, when set, is an allowlist.** Left unset,
 *      callbacks to other hosts are permitted — because an internal orchestrator
 *      on an arbitrary cluster DNS name is the normal case and a mandatory
 *      allowlist would make the feature unusable out of the box. The production
 *      readiness gate flags the unset allowlist, so the trade-off is a decision
 *      an operator makes rather than one they inherit silently.
 *
 * On top of those literal checks, delivery resolves the host itself and applies
 * the address classification shared with the `source_url` pull (source-url.ts):
 *
 *   3. **Without an allowlist, only public addresses are reachable.** Every
 *      resolved A/AAAA address must be public unicast (`isForbiddenAddress`):
 *      private, loopback, CGNAT, ULA, multicast and the IPv4-embedded forms of
 *      those are refused — the literal form already at request time, a DNS name
 *      at delivery time. An internal orchestrator must therefore be listed in
 *      `CALLBACK_ALLOWED_HOSTS`.
 *   4. **An allowlisted host may resolve to private space** (the operator named
 *      it), but never to a link-local / metadata address
 *      (`isLinkLocalOrMetadataAddress`).
 *   5. **The connection is pinned to the validated address** through the socket
 *      `lookup` hook (`pinnedLookup`), so a second DNS answer (DNS rebinding)
 *      cannot redirect the actual TCP connection. TLS still verifies against
 *      the host name. Each retry resolves and validates again.
 */

import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Logger } from "pino";
import { validationError } from "../errors.js";
import { injectTraceHeaders } from "../trace-context.js";
// Circular with source-url.ts (which imports FORBIDDEN_HOST_PATTERNS and
// isHostAllowed from here). Safe: both modules only use each other's bindings
// inside function bodies, never during module evaluation.
import {
  defaultHostResolver,
  isForbiddenAddress,
  isLinkLocalOrMetadataAddress,
  pinnedLookup,
  type HostResolver,
  type ResolvedAddress,
} from "./source-url.js";

export interface CallbackConfig {
  callbackMaxRetries: number;
  callbackTimeoutMs: number;
  /** Empty means "any host"; the production gate flags that. */
  callbackAllowedHosts: string[];
}

/**
 * Addresses that are never a legitimate target for a caller-supplied URL.
 *
 * Exported so the `source_url` pull refuses exactly the same set:
 * the SSRF surface of "the server fetches an address the caller chose" is the
 * same whether the address is a callback or a source, so the control must be
 * the same too.
 */
export const FORBIDDEN_HOST_PATTERNS: readonly RegExp[] = [
  // IPv4 link-local, which is where cloud instance metadata lives.
  /^169\.254\./,
  // The IPv6 equivalent, and IPv4-mapped forms of the same.
  /^\[?fe80:/i,
  /^\[?::ffff:169\.254\./i,
  // Alibaba/Oracle metadata alias.
  /^metadata\.google\.internal$/i,
];

/**
 * Validate and normalise a caller-supplied callback URL.
 *
 * Throws a client error rather than silently declining, because a caller whose
 * callback was rejected needs to know that no result is coming.
 */
export function resolveCallbackUrl(raw: string, config: CallbackConfig): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validationError("X-Callback-URL must be an absolute http(s) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw validationError(
      `X-Callback-URL must use http or https, not "${url.protocol.replace(":", "")}"`,
    );
  }
  // Credentials in a URL would be logged and are never the right way to
  // authenticate a callback.
  if (url.username !== "" || url.password !== "") {
    throw validationError("X-Callback-URL must not contain credentials");
  }

  const host = url.hostname;
  if (FORBIDDEN_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw validationError("X-Callback-URL points at a link-local or metadata address");
  }

  if (config.callbackAllowedHosts.length > 0 && !isHostAllowed(host, config.callbackAllowedHosts)) {
    throw validationError(
      `X-Callback-URL host "${host}" is not in CALLBACK_ALLOWED_HOSTS`,
    );
  }

  // An IP literal is judged now, before any work is done, with the same policy
  // delivery applies to resolved addresses (see callbackAddressRefusal).
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0) {
    const refusal = callbackAddressRefusal([literal], config);
    if (refusal !== null) throw validationError(`X-Callback-URL ${refusal}`);
  }

  return url;
}

/**
 * Why a set of resolved addresses may not receive a callback, or null when
 * they may. Every address must pass — a host that answers with one permitted
 * and one refused address is refused, because the connection could otherwise
 * be steered to the refused one.
 *
 * Without an allowlist only public unicast addresses pass. With one (the host
 * was already matched against it), private space is allowed because the
 * operator named the host, but link-local / metadata addresses never are.
 */
export function callbackAddressRefusal(
  addresses: readonly string[],
  config: CallbackConfig,
): string | null {
  if (addresses.some((address) => isLinkLocalOrMetadataAddress(address))) {
    return "points at a link-local or metadata address";
  }
  if (config.callbackAllowedHosts.length === 0 && addresses.some((a) => isForbiddenAddress(a))) {
    return (
      "points at a private, loopback or reserved address; list the host in " +
      "CALLBACK_ALLOWED_HOSTS to permit an internal receiver"
    );
  }
  return null;
}

/** Thrown when the callback host resolves to a refused address (terminal). */
class CallbackAddressRefused extends Error {}

/**
 * Resolve the callback host and return the single validated address the
 * connection is pinned to. DNS failures are retryable (plain Error); a refused
 * address is terminal ({@link CallbackAddressRefused}).
 */
async function resolveCallbackAddress(
  url: URL,
  config: CallbackConfig,
  resolver: HostResolver,
): Promise<ResolvedAddress> {
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(literal);
  const addresses: ResolvedAddress[] =
    literalFamily !== 0
      ? [{ address: literal, family: literalFamily === 6 ? 6 : 4 }]
      : await resolver(literal);
  const first = addresses[0];
  if (first === undefined) throw new Error("callback host has no A/AAAA records");
  const refusal = callbackAddressRefusal(
    addresses.map((entry) => entry.address),
    config,
  );
  if (refusal !== null) throw new CallbackAddressRefused(`callback host ${refusal}`);
  return first;
}

/** The part of a callback response delivery needs. */
export interface CallbackResponse {
  status: number;
}

/**
 * Issues one POST to `url`, connecting to `pinned` instead of re-resolving the
 * host. Injectable for tests; the default is {@link pinnedPostRequest}.
 */
export type CallbackRequester = (
  url: URL,
  pinned: ResolvedAddress,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<CallbackResponse>;

/**
 * POST over node:http(s) with a `lookup` hook that only ever returns the
 * validated address. Redirects are never followed (node:http does not follow
 * them), so a 3xx is reported as a refusal like any other non-5xx status.
 */
export const pinnedPostRequest: CallbackRequester = (url, pinned, init) =>
  new Promise<CallbackResponse>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "POST",
        headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
        signal: init.signal,
        lookup: pinnedLookup(pinned),
        // A fresh socket per attempt: a pooled keep-alive socket was connected
        // under an earlier validation and must not be reused for this one.
        agent: false,
      },
      (response) => {
        // The receiver's body is irrelevant; drain it so the socket closes.
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });

/** Exact match, or a `.example.com` suffix entry matching any subdomain. */
export function isHostAllowed(host: string, allowed: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowed.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate === "") return false;
    if (candidate.startsWith(".")) return lower.endsWith(candidate);
    return lower === candidate;
  });
}

/** Sleep with jitter so concurrent retries do not synchronise. */
function backoffDelay(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export interface DeliverCallbackArgs {
  url: URL;
  jobId: string;
  body: unknown;
  config: CallbackConfig;
  logger: Logger;
  /** Injectable for tests; defaults to DNS resolution via node:dns. */
  resolver?: HostResolver;
  /** Injectable for tests; defaults to {@link pinnedPostRequest}. */
  requestImpl?: CallbackRequester;
}

/**
 * POST the result, retrying transient failures.
 *
 * A 4xx is not retried: the receiver understood the request and refused it, so
 * repeating it wastes the retry budget on an outcome that will not change. A 5xx
 * or a network failure is retried, because those are the receiver restarting.
 *
 * Failure here is terminal and only logged. The conversion succeeded, the caller
 * has already had its 202, and there is no channel left to report on — which is
 * why the job id is in every log line: it is the only way to correlate a missing
 * callback with the work that produced it.
 */
export async function deliverCallback(args: DeliverCallbackArgs): Promise<void> {
  const { url, jobId, body, config, logger } = args;
  const resolver = args.resolver ?? defaultHostResolver;
  const doRequest = args.requestImpl ?? pinnedPostRequest;
  const payload = JSON.stringify(body);

  for (let attempt = 0; attempt <= config.callbackMaxRetries; attempt++) {
    const controller = new AbortController();
    const timeout =
      config.callbackTimeoutMs > 0
        ? setTimeout(() => controller.abort(), config.callbackTimeoutMs)
        : null;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-job-id": jobId,
      };
      injectTraceHeaders(headers);

      // Resolve + validate on every attempt and pin the connection to the
      // validated address, so neither a DNS change between attempts nor a
      // rebinding answer during connect can reach a refused address. The
      // caller-supplied target is never redirected (node:http does not follow).
      const pinned = await resolveCallbackAddress(url, config, resolver);
      const response = await doRequest(url, pinned, {
        headers,
        body: payload,
        signal: controller.signal,
      });

      if (response.status >= 200 && response.status < 300) {
        logger.info({ jobId, status: response.status }, "Conversion callback delivered");
        return;
      }
      if (response.status < 500) {
        logger.error(
          { jobId, status: response.status, host: url.hostname },
          "Conversion callback was refused; not retrying",
        );
        return;
      }
      logger.warn(
        { jobId, status: response.status, attempt: attempt + 1 },
        "Conversion callback failed; retrying",
      );
    } catch (error) {
      if (error instanceof CallbackAddressRefused) {
        // Terminal: the host resolves to an address this policy never
        // reaches; retrying cannot make it acceptable.
        logger.error(
          { jobId, host: url.hostname, err: error.message },
          "Conversion callback refused by the address policy; not retrying",
        );
        return;
      }
      logger.warn(
        { jobId, attempt: attempt + 1, err: error instanceof Error ? error.message : String(error) },
        "Conversion callback could not be delivered; retrying",
      );
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }

    if (attempt < config.callbackMaxRetries) {
      await new Promise<void>((resolve) => setTimeout(resolve, backoffDelay(attempt)));
    }
  }

  logger.error(
    { jobId, host: url.hostname, attempts: config.callbackMaxRetries + 1 },
    "Conversion callback exhausted every attempt; the result was discarded",
  );
}
