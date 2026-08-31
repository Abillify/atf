// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the webhook replay guard (`src/util/replay-guard.ts`).
 */

import { describe, it, expect } from "bun:test";
import { isTimestampFresh, NonceCache } from "../replay-guard.js";

describe("isTimestampFresh", () => {
  it("accepts a timestamp within tolerance", () => {
    expect(isTimestampFresh(1000, 1000, 5000)).toBe(true);
    expect(isTimestampFresh(1000, 4000, 5000)).toBe(true); // 3s late, within 5s
    expect(isTimestampFresh(4000, 1000, 5000)).toBe(true); // 3s "future" (skew)
  });

  it("rejects a timestamp outside tolerance, past or future", () => {
    expect(isTimestampFresh(1000, 10_000, 5000)).toBe(false); // too old
    expect(isTimestampFresh(10_000, 1000, 5000)).toBe(false); // too far future
  });

  it("rejects a non-finite timestamp", () => {
    expect(isTimestampFresh(NaN, 1000, 5000)).toBe(false);
    expect(isTimestampFresh(Infinity, 1000, 5000)).toBe(false);
  });
});

describe("NonceCache", () => {
  it("accepts a fresh nonce and rejects the same nonce replayed", () => {
    const cache = new NonceCache();
    expect(cache.consume("flow-a", "nonce-1")).toBe(true);
    expect(cache.consume("flow-a", "nonce-1")).toBe(false); // replay
  });

  it("scopes nonces by namespace — the same nonce in a different namespace is fresh", () => {
    const cache = new NonceCache();
    expect(cache.consume("flow-a", "nonce-1")).toBe(true);
    expect(cache.consume("flow-b", "nonce-1")).toBe(true);
  });

  it("expires a consumed nonce after its TTL, allowing reuse", () => {
    let now = 0;
    const cache = new NonceCache({ ttlMs: 1000, clock: () => now });
    expect(cache.consume("flow-a", "n1")).toBe(true);
    now = 500;
    expect(cache.consume("flow-a", "n1")).toBe(false); // still within TTL
    now = 1500;
    expect(cache.consume("flow-a", "n1")).toBe(true); // expired — treated as fresh
  });

  it("bounds memory: evicts the oldest entry once over maxEntries", () => {
    const cache = new NonceCache({ maxEntries: 2, ttlMs: 60_000 });
    cache.consume("ns", "a");
    cache.consume("ns", "b");
    cache.consume("ns", "c"); // evicts "a"
    expect(cache.size()).toBe(2);
    // "a" was evicted, so it is treated as fresh again (not remembered).
    expect(cache.consume("ns", "a")).toBe(true);
  });

  it("does not grow unbounded under a public endpoint hammering distinct nonces", () => {
    const cache = new NonceCache({ maxEntries: 100, ttlMs: 60_000 });
    for (let i = 0; i < 1000; i++) cache.consume("ns", `nonce-${i}`);
    expect(cache.size()).toBeLessThanOrEqual(100);
  });
});
