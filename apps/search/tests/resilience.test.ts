// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Circuit breaker, retry-with-backoff, per-IP rate limiter and vector utils.
 *
 * The circuit breaker and the rate limiter were both named in the quality
 * assessment as *untested core logic*, which is a bad combination: their whole
 * purpose is to behave correctly during an incident, i.e. exactly when nobody is
 * in a position to debug them. The state machine and the sliding window are
 * therefore pinned explicitly, including the transitions that only happen after
 * a timeout.
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  CIRCUIT_OPEN_CODE,
  createCircuitBreaker,
  retryWithBackoff,
} from "../src/retry.js";
import { createRateLimiter } from "../src/rate-limiter.js";
import {
  blendVectors,
  l2Normalize,
  toBinaryString,
} from "../src/vector-utils.js";

type Res<T = unknown> =
  | { ok: true; result?: T }
  | { ok: false; error: { code: string; message: string } };

const ok = (): Res => ({ ok: true });
const fail = (code = "UPSTREAM"): Res => ({
  ok: false,
  error: { code, message: "boom" },
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker · CLOSED", () => {
  it("starts closed and passes calls through", async () => {
    const cb = createCircuitBreaker({ name: "embedding" });
    expect(cb.state).toBe("CLOSED");
    expect(cb.name).toBe("embedding");
    expect(await cb.call(async () => ok())).toEqual({ ok: true });
  });

  it("counts consecutive failures", async () => {
    const cb = createCircuitBreaker({ name: "e", failureThreshold: 3 });
    await cb.call(async () => fail());
    expect(cb.failures).toBe(1);
    await cb.call(async () => fail());
    expect(cb.failures).toBe(2);
    expect(cb.state).toBe("CLOSED");
  });

  it("resets the counter on success", async () => {
    const cb = createCircuitBreaker({ name: "e", failureThreshold: 3 });
    await cb.call(async () => fail());
    await cb.call(async () => ok());
    expect(cb.failures).toBe(0);
    expect(cb.state).toBe("CLOSED");
  });

  it("trips once the threshold is reached", async () => {
    const cb = createCircuitBreaker({ name: "e", failureThreshold: 3 });
    for (let i = 0; i < 3; i++) await cb.call(async () => fail());
    expect(cb.state).toBe("OPEN");
  });

  it("records a failure for a thrown error and rethrows it", async () => {
    // A throw is not a graceful { ok: false } response, but it is still a
    // downstream failure and must count — otherwise a service that throws never
    // trips the breaker.
    const cb = createCircuitBreaker({ name: "e", failureThreshold: 2 });
    await expect(
      cb.call(async () => {
        throw new Error("socket hang up");
      }),
    ).rejects.toThrow("socket hang up");
    expect(cb.failures).toBe(1);
  });
});

describe("circuit breaker · OPEN", () => {
  it("rejects immediately without running the call", async () => {
    const cb = createCircuitBreaker({ name: "e", failureThreshold: 1 });
    await cb.call(async () => fail());
    expect(cb.state).toBe("OPEN");

    const inner = vi.fn(async () => ok());
    const result = (await cb.call(inner)) as Res;
    expect(inner).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(CIRCUIT_OPEN_CODE);
      expect(result.error.message).toContain('"e"');
    }
  });

  it("moves to HALF_OPEN after the recovery window", async () => {
    const cb = createCircuitBreaker({
      name: "e",
      failureThreshold: 1,
      recoveryMs: 10,
    });
    await cb.call(async () => fail());
    expect(cb.state).toBe("OPEN");
    await new Promise((r) => setTimeout(r, 20));
    // The transition is lazy — reading state does not trigger it; a call does.
    const probe = vi.fn(async () => ok());
    await cb.call(probe);
    expect(probe).toHaveBeenCalledOnce();
    expect(cb.state).toBe("CLOSED");
  });
});

describe("circuit breaker · HALF_OPEN", () => {
  async function halfOpen() {
    const cb = createCircuitBreaker({
      name: "e",
      failureThreshold: 1,
      recoveryMs: 5,
    });
    await cb.call(async () => fail());
    await new Promise((r) => setTimeout(r, 15));
    return cb;
  }

  it("closes the circuit when the probe succeeds", async () => {
    const cb = await halfOpen();
    await cb.call(async () => ok());
    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(0);
  });

  it("reopens immediately when the probe fails, regardless of threshold", async () => {
    const cb = await halfOpen();
    await cb.call(async () => fail());
    expect(cb.state).toBe("OPEN");
  });

  it("admits only ONE concurrent probe", async () => {
    // Letting every waiting caller probe a dead service would defeat the
    // purpose of opening the circuit in the first place.
    const cb = await halfOpen();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = cb.call(async () => {
      await gate;
      return ok();
    });
    const second = (await cb.call(async () => ok())) as Res;
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe(CIRCUIT_OPEN_CODE);

    release();
    await first;
    expect(cb.state).toBe("CLOSED");
  });
});

describe("circuit breaker · rolling failure window", () => {
  /**
   * Documented as a rolling deadline rather than a strict sliding window: a
   * quiet period longer than `windowMs` wipes the counter. Worth pinning because
   * the two behaviours are easy to confuse and produce different trip points.
   */
  it("resets the counter after a quiet period longer than the window", async () => {
    const cb = createCircuitBreaker({
      name: "e",
      failureThreshold: 3,
      windowMs: 10,
    });
    await cb.call(async () => fail());
    await cb.call(async () => fail());
    expect(cb.failures).toBe(2);
    await new Promise((r) => setTimeout(r, 25));
    await cb.call(async () => fail());
    expect(cb.failures).toBe(1);
    expect(cb.state).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

describe("retryWithBackoff", () => {
  it("returns the first successful result without retrying", async () => {
    // Note the predicate: `shouldRetry` is evaluated on EVERY result, success
    // included, so a caller passing `() => true` would re-run a successful call.
    // The realistic predicate is "retry only failures".
    const fn = vi.fn(async () => ok());
    expect(await retryWithBackoff(fn, (r) => !r.ok, 3, 1)).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries a retryable failure up to maxAttempts", async () => {
    const fn = vi.fn(async () => fail());
    await retryWithBackoff(fn, () => true, 3, 1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when shouldRetry says no", async () => {
    const fn = vi.fn(async () => fail("BAD_REQUEST"));
    await retryWithBackoff(fn, () => false, 3, 1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("stops as soon as a retry succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => (++calls < 2 ? fail() : ok()));
    expect(await retryWithBackoff(fn, (r) => !r.ok, 5, 1)).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  /**
   * Retrying into an open circuit is pure waste: the breaker rejects without a
   * network call, so N attempts just burn N sleeps before returning the same
   * answer.
   */
  it("never retries a CIRCUIT_OPEN response", async () => {
    const cb = createCircuitBreaker({ name: "e", failureThreshold: 1 });
    await cb.call(async () => fail());
    const fn = vi.fn(async () => ok());
    const result = (await retryWithBackoff(fn, () => true, 5, 1, cb)) as Res;
    expect(fn).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error.code).toBe(CIRCUIT_OPEN_CODE);
  });

  it("routes attempts through the breaker so failures are recorded", async () => {
    const cb = createCircuitBreaker({ name: "e", failureThreshold: 10 });
    await retryWithBackoff(async () => fail(), () => true, 3, 1, cb);
    expect(cb.failures).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe("rate limiter", () => {
  function mkReq(ip: string, forwardedFor?: string): Request {
    return {
      socket: { remoteAddress: ip },
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    } as unknown as Request;
  }

  function mkRes() {
    const res = {
      _status: undefined as number | undefined,
      _headers: {} as Record<string, string>,
      _body: undefined as unknown,
      setHeader(k: string, v: string) {
        res._headers[k] = v;
      },
      status(code: number) {
        res._status = code;
        return res;
      },
      json(body: unknown) {
        res._body = body;
        return res;
      },
    };
    return res as unknown as Response & {
      _status?: number;
      _headers: Record<string, string>;
      _body?: unknown;
    };
  }

  function hit(
    limiter: ReturnType<typeof createRateLimiter>,
    ip: string,
    forwardedFor?: string,
  ) {
    const res = mkRes();
    const next = vi.fn();
    limiter.middleware(mkReq(ip, forwardedFor), res, next);
    return { res, passed: next.mock.calls.length > 0 };
  }

  it("passes everything through when max is 0", () => {
    const limiter = createRateLimiter({ max: 0, windowMs: 1000 });
    for (let i = 0; i < 50; i++) {
      expect(hit(limiter, "1.2.3.4").passed).toBe(true);
    }
    limiter.close();
  });

  it("allows up to the limit and refuses the next request", () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 10_000 });
    expect(hit(limiter, "1.2.3.4").passed).toBe(true);
    expect(hit(limiter, "1.2.3.4").passed).toBe(true);
    expect(hit(limiter, "1.2.3.4").passed).toBe(true);
    const fourth = hit(limiter, "1.2.3.4");
    expect(fourth.passed).toBe(false);
    expect(fourth.res._status).toBe(429);
    expect(fourth.res._headers["Retry-After"]).toBeDefined();
    limiter.close();
  });

  it("counts each IP separately", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10_000 });
    expect(hit(limiter, "1.1.1.1").passed).toBe(true);
    expect(hit(limiter, "2.2.2.2").passed).toBe(true);
    expect(hit(limiter, "1.1.1.1").passed).toBe(false);
    limiter.close();
  });

  it("lets requests through again once the window slides", async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 20 });
    expect(hit(limiter, "1.2.3.4").passed).toBe(true);
    expect(hit(limiter, "1.2.3.4").passed).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(hit(limiter, "1.2.3.4").passed).toBe(true);
    limiter.close();
  });

  /**
   * The spoofing guard: with trustProxy off, an attacker-supplied
   * X-Forwarded-For must not be able to mint a fresh bucket per request.
   */
  it("ignores X-Forwarded-For unless trustProxy is set", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10_000 });
    expect(hit(limiter, "1.2.3.4", "9.9.9.9").passed).toBe(true);
    expect(hit(limiter, "1.2.3.4", "8.8.8.8").passed).toBe(false);
    limiter.close();
  });

  it("uses the leftmost X-Forwarded-For entry when trustProxy is set", () => {
    const limiter = createRateLimiter({
      max: 1,
      windowMs: 10_000,
      trustProxy: true,
    });
    expect(hit(limiter, "10.0.0.1", "9.9.9.9, 10.0.0.1").passed).toBe(true);
    // Same original client → same bucket, despite a different proxy hop.
    expect(hit(limiter, "10.0.0.2", "9.9.9.9, 10.0.0.2").passed).toBe(false);
    // Different original client → own bucket.
    expect(hit(limiter, "10.0.0.1", "7.7.7.7").passed).toBe(true);
    limiter.close();
  });

  it("falls back to a sentinel key when no address is available", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10_000 });
    const res = mkRes();
    const next = vi.fn();
    limiter.middleware({ socket: {}, headers: {} } as unknown as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    limiter.close();
  });

  it("bounds the key store so many unique IPs cannot exhaust memory", () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 10_000, maxKeys: 10 });
    for (let i = 0; i < 100; i++) {
      expect(hit(limiter, `10.0.0.${i}`).passed).toBe(true);
    }
    limiter.close();
  });

  it("close() is idempotent", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10 });
    limiter.close();
    expect(() => limiter.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Vector utils
// ---------------------------------------------------------------------------

describe("toBinaryString", () => {
  it("maps sign to bits, treating zero as positive", () => {
    expect(toBinaryString([0.5, -0.5, 0, -0.001])).toBe("1010");
  });

  it("returns an empty string for an empty vector", () => {
    expect(toBinaryString([])).toBe("");
  });

  it("produces one bit per dimension", () => {
    expect(toBinaryString(new Array(768).fill(0.1))).toHaveLength(768);
  });
});

describe("l2Normalize", () => {
  it("scales the vector to unit length", () => {
    const norm = l2Normalize([3, 4]);
    expect(norm[0]).toBeCloseTo(0.6);
    expect(norm[1]).toBeCloseTo(0.8);
  });

  it("leaves a zero vector unchanged instead of dividing by zero", () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("mutates and returns the same array (documented in-place behaviour)", () => {
    const v = [3, 4];
    expect(l2Normalize(v)).toBe(v);
  });
});

describe("blendVectors", () => {
  it("returns a normalised blend", () => {
    const blended = blendVectors([1, 0], [0, 1], 0.5);
    expect(blended[0]).toBeCloseTo(Math.SQRT1_2);
    expect(blended[1]).toBeCloseTo(Math.SQRT1_2);
  });

  it("alpha 1 yields the first vector, alpha 0 the second", () => {
    expect(blendVectors([3, 4], [0, 1], 1)[0]).toBeCloseTo(0.6);
    expect(blendVectors([3, 4], [0, 1], 0)).toEqual([0, 1]);
  });

  it("does not mutate its inputs", () => {
    const a = [1, 0];
    const b = [0, 1];
    blendVectors(a, b, 0.5);
    expect(a).toEqual([1, 0]);
    expect(b).toEqual([0, 1]);
  });
});
