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
  COMMON_CONFIG_FIELDS,
  LLM_MODEL_FIELDS,
  NODE_TYPE_CATALOG,
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
        for (const m of src.matchAll(re)) if (m[1]) read.add(m[1]);
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

// ---------------------------------------------------------------------------
// Top-level node fields (`topLevel`)
// ---------------------------------------------------------------------------
//
// `topLevel` is what the Studio uses to decide which node fields to offer, so a
// gap there is not a documentation nit: the form either hides a field the engine
// reads, or offers one nobody reads. These tests pin the declarations against
// the code that actually does the reading.

const GRAPH = path.resolve(import.meta.dir, "..");

/** `usage` of a field on a type, or undefined when the type doesn't list it. */
const usage = (type: string, key: string): string | undefined =>
  nodeTypeDoc(type)?.topLevel.find((f) => f.key === key)?.usage;

const typesDeclaring = (key: string): string[] =>
  NODE_TYPE_CATALOG.filter((d) => (usage(d.type, key) ?? "ignored") !== "ignored")
    .map((d) => d.type)
    .sort();

describe("node type catalog — top-level fields", () => {
  test("every type takes a position on llm, systemPrompt and tools", () => {
    // Leaving one out reads as "not applicable" in the docs and hides it in the
    // Studio, which is the same outcome as `ignored` — but only `ignored` says
    // so on purpose, and only it carries the reason.
    const missing: string[] = [];
    for (const doc of NODE_TYPE_CATALOG) {
      for (const key of ["llm", "systemPrompt", "tools"]) {
        if (usage(doc.type, key) === undefined) missing.push(`${doc.type}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every top-level entry explains itself, exactly once per field", () => {
    for (const doc of NODE_TYPE_CATALOG) {
      const keys = doc.topLevel.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const f of doc.topLevel) {
        // A bare "Not used." is why these were easy to get wrong: the reader
        // needs to know where the setting belongs instead.
        expect(f.description.length).toBeGreaterThan(20);
      }
    }
  });

  test("`overrides` is declared exactly for the handlers that resolve them", () => {
    // `resolveNodeConfig` (graph-engine/node-config.ts) is the only code path
    // that applies `node.overrides`. handlers/<type>.ts maps 1:1 to a node type
    // (see handlers/index.ts), so importing it is the evidence.
    const resolvers = fs
      .readdirSync(path.join(GRAPH, "handlers"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .filter((f) =>
        /resolveNodeConfig\s*\(/.test(
          fs.readFileSync(path.join(GRAPH, "handlers", f), "utf8"),
        ),
      )
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();

    expect(resolvers).toEqual(["llm", "tool"]);
    expect(typesDeclaring("overrides")).toEqual(resolvers);
  });

  test("`priority` is declared exactly for the types the queue reads it from", () => {
    // The only reader of `node.priority` is the flow priority computation in
    // graph-engine/handler-factories.ts, which filters on the node type.
    const src = fs.readFileSync(
      path.join(GRAPH, "graph-engine", "handler-factories.ts"),
      "utf8",
    );
    const block =
      /const flowPriority = Math\.max\(([\s\S]{0,400}?)\);/.exec(src)?.[1] ?? "";
    expect(block).toContain("node.priority");
    const queueTypes = [
      ...new Set(
        [...block.matchAll(/node\.type === "([\w-]+)"/g)].flatMap((m) =>
          m[1] === undefined ? [] : [m[1]],
        ),
      ),
    ].sort();

    expect(queueTypes).toEqual(["classifier", "llm"]);
    expect(typesDeclaring("priority")).toEqual(queueTypes);
  });

  test("`classifierSchema` and `parallelNodes` belong to exactly one type each", () => {
    expect(typesDeclaring("classifierSchema")).toEqual(["classifier"]);
    expect(typesDeclaring("parallelNodes")).toEqual(["parallel"]);
  });

  test("a type whose handler reads a field does not declare it ignored", () => {
    // Direct reads in the handler file, e.g. `node.systemPrompt` in
    // classifier.ts or `node.parallelNodes` in parallel.ts.
    const wrong: string[] = [];
    for (const doc of NODE_TYPE_CATALOG) {
      const file = path.join(GRAPH, "handlers", `${doc.type}.ts`);
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, "utf8");
      for (const key of [
        "llm",
        "systemPrompt",
        "tools",
        "classifierSchema",
        "parallelNodes",
        "overrides",
      ]) {
        const reads = new RegExp(`node\\.${key}\\b`).test(src);
        if (reads && usage(doc.type, key) === "ignored") {
          wrong.push(`${doc.type}.${key}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("`label` is explained on every type — the panel offers it everywhere", () => {
    // The Studio renders a Label input for every node, so every type must say
    // what it does (and that the id, not the label, is the reference).
    const missing = NODE_TYPE_CATALOG.filter((d) => usage(d.type, "label") === undefined).map(
      (d) => d.type,
    );
    expect(missing).toEqual([]);
    for (const doc of NODE_TYPE_CATALOG) {
      expect(usage(doc.type, "label")).toBe("optional");
    }
  });
});

// ---------------------------------------------------------------------------
// Model selection inside `llm` (`LLM_MODEL_FIELDS`)
// ---------------------------------------------------------------------------

describe("node type catalog — llm model fields", () => {
  test("documents the keys of LlmConfig the Studio edits", () => {
    // The panel's Model section edits exactly these; a new LlmConfig key
    // without a passage here shows up in the JSON tab with no docs.
    const src = fs.readFileSync(path.resolve(GRAPH, "../types/flow.ts"), "utf8");
    const body = /export interface LlmConfig \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    const keys = [...body.matchAll(/^\s{2}([A-Za-z]+)\?:/gm)]
      .map((m) => m[1])
      .filter((k): k is string => k !== undefined);
    expect(keys.length).toBeGreaterThan(3);
    const documented = new Set(LLM_MODEL_FIELDS.map((f) => f.key.split(".")[1]));
    expect(keys.filter((k) => !documented.has(k))).toEqual([]);
  });

  test("every llm field explains itself with a dotted key", () => {
    const check = (fields: typeof LLM_MODEL_FIELDS, top: boolean): void => {
      for (const f of fields) {
        if (top) expect(f.key.startsWith("llm.")).toBe(true);
        expect(f.description.length).toBeGreaterThan(20);
        if (f.kind === "enum") expect(f.options?.length ?? 0).toBeGreaterThan(0);
        if (f.fields) check(f.fields, false);
      }
    };
    check(LLM_MODEL_FIELDS, true);
  });
});
