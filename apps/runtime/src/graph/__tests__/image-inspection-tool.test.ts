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

/** Records each call the stubbed asset-fetch hook received. */
interface FetchAssetCall {
  assetId: string;
  region?: [number, number, number, number];
}

/** Builds the tool plus the registry/spy scaffolding around it. */
function fixture(options?: {
  answer?: string;
  fail?: boolean;
  maxAnswerChars?: number;
  description?: string;
  /** Pre-register N images so the run has known refs. */
  images?: number;
  /**
   * Stub asset-fetch hook. `bytes`/`mediaType` are returned on success; `throw`
   * makes it reject; leaving both undefined omits the hook entirely (so an
   * `asset:` reference is unresolvable). `undefinedResult` returns undefined
   * (an unavailable/forbidden asset).
   */
  fetchAsset?: {
    bytes?: Uint8Array;
    mediaType?: string;
    throw?: boolean;
    undefinedResult?: boolean;
  };
}) {
  const store = new InMemoryMediaStore();
  const registry = new HashedImageRefRegistry({ store });
  for (let i = 0; i < (options?.images ?? 1); i += 1) {
    registry.register(new Uint8Array([i + 1, 2, 3, 4]), "image/png");
  }
  const fetchAssetCalls: FetchAssetCall[] = [];
  const fetchAsset =
    options?.fetchAsset !== undefined
      ? async (
          assetId: string,
          opts: { region?: [number, number, number, number] },
        ): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> => {
          fetchAssetCalls.push({
            assetId,
            ...(opts.region !== undefined ? { region: opts.region } : {}),
          });
          if (options.fetchAsset?.throw === true) {
            throw new Error("get_asset boom");
          }
          if (options.fetchAsset?.undefinedResult === true) return undefined;
          return {
            bytes: options.fetchAsset?.bytes ?? new Uint8Array([9, 8, 7, 6]),
            mediaType: options.fetchAsset?.mediaType ?? "image/png",
          };
        }
      : undefined;
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
    ...(fetchAsset !== undefined ? { fetchAsset } : {}),
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
    fetchAssetCalls,
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

  // ── asset:<id>[#bbox] resolution (Req 16.3) ──────────────────────────────

  test("the tool description advertises asset:<id>[#bbox] references", () => {
    const { tools } = fixture({ fetchAsset: {} });
    const description = (
      tools[IMAGE_INSPECTION_TOOL_NAME] as unknown as { description: string }
    ).description;
    expect(description).toContain("asset:<id>");
    // The `image` parameter description also mentions the asset form, so the
    // model knows it may pass one. Assert against the serialized tool to avoid
    // coupling to the AI SDK's internal schema wrapper shape.
    expect(JSON.stringify(tools[IMAGE_INSPECTION_TOOL_NAME])).toContain(
      "asset:<id>",
    );
  });

  test("fetches a whole asset via the hook, parks it as img-N, and inspects it", async () => {
    const bytes = new Uint8Array([42, 43, 44, 45]);
    const { tool, registry, fetchAssetCalls, metrics } = fixture({
      images: 0,
      answer: "A signed contract.",
      fetchAsset: { bytes, mediaType: "image/jpeg" },
    });
    expect(registry.list()).toHaveLength(0);
    const result = await tool().execute(
      { image: "asset:abc-123", question: "Was steht drauf?" },
      { toolCallId: "call-asset" },
    );
    expect(result.status).toBe("ok");
    expect(result.description).toBe("A signed contract.");
    // The reference the model quoted is echoed back, not a rewritten img-N.
    expect(result.image).toBe("asset:abc-123");
    // The bytes were fetched with no region (whole asset) and parked.
    expect(fetchAssetCalls).toEqual([{ assetId: "abc-123" }]);
    expect(registry.list()).toHaveLength(1);
    // The vision sub-LLM was actually consulted.
    expect(metrics.llmCalls).toHaveLength(1);
    // The base64 of the fetched bytes never reaches the hosting model.
    expect(JSON.stringify(result)).not.toContain(
      Buffer.from(bytes).toString("base64"),
    );
  });

  test("passes the #bbox region to the asset fetch", async () => {
    const { tool, fetchAssetCalls } = fixture({
      images: 0,
      fetchAsset: {},
    });
    const result = await tool().execute(
      { image: "asset:fig-9#0.1,0.2,0.5,0.6", question: "Welche Farbe?" },
      {},
    );
    expect(result.status).toBe("ok");
    expect(fetchAssetCalls).toEqual([
      { assetId: "fig-9", region: [0.1, 0.2, 0.5, 0.6] },
    ]);
  });

  test("an unavailable or forbidden asset fails closed as unknown_image", async () => {
    const { tool, metrics } = fixture({
      images: 0,
      fetchAsset: { undefinedResult: true },
    });
    const result = await tool().execute(
      { image: "asset:secret-1", question: "Was ist das?" },
      {},
    );
    expect(result.status).toBe("unknown_image");
    expect(String(result.message)).toContain("not available or not authorized");
    // No vision call was made — nothing to look at.
    expect(metrics.llmCalls).toHaveLength(0);
  });

  test("a get_asset error fails closed without crashing or leaking its cause", async () => {
    const { tool } = fixture({
      images: 0,
      fetchAsset: { throw: true },
    });
    const result = await tool().execute(
      { image: "asset:boom", question: "Was ist das?" },
      {},
    );
    expect(result.status).toBe("unknown_image");
    expect(JSON.stringify(result)).not.toContain("get_asset boom");
  });

  test("a malformed asset reference is rejected with a clear error", async () => {
    const { tool, fetchAssetCalls, metrics } = fixture({
      images: 0,
      fetchAsset: {},
    });
    for (const bad of ["asset:", "asset:x#0.1,0.2", "asset:x#2,0,3,1", "asset:x#a,b,c,d"]) {
      const result = await tool().execute(
        { image: bad, question: "Was ist das?" },
        {},
      );
      expect(result.status).toBe("invalid_request");
    }
    // A malformed ref never reaches the fetch hook or the vision model.
    expect(fetchAssetCalls).toHaveLength(0);
    expect(metrics.llmCalls).toHaveLength(0);
  });

  test("an asset reference is unresolvable when no fetch hook is configured", async () => {
    // No fetchAsset stub → the hook is omitted (a node without assetSource).
    const { tool } = fixture({ images: 1 });
    const result = await tool().execute(
      { image: "asset:abc", question: "Was ist das?" },
      {},
    );
    expect(result.status).toBe("unknown_image");
  });

  test("inline img-N inspection is unchanged when a fetch hook is present", async () => {
    const { tool, fetchAssetCalls } = fixture({
      images: 1,
      answer: "Still a red cat.",
      fetchAsset: {},
    });
    const result = await tool().execute(
      { image: "img-1", question: "Was ist das?" },
      {},
    );
    expect(result.status).toBe("ok");
    expect(result.description).toBe("Still a red cat.");
    // The inline path must not touch the asset fetch.
    expect(fetchAssetCalls).toHaveLength(0);
  });
});
