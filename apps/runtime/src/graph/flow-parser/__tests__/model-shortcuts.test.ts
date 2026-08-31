// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "bun:test";
import {
  resolveModelShortcuts,
  type ModelShortcutsData,
} from "../model-shortcuts.js";

const DATA: ModelShortcutsData = {
  engines: {
    lmstudio: { provider: "openai", credential: "lmstudio" },
    bedrock: { provider: "bedrock", credential: "bedrock-eu" },
  },
  modelPresets: {
    qwen: {
      model: "qwen/qwen3.6-35b-a3b",
      parameters: {
        reasoningEffort: "none",
        chatTemplateKwargs: { enable_thinking: false },
      },
    },
    haiku: { model: "eu.anthropic.claude-haiku" },
  },
  shortcuts: {
    "qwen-local": { engine: "lmstudio", model: "qwen" },
    haiku: { engine: "bedrock", model: "haiku" },
    "qwen-hot": {
      engine: "lmstudio",
      model: "qwen",
      parameters: { temperature: 0.9 },
    },
  },
};

function nodeWithLlm(llm: Record<string, unknown>): Record<string, unknown> {
  return { nodes: [{ id: "n1", type: "llm", llm }] };
}

function firstLlm(raw: Record<string, unknown>): Record<string, unknown> {
  const node = (raw.nodes as Array<Record<string, unknown>>)[0];
  if (node === undefined) throw new Error("expected a first node");
  return node.llm as Record<string, unknown>;
}

describe("resolveModelShortcuts", () => {
  test("expands shortcut to provider + model + preset params, dropping shortcut", () => {
    const raw = nodeWithLlm({ shortcut: "qwen-local" });
    resolveModelShortcuts(raw, DATA, "f");
    const llm = firstLlm(raw);
    expect(llm.shortcut).toBeUndefined();
    expect(llm.provider).toBe("openai");
    expect(llm.model).toBe("qwen/qwen3.6-35b-a3b");
    expect(llm.parameters).toEqual({
      reasoningEffort: "none",
      chatTemplateKwargs: { enable_thinking: false },
    });
  });

  test("node parameters win over preset parameters", () => {
    const raw = nodeWithLlm({
      shortcut: "qwen-local",
      parameters: { temperature: 0.2, reasoningEffort: "high" },
    });
    resolveModelShortcuts(raw, DATA, "f");
    const params = firstLlm(raw).parameters as Record<string, unknown>;
    // node override wins over preset
    expect(params.reasoningEffort).toBe("high");
    expect(params.temperature).toBe(0.2);
    // preset value still present when node does not override it
    expect(params.chatTemplateKwargs).toEqual({ enable_thinking: false });
  });

  test("precedence preset < shortcut < node", () => {
    const raw = nodeWithLlm({
      shortcut: "qwen-hot",
      parameters: { maxTokens: 100 },
    });
    resolveModelShortcuts(raw, DATA, "f");
    const params = firstLlm(raw).parameters as Record<string, unknown>;
    // shortcut sets temperature 0.9 (over preset), node adds maxTokens
    expect(params.temperature).toBe(0.9);
    expect(params.maxTokens).toBe(100);
    expect(params.reasoningEffort).toBe("none");
  });

  test("cloud shortcut yields no thinking params", () => {
    const raw = nodeWithLlm({ shortcut: "haiku", parameters: { maxTokens: 256 } });
    resolveModelShortcuts(raw, DATA, "f");
    const llm = firstLlm(raw);
    expect(llm.provider).toBe("bedrock");
    expect(llm.model).toBe("eu.anthropic.claude-haiku");
    expect(llm.parameters).toEqual({ maxTokens: 256 });
  });

  test("unknown shortcut is left intact (so Zod rejects it)", () => {
    const raw = nodeWithLlm({ shortcut: "does-not-exist" });
    resolveModelShortcuts(raw, DATA, "f");
    const llm = firstLlm(raw);
    expect(llm.shortcut).toBe("does-not-exist");
    expect(llm.provider).toBeUndefined();
  });

  test("expands nested locations: plannerLlm and mediaTools[].llm", () => {
    const raw = {
      nodes: [
        {
          id: "orch",
          type: "agent-harness",
          config: {
            plannerLlm: { shortcut: "haiku" },
            mediaTools: [{ name: "gen", llm: { shortcut: "qwen-local" } }],
          },
        },
      ],
    };
    resolveModelShortcuts(raw, DATA, "f");
    const cfg = (raw.nodes[0] as { config: Record<string, unknown> }).config;
    expect((cfg.plannerLlm as Record<string, unknown>).provider).toBe(
      "bedrock",
    );
    const media = cfg.mediaTools as Array<{ llm: Record<string, unknown> }>;
    const media0 = media[0];
    if (media0 === undefined) throw new Error("expected a first media tool");
    expect(media0.llm.provider).toBe("openai");
    expect(media0.llm.model).toBe("qwen/qwen3.6-35b-a3b");
  });

  test("no-op when a node has no shortcut", () => {
    const raw = nodeWithLlm({ provider: "openai", model: "gpt-4o" });
    resolveModelShortcuts(raw, DATA, "f");
    expect(firstLlm(raw)).toEqual({ provider: "openai", model: "gpt-4o" });
  });
});
