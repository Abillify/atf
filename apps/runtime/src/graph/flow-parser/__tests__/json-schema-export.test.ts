// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { buildFlowJsonSchema, FLOW_SCHEMA_ID } from "../json-schema-export.js";
import { validateFlowDefinition } from "../../flow-parser.js";

const fixture = { id: "public-schema-fixture", name: "Public schema fixture", nodes: [{ id: "start", type: "llm" }], edges: [] };

describe("buildFlowJsonSchema", () => {
  test("produces a deterministic draft-2020-12 top-level schema", () => {
    const schema = buildFlowJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(FLOW_SCHEMA_ID);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["id", "name", "nodes", "edges"]));
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
