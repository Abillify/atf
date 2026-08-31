// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the XML classifier response format:
 *   - extractXmlToJson: parses XML into a flat key-value object
 *   - buildXmlSchemaHint: generates an XML example prompt from a JSON schema
 *
 * Fixtures use neutral, domain-agnostic labels (the engine must not know about
 * any specific flow's routing vocabulary).
 */

import { describe, test, expect } from "bun:test";
import { extractXmlToJson, buildXmlSchemaHint } from "../exec-runtime.js";

// ---------------------------------------------------------------------------
// extractXmlToJson
// ---------------------------------------------------------------------------

describe("extractXmlToJson", () => {
  const classifierSchema = {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["ALPHA", "BETA", "GAMMA", "DELTA"],
        description: "Target category",
      },
      tag: { type: "string", description: "Tag name" },
      flagA: { type: "boolean", description: "Boolean flag A" },
      flagB: { type: "boolean", description: "Boolean flag B" },
      flagC: { type: "boolean", description: "Boolean flag C" },
    },
    required: ["category", "flagA"],
  };

  test("parses a well-formed XML response", () => {
    const xml = `<response>
  <category>GAMMA</category>
  <tag></tag>
  <flagA>false</flagA>
  <flagB>false</flagB>
  <flagC>false</flagC>
</response>`;

    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).toEqual({
      category: "GAMMA",
      tag: "",
      flagA: false,
      flagB: false,
      flagC: false,
    });
  });

  test("coerces boolean values (true)", () => {
    const xml = `<response>
  <category>ALPHA</category>
  <flagA>true</flagA>
</response>`;
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.category).toBe("ALPHA");
    expect(result.flagA).toBe(true);
  });

  test("handles XML wrapped in fenced code block", () => {
    const xml =
      "```xml\n<response>\n  <category>DELTA</category>\n  <flagA>false</flagA>\n</response>\n```";
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.category).toBe("DELTA");
    expect(result.flagA).toBe(false);
  });

  test("handles XML wrapped in plain fenced code block (no xml tag)", () => {
    const xml =
      "```\n<response>\n  <category>GAMMA</category>\n  <flagA>true</flagA>\n</response>\n```";
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.category).toBe("GAMMA");
  });

  test("falls back to JSON parsing if model emits JSON despite XML instructions", () => {
    const json = '{"category": "BETA", "flagA": true, "tag": "ValueX"}';
    const result = extractXmlToJson(json, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.category).toBe("BETA");
    expect(result.flagA).toBe(true);
    expect(result.tag).toBe("ValueX");
  });

  test("handles tags without a root element", () => {
    const xml = `<category>GAMMA</category>
<flagA>false</flagA>
<flagC>true</flagC>`;
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.category).toBe("GAMMA");
    expect(result.flagA).toBe(false);
    expect(result.flagC).toBe(true);
  });

  test("handles leading/trailing whitespace around values", () => {
    const xml = `<response>
  <category>  GAMMA  </category>
  <flagA>  false  </flagA>
</response>`;
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.category).toBe("GAMMA");
    expect(result.flagA).toBe(false);
  });

  test("returns null for empty/unrecognisable text", () => {
    expect(extractXmlToJson("", classifierSchema)).toBeNull();
    expect(extractXmlToJson("no xml here at all", classifierSchema)).toBeNull();
  });

  test("handles empty string values for tag content", () => {
    const xml = `<response>
  <category>GAMMA</category>
  <tag></tag>
  <flagA>false</flagA>
</response>`;
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.tag).toBe("");
  });

  test("parses a full classifier-like response with all fields", () => {
    const xml = `<response>
  <category>BETA</category>
  <tag>ValueX</tag>
  <flagA>true</flagA>
  <flagB>false</flagB>
  <flagC>false</flagC>
</response>`;
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).toEqual({
      category: "BETA",
      tag: "ValueX",
      flagA: true,
      flagB: false,
      flagC: false,
    });
  });

  test("handles case-insensitive boolean parsing", () => {
    const xml = `<response>
  <category>GAMMA</category>
  <flagA>FALSE</flagA>
  <flagC>TRUE</flagC>
</response>`;
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.flagA).toBe(false);
    expect(result.flagC).toBe(true);
  });

  test("handles number type coercion", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        score: { type: "number" },
      },
    };
    const xml = `<response>
  <name>test</name>
  <count>42</count>
  <score>0.95</score>
</response>`;
    const result = extractXmlToJson(xml, schema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.name).toBe("test");
    expect(result.count).toBe(42);
    expect(result.score).toBe(0.95);
  });

  test("preserves unknown tags not in schema as strings", () => {
    const xml = `<response>
  <category>GAMMA</category>
  <unknownField>some value</unknownField>
  <flagA>false</flagA>
</response>`;
    const result = extractXmlToJson(xml, classifierSchema);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a parsed result");
    expect(result.unknownField).toBe("some value");
  });
});

// ---------------------------------------------------------------------------
// buildXmlSchemaHint
// ---------------------------------------------------------------------------

describe("buildXmlSchemaHint", () => {
  test("generates XML example for a basic schema", () => {
    const schema = {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["A", "B", "C"],
          description: "Target category",
        },
        flagA: {
          type: "boolean",
          description: "Whether a detail is needed",
        },
      },
      required: ["category"],
    };

    const hint = buildXmlSchemaHint(schema);
    expect(hint).toContain("<response>");
    expect(hint).toContain("</response>");
    expect(hint).toContain("<category>");
    expect(hint).toContain("A|B|C");
    expect(hint).toContain("<flagA>");
    expect(hint).toContain("true|false");
    expect(hint).toContain("XML");
  });

  test("marks optional fields", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", description: "A name" },
        age: { type: "integer", description: "Age" },
      },
      required: ["name"],
    };
    const hint = buildXmlSchemaHint(schema);
    // 'name' is required — should NOT have (optional)
    expect(hint).toMatch(/<name>.*<\/name>(?!\s*\(optional\))/);
    // 'age' is NOT required — should have (optional)
    expect(hint).toContain("(optional)");
  });

  test("handles enum with empty string", () => {
    const schema = {
      type: "object",
      properties: {
        tag: {
          type: "string",
          enum: ["ValueX", "ValueY", ""],
          description: "Tag name",
        },
      },
      required: ["tag"],
    };
    const hint = buildXmlSchemaHint(schema);
    expect(hint).toContain("(empty string)");
    expect(hint).toContain("ValueX");
  });

  test("handles schema with no properties", () => {
    const schema = { type: "object" };
    const hint = buildXmlSchemaHint(schema);
    expect(hint).toContain("<response>");
    expect(hint).toContain("</response>");
  });
});
