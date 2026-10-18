// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Asset identity is derived from document reference + figure id and is written
 * into the figure chunk (`chunk.asset_id`) as well as used as the v2 asset id
 * (`PUT /v2/assets/:assetId`). A drift in the derivation would orphan every
 * stored crop of an existing corpus.
 *
 * So this file pins the derivation against literal digests. (Search no longer
 * recomputes the id itself: the legacy `/document-assets` endpoint that did was
 * removed, so the former cross-check against Search's implementation is gone.)
 */

import { describe, expect, test } from "bun:test";
import { buildDocumentAssetId, isAssetId } from "../src/index.js";

describe("buildDocumentAssetId", () => {
  test("matches pinned digests", () => {
    expect(buildDocumentAssetId("doc-1", "p1-f1")).toBe(
      "f18cce94532992b193348f3e8d3328b95343268be81ef87fbf83cf98573c0b61",
    );
    expect(buildDocumentAssetId("spec.pdf", "p12-f3")).toBe(
      "85bca7ac9edc122ac8c7ffd5e005f5747889c9b91852c06b0d4469c6ccf93058",
    );
  });

  test("normalises unicode so filesystem encoding cannot change the id", () => {
    const composed = buildDocumentAssetId("Gr\u00fcn.pdf", "p1-f1");
    const decomposed = buildDocumentAssetId("Gru\u0308n.pdf", "p1-f1");
    expect(composed).toBe(decomposed);
    expect(composed).toBe(
      "b7bcfd6638f433a6d444a3ee92e840d083ba8d07e731b1f636cc5909dbc76b60",
    );
  });

  test("separates reference from figure id", () => {
    // Without the \n separator these two would collide.
    expect(buildDocumentAssetId("ab", "c")).not.toBe(buildDocumentAssetId("a", "bc"));
  });

  test("isAssetId accepts only lower-case hex sha256", () => {
    expect(isAssetId(buildDocumentAssetId("a", "b"))).toBe(true);
    expect(isAssetId("F18CCE94532992B193348F3E8D3328B95343268BE81EF87FBF83CF98573C0B61")).toBe(false);
    expect(isAssetId("abc")).toBe(false);
  });
});
