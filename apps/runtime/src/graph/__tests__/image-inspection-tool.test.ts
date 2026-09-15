// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the `inspect_image` tool (`buildImageInspectionTools`).
 *
 * The tool is the read side of the image-reference indirection: inline images
 * were parked in the run registry as `img-N`, and this resolves one of them
 * again by asking a dedicated vision model. What matters here is that the
 * hosting model never sees bytes, that a bad reference explains itself with the
 * live reference list, that the vision spend is reported, and that a node which
 * did not opt in is left completely alone.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { Tool } from "ai";
import {
  buildImageInspectionTools,
  type AgentImageInspectionHooks,
} from "../agent-tools.js";
import {
  HashedImageRefRegistry,
  IMAGE_INSPECTION_TOOL_NAME,
} from "../image-reference.js";
import { InMemoryMediaStore } from "../media-store.js";
import type { ImageInspectionConfig } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import { mkUsage } from "./v3-mock-helpers.js";

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

const visionLlm: ImageInspectionConfig["llm"] = {
  provider: "google",
  model: "mock-vision-model",
};

const PROVIDER_ERROR_CANARY =
  "sk-secret-canary at https://private.internal/vision";

/** A provider factory whose model answers with the given text. */
function visionFactory(text: string, options?: { fail?: boolean }) {
  return () =>
    new MockLanguageModelV3({
      doGenerate: async () => {
        if (options?.fail === true) throw new Error(PROVIDER_ERROR_CANARY);
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: mkUsage(120, 40),
          warnings: [],
        };
      },
    }) as unknown as import("ai").LanguageModel;
}

type ExecutableTool = Tool & {
  execute: (
    args: { image: string; question: string },
    opts: { toolCallId?: string },
  ) => Promise<Record<string, unknown>>;
};

/** Builds the tool plus the registry/spy scaffolding around it. */
function fixture(options?: {
  answer?: string;
  fail?: boolean;
  maxAnswerChars?: number;
  description?: string;
  /** Pre-register N images so the run has known refs. */
  images?: number;
}) {
  const store = new InMemoryMediaStore();
  const registry = new HashedImageRefRegistry({ store });
  for (let i = 0; i < (options?.images ?? 1); i += 1) {
    registry.register(new Uint8Array([i + 1, 2, 3, 4]), "image/png");
  }
  const metrics: { llmCalls: unknown[][] } = { llmCalls: [] };
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const traces: unknown[][] = [];
  const diagnostics: unknown[] = [];
  const config: ImageInspectionConfig = {
    llm: visionLlm,
    ...(options?.maxAnswerChars !== undefined
      ? { maxAnswerChars: options.maxAnswerChars }
      : {}),
    ...(options?.description !== undefined
      ? { description: options.description }
      : {}),
  };
  const tools = buildImageInspectionTools({
    registry,
    config,
    appConfig: baseConfig,
    llmProviderFactory: visionFactory(options?.answer ?? "A red cat.", {
      ...(options?.fail === undefined ? {} : { fail: options.fail }),
    }),
    metrics: {
      recordLlmCall: (...call: unknown[]) => {
        metrics.llmCalls.push(call);
      },
    } as never,
    clientId: "client-1",
    nodeId: "answer",
    usage,
    setGenAiAttributes: (...attributes) => traces.push(attributes),
    onNodeDiagnostic: (...diagnostic) => diagnostics.push(diagnostic),
  } satisfies AgentImageInspectionHooks);
  return {
    registry,
    tools,
    metrics,
    usage,
    traces,
    diagnostics,
    tool: () => tools[IMAGE_INSPECTION_TOOL_NAME] as ExecutableTool,
  };
}

describe("buildImageInspectionTools", () => {
  test("returns an empty set when the config block has no vision model", () => {
    const tools = buildImageInspectionTools({
      registry: new HashedImageRefRegistry({
        store: new InMemoryMediaStore(),
      }),
      config: {} as ImageInspectionConfig,
      appConfig: baseConfig,
      llmProviderFactory: visionFactory("unused"),
    } as AgentImageInspectionHooks);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  test("exposes the tool under the well-known name", () => {
    const { tools } = fixture();
    expect(Object.keys(tools)).toEqual([IMAGE_INSPECTION_TOOL_NAME]);
  });

  test("uses a suffix instead of replacing an existing inspect_image tool", () => {
    const registry = new HashedImageRefRegistry({ store: new InMemoryMediaStore() });
    const tools = buildImageInspectionTools({
      registry,
      config: { llm: visionLlm },
      appConfig: baseConfig,
      llmProviderFactory: visionFactory("unused"),
      existingTools: { inspect_image: {} as never },
    });
    expect(Object.keys(tools)).toEqual(["inspect_image_2"]);
  });

  test("the description does not freeze a ref list (tools are built before offloading)", () => {
    const empty = fixture({ images: 0 });
    const populated = fixture({ images: 3 });
    const first = (
      empty.tools[IMAGE_INSPECTION_TOOL_NAME] as unknown as {
        description: string;
      }
    ).description;
    const second = (
      populated.tools[IMAGE_INSPECTION_TOOL_NAME] as unknown as {
        description: string;
      }
    ).description;
    // A description that embedded "currently available" refs would be stale on
    // the very first turn, because the images are parked after this call.
    expect(first).toBe(second);
    expect(first).toContain("img-N");
  });

  test("honours an explicit description override", () => {
    const { tools } = fixture({ description: "Bild prüfen." });
    const description = (
      tools[IMAGE_INSPECTION_TOOL_NAME] as unknown as { description: string }
    ).description;
    expect(description).toBe("Bild prüfen.");
  });

  test("answers with the vision model's text and reports the spend", async () => {
    const { tool, metrics, usage, traces } = fixture({ answer: "Rechnung über 149,90 €." });
    const result = await tool().execute(
      { image: "img-1", question: "Betrag?" },
      { toolCallId: "call-1" },
    );
    expect(result.status).toBe("ok");
    expect(result.description).toBe("Rechnung über 149,90 €.");
    expect(result.image).toBe("img-1");
    // The vision call is attributed, not hidden inside a tool result.
    expect(metrics.llmCalls).toHaveLength(1);
    expect(metrics.llmCalls[0]?.[1]).toBe("mock-vision-model");
    expect(usage).toMatchObject({ promptTokens: 120, completionTokens: 40, totalTokens: 160 });
    expect(traces[0]).toEqual([
      "call-1",
      { provider: "google", model: "mock-vision-model" },
      { inputTokens: 120, outputTokens: 40 },
    ]);
  });

  test("never returns the image bytes to the hosting model", async () => {
    const { tool, registry } = fixture();
    const stored = registry.resolve("img-1");
    expect(stored).toBeDefined();
    const result = await tool().execute(
      { image: "img-1", question: "Was ist das?" },
      {},
    );
    expect(JSON.stringify(result)).not.toContain(
      Buffer.from(stored?.data ?? new Uint8Array()).toString("base64"),
    );
  });

  test("an unknown reference reports the live list without echoing the input", async () => {
    const { tool } = fixture({ images: 2 });
    const result = await tool().execute(
      { image: PROVIDER_ERROR_CANARY, question: "Was ist das?" },
      {},
    );
    expect(result.status).toBe("unknown_image");
    expect(String(result.message)).not.toContain(PROVIDER_ERROR_CANARY);
    expect(String(result.message)).toContain("img-1");
    expect(String(result.message)).toContain("img-2");
  });

  test("an empty question is rejected without a vision call", async () => {
    const { tool, metrics } = fixture();
    const result = await tool().execute(
      { image: "img-1", question: "   " },
      {},
    );
    expect(result.status).toBe("invalid_request");
    expect(metrics.llmCalls).toHaveLength(0);
  });

  test("caps the answer at maxAnswerChars", async () => {
    const answer = "x".repeat(500);
    const { tool } = fixture({ answer, maxAnswerChars: 50 });
    const result = await tool().execute(
      { image: "img-1", question: "Beschreib das" },
      {},
    );
    expect(String(result.description).length).toBeLessThanOrEqual(51);
    expect(String(result.description).startsWith("x".repeat(50))).toBe(true);
  });

  test("a provider initialization failure does not disclose its cause", async () => {
    const registry = new HashedImageRefRegistry({
      store: new InMemoryMediaStore(),
    });
    registry.register(new Uint8Array([1, 2, 3]), "image/png");
    const diagnostics: unknown[] = [];
    const tools = buildImageInspectionTools({
      registry,
      config: { llm: visionLlm },
      appConfig: baseConfig,
      llmProviderFactory: () => {
        throw new Error(PROVIDER_ERROR_CANARY);
      },
      nodeId: "answer",
      onNodeDiagnostic: (...diagnostic) => diagnostics.push(diagnostic),
    });
    const tool = tools[IMAGE_INSPECTION_TOOL_NAME] as ExecutableTool;
    const result = await tool.execute(
      { image: "img-1", question: "Was ist das?" },
      {},
    );
    expect(result.status).toBe("vision_provider_error");
    expect(result.message).toBe("Could not initialise the vision model.");
    expect(JSON.stringify({ result, diagnostics })).not.toContain(
      PROVIDER_ERROR_CANARY,
    );
  });

  test("a provider failure degrades to a tool result, not a failed node", async () => {
    const { tool, metrics, traces, diagnostics } = fixture({ fail: true });
    const result = await tool().execute(
      { image: "img-1", question: "Was ist das?" },
      { toolCallId: "call-failed" },
    );
    expect(result.status).toBe("vision_call_failed");
    expect(result.message).toBe("Vision inspection failed.");
    expect(JSON.stringify(result)).not.toContain(PROVIDER_ERROR_CANARY);
    expect(metrics.llmCalls[0]?.[2]).toBe("error");
    expect(traces[0]?.[0]).toBe("call-failed");
    expect(diagnostics[0]).toBeDefined();
    expect(JSON.stringify(diagnostics)).not.toContain(PROVIDER_ERROR_CANARY);
  });
});
