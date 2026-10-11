// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Rate-limit middleware contract (Req 11.1/11.2): the shared HTTP layer the
 * ATF services used to hand-roll — disable switch, per-client budget,
 * Retry-After on 429, X-Forwarded-For handling only when trusted, and a
 * customisable rejection body.
 */

import { describe, expect, test } from "bun:test";
import { createRateLimitMiddleware } from "../src/index.js";
import type { RateLimitRequest, RateLimitResponse } from "../src/index.js";

function fakeReq(opts: {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}): RateLimitRequest {
  return {
    socket: opts.ip !== undefined ? { remoteAddress: opts.ip } : undefined,
    headers: opts.headers ?? {},
  };
}

function fakeRes(): RateLimitResponse & {
  statusCode: number | undefined;
  body: unknown;
  headers: Record<string, string | number>;
} {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    headers: {} as Record<string, string | number>,
    setHeader(name: string, value: string | number) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return {
        json: (body: unknown) => {
          res.body = body;
        },
      };
    },
  };
  return res;
}

function run(mw: (r: RateLimitRequest, s: RateLimitResponse, n: () => void) => void, req: RateLimitRequest) {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => {
    passed = true;
  });
  return { res, passed };
}

describe("createRateLimitMiddleware", () => {
  test("max: 0 disables limiting entirely", () => {
    const { middleware } = createRateLimitMiddleware({ max: 0, windowMs: 1_000 });
    for (let i = 0; i < 50; i += 1) {
      const { res, passed } = run(middleware, fakeReq({ ip: "1.2.3.4" }));
      expect(passed).toBe(true);
      expect(res.statusCode).toBeUndefined();
    }
  });

  test("allows the burst, then 429s with Retry-After", () => {
    const { middleware } = createRateLimitMiddleware({ max: 3, windowMs: 60_000 });
    const req = fakeReq({ ip: "10.0.0.1" });
    for (let i = 0; i < 3; i += 1) {
      expect(run(middleware, req).passed).toBe(true);
    }
    const { res, passed } = run(middleware, req);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: "Too Many Requests" });
    const retryAfter = Number(res.headers["Retry-After"]);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  test("budgets are per client address", () => {
    const { middleware } = createRateLimitMiddleware({ max: 1, windowMs: 60_000 });
    expect(run(middleware, fakeReq({ ip: "10.0.0.1" })).passed).toBe(true);
    expect(run(middleware, fakeReq({ ip: "10.0.0.2" })).passed).toBe(true);
    expect(run(middleware, fakeReq({ ip: "10.0.0.1" })).passed).toBe(false);
  });

  test("without trustProxy, X-Forwarded-For is ignored", () => {
    const { middleware } = createRateLimitMiddleware({ max: 1, windowMs: 60_000 });
    expect(run(middleware, fakeReq({ ip: "10.0.0.1" })).passed).toBe(true);
    // Different forwarded client, same socket — still limited on the socket.
    const { passed } = run(
      middleware,
      fakeReq({ ip: "10.0.0.1", headers: { "x-forwarded-for": "203.0.113.5" } }),
    );
    expect(passed).toBe(false);
  });

  test("with trustProxy, the leftmost X-Forwarded-For entry keys the budget", () => {
    const { middleware } = createRateLimitMiddleware({
      max: 1,
      windowMs: 60_000,
      trustProxy: true,
    });
    expect(
      run(
        middleware,
        fakeReq({ ip: "10.0.0.1", headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18" } }),
      ).passed,
    ).toBe(true);
    // Same forwarded client behind a different proxy socket → limited.
    expect(
      run(
        middleware,
        fakeReq({ ip: "10.0.0.9", headers: { "x-forwarded-for": "203.0.113.5" } }),
      ).passed,
    ).toBe(false);
    // Different forwarded client → its own budget.
    expect(
      run(middleware, fakeReq({ ip: "10.0.0.1", headers: { "x-forwarded-for": "198.51.100.7" } }))
        .passed,
    ).toBe(true);
  });

  test("trustProxy falls back to the socket address when the header is absent", () => {
    const { middleware } = createRateLimitMiddleware({
      max: 1,
      windowMs: 60_000,
      trustProxy: true,
    });
    expect(run(middleware, fakeReq({ ip: "10.0.0.1" })).passed).toBe(true);
    expect(run(middleware, fakeReq({ ip: "10.0.0.1" })).passed).toBe(false);
  });

  test("custom rejectBody replaces the default 429 payload", () => {
    const { middleware } = createRateLimitMiddleware({
      max: 1,
      windowMs: 60_000,
      rejectBody: { error: "Too Many Requests", code: "RATE_LIMITED", retryable: true },
    });
    run(middleware, fakeReq({ ip: "10.0.0.1" }));
    const { res } = run(middleware, fakeReq({ ip: "10.0.0.1" }));
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED", retryable: true });
  });

  test("missing socket address falls back to a shared 'unknown' key", () => {
    const { middleware } = createRateLimitMiddleware({ max: 1, windowMs: 60_000 });
    expect(run(middleware, fakeReq({})).passed).toBe(true);
    expect(run(middleware, fakeReq({})).passed).toBe(false);
  });

  test("close() is idempotent and leaves the middleware usable", () => {
    const limiter = createRateLimitMiddleware({ max: 1, windowMs: 60_000 });
    limiter.close();
    limiter.close();
    expect(run(limiter.middleware, fakeReq({ ip: "10.0.0.1" })).passed).toBe(true);
  });
});
