// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the in-memory idempotency store.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryIdempotencyStore,
  type IdempotencyRecord,
} from "../idempotency-store.js";

const rec = (text: string): IdempotencyRecord => ({
  model: "flow",
  responseText: text,
  finishReason: "stop",
  createdAt: new Date().toISOString(),
});

describe("InMemoryIdempotencyStore", () => {
  it("claims a fresh key", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("k1", "fp")).toEqual({ status: "claimed" });
  });

  it("reports in-flight for a second claim before completion", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("k1", "fp");
    expect(store.claim("k1", "fp")).toEqual({ status: "inflight" });
  });

  it("replays the stored record after completion", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("k1", "fp");
    store.complete("k1", rec("answer"));
    const outcome = store.claim("k1", "fp");
    expect(outcome.status).toBe("replay");
    if (outcome.status === "replay")
      expect(outcome.record.responseText).toBe("answer");
  });

  it("returns mismatch when the same key is reused with a different fingerprint", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("k1", "fp-a");
    expect(store.claim("k1", "fp-b")).toEqual({ status: "mismatch" });
  });

  it("lets a retry proceed after release (failed first attempt)", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("k1", "fp");
    store.release("k1");
    expect(store.claim("k1", "fp")).toEqual({ status: "claimed" });
  });

  it("release is a no-op once completed (keeps the replay record)", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("k1", "fp");
    store.complete("k1", rec("answer"));
    store.release("k1");
    expect(store.claim("k1", "fp").status).toBe("replay");
  });

  it("expires entries after the TTL and treats the key as fresh", () => {
    let now = 1_000_000;
    const store = new InMemoryIdempotencyStore({
      ttlSeconds: 10,
      clock: () => now,
    });
    store.claim("k1", "fp");
    store.complete("k1", rec("answer"));
    now += 11_000;
    expect(store.claim("k1", "fp")).toEqual({ status: "claimed" });
  });

  it("evicts the least-recently-used entry when over the bound", () => {
    const store = new InMemoryIdempotencyStore({ maxEntries: 2 });
    store.claim("a", "fp");
    store.claim("b", "fp");
    store.claim("a", "fp"); // touch a → b is LRU
    store.claim("c", "fp"); // evicts b
    expect(store.size()).toBe(2);
    // b was evicted → a fresh claim, not in-flight.
    expect(store.claim("b", "fp")).toEqual({ status: "claimed" });
  });

  it("complete on an unknown key is a no-op", () => {
    const store = new InMemoryIdempotencyStore();
    store.complete("ghost", rec("x"));
    expect(store.size()).toBe(0);
  });
});
