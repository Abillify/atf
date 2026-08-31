// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for media-generation tools (`buildMediaTools` + `uniqueMediaToolKey`).
 *
 * A media tool wraps a dedicated generation model configured inline under an
 * `llm` node's `config.mediaTools`. When the hosting model calls it, the engine
 * runs the configured model, streams any produced media back to the client via
 * the `emit` hook, and returns a short text confirmation to the hosting model
 * (never the raw bytes).
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { Tool } from "ai";
import { buildMediaTools, uniqueMediaToolKey } from "../agent-tools.js";
import type { FlowNode } from "../../types/flow.js";
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

/** Builds an `llm` node carrying a single `generate_image` media tool. */
function nodeWithMediaTool(): FlowNode {
  return {
    id: "responder",
    type: "llm",
    config: {
      mediaTools: [
        {
          name: "generate_image",
          description: "Generate an image.",
          promptDescription: "What to draw.",
          llm: {
            provider: "google",
            model: "mock-image-model",
            parameters: {
              providerOptions: { google: { responseModalities: ["IMAGE"] } },
            },
          },
        },
      ],
    },
  };
}

/**
 * A provider factory returning a model whose generate yields one image file.
 *
 * The generated-file part's `data` field is now a tagged union at runtime
 * (`{ type: "data", data: <base64|bytes> }` or `{ type: "url", url }`) —
 * matching what real provider packages such as `@ai-sdk/google@4.x` emit and
 * what `ai@7`'s internal `asContent()` normaliser expects. The installed
 * `@ai-sdk/provider@4.0.3` `.d.ts` for `LanguageModelV3File.data` is still the
 * OLDER flat `string | Uint8Array` shape (a type/runtime lag between the
 * "V3" provider spec's declared and actual contract in this SDK generation —
 * verified against the real `@ai-sdk/google` source and the passing test
 * runtime behaviour). The inner cast documents and isolates that mismatch to
 * this one fixture rather than fighting the stale declaration file.
 */
function imageModelFactory(base64: string, mediaType = "image/png") {
  return () =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: "file",
            data: { type: "data", data: base64 },
            mediaType,
          },
        ] as unknown as Array<{
          type: "file";
          data: string | Uint8Array;
          mediaType: string;
        }>,
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: mkUsage(3, 4),
        warnings: [],
      }),
    }) as unknown as import("ai").LanguageModel;
}

/** A provider factory returning a model that yields only text (no media). */
function textOnlyModelFactory(text: string) {
  return () =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: mkUsage(3, 4),
        warnings: [],
      }),
    }) as unknown as import("ai").LanguageModel;
}

type ExecutableTool = Tool & {
  execute: (args: { prompt: string }, opts: unknown) => Promise<unknown>;
};

describe("buildMediaTools", () => {
  test("returns an empty set when the node declares no media tools", () => {
    const tools = buildMediaTools(
      { id: "n", type: "llm" },
      {
        appConfig: baseConfig,
        llmProviderFactory: imageModelFactory("AAAA"),
        emit: async () => {},
      },
    );
    expect(Object.keys(tools)).toHaveLength(0);
  });

  test("exposes a tool keyed by the configured name", () => {
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("AAAA"),
      emit: async () => {},
    });
    expect(Object.keys(tools)).toEqual(["generate_image"]);
  });

  test("streams the generated image as a markdown data-URI and confirms to the model", async () => {
    const emitted: string[] = [];
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("BASE64DATA", "image/png"),
      emit: async (t) => {
        emitted.push(t);
      },
    });
    const tool = tools.generate_image as ExecutableTool;
    const result = (await tool.execute({ prompt: "a red cat" }, {})) as {
      status: string;
      generated: number;
    };

    const streamed = emitted.join("");
    expect(streamed).toContain("![](data:image/png;base64,BASE64DATA)");
    expect(result.status).toBe("ok");
    expect(result.generated).toBe(1);
    // The model-facing result must not carry the raw bytes.
    expect(JSON.stringify(result)).not.toContain("BASE64DATA");
  });

  test("emits a short media URL (not a data-URI) when publishMedia is available", async () => {
    const emitted: string[] = [];
    const published: Array<{ base64: string; mediaType: string }> = [];
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("BASE64DATA", "image/png"),
      publishMedia: (base64, mediaType) => {
        published.push({ base64, mediaType });
        return "https://example.test/media/abc-123.png";
      },
      emit: async (t) => {
        emitted.push(t);
      },
    });
    const tool = tools.generate_image as ExecutableTool;
    const result = (await tool.execute({ prompt: "a red cat" }, {})) as {
      status: string;
      generated: number;
    };

    const streamed = emitted.join("");
    // A single small URL frame — no inline base64 at all.
    expect(streamed).toContain("![](https://example.test/media/abc-123.png)");
    expect(streamed).not.toContain("BASE64DATA");
    expect(streamed).not.toContain("data:image");
    expect(emitted).toHaveLength(1);
    expect(published).toEqual([
      { base64: "BASE64DATA", mediaType: "image/png" },
    ]);
    expect(result.status).toBe("ok");
    expect(result.generated).toBe(1);
  });

  test("falls back to a data-URI when publishMedia returns undefined", async () => {
    const emitted: string[] = [];
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("BASE64DATA", "image/png"),
      publishMedia: () => undefined,
      emit: async (t) => {
        emitted.push(t);
      },
    });
    const tool = tools.generate_image as ExecutableTool;
    await tool.execute({ prompt: "a red cat" }, {});
    expect(emitted.join("")).toContain("![](data:image/png;base64,BASE64DATA)");
  });

  test("returns no_media (and emits nothing) when the model yields no file", async () => {
    const emitted: string[] = [];
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: textOnlyModelFactory("I cannot draw that."),
      emit: async (t) => {
        emitted.push(t);
      },
    });
    const tool = tools.generate_image as ExecutableTool;
    const result = (await tool.execute({ prompt: "x" }, {})) as {
      status: string;
      message: string;
    };

    expect(emitted).toHaveLength(0);
    expect(result.status).toBe("no_media");
    expect(result.message).toContain("I cannot draw that.");
  });

  test("reports a provider error instead of throwing when the model cannot be built", async () => {
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: () => {
        throw new Error("no api key");
      },
      emit: async () => {},
    });
    const tool = tools.generate_image as ExecutableTool;
    const result = (await tool.execute({ prompt: "x" }, {})) as {
      error: string;
    };
    expect(result.error).toBe("media_provider_error");
  });
});

describe("uniqueMediaToolKey", () => {
  test("sanitises invalid identifier characters", () => {
    const key = uniqueMediaToolKey({}, "generate image!");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("disambiguates a collision with a numeric suffix", () => {
    const existing: Record<string, unknown> = {};
    const k1 = uniqueMediaToolKey(existing, "gen");
    existing[k1] = true;
    const k2 = uniqueMediaToolKey(existing, "gen");
    expect(k1).toBe("gen");
    expect(k2).toBe("gen_2");
  });

  test("falls back to a default when the name is empty", () => {
    expect(uniqueMediaToolKey({}, "")).toBe("media_tool");
  });
});
