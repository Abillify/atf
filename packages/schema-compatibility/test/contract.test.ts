// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { diffToolSchemas, type ToolSchemas } from "../src/index.ts";

const tool = (inputSchema: ToolSchemas["inputSchema"], outputSchema?: ToolSchemas["outputSchema"]): ToolSchemas => ({ inputSchema, ...(outputSchema ? { outputSchema } : {}) });
const object = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: "object", properties, required, ...extra });
const codes = (findings: ReturnType<typeof diffToolSchemas>["breaking"]) => findings.map((finding) => `${finding.direction}:${finding.path}:${finding.code}`);

describe("input compatibility", () => {
  test("classifies added optional and required properties and removed properties", () => {
    const previous = tool(object({ keep: { type: "string" }, gone: { type: "string" } }, ["keep"]));
    const next = tool(object({ keep: { type: "string" }, optional: { type: "number" }, required: { type: "string" } }, ["keep", "required"]));
    const diff = diffToolSchemas(previous, next);
    expect(codes(diff.breaking)).toEqual([
      "input:$.properties.gone:property-removed",
      "input:$.properties.required:required-property-added",
    ]);
    expect(codes(diff.nonBreaking)).toEqual(["input:$.properties.optional:property-added"]);
  });

  test("classifies requiredness changes recursively", () => {
    const previous = tool(object({ nested: object({ value: { type: "string" } }) }));
    const next = tool(object({ nested: object({ value: { type: "string" } }, ["value"]) }));
    expect(codes(diffToolSchemas(previous, next).breaking)).toEqual([
      "input:$.properties.nested.properties.value:property-made-required",
    ]);
    expect(codes(diffToolSchemas(next, previous).nonBreaking)).toEqual([
      "input:$.properties.nested.properties.value:property-made-optional",
    ]);
  });

  test("classifies narrowed and widened type and enum constraints", () => {
    const broad = tool(object({ value: { type: ["string", "number"], enum: ["a", "b"] } }));
    const narrow = tool(object({ value: { type: "string", enum: ["a"] } }));
    expect(codes(diffToolSchemas(broad, narrow).breaking)).toEqual([
      "input:$.properties.value:type-narrowed",
      "input:$.properties.value:enum-narrowed",
    ]);
    expect(codes(diffToolSchemas(narrow, broad).nonBreaking)).toEqual([
      "input:$.properties.value:type-widened",
      "input:$.properties.value:enum-widened",
    ]);
  });

  test("classifies numeric, string, and array bounds", () => {
    const broad = tool(object({ value: { minimum: 0, maximum: 10, minLength: 1, maxLength: 10, minItems: 1, maxItems: 10 } }));
    const narrow = tool(object({ value: { minimum: 1, maximum: 9, minLength: 2, maxLength: 9, minItems: 2, maxItems: 9 } }));
    expect(diffToolSchemas(broad, narrow).breaking).toHaveLength(6);
    expect(diffToolSchemas(narrow, broad).nonBreaking).toHaveLength(6);
  });

  test("classifies additionalProperties and oneOf/anyOf variants", () => {
    const stringVariant = { type: "string" };
    const numberVariant = { type: "number" };
    const broad = tool({ oneOf: [stringVariant, numberVariant], anyOf: [stringVariant, numberVariant] });
    const narrow = tool({ oneOf: [stringVariant], anyOf: [stringVariant], additionalProperties: false });
    expect(codes(diffToolSchemas(broad, narrow).breaking)).toEqual([
      "input:$:additional-properties-disabled",
      "input:$:oneOf-variant-removed",
      "input:$:anyOf-variant-removed",
    ]);
    expect(codes(diffToolSchemas(narrow, broad).nonBreaking)).toEqual([
      "input:$:additional-properties-enabled",
      "input:$:oneOf-variant-added",
      "input:$:anyOf-variant-added",
    ]);
  });
});

describe("output compatibility", () => {
  test("marks removed and optionalized guarantees as breaking and additions as compatible", () => {
    const previous = tool({}, object({ removed: { type: "string" }, optionalized: { type: "string" } }, ["removed", "optionalized"]));
    const next = tool({}, object({ optionalized: { type: "string" }, added: { type: "number" } }));
    const diff = diffToolSchemas(previous, next);
    expect(codes(diff.breaking)).toEqual([
      "output:$.properties.optionalized:property-made-optional",
      "output:$.properties.removed:property-removed",
    ]);
    expect(codes(diff.nonBreaking)).toEqual(["output:$.properties.added:property-added"]);
  });

  test("treats loosened output type, enum, and bounds as breaking", () => {
    const narrow = tool({}, object({ value: { type: "string", enum: ["a"], minimum: 1, maximum: 9, minLength: 2, maxLength: 9, minItems: 2, maxItems: 9 } }));
    const broad = tool({}, object({ value: { type: ["string", "number"], enum: ["a", "b"], minimum: 0, maximum: 10, minLength: 1, maxLength: 10, minItems: 1, maxItems: 10 } }));
    expect(diffToolSchemas(narrow, broad).breaking).toHaveLength(8);
    expect(diffToolSchemas(broad, narrow).nonBreaking).toHaveLength(8);
  });

  test("handles optional output schemas", () => {
    expect(codes(diffToolSchemas(tool({}), tool({}, {})).nonBreaking)).toEqual(["output:$:output-schema-added"]);
    expect(codes(diffToolSchemas(tool({}, {}), tool({})).breaking)).toEqual(["output:$:output-schema-removed"]);
  });
});

describe("unknown and deterministic behavior", () => {
  test.each(["$ref", "allOf", "not", "if", "then", "else", "dependentSchemas", "patternProperties"])("reports changed %s as unknown", (keyword) => {
    const diff = diffToolSchemas(tool({}), tool({ [keyword]: keyword === "$ref" ? "#/$defs/X" : {} }));
    expect(diff.unknown.some((finding) => finding.code === "unsupported-keyword" && finding.message.startsWith(keyword))).toBe(true);
  });

  test("does not guess below a changed unsupported construct", () => {
    const previous = tool({ $ref: "#/$defs/Old", type: ["string", "number"] });
    const next = tool({ $ref: "#/$defs/New", type: "string" });
    const diff = diffToolSchemas(previous, next);
    expect(diff.breaking).toEqual([]);
    expect(codes(diff.unknown)).toEqual(["input:$:unsupported-keyword"]);
  });

  test("does not guess for schema-valued additionalProperties or unorderable enum changes", () => {
    const previous = tool({ additionalProperties: { type: "string" }, enum: ["a", "b"] });
    const next = tool({ additionalProperties: { type: "number" }, enum: ["b", "c"] });
    expect(codes(diffToolSchemas(previous, next).unknown)).toEqual([
      "input:$:enum-changed",
      "input:$:additional-properties-schema",
    ]);
  });

  test("reports complex enum values as unknown", () => {
    const diff = diffToolSchemas(tool({ enum: [{ kind: "old" }] }), tool({ enum: [{ kind: "new" }] }));
    expect(codes(diff.unknown)).toEqual(["input:$:enum-complex"]);
  });

  test("is deterministic and does not mutate inputs", () => {
    const previous = tool(object({ z: { type: "string" }, a: { type: "string" } }));
    const next = tool(object({ b: { type: "string" } }));
    const beforePrevious = JSON.stringify(previous);
    const beforeNext = JSON.stringify(next);
    const first = diffToolSchemas(previous, next);
    expect(diffToolSchemas(previous, next)).toEqual(first);
    expect(codes(first.breaking)).toEqual([
      "input:$.properties.a:property-removed",
      "input:$.properties.z:property-removed",
    ]);
    expect(JSON.stringify(previous)).toBe(beforePrevious);
    expect(JSON.stringify(next)).toBe(beforeNext);
  });

  test("returns no findings for equivalent schemas with reordered keys and variants", () => {
    const previous = tool({ properties: { b: { type: "number" }, a: { type: "string" } }, oneOf: [{ type: "string", title: "x" }] });
    const next = tool({ oneOf: [{ title: "x", type: "string" }], properties: { a: { type: "string" }, b: { type: "number" } } });
    expect(diffToolSchemas(previous, next)).toEqual({ breaking: [], nonBreaking: [], unknown: [] });
  });
});
