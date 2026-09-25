// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Keeps the node type catalog complete: every key a config schema declares and
 * every `node.config` key the engine reads must be documented, otherwise the
 * Studio can't offer it and the Copilot doesn't know it exists.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  NODE_TYPE_CATALOG,
  COMMON_CONFIG_FIELDS,
  catalogPromptReference,
  nodeTypeDoc,
} from "../node-type-catalog.js";
import {
  HarnessConfigSchema,
  LlmNodeConfigSchema,
  ParallelConfigSchema,
  TransformConfigSchema,
} from "../flow-parser/validate.js";
import { TriggerConfigSchema } from "../handlers/trigger.js";

function shapeKeys(schema: unknown): string[] {
  let s = schema as Record<string, unknown> | undefined;
  for (let i = 0; i < 6 && s; i++) {
    const shape = (s as { shape?: Record<string, unknown> }).shape;
    if (shape) return Object.keys(shape);
    const def = (s as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> })._zod?.def ??
      (s as { def?: Record<string, unknown> }).def;
    s = (def?.["in"] ?? def?.["schema"] ?? def?.["innerType"]) as Record<string, unknown> | undefined;
  }
  return [];
}

const keysOf = (type: string): Set<string> =>
  new Set([
    ...(nodeTypeDoc(type)?.config.map((f) => f.key) ?? []),
    ...COMMON_CONFIG_FIELDS.map((f) => f.key),
  ]);

const allKeys = new Set(
  [...NODE_TYPE_CATALOG.flatMap((d) => d.config), ...COMMON_CONFIG_FIELDS].map((f) => f.key),
);

describe("node type catalog", () => {
  test("covers every built-in node type once", () => {
    const types = NODE_TYPE_CATALOG.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
    for (const t of [
      "llm", "tool", "router", "classifier", "parallel", "retrieval", "memory",
      "agent-harness", "transform", "trigger", "assistant-context", "assistant-learn",
    ]) {
      expect(types).toContain(t);
    }
  });

  test.each([
    ["llm", LlmNodeConfigSchema],
    ["agent-harness", HarnessConfigSchema],
    ["parallel", ParallelConfigSchema],
    ["transform", TransformConfigSchema],
    ["trigger", TriggerConfigSchema],
  ] as const)("documents every key of the %s config schema", (type, schema) => {
    const keys = shapeKeys(schema);
    expect(keys.length).toBeGreaterThan(0);
    const documented = keysOf(type);
    expect(keys.filter((k) => !documented.has(k))).toEqual([]);
  });

  test("documents every node.config key the engine reads", () => {
    const root = path.resolve(import.meta.dir, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "__tests__") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    walk(path.resolve(root, "../"));
    const read = new Set<string>();
    // `(node.config as { key?: T } | undefined)?.key` — the dominant idiom.
    const castRe = /node\.config as\s*\|?\s*\{\s*([A-Za-z]+)\?:/g;
    const castRe2 = /\(\s*node\.config as[^;]{0,400}?\)\s*\?\.\s*([A-Za-z]+)/g;
    for (const f of new Set(files)) {
      if (f.includes("node-type-catalog")) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const re of [castRe, castRe2]) {
        for (const m of src.matchAll(re)) read.add(m[1]!);
      }
    }
    expect(read.size).toBeGreaterThan(10);
    const undocumented = [...read].filter((k) => !allKeys.has(k)).sort();
    expect(undocumented).toEqual([]);
  });

  test("every field has a description and enum fields list their options", () => {
    const check = (fields: typeof COMMON_CONFIG_FIELDS): void => {
      for (const f of fields) {
        expect(f.description.length).toBeGreaterThan(20);
        if (f.kind === "enum") expect(f.options?.length ?? 0).toBeGreaterThan(0);
        if (f.kind === "object") expect(f.fields?.length ?? 0).toBeGreaterThan(0);
        if (f.fields) check(f.fields);
      }
    };
    check(COMMON_CONFIG_FIELDS);
    for (const d of NODE_TYPE_CATALOG) {
      expect(d.description.length).toBeGreaterThan(80);
      check(d.config);
    }
  });

  test("prompt reference names every key", () => {
    const ref = catalogPromptReference();
    for (const k of allKeys) expect(ref).toContain(k);
  });
});
