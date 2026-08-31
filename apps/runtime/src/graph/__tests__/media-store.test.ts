// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the in-memory media store (`InMemoryMediaStore`) and the
 * `mediaExtension` helper used to build public media URLs.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryMediaStore, mediaExtension } from "../media-store.js";

const bytes = (n: number): Uint8Array =>
  new Uint8Array(Array.from({ length: n }, (_, i) => i % 256));

describe("InMemoryMediaStore", () => {
  test("stores and retrieves media by id with the original bytes + type", () => {
    const store = new InMemoryMediaStore();
    const data = bytes(32);
    const id = store.put(data, "image/png");
    const got = store.get(id);
    expect(got).toBeDefined();
    if (got === undefined) throw new Error("expected stored media");
    expect(got.mediaType).toBe("image/png");
    expect(Array.from(got.data)).toEqual(Array.from(data));
  });

  test("mints unguessable, unique ids per put", () => {
    const store = new InMemoryMediaStore();
    const a = store.put(bytes(4), "image/png");
    const b = store.put(bytes(4), "image/png");
    expect(a).not.toBe(b);
    // UUID v4 shape (the capability must be unguessable).
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("returns undefined for an unknown id", () => {
    const store = new InMemoryMediaStore();
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  test("expires entries after the TTL (injected clock)", () => {
    let now = 1_000;
    const store = new InMemoryMediaStore({
      ttlSeconds: 10,
      clock: () => now,
    });
    const id = store.put(bytes(8), "image/jpeg");
    expect(store.get(id)).toBeDefined();
    now += 10_001; // past the 10s TTL
    expect(store.get(id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  test("evicts the least-recently-used entry when over the entry bound", () => {
    const store = new InMemoryMediaStore({ maxEntries: 2 });
    const a = store.put(bytes(4), "image/png");
    const b = store.put(bytes(4), "image/png");
    // Touch a so b becomes the LRU.
    store.get(a);
    const c = store.put(bytes(4), "image/png");
    expect(store.get(b)).toBeUndefined(); // evicted
    expect(store.get(a)).toBeDefined();
    expect(store.get(c)).toBeDefined();
    expect(store.size()).toBe(2);
  });

  test("evicts to stay under the total-byte bound", () => {
    const store = new InMemoryMediaStore({
      maxTotalBytes: 100,
      maxEntries: 100,
    });
    const a = store.put(bytes(60), "image/png");
    const b = store.put(bytes(60), "image/png"); // 120 > 100 → evict a
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBeDefined();
  });
});

describe("mediaExtension", () => {
  test("maps common image types", () => {
    expect(mediaExtension("image/jpeg")).toBe("jpg");
    expect(mediaExtension("image/png")).toBe("png");
    expect(mediaExtension("image/webp")).toBe("webp");
    expect(mediaExtension("image/svg+xml")).toBe("svg");
  });

  test("derives a sane extension from the subtype for unknown types", () => {
    expect(mediaExtension("image/avif")).toBe("avif");
    expect(mediaExtension("application/octet-stream")).toBe("octetstream");
  });

  test("is case-insensitive and never empty", () => {
    expect(mediaExtension("IMAGE/JPEG")).toBe("jpg");
    expect(mediaExtension("")).toBe("bin");
  });
});
