// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LLM provider transport: one connect-retry per provider request.
 *
 * Every tool-loop step of the AI SDK is a separate `fetch` call. When that
 * call rejects before any response header arrived (stale keep-alive socket,
 * reset before the first byte) the step has produced no output of its own,
 * so re-sending the identical request on a fresh connection is safe — even
 * when earlier steps of the same attempt already streamed text. A step that
 * fails after its response started (mid-stream abort) never reaches this
 * wrapper as a reject and keeps today's "no retry after partial output" rule.
 *
 * Diagnostics need the node context, which the fetch layer does not know; the
 * candidate loop provides it through {@link runInLlmTransportScope}
 * (AsyncLocalStorage). Without a scope the retry still happens, untraced.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { preResponseConnectErrorCode } from "./provider-circuit-breaker.js";

/** Pause before the single connect-retry. */
export const LLM_CONNECT_RETRY_DELAY_MS = 75;

export interface ConnectRetryEvent {
  provider: string;
  model: string;
  /** 1-based number of the provider request within the scope (≈ step). */
  requestIndex: number;
  errorCode: string;
  retryDelayMs: number;
  keepAlive: boolean;
}

export interface ConnectRetryFailedEvent {
  provider: string;
  model: string;
  requestIndex: number;
  errorCode: string;
  /** Pre-response connect code of the retry's error, when it has one. */
  retryErrorCode: string | undefined;
}

export interface LlmTransportScope {
  onConnectRetry?(event: ConnectRetryEvent): void;
  onConnectRetryFailed?(event: ConnectRetryFailedEvent): void;
  /** Provider requests issued in this scope so far; incremented per call. */
  requestCount: number;
}

const transportScope = new AsyncLocalStorage<LlmTransportScope>();

/** Run `fn` (and every provider request it triggers) inside `scope`. */
export function runInLlmTransportScope<T>(scope: LlmTransportScope, fn: () => T): T {
  return transportScope.run(scope, fn);
}

/**
 * Copies `tools` so every `execute` runs outside any transport scope. Tool
 * executions are invoked from within the attempt's scope, and some issue
 * their own LLM requests (harness planner/delegate/extraction, image
 * inspection). Without isolation those nested requests would bump the outer
 * `requestCount` and report their connect-retries on the outer node. They
 * still get their single retry, just untraced.
 */
export function isolateToolsFromLlmTransportScope<T extends Record<string, object>>(
  tools: T,
): T {
  const isolated: Record<string, object> = {};
  for (const [key, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: unknown }).execute;
    isolated[key] =
      typeof execute === "function"
        ? {
            ...tool,
            execute: (...args: unknown[]) =>
              transportScope.exit(() => (execute as (...a: unknown[]) => unknown).apply(tool, args)),
          }
        : tool;
  }
  return isolated as T;
}

export interface LlmTransportFetchOptions {
  /** Transport for the first try (keep-alive or not, per configuration). */
  primary: typeof fetch;
  /** Transport for the retry; must not reuse pooled sockets. */
  fresh: typeof fetch;
  provider: string;
  model: string;
  keepAlive: boolean;
  delayMs?: number;
}

/** Bodies the retry can re-send unchanged. Streams cannot be replayed. */
function isReplayableBody(body: RequestInit["body"] | undefined): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams
  );
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Diagnostics must never break the request. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignored
  }
}

/**
 * Provider `fetch` that retries exactly once, on `fresh`, when `primary`
 * rejects with a pre-response connection failure. Everything else — HTTP
 * error responses, aborts, timeouts, DNS/policy failures, errors while
 * reading an already-started body — passes through unchanged.
 *
 * The retry budget is per `fetch` call. When the AI SDK retries a request
 * itself (`maxRetries`, used on the last candidate), each SDK try goes
 * through this wrapper again, so a persistently unreachable endpoint costs
 * up to `2 × (maxRetries + 1)` connects per step (6 with `maxRetries = 2`).
 */
export function createLlmTransportFetch(options: LlmTransportFetchOptions): typeof fetch {
  const delayMs = options.delayMs ?? LLM_CONNECT_RETRY_DELAY_MS;
  const fn = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const scope = transportScope.getStore();
    let requestIndex = 0;
    if (scope !== undefined) {
      scope.requestCount += 1;
      requestIndex = scope.requestCount;
    }
    try {
      return await options.primary(input, init);
    } catch (error) {
      const errorCode = preResponseConnectErrorCode(error);
      if (
        errorCode === undefined ||
        init?.signal?.aborted === true ||
        input instanceof Request ||
        !isReplayableBody(init?.body)
      ) {
        throw error;
      }
      safely(() =>
        scope?.onConnectRetry?.({
          provider: options.provider,
          model: options.model,
          requestIndex,
          errorCode,
          retryDelayMs: delayMs,
          keepAlive: options.keepAlive,
        }),
      );
      await delay(delayMs, init?.signal);
      try {
        return await options.fresh(input, init);
      } catch (retryError) {
        safely(() =>
          scope?.onConnectRetryFailed?.({
            provider: options.provider,
            model: options.model,
            requestIndex,
            errorCode,
            retryErrorCode: preResponseConnectErrorCode(retryError),
          }),
        );
        throw retryError;
      }
    }
  };
  return fn as unknown as typeof fetch;
}
