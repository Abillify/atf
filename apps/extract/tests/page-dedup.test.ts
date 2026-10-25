// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * page-dedup.test.ts
 *
 * Render-hash page deduplication. The registry is a
 * pure in-memory decision; the hash helper is exercised against synthetic
 * rasters authored inline (no fixtures).
 *
 * Covers:
 *  - identical pixels hash the same across different PNG encodings
 *  - different pixels hash differently
 *  - the registry calls the first page unique and later identical pages duplicates
 *  - an unhashable image is always unique (safe fallback → run vision)
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createDedupRegistry, renderHash } from "../src/jobs/page-dedup.js";

/** A solid-colour PNG of the given size and grey level. */
async function solidPng(width: number, height: number, grey: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3, grey);
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("renderHash", () => {
  it("hashes identical pixels to the same value across re-encodings", async () => {
    const a = await solidPng(20, 20, 200);
    // Re-encode the same pixels through a different pipeline (adds a resize
    // round-trip that leaves the downscaled pixels unchanged for a solid image).
    const b = await sharp(a).png({ compressionLevel: 1 }).toBuffer();
    expect(await renderHash(a)).toBe(await renderHash(b));
  });

  it("hashes different images to different values", async () => {
    const a = await solidPng(20, 20, 40);
    const b = await solidPng(20, 20, 220);
    expect(await renderHash(a)).not.toBe(await renderHash(b));
  });

  it("returns null for an undecodable buffer", async () => {
    expect(await renderHash(Buffer.from("nope"))).toBeNull();
  });
});

describe("createDedupRegistry", () => {
  it("marks the first page unique and later identical pages duplicates", () => {
    const registry = createDedupRegistry();
    const h = "hash-A";
    expect(registry.register(1, h)).toEqual({ kind: "unique" });
    expect(registry.register(2, h)).toEqual({ kind: "duplicate", sourcePage: 1 });
    expect(registry.register(3, h)).toEqual({ kind: "duplicate", sourcePage: 1 });
    expect(registry.sourceFor(h)).toBe(1);
    expect(registry.size()).toBe(1);
  });

  it("keeps distinct hashes independent", () => {
    const registry = createDedupRegistry();
    expect(registry.register(1, "h1")).toEqual({ kind: "unique" });
    expect(registry.register(2, "h2")).toEqual({ kind: "unique" });
    expect(registry.size()).toBe(2);
  });

  it("re-registering the same page stays its own source (resume re-walk)", () => {
    const registry = createDedupRegistry();
    registry.register(5, "h");
    expect(registry.register(5, "h")).toEqual({ kind: "unique" });
  });

  it("treats an unhashable page as unique", () => {
    const registry = createDedupRegistry();
    expect(registry.register(1, null)).toEqual({ kind: "unique" });
    expect(registry.register(2, null)).toEqual({ kind: "unique" });
    expect(registry.sourceFor(null)).toBeNull();
  });
});
