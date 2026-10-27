// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test for the classifier's system-message placement.
 *
 * A classifier that runs after a tool node with `injectResultContext` (e.g. in a
 * production flow: folder-listing tool → mode classifier) receives the tool node's live-result system
 * message inside `state.messages` — AFTER the human turn. Strict chat templates
 * (vLLM's Qwen: "System message must be at the beginning") reject that with a
 * 500 Jinja error on every pool candidate, so the classifier silently lands on
 * `config.fallback` and the routing decision is lost (observed in a production
 * trace: every pool candidate failed, used_fallback=true, raw_output="").
 *
 * The classifier must therefore fold non-leading system messages into an
 * adjacent turn (`sanitizeSystemMessages`) before prepending its own prompt —
 * exactly the contract the llm handler already applies.
 */
import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import { mkGenerateResult } from "./v3-mock-helpers.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

function modeFlow(): FlowDefinition {
  return {
    id: "mode-flow",
    name: "Mode classifier",
    nodes: [
      {
        id: "mode",
        type: "classifier",
        systemPrompt: "Waehle einen Modus.",
        classifierSchema: {
          classKey: "mode",
          schema: {
            type: "object",
            properties: { mode: { type: "string", enum: ["lookup", "broad"] } },
            required: ["mode"],
          },
        },
        config: { responseFormat: "json" },
      },
    ],
    edges: [],
  };
}

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

async function runCapturing(
  messages: { role: "user" | "system" | "assistant"; content: string }[],
): Promise<LanguageModelV3Prompt> {
  let captured: LanguageModelV3Prompt = [];
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(modeFlow()),
    llmProviderFactory: () =>
      new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          captured = prompt;
          return mkGenerateResult(JSON.stringify({ mode: "lookup" }), 5, 5) as never;
        },
      }),
  });
  await engine.executeFlow(
    "mode-flow",
    messages as never,
    { ssoToken: "a.b.c", executionId: "exec-mode" },
    async () => {},
    async () => {},
  );
  return captured;
}

describe("classifier node — system messages stay provider-valid", () => {
  test("a mid-conversation system message is folded, never sent after the user turn", async () => {
    // Mirrors a production flow: a folder-listing tool node injected its live-result
    // context as a system message AFTER the human turn.
    const prompt = await runCapturing([
      { role: "user", content: "Welche Anforderungen gibt es an das Protokoll?" },
      {
        role: "system",
        content:
          "The following sources are ordered by relevance to the question. This is the result of a live tool query.",
      },
    ]);
    const systemIndices = prompt
      .map((m, i) => (m.role === "system" ? i : -1))
      .filter((i) => i >= 0);
    // Exactly one system message — the node's own prompt — and it leads.
    expect(systemIndices).toEqual([0]);
    // The injected context content is still delivered to the model, folded into
    // a non-system turn.
    const allText = prompt
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(allText).toContain("ordered by relevance");
  });

  test("a leading system message from the client stays ahead of every turn", async () => {
    const prompt = await runCapturing([
      { role: "system", content: "User Context: Kunde X" },
      { role: "user", content: "Frage" },
    ]);
    // The invariant strict templates require: no system message may appear
    // after a non-system turn. (The node prompt + the client's leading context
    // may both lead — that is provider-valid.)
    const firstNonSystem = prompt.findIndex((m) => m.role !== "system");
    const systemAfterTurn = prompt.findIndex(
      (m, i) => m.role === "system" && firstNonSystem !== -1 && i > firstNonSystem,
    );
    expect(systemAfterTurn).toBe(-1);
    const allText = prompt
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(allText).toContain("User Context: Kunde X");
  });
});
