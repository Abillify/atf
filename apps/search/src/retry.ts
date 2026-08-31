// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * retry.ts
 *
 * Exponential-backoff retry and Circuit Breaker for external service calls.
 *
 * Circuit Breaker
 * ───────────────
 * Prevents cascading failures when a downstream service (embedding server,
 * reranker, …) becomes unresponsive.  Without a circuit breaker, every
 * in-flight request blocks for up to `fetchTimeoutMs` × retries before
 * returning an error, exhausting the PostgreSQL connection pool while the
 * queue of hanging requests grows.
 *
 * States
 * ──────
 *   CLOSED     Normal operation.  Failures are counted.  When
 *              `failureThreshold` consecutive failures occur, the circuit
 *              opens.  The counter resets to zero only when a full `windowMs`
 *              has elapsed since the *last* failure — this is a rolling
 *              deadline (not a fixed sliding window).  Concretely: 4 rapid
 *              failures followed by a long pause and then 1 more failure will
 *              trip a threshold-5 circuit, because the pause resets nothing
 *              until the window expires.
 *
 *   OPEN       All calls are rejected immediately with a CIRCUIT_OPEN error
 *              (no network attempt).  After `recoveryMs` the circuit moves
 *              to HALF_OPEN to probe whether the service has recovered.
 *
 *   HALF_OPEN  One probe call is allowed through.
 *                Success → CLOSED (failure count reset).
 *                Failure → OPEN again (recovery timer restarts).
 *
 * Usage
 * ─────
 *   // Create once per downstream service (e.g. in createApp / main):
 *   const embedBreaker = createCircuitBreaker({ name: "embedding" });
 *
 *   // Pass to retryWithBackoff or call wrap() directly:
 *   const result = await retryWithBackoff(fn, isRetryable, 3, 100, embedBreaker);
 */

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  /** Human-readable name used in log/error messages. */
  name: string;
  /**
   * Number of consecutive failures that trip the circuit.
   * Default: 5.
   */
  failureThreshold?: number;
  /**
   * Inactivity window in ms after which the failure counter resets.
   * If no failure occurs for `windowMs` after the last failure, the counter
   * is reset to zero on the next failure.  This is a rolling deadline, not a
   * strict sliding window: rapid bursts of failures accumulate normally, but
   * a quiet period of at least `windowMs` wipes the slate clean.
   * Default: 60 000 (1 minute).
   */
  windowMs?: number;
  /**
   * Time in ms the circuit stays OPEN before probing again.
   * Default: 30 000 (30 seconds).
   */
  recoveryMs?: number;
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreaker {
  /**
   * Human-readable name of this circuit breaker (as passed to createCircuitBreaker).
   * Exposed so the postgres client can build CircuitBreakerStatus objects.
   */
  readonly name: string;
  /**
   * Wrap a single async call with circuit-breaker logic.
   * - CLOSED / HALF_OPEN: runs the call; records success or failure.
   * - OPEN:               rejects immediately without running the call.
   *
   * Returns the result of the call, or—when the circuit is open—a result
   * that satisfies `{ ok: false, error: { code: "CIRCUIT_OPEN", … } }`.
   * The caller must be prepared to handle this response shape.
   */
  call<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T>;

  /** Current circuit state — useful for health checks / metrics. */
  readonly state: CircuitState;

  /** Number of consecutive failures recorded in the current window. */
  readonly failures: number;
}

/** Sentinel error code injected when the circuit is open. */
export const CIRCUIT_OPEN_CODE = "CIRCUIT_OPEN" as const;

export function createCircuitBreaker(
  options: CircuitBreakerOptions,
): CircuitBreaker {
  const {
    name,
    failureThreshold = 5,
    windowMs = 60_000,
    recoveryMs = 30_000,
  } = options;
  let state: CircuitState = "CLOSED";
  let failureCount = 0;
  let lastFailureTime = 0;
  let openedAt = 0;

  // When true, a HALF_OPEN probe is already in-flight. Additional calls are
  // rejected (treated as OPEN) to avoid multiple concurrent probes.
  let probeInFlight = false;

  function recordSuccess(): void {
    state = "CLOSED";
    failureCount = 0;
    lastFailureTime = 0;
    probeInFlight = false;
  }

  function recordFailure(): void {
    const now = Date.now();

    // Reset counter if the last failure is outside the tracking window.
    if (now - lastFailureTime > windowMs) {
      failureCount = 0;
    }

    failureCount++;
    lastFailureTime = now;

    if (state === "HALF_OPEN" || failureCount >= failureThreshold) {
      state = "OPEN";
      openedAt = now;
      probeInFlight = false;
    }
  }

  function tryTransitionToHalfOpen(): CircuitState {
    if (state === "OPEN" && Date.now() - openedAt >= recoveryMs) {
      state = "HALF_OPEN";
    }
    return state;
  }

  /**
   * Build a CIRCUIT_OPEN response that fits the standard `{ ok: false, error: … }` shape.
   * TypeScript cannot statically verify the cast, but every client in this codebase
   * uses that discriminated-union response type.
   */
  function openResponse<T>(): T {
    return {
      ok: false,
      error: {
        code: CIRCUIT_OPEN_CODE,
        message: `Circuit breaker OPEN for "${name}"; requests are paused until recovery`,
      },
    } as unknown as T;
  }

  return {
    get name(): string {
      return name;
    },

    get state(): CircuitState {
      return state;
    },

    get failures(): number {
      return failureCount;
    },

    async call<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T> {
      const current = tryTransitionToHalfOpen();

      if (current === "OPEN") {
        return openResponse<T>();
      }

      if (current === "HALF_OPEN") {
        if (probeInFlight) {
          // Another probe is already running — reject this call.
          return openResponse<T>();
        }
        probeInFlight = true;
      }

      let result: T;
      try {
        result = await fn();
      } catch (err) {
        // Unexpected throw (not a graceful { ok: false } response).
        recordFailure();
        throw err;
      }

      if (result.ok) {
        recordSuccess();
      } else {
        recordFailure();
      }

      return result;
    },
  };
}

// ─── Retry with backoff ───────────────────────────────────────────────────────

/**
 * Retry a function with exponential backoff and full jitter.
 * Calls fn() up to maxAttempts times. Between attempts waits a random duration
 * in [0, baseDelayMs * 2^attempt) (full jitter) to avoid thundering-herd when
 * multiple callers retry simultaneously.
 * Only retries when shouldRetry(result) is true.
 *
 * When a circuitBreaker is provided, every attempt is wrapped in
 * circuitBreaker.call().  A CIRCUIT_OPEN response is never retried —
 * it is returned immediately regardless of shouldRetry.
 */
export async function retryWithBackoff<T extends { ok: boolean }>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  maxAttempts = 3,
  baseDelayMs = 100,
  circuitBreaker?: CircuitBreaker,
): Promise<T> {
  const execute = circuitBreaker ? () => circuitBreaker.call(fn) : fn;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await execute();

    // Never retry a circuit-open rejection.
    if (
      !result.ok &&
      (result as unknown as { ok: false; error: { code: string } }).error
        .code === CIRCUIT_OPEN_CODE
    ) {
      return result;
    }

    if (!shouldRetry(result) || attempt === maxAttempts - 1) return result;

    const cap = baseDelayMs * 2 ** attempt;
    await new Promise<void>((r) => setTimeout(r, Math.random() * cap));
  }
  // Unreachable but required by TypeScript.
  return execute();
}
