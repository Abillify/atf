// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { createIdentityRateLimiter } from "../../src/server/identity-rate-limit.ts";
import { ServerConfigSchema } from "../../src/config/schema.ts";

function perIdentityCfg(overrides: Record<string, unknown> = {}) {
  return ServerConfigSchema.parse({
    rateLimit: { perIdentity: { enabled: true, windowMs: 60_000, max: 2, ...overrides } },
  }).rateLimit.perIdentity;
}

describe("createIdentityRateLimiter (memory)", () => {
  it("returns undefined when disabled", async () => {
    const cfg = ServerConfigSchema.parse({}).rateLimit.perIdentity;
    const limiter = await createIdentityRateLimiter(cfg);
    expect(limiter).toBeUndefined();
  });

  it("allows calls up to max within the window, then rejects", async () => {
    const limiter = await createIdentityRateLimiter(perIdentityCfg());
    expect(limiter).toBeDefined();
    const a1 = await limiter!.check("alice");
    const a2 = await limiter!.check("alice");
    const a3 = await limiter!.check("alice");
    expect(a1.allowed).toBe(true);
    expect(a2.allowed).toBe(true);
    expect(a3.allowed).toBe(false);
    expect(a3.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks separate buckets per identity key", async () => {
    const limiter = await createIdentityRateLimiter(perIdentityCfg());
    await limiter!.check("alice");
    await limiter!.check("alice");
    const bobFirst = await limiter!.check("bob");
    expect(bobFirst.allowed).toBe(true);
  });

  it("resets the bucket once the window elapses", async () => {
    const limiter = await createIdentityRateLimiter(perIdentityCfg({ windowMs: 20 }));
    await limiter!.check("alice");
    await limiter!.check("alice");
    const blocked = await limiter!.check("alice");
    expect(blocked.allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    const afterReset = await limiter!.check("alice");
    expect(afterReset.allowed).toBe(true);
  });
});
