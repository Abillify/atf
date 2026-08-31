// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { validateArgs } from "../../src/tools/validate.ts";

describe("validateArgs", () => {
  it("passes when the schema is empty / unconstrained", () => {
    expect(validateArgs({ type: "object", properties: {}, required: [] }, {}).ok).toBe(true);
    expect(validateArgs(undefined, { anything: 1 }).ok).toBe(true);
  });

  it("flags a missing required property", () => {
    const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
    const res = validateArgs(schema, {});
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("id: required");
  });

  it("treats null as missing for required properties", () => {
    const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
    expect(validateArgs(schema, { id: null }).ok).toBe(false);
  });

  it("rejects a wrong property type", () => {
    const schema = { type: "object", properties: { n: { type: "number" } }, required: [] };
    const res = validateArgs(schema, { n: "not-a-number" });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("expected number");
  });

  it("accepts a whole-valued number as integer and number", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } }, required: [] };
    expect(validateArgs(schema, { n: 5 }).ok).toBe(true);
    expect(validateArgs(schema, { n: 5.5 }).ok).toBe(false);
  });

  it("enforces enum membership", () => {
    const schema = {
      type: "object",
      properties: { color: { type: "string", enum: ["red", "green"] } },
      required: [],
    };
    expect(validateArgs(schema, { color: "red" }).ok).toBe(true);
    expect(validateArgs(schema, { color: "blue" }).ok).toBe(false);
  });

  it("validates array item types", () => {
    const schema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: [],
    };
    expect(validateArgs(schema, { tags: ["a", "b"] }).ok).toBe(true);
    expect(validateArgs(schema, { tags: ["a", 2] }).ok).toBe(false);
  });

  it("recurses into nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        user: { type: "object", properties: { age: { type: "number" } }, required: ["age"] },
      },
      required: ["user"],
    };
    expect(validateArgs(schema, { user: { age: 30 } }).ok).toBe(true);
    expect(validateArgs(schema, { user: {} }).ok).toBe(false);
  });
});
