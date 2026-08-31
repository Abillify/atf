// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the extracted transform node handler (`src/graph/transform-node.ts`).
 * Behaviour must match the pre-extraction implementation in node-handlers.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  parseTransformRules,
  applyTransformRule,
  type TransformDeriveRule,
} from "../transform-node.js";
import type { FlowNode } from "../../types/flow.js";

function node(config: unknown): FlowNode {
  return { id: "t", type: "transform", config } as unknown as FlowNode;
}

describe("parseTransformRules", () => {
  test("returns [] for missing or non-array config", () => {
    expect(parseTransformRules(node(undefined))).toEqual([]);
    expect(parseTransformRules(node({ derive: "nope" }))).toEqual([]);
  });

  test("skips entries without a valid from/lookup", () => {
    const rules = parseTransformRules(
      node({
        derive: [
          { from: "", lookup: {} },
          { from: "x" },
          {
            from: "client",
            lookup: { a: { tag: "1" } },
            default: { tag: "" },
          },
        ],
      }),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]?.from).toBe("client");
    expect(rules[0]?.default).toEqual({ tag: "" });
  });
});

describe("applyTransformRule", () => {
  const rule: TransformDeriveRule = {
    from: "client",
    lookup: { acme: { col: "acme_docs", taiga: "acme_taiga" } },
    default: { col: "shared", taiga: "shared_taiga" },
  };

  test("expands a matched source value", () => {
    const c: Record<string, unknown> = { client: "acme" };
    applyTransformRule(c, rule);
    expect(c.col).toBe("acme_docs");
    expect(c.taiga).toBe("acme_taiga");
  });

  test("applies the default row when the value is unknown", () => {
    const c: Record<string, unknown> = { client: "unknown" };
    applyTransformRule(c, rule);
    expect(c.col).toBe("shared");
  });

  test("blanks out all producible fields when no match and no default", () => {
    const noDefault: TransformDeriveRule = {
      from: "client",
      lookup: { acme: { col: "acme_docs", taiga: "acme_taiga" } },
    };
    const c: Record<string, unknown> = {};
    applyTransformRule(c, noDefault);
    expect(c.col).toBe("");
    expect(c.taiga).toBe("");
  });
});
