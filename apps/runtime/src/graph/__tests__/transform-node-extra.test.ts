// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Transform node — pure derivation helpers (`src/graph/transform-node.ts`)
 *
 * parseTransformRules / applyTransformRule deterministically derive extra
 * classification fields from static lookup tables. No LLM, no runtime — pure.
 */

import { describe, test, expect } from "bun:test";
import {
  parseTransformRules,
  applyTransformRule,
  type TransformDeriveRule,
} from "../transform-node.js";
import type { FlowNode } from "../../types/flow.js";

function node(config: unknown): FlowNode {
  return { id: "t", type: "transform", config: config as FlowNode["config"] };
}

describe("parseTransformRules", () => {
  test("returns [] when config.derive is missing or not an array", () => {
    expect(parseTransformRules(node(undefined))).toEqual([]);
    expect(parseTransformRules(node({ derive: "nope" }))).toEqual([]);
  });

  test("keeps valid rules and drops malformed entries", () => {
    const rules = parseTransformRules(
      node({
        derive: [
          null,
          "bad",
          { from: "", lookup: {} }, // empty from
          { from: "client", lookup: null }, // bad lookup
          { from: "client", lookup: { a: { tag: "x" } } }, // valid
        ],
      }),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]?.from).toBe("client");
  });

  test("carries an optional default row through", () => {
    const rules = parseTransformRules(
      node({
        derive: [
          { from: "m", lookup: { a: { tag: "x" } }, default: { tag: "z" } },
        ],
      }),
    );
    expect(rules[0]?.default).toEqual({ tag: "z" });
  });
});

describe("applyTransformRule", () => {
  const rule: TransformDeriveRule = {
    from: "client",
    lookup: { acme: { tenantTag: "acme-docs", region: "eu" } },
  };

  test("writes the matched row's fields onto the classification", () => {
    const c: Record<string, unknown> = { client: "acme" };
    applyTransformRule(c, rule);
    expect(c.tenantTag).toBe("acme-docs");
    expect(c.region).toBe("eu");
  });

  test("applies the default row when the source value is unknown", () => {
    const c: Record<string, unknown> = { client: "unknown" };
    applyTransformRule(c, { ...rule, default: { tenantTag: "fallback" } });
    expect(c.tenantTag).toBe("fallback");
  });

  test("blanks every derivable field when no match and no default", () => {
    const c: Record<string, unknown> = { client: "missing" };
    applyTransformRule(c, rule);
    expect(c.tenantTag).toBe("");
    expect(c.region).toBe("");
  });

  test("treats a non-string source value as no match", () => {
    const c: Record<string, unknown> = { client: 123 };
    applyTransformRule(c, rule);
    expect(c.tenantTag).toBe("");
  });
});
