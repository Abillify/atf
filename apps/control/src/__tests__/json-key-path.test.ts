// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";
import { jsonKeyPathAt, nodeDocKeyForPath } from "../lib/json-key-path";

/** Cursor offset of the (n+1)-th occurrence of `needle` in `text`. */
function at(text: string, needle: string, n = 0): number {
  let idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx === -1) throw new Error(`occurrence ${n} of ${needle} not found`);
  }
  return idx;
}

const LLM_FIELDS = [
  { key: "llm.shortcut", kind: "string" as const, label: "Shortcut", description: "d" },
  { key: "llm.parameters", kind: "object" as const, label: "Parameters", description: "d", fields: [
    { key: "temperature", kind: "number" as const, label: "Temperature", description: "d" },
    { key: "maxTokens", kind: "number" as const, label: "Max tokens", description: "d" },
  ] },
];

describe("jsonKeyPathAt", () => {
  test("top-level key", () => {
    const text = '{\n  "label": "Answer",\n  "type": "llm"\n}';
    expect(jsonKeyPathAt(text, at(text, "Answer"))).toBe("label");
    expect(jsonKeyPathAt(text, at(text, "llm"))).toBe("type");
  });

  test("nested path, cursor inside the value", () => {
    const text = '{\n  "llm": {\n    "parameters": {\n      "temperature": 0.2\n    }\n  }\n}';
    expect(jsonKeyPathAt(text, at(text, "0.2"))).toBe("llm.parameters.temperature");
    // Just past the closing brace of `parameters`, its own key is reported.
    expect(jsonKeyPathAt(text, at(text, "0.2") + 10)).toBe("llm.parameters");
    // Just past the closing brace of `llm`, the cursor belongs to `llm`.
    expect(jsonKeyPathAt(text, at(text, "0.2") + 13)).toBe("llm");
  });

  test("cursor inside a string keeps the enclosing key", () => {
    const text = '{\n  "systemPrompt": "long text here"\n}';
    expect(jsonKeyPathAt(text, at(text, "text here") + 2)).toBe("systemPrompt");
  });

  test("config keys and arrays inside config", () => {
    const text = '{\n  "config": {\n    "toolArgs": { "format": "json" },\n    "ragProfiles": [ { "collection": "kb" } ]\n  }\n}';
    expect(jsonKeyPathAt(text, at(text, "json"))).toBe("config.toolArgs.format");
    expect(jsonKeyPathAt(text, at(text, "kb"))).toBe("config.ragProfiles.collection");
  });

  test("key position (before the colon) reports that key", () => {
    const text = '{\n  "overrides": []\n}';
    expect(jsonKeyPathAt(text, at(text, "overrides") + 2)).toBe("overrides");
  });

  test("invalid mid-edit JSON still reports a path", () => {
    const text = '{\n  "llm": {\n    "model": "gpt",\n  ';
    // Unclosed braces: the last key read at the deepest open depth wins.
    expect(jsonKeyPathAt(text, text.length)).toBe("llm.model");
    expect(jsonKeyPathAt(text, at(text, "gpt"))).toBe("llm.model");
  });

  test("empty document / cursor at 0 → undefined", () => {
    expect(jsonKeyPathAt("", 0)).toBeUndefined();
    expect(jsonKeyPathAt("{}", 1)).toBeUndefined();
  });

  test("escaped quotes in keys and values", () => {
    const text = '{\n  "a\\"b": "v"\n}';
    // The key is reported as written (escape kept verbatim).
    expect(jsonKeyPathAt(text, at(text, "v"))).toBe('a\\"b');
  });
});

describe("nodeDocKeyForPath", () => {
  test("config.* maps to the bare (last) segment", () => {
    expect(nodeDocKeyForPath("config.maxToolSteps")).toBe("maxToolSteps");
    expect(nodeDocKeyForPath("config.toolArgs.format")).toBe("format");
    expect(nodeDocKeyForPath("config.ragProfiles.collection")).toBe("collection");
    expect(nodeDocKeyForPath("config")).toBeUndefined();
  });

  test("llm paths map to documented model fields", () => {
    expect(nodeDocKeyForPath("llm", LLM_FIELDS)).toBe("llm");
    expect(nodeDocKeyForPath("llm.shortcut", LLM_FIELDS)).toBe("llm.shortcut");
    expect(nodeDocKeyForPath("llm.parameters.temperature", LLM_FIELDS)).toBe(
      "llm.parameters.temperature",
    );
    // Undocumented model keys fall back to the llm node field.
    expect(nodeDocKeyForPath("llm.provider", LLM_FIELDS)).toBe("llm");
    expect(nodeDocKeyForPath("llm.parameters.unknown", LLM_FIELDS)).toBe("llm.parameters");
  });

  test("without llmFields every llm path falls back to llm", () => {
    expect(nodeDocKeyForPath("llm.parameters.temperature")).toBe("llm");
  });

  test("other top-level node fields pass through", () => {
    expect(nodeDocKeyForPath("label")).toBe("label");
    expect(nodeDocKeyForPath("overrides.0.whenClass")).toBe("overrides");
    expect(nodeDocKeyForPath(undefined)).toBeUndefined();
  });
});
