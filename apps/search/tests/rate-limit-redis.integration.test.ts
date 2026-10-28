// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * The shared GCRA rate-limit backend (Security_Kit, used by Search and
 * Extract when RATE_LIMIT_REDIS_URL is set) against a real Redis with the
 * real `redis` client. Runs when TEST_REDIS_URL points at a disposable Redis;
 * skipped otherwise. Keys use a per-run prefix, nothing else is touched.
 */
import { randomUUID } from "node:crypto";
import { createLazyRedisRateLimitBackend } from "@atf/security-kit";
import { afterAll, describe, expect, it } from "vitest";

const REDIS_URL = process.env.TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("GCRA rate limit on a real Redis", () => {
  const errors: unknown[] = [];
  const keyPrefix = `t:rl:${randomUUID()}`;
  const make = () =>
    createLazyRedisRateLimitBackend({
      redisUrl: REDIS_URL as string,
      keyPrefix,
      failMode: "closed",
      onError: (err) => errors.push(err),
    });
  const a = make();
  const b = make();

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it("shares one budget between replicas and refuses the call after the burst", async () => {
    const config = { limit: 3, burstMs: 60_000 };
    const results = [
      await a.take("client-1", config, 1),
      await b.take("client-1", config, 1),
      await a.take("client-1", config, 1),
    ];
    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0]);

    const refused = await b.take("client-1", config, 1);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(20_000);

    // Another key has its own budget.
    expect((await a.take("client-2", config, 1)).allowed).toBe(true);
    // A refusal must come from the limit, never from a failing Redis call.
    expect(errors).toEqual([]);
  });

  it("charges a weighted request with its cost", async () => {
    const config = { limit: 4, burstMs: 60_000 };
    const heavy = await a.take("client-3", config, 3);
    expect(heavy).toMatchObject({ allowed: true, remaining: 1 });
    expect((await b.take("client-3", config, 2)).allowed).toBe(false);
    expect((await b.take("client-3", config, 1)).allowed).toBe(true);
    expect(errors).toEqual([]);
  });
});
