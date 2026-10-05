// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LLM node `config.turnContext`: per-request context (here a classifier's
 * image transcription) is appended to the newest user turn — never to the
 * system prompt — and omitted when every referenced placeholder is empty.
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { AppConfig } from "../../config/index.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import { resolveTurnContext } from "../exec-runtime.js";
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

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const IMAGE_CONTEXT = "Tabelle Offene Auftragspositionen ohne Spalte Aktionskennzeichen";

const flow: FlowDefinition = {
  id: "turn-context-flow",
  name: "Turn context",
  nodes: [
    {
      id: "cls",
      type: "classifier",
      systemPrompt: "Transcribe the image.",
      classifierSchema: {
        classKey: "status",
        schema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["enriched", "unchanged"] },
            imageContext: { type: "string" },
          },
          required: ["status", "imageContext"],
        },
      },
      config: {
        responseFormat: "json",
        inputFilter: "current-turn-attachments",
        fallback: { status: "unchanged", imageContext: "" },
      },
    },
    {
      id: "resp",
      type: "llm",
      systemPrompt: "Du bist ein Analyst.",
      // Attest vision so the image turn reaches the mock model.
      llm: { provider: "openai", model: "mock-model", parameters: { visionInput: true } },
      config: {
        turnContext: "Bildkontext: {{node.cls.classification.imageContext}}",
      },
    },
  ],
  edges: [{ source: "cls", target: "resp" }],
};

type Prompt = LanguageModelV3CallOptions["prompt"];

const usage = {
  inputTokens: {
    total: 7,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

async function run(content: unknown, executionId: string): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  const map = new Map([[flow.id, flow]]);
  const registry: FlowRegistry = {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    llmProviderFactory: () =>
      new MockLanguageModelV3({
        doGenerate: async () =>
          mkGenerateResult(
            JSON.stringify({ status: "enriched", imageContext: IMAGE_CONTEXT }),
            5,
            5,
          ) as never,
        doStream: async (options: LanguageModelV3CallOptions) => {
          prompts.push(options.prompt);
          return {
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
                controller.enqueue({ type: "text-end", id: "t" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage,
                });
                controller.close();
              },
            }),
          } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
        },
      }),
  });
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: content as never }],
    { ssoToken: "a.b.c", executionId },
    async () => {},
    async () => {},
  );
  return prompts;
}

const textOf = (message: Prompt[number] | undefined): string =>
  message === undefined
    ? ""
    : typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);

describe("LLM node — config.turnContext", () => {
  test("classifier output lands in the newest user turn, not the system prompt", async () => {
    const prompts = await run(
      [
        { type: "text", text: "Bewerte die Meldung" },
        { type: "image_url", image_url: { url: PNG_1PX } },
      ],
      "exec-turn-context",
    );
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? [];
    const system = prompt.filter((message) => message.role === "system");
    const lastUser = prompt.findLast((message) => message.role === "user");
    expect(textOf(lastUser)).toContain(`Bildkontext: ${IMAGE_CONTEXT}`);
    for (const message of system) {
      expect(textOf(message)).not.toContain("Bildkontext");
    }
  });

  test("empty classifier value → the block is omitted entirely", async () => {
    const prompts = await run("Bewerte die Meldung", "exec-turn-context-empty");
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).not.toContain("Bildkontext");
  });
});

describe("resolveTurnContext", () => {
  const ctx: RequestContext = { ssoToken: "a.b.c", executionId: "exec-unit" };
  const ns = {
    node: {
      cls: { classification: { imageContext: "Bild", empty: "  " }, classLabel: "x" },
    },
  };

  test("resolves and trims", () => {
    expect(
      resolveTurnContext(
        "  Bildkontext: {{node.cls.classification.imageContext}}  ",
        ctx,
        ns,
      ),
    ).toBe("Bildkontext: Bild");
  });

  test("omitted when every referenced placeholder is empty", () => {
    expect(
      resolveTurnContext(
        "A: {{node.cls.classification.empty}} B: {{node.missing.classification.x}}",
        ctx,
        ns,
      ),
    ).toBeUndefined();
  });

  test("kept when at least one placeholder has a value", () => {
    expect(
      resolveTurnContext(
        "A: {{node.cls.classification.empty}} B: {{node.cls.classification.imageContext}}",
        ctx,
        ns,
      ),
    ).toBe("A:    B: Bild");
  });

  test("static text and unknown roots are sent as-is; non-strings are ignored", () => {
    expect(resolveTurnContext("Nur Text {{foo.bar}}", ctx, ns)).toBe(
      "Nur Text {{foo.bar}}",
    );
    expect(resolveTurnContext(undefined, ctx, ns)).toBeUndefined();
    expect(resolveTurnContext(42, ctx, ns)).toBeUndefined();
    expect(resolveTurnContext("   ", ctx, ns)).toBeUndefined();
  });
});
