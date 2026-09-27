// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * render-api.test.ts
 *
 * The `POST /v2/render` request/response wire shapes (task 3.8, requirements
 * 6.8, 14.4). These are the contract Extract (producer) and Search (consumer)
 * agree on for on-demand page/region rendering; the schema is what stops the
 * two services drifting on field names or bbox conventions.
 */

import { describe, expect, test } from "bun:test";
import { renderRequestSchema, renderResultSchema } from "../../src/v2/index.js";

const SHA = "a".repeat(64);

describe("renderRequestSchema", () => {
  test("accepts a whole-page render", () => {
    const parsed = renderRequestSchema.parse({ source: SHA, page: 1 });
    expect(parsed.source).toBe(SHA);
    expect(parsed.page).toBe(1);
    expect(parsed.bbox).toBeUndefined();
  });

  test("accepts a normalised bbox region and a target pixel count", () => {
    const parsed = renderRequestSchema.parse({
      source: SHA,
      page: 12,
      bbox: [0.1, 0.2, 0.5, 0.7],
      targetPixels: 2048,
    });
    expect(parsed.bbox).toEqual([0.1, 0.2, 0.5, 0.7]);
    expect(parsed.targetPixels).toBe(2048);
  });

  test("rejects a non-sha256 source", () => {
    expect(() => renderRequestSchema.parse({ source: "nope", page: 1 })).toThrow();
  });

  test("rejects a page below 1", () => {
    expect(() => renderRequestSchema.parse({ source: SHA, page: 0 })).toThrow();
  });

  test("rejects a bbox outside [0,1]", () => {
    expect(() =>
      renderRequestSchema.parse({ source: SHA, page: 1, bbox: [0, 0, 1.5, 1] }),
    ).toThrow();
  });

  test("rejects an inverted bbox (x0>=x1 or y0>=y1)", () => {
    expect(() =>
      renderRequestSchema.parse({ source: SHA, page: 1, bbox: [0.6, 0.1, 0.2, 0.7] }),
    ).toThrow();
  });

  test("rejects unknown fields (strict)", () => {
    expect(() =>
      renderRequestSchema.parse({ source: SHA, page: 1, dpi: 300 }),
    ).toThrow();
  });
});

describe("renderResultSchema", () => {
  test("describes the render metadata", () => {
    const parsed = renderResultSchema.parse({
      source: SHA,
      page: 3,
      bbox: null,
      width: 800,
      height: 600,
      dpi: 200,
      mimeType: "image/png",
    });
    expect(parsed.width).toBe(800);
    expect(parsed.mimeType).toBe("image/png");
  });
});
