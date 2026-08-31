// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { resolveModelShortcuts, type ModelShortcutsData } from "../model-shortcuts.js";

const shortcuts: ModelShortcutsData = {
  engines: { local: { provider: "openai" }, cloud: { provider: "bedrock" } },
  modelPresets: { structured: { model: "example/structured", parameters: { maxTokens: 512 } }, general: { model: "example/general" } },
  shortcuts: { "local-structured": { engine: "local", model: "structured" }, "cloud-general": { engine: "cloud", model: "general" } },
};

function fixture() {
  return { nodes: [
    { id: "classifier", type: "llm", llm: { shortcut: "local-structured" }, config: { outputSchema: { name: "result", schema: { type: "object", required: ["status"] } } } },
    { id: "responder", type: "llm", llm: { shortcut: "cloud-general", parameters: { maxTokens: 256 } } },
  ] } as Record<string, unknown>;
}

describe("model shortcuts resolve in public fixtures", () => {
  test("expands provider, model, and parameters while removing the shortcut", () => {
    const raw = fixture();
    resolveModelShortcuts(raw, shortcuts, "fixture.yaml");
    const nodes = raw.nodes as Array<{ llm: Record<string, unknown> }>;
    expect(nodes[0]?.llm).toMatchObject({ provider: "openai", model: "example/structured", parameters: { maxTokens: 512 } });
    expect(nodes[0]?.llm.shortcut).toBeUndefined();
    expect(nodes[1]?.llm).toMatchObject({ provider: "bedrock", model: "example/general", parameters: { maxTokens: 256 } });
  });

  test("preserves a machine-enforced structured-output declaration", () => {
    const raw = fixture();
    const classifier = (raw.nodes as Array<{ config: { outputSchema: { name: string; schema: { required: string[] } } } }>)[0];
    expect(classifier?.config.outputSchema.name).toBe("result");
    expect(classifier?.config.outputSchema.schema.required).toContain("status");
  });
});
