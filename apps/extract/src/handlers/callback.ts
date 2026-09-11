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
 * DNS rebinding is not addressed here: the hostname is validated and then
 * resolved again by `fetch`. Closing that would require resolving to an address,
 * checking it, and connecting to that address, which Node's fetch does not
 * expose. The allowlist is the control that actually holds, which is why the gate
 * pushes towards it.
 */

import type { Logger } from "pino";
import { validationError } from "../errors.js";
import { injectTraceHeaders } from "../trace-context.js";

export interface CallbackConfig {
  callbackMaxRetries: number;
  callbackTimeoutMs: number;
  /** Empty means "any host"; the production gate flags that. */
  callbackAllowedHosts: string[];
}

/** Addresses that are never a legitimate callback target. */
const FORBIDDEN_HOST_PATTERNS: readonly RegExp[] = [
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

  return url;
}

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

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
        // The callback target is caller-supplied; following a redirect would let
        // it bounce the request somewhere the allowlist never approved.
        redirect: "manual",
      });

      if (response.ok) {
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
