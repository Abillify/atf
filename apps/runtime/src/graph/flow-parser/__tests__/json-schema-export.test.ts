// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { buildFlowJsonSchema, FLOW_SCHEMA_ID } from "../json-schema-export.js";
import { validateFlowDefinition } from "../../flow-parser.js";

const fixture = { id: "public-schema-fixture", name: "Public schema fixture", nodes: [{ id: "start", type: "llm" }], edges: [] };

describe("buildFlowJsonSchema", () => {
  test("produces a deterministic draft-2020-12 top-level schema", () => {
    const schema = buildFlowJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(FLOW_SCHEMA_ID);
    expect(schema.type).toBe("object");
    // nodes/edges are required unless metadata.$include supplies them (see below).
    expect(schema.required).toEqual(expect.arrayContaining(["id", "name"]));
    expect(JSON.stringify(schema)).toBe(JSON.stringify(buildFlowJsonSchema()));
  });

  test("has every exported required property after validating a public fixture", () => {
    const result = validateFlowDefinition(fixture);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.reason);
    const required = buildFlowJsonSchema().required;
    expect(Array.isArray(required)).toBe(true);
    for (const key of required as string[]) expect(result.data).toHaveProperty(key);
  });
});

/**
 * The exported schema describes flow FILES (source form). Zod's
 * fromJSONSchema is used to run positive cases; it does not enforce
 * patternProperties/root anyOf strictly, so the strict parts are asserted on
 * the schema structure instead.
 */
describe("flow.schema.json accepts the source form", () => {
  const schema = buildFlowJsonSchema() as Record<string, any>;
  const accepts = (flow: unknown): boolean => z.fromJSONSchema(schema as never).safeParse(flow).success;
  const node = schema.properties.nodes.items;
  const override = node.properties.overrides.items;

  test("llm is a shortcut or an explicit provider/model, on nodes and overrides", () => {
    for (const llm of [node.properties.llm, override.properties.llm]) {
      const [shortcut, explicit] = llm.anyOf;
      expect(shortcut.required).toEqual(["shortcut"]);
      expect(Object.keys(shortcut.properties)).toEqual(["shortcut", "parameters"]);
      expect(shortcut.additionalProperties).toBe(false); // provider/model next to a shortcut are rejected
      expect(explicit.required).toEqual(["provider", "model"]);
    }
    const base = { id: "f", name: "F", edges: [] };
    expect(accepts({ ...base, nodes: [{ id: "a", type: "llm", llm: { shortcut: "fast-pool" } }] })).toBe(true);
    expect(accepts({ ...base, nodes: [{ id: "a", type: "llm", llm: { shortcut: "x", parameters: { temperature: 0.2 } } }] })).toBe(true);
    expect(accepts({ ...base, nodes: [{ id: "a", type: "llm", llm: { shortcut: "x", provider: "openai" } }] })).toBe(false);
    expect(accepts({ ...base, nodes: [{ id: "a", type: "llm", llm: { model: "m" } }] })).toBe(false);
  });

  test("_-prefixed comment keys are allowed; other unknown keys are not", () => {
    for (const obj of [schema, node, schema.properties.edges.items, override]) {
      expect(obj.additionalProperties).toBe(false);
      expect(Object.keys(obj.patternProperties)).toEqual(["^_"]);
    }
  });

  test("nodes/edges may come from metadata.$include instead", () => {
    expect(schema.required).not.toContain("nodes");
    expect(schema.anyOf).toEqual([
      { required: ["nodes", "edges"] },
      { required: ["metadata"], properties: { metadata: { type: "object", required: ["$include"] } } },
    ]);
  });

  test("every example flow in deploy/examples/flows validates", () => {
    const dir = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "deploy", "examples", "flows");
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !f.includes(".example."));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect({ f, ok: accepts(parse(fs.readFileSync(path.join(dir, f), "utf8"))) }).toEqual({ f, ok: true });
    }
  });
});
