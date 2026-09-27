// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { buildAssetId, pageLocalId, validateRecord } from "../../src/index.js";
import { beginRecord, figureBlock, pageRecord, REFERENCE } from "./fixtures.js";

function errorPaths(value: unknown, options?: Parameters<typeof validateRecord>[1]): string[] {
  const result = validateRecord(value, options);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe("validateRecord — structural", () => {
  test("accepts a well-formed page", () => {
    const result = validateRecord(pageRecord(1), { reference: REFERENCE });
    expect(result.ok).toBe(true);
  });

  test("rejects wrong types with a machine-readable issue list", () => {
    const result = validateRecord({ type: "page", page: "one" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((i) => typeof i.path === "string")).toBe(true);
    }
  });
});

describe("validateRecord — contract compatibility", () => {
  test("accepts a v2 document.begin", () => {
    expect(validateRecord(beginRecord()).ok).toBe(true);
  });

  test("rejects an incompatible major", () => {
    expect(errorPaths(beginRecord({ contract: "atf-extract/1.1.0" })).join(" ")).toContain(
      "not a compatible atf-extract version",
    );
  });
});

describe("validateRecord — semantic", () => {
  test("rejects a figure whose asset id does not match", () => {
    const page = pageRecord(1, {
      blocks: [figureBlock(1, 1, { assetId: "0".repeat(64) })],
    });
    expect(errorPaths(page, { reference: REFERENCE }).join(" ")).toContain(
      "does not match sha256(reference \\n figureId)",
    );
  });

  test("rejects an asset ref whose asset id does not match", () => {
    const page = pageRecord(1, {
      assets: [
        {
          assetId: "0".repeat(64),
          kind: "page",
          localId: pageLocalId(1),
          page: 1,
        },
      ],
    });
    expect(errorPaths(page, { reference: REFERENCE }).join(" ")).toContain(
      "does not match sha256(reference \\n localId)",
    );
  });

  test("rejects a block attributed to the wrong page", () => {
    const page = pageRecord(1, {
      blocks: [{ type: "paragraph", id: "b1", page: 5, text: "x" }],
    });
    expect(errorPaths(page, { reference: REFERENCE }).join(" ")).toContain(
      "claims page 5 but is on page 1",
    );
  });

  test("rejects duplicate block ids", () => {
    const page = pageRecord(1, {
      blocks: [
        { type: "paragraph", id: "dup", page: 1, text: "a" },
        { type: "paragraph", id: "dup", page: 1, text: "b" },
      ],
    });
    expect(errorPaths(page, { reference: REFERENCE }).join(" ")).toContain(
      'duplicate block id "dup"',
    );
  });

  test("skips asset-id checks when no reference is supplied", () => {
    const page = pageRecord(1, {
      blocks: [figureBlock(1, 1, { assetId: "0".repeat(64) })],
    });
    // No reference → mid-stream validation cannot verify asset ids, so this
    // passes structurally.
    expect(validateRecord(page).ok).toBe(true);
  });

  test("warns but does not fail on an empty figure description", () => {
    const page = pageRecord(1, {
      blocks: [figureBlock(1, 1, { description: "  " })],
    });
    const result = validateRecord(page, { reference: REFERENCE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues.map((i) => i.message).join(" ")).toContain("retrievable text");
    }
  });

  test("a matching asset id validates", () => {
    const page = pageRecord(1, {
      assets: [
        {
          assetId: buildAssetId(REFERENCE, pageLocalId(1)),
          kind: "page",
          localId: pageLocalId(1),
          page: 1,
        },
      ],
    });
    expect(validateRecord(page, { reference: REFERENCE }).ok).toBe(true);
  });
});
