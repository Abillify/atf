// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Asset identity across v1 and v2.
 *
 * The load-bearing property: a figure's asset id
 * is IDENTICAL to v1, so re-extracting an existing corpus under v2 keeps every
 * previously uploaded crop valid. The new page/tile/native local ids are
 * derived through the same hash with a prefix.
 */

import { describe, expect, test } from "bun:test";
import {
  buildAssetId,
  buildDocumentAssetId,
  figureLocalId,
  nativeLocalId,
  pageLocalId,
  tileLocalId,
} from "../../src/index.js";
import { buildDocumentAssetId as v1BuildDocumentAssetId } from "../../src/v1/index.js";

describe("asset-id v2 continuity", () => {
  test("figure ids are byte-identical to v1", () => {
    const reference = "docs/handbuch.pdf";
    const figureId = "p12-f3";
    // v2 buildAssetId(reference, figureLocalId(id)) === v1 buildDocumentAssetId
    expect(buildAssetId(reference, figureLocalId(figureId))).toBe(
      v1BuildDocumentAssetId(reference, figureId),
    );
    // …and equals the same pinned digest the v1 suite freezes for this pair,
    // so the value is frozen, not merely self-consistent.
    expect(buildDocumentAssetId("spec.pdf", "p12-f3")).toBe(
      "85bca7ac9edc122ac8c7ffd5e005f5747889c9b91852c06b0d4469c6ccf93058",
    );
  });

  test("page / tile / native local ids carry their prefix", () => {
    expect(pageLocalId(37)).toBe("page:p37");
    expect(tileLocalId("p37-f1-r2c3")).toBe("tile:p37-f1-r2c3");
    expect(nativeLocalId("source")).toBe("native:source");
    expect(nativeLocalId("diagram.bpmn")).toBe("native:diagram.bpmn");
  });

  test("prefixed builders are idempotent", () => {
    expect(tileLocalId("tile:x")).toBe("tile:x");
    expect(nativeLocalId("native:x")).toBe("native:x");
  });

  test("a page asset id differs from a figure asset id on the same page", () => {
    const reference = "docs/handbuch.pdf";
    const pageId = buildAssetId(reference, pageLocalId(37));
    const figId = buildAssetId(reference, figureLocalId("p37-f1"));
    expect(pageId).not.toBe(figId);
  });
});
