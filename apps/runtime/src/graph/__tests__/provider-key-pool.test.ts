// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the provider API-key pool (`src/graph/provider-key-pool.ts`).
 *
 * A fake clock makes cooldown/recovery deterministic.
 */

import { describe, it, expect } from "bun:test";
import { ProviderKeyPool, maskKey, type Clock } from "../provider-key-pool.js";

/** Mutable fake clock. */
function fakeClock(): { clock: Clock; advance: (ms: number) => void } {
  let now = 0;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

/** `pool.health()[provider]`, asserting the provider has an entry. */
function healthFor(pool: ProviderKeyPool, provider: string) {
  const h = pool.health()[provider];
  if (h === undefined) throw new Error(`expected health entries for "${provider}"`);
  return h;
}

describe("maskKey", () => {
  it("redacts all but the last 4 chars", () => {
    expect(maskKey("sk-abcdEFGH1234")).toBe("****1234");
  });
  it("fully redacts very short keys", () => {
    expect(maskKey("ab")).toBe("****");
  });
});

describe("ProviderKeyPool — basics", () => {
  it("is inactive with no keys and returns undefined", () => {
    const pool = new ProviderKeyPool({});
    expect(pool.active).toBe(false);
    expect(pool.acquire("openai")).toBeUndefined();
    expect(pool.sizeFor("openai")).toBe(0);
  });

  it("de-duplicates repeated keys", () => {
    const pool = new ProviderKeyPool({ openai: ["k1", "k1", "k2", ""] });
    expect(pool.sizeFor("openai")).toBe(2);
  });

  it("round-robins among healthy keys", () => {
    const pool = new ProviderKeyPool({ openai: ["k1", "k2", "k3"] });
    expect(pool.acquire("openai")).toBe("k1");
    expect(pool.acquire("openai")).toBe("k2");
    expect(pool.acquire("openai")).toBe("k3");
    expect(pool.acquire("openai")).toBe("k1");
  });
});

describe("ProviderKeyPool — health & quarantine", () => {
  it("skips a failed key until its cooldown expires, then returns it", () => {
    const { clock, advance } = fakeClock();
    const pool = new ProviderKeyPool(
      { openai: ["k1", "k2"] },
      { baseCooldownMs: 1000, clock },
    );

    // k1 fails → quarantined for 1000ms.
    pool.reportFailure("openai", "k1");
    // Next acquisitions skip k1 entirely.
    expect(pool.acquire("openai")).toBe("k2");
    expect(pool.acquire("openai")).toBe("k2");

    // After the cooldown, k1 is healthy again.
    advance(1000);
    const seen = new Set([pool.acquire("openai"), pool.acquire("openai")]);
    expect(seen.has("k1")).toBe(true);
  });

  it("applies exponential backoff on consecutive failures", () => {
    const { clock, advance } = fakeClock();
    const pool = new ProviderKeyPool(
      { openai: ["only"] },
      { baseCooldownMs: 1000, maxCooldownMs: 60_000, clock },
    );

    pool.reportFailure("openai", "only"); // cooldown 1000
    expect(at(healthFor(pool, "openai"), 0).cooldownUntil).toBe(1000);
    expect(at(healthFor(pool, "openai"), 0).healthy).toBe(false);

    advance(1000);
    pool.reportFailure("openai", "only"); // 2nd consecutive → 2000
    expect(at(healthFor(pool, "openai"), 0).cooldownUntil).toBe(1000 + 2000);
    expect(at(healthFor(pool, "openai"), 0).consecutiveFailures).toBe(2);
  });

  it("caps the cooldown at maxCooldownMs", () => {
    const { clock } = fakeClock();
    const pool = new ProviderKeyPool(
      { openai: ["only"] },
      { baseCooldownMs: 1000, maxCooldownMs: 3000, clock },
    );
    for (let i = 0; i < 10; i++) pool.reportFailure("openai", "only");
    expect(at(healthFor(pool, "openai"), 0).cooldownUntil).toBe(3000); // clock stays at 0, capped cooldown
  });

  it("reportSuccess clears the cooldown and resets failure count", () => {
    const { clock } = fakeClock();
    const pool = new ProviderKeyPool(
      { openai: ["k1"] },
      { baseCooldownMs: 1000, clock },
    );
    pool.reportFailure("openai", "k1");
    expect(at(healthFor(pool, "openai"), 0).healthy).toBe(false);
    pool.reportSuccess("openai", "k1");
    const h = at(healthFor(pool, "openai"), 0);
    expect(h.healthy).toBe(true);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.successes).toBe(1);
  });

  it("fails open: when all keys are quarantined, returns the soonest to recover", () => {
    const { clock, advance } = fakeClock();
    const pool = new ProviderKeyPool(
      { openai: ["k1", "k2"] },
      { baseCooldownMs: 1000, clock },
    );
    pool.reportFailure("openai", "k1"); // cooldownUntil 1000
    advance(500);
    pool.reportFailure("openai", "k2"); // cooldownUntil 1500
    // Both quarantined at t=500 → k1 recovers soonest.
    expect(pool.acquire("openai")).toBe("k1");
  });

  it("isolates pools per provider", () => {
    const pool = new ProviderKeyPool({
      openai: ["o1"],
      google: ["g1", "g2"],
    });
    expect(pool.sizeFor("openai")).toBe(1);
    expect(pool.sizeFor("google")).toBe(2);
    expect(pool.acquire("google")).toBe("g1");
    expect(pool.acquire("openai")).toBe("o1");
  });

  it("health() masks keys and never leaks the raw value", () => {
    const pool = new ProviderKeyPool({ openai: ["sk-supersecret-1234"] });
    const h = healthFor(pool, "openai");
    expect(at(h, 0).keyMask).toBe("****1234");
    expect(JSON.stringify(h)).not.toContain("supersecret");
  });
});
