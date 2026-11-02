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
import type { ModelMessage, Tool } from "ai";
import type { ImageModelV4, ImageModelV4Result } from "@ai-sdk/provider";
import {
  buildMediaTools,
  editMediaToolNames,
  uniqueMediaToolKey,
} from "../agent-tools.js";
import type { FlowNode } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import {
  HashedImageRefRegistry,
  rehydrateMediaRefs,
} from "../image-reference.js";
import { InMemoryMediaStore } from "../media-store.js";
import { mkUsage } from "./v3-mock-helpers.js";

const PROVIDER_ERROR_CANARY =
  "sk-secret-canary at https://private.internal/media";

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
 * Per the V3 provider spec (`LanguageModelV3File.data`), a generated-file
 * part's `data` is the FLAT base64 string (or bytes). ai@7.0.143's v3→v4
 * model adapter wraps it into the tagged union
 * (`{ type: "data", data: <base64|bytes> }`) that its internal content
 * normaliser consumes; passing the tagged union in a V3 mock would be
 * double-wrapped and surface as an object on `result.files[].base64`.
 * Real provider packages (all `@ai-sdk/*@4.x`, spec v4) emit the tagged
 * union themselves and never take this adapter path.
 */
function imageModelFactory(base64: string, mediaType = "image/png") {
  return () =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: "file",
            data: base64,
            mediaType,
          },
        ],
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

  test("reports the effective args as key-value JSON before running", async () => {
    // The live graph's INPUT panel must show the real { prompt } payload, not
    // the key-only placeholder that onToolCall records (pre-DLP policy). Local
    // tools have no egress DLP, so the execute site is the authoritative place
    // to fire the effective-args report — mirroring the MCP tool path.
    const effectiveArgs: Array<{
      toolCallId: string;
      toolName: string;
      argsJson: string;
    }> = [];
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("BASE64DATA", "image/png"),
      emit: async () => {},
      onEffectiveArgs: (toolCallId, toolName, argsJson) => {
        effectiveArgs.push({ toolCallId, toolName, argsJson });
      },
    });
    const tool = tools.generate_image as ExecutableTool;
    await tool.execute({ prompt: "a red cat" }, { toolCallId: "call-7" });
    expect(effectiveArgs).toHaveLength(1);
    expect(effectiveArgs[0]?.toolCallId).toBe("call-7");
    expect(effectiveArgs[0]?.toolName).toBe("generate_image");
    expect(JSON.parse(effectiveArgs[0]?.argsJson ?? "")).toEqual({
      prompt: "a red cat",
    });
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
        throw new Error(PROVIDER_ERROR_CANARY);
      },
      emit: async () => {},
    });
    const tool = tools.generate_image as ExecutableTool;
    const result = (await tool.execute({ prompt: "x" }, {})) as {
      error: string;
      message: string;
    };
    expect(result.error).toBe("media_provider_error");
    expect(result.message).toBe("Could not initialise the media model.");
    expect(JSON.stringify(result)).not.toContain(PROVIDER_ERROR_CANARY);
  });

  test("does not disclose a media generation provider failure", async () => {
    const tools = buildMediaTools(nodeWithMediaTool(), {
      appConfig: baseConfig,
      llmProviderFactory: () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error(PROVIDER_ERROR_CANARY);
          },
        }) as unknown as import("ai").LanguageModel,
      emit: async () => {},
    });
    const tool = tools.generate_image as ExecutableTool;
    const result = (await tool.execute({ prompt: "x" }, {})) as {
      error: string;
      message: string;
    };
    expect(result.error).toBe("media_generation_failed");
    expect(result.message).toBe("Media generation failed.");
    expect(JSON.stringify(result)).not.toContain(PROVIDER_ERROR_CANARY);
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

// ---------------------------------------------------------------------------
// Images-API media tools (`mode: image-generation` / `image-edit`)
//
// A dedicated image server (mflux behind LiteLLM, DALL·E, gpt-image) answers
// only on the OpenAI *images* API. The chat path above can never reach it — a
// chat provider does not parse image output — so these tools run
// `generateImage()` on an injected `ImageModelV4` instead. What is under test
// is everything the mode adds around that call: reference resolution, the
// newest-image fallback, the size passthrough, and the error vocabulary the
// hosting model needs to recover.
// ---------------------------------------------------------------------------

/** What the injected image model was asked to do. */
interface ImageCall {
  prompt: string | undefined;
  files: { type: string; mediaType: string; data: string | Uint8Array }[] | undefined;
  size: string | undefined;
  n: number;
  seed: number | undefined;
  aspectRatio: string | undefined;
  providerOptions: unknown;
}

/**
 * A minimal `ImageModelV4` returning one PNG, recording the call options it saw.
 * `generateImage()` sniffs the media type from the bytes and defaults to
 * `image/png`, so the payload here is a real (tiny) PNG header.
 */
function imageModelStub(
  onCall: (call: ImageCall) => void | Promise<void>,
  options?: { images?: string[]; usage?: ImageModelV4Result["usage"] },
): ImageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test.images",
    modelId: "stub-image-model",
    maxImagesPerCall: 4,
    supportsFileInputs: true,
    async doGenerate(call) {
      await onCall(call as unknown as ImageCall);
      const images = options?.images ?? [PNG_BASE64];
      return {
        images,
        // An empty answer is final here. Without this the SDK classifies it as
        // a retryable miss and re-calls the model until the retries run out.
        ...(images.length === 0 ? { isRetryable: false } : {}),
        warnings: [],
        response: {
          timestamp: new Date(0),
          modelId: "stub-image-model",
          headers: {},
        },
        ...(options?.usage !== undefined ? { usage: options.usage } : {}),
      };
    },
  };
}

/** The base64 of a 1×1 PNG — enough for the SDK's media-type sniffing. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** A node declaring one images-API media tool with the given mode. */
function nodeWithImagesTool(
  mode: "image-generation" | "image-edit",
  overrides?: Record<string, unknown>,
): FlowNode {
  return {
    id: "responder",
    type: "llm",
    config: {
      mediaTools: [
        {
          name: mode === "image-edit" ? "edit_image" : "generate_image",
          mode,
          defaultSize: "1024x1024",
          llm: { provider: "litellm", model: "qwen-image" },
          ...overrides,
        },
      ],
    },
  };
}

function newRegistry(): HashedImageRefRegistry {
  return new HashedImageRefRegistry({ store: new InMemoryMediaStore({}) });
}

/** Deterministic non-PNG bytes, used as a distinguishable "attached" picture. */
function otherPngBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(48);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 7 + i) % 251;
  return bytes;
}

type EditExecutableTool = Tool & {
  execute: (
    args: Record<string, unknown>,
    opts: unknown,
  ) => Promise<Record<string, unknown>>;
};

describe("media tools — images API (mode image-generation)", () => {
  test("calls generateImage with the prompt and the configured size", async () => {
    const calls: ImageCall[] = [];
    const emitted: string[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub((c) => void calls.push(c)),
      emit: async (t) => {
        emitted.push(t);
      },
    });
    const tool = tools.generate_image as EditExecutableTool;
    const result = await tool.execute({ prompt: "a red cat" }, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("a red cat");
    expect(calls[0]?.files).toBeUndefined();
    expect(calls[0]?.size).toBe("1024x1024");
    expect(result.status).toBe("ok");
    expect(result.generated).toBe(1);
    expect(emitted.join("")).toContain("data:image/png;base64,");
  });

  test("drops a malformed or too-small defaultSize instead of sending it", async () => {
    const sizes: (string | undefined)[] = [];
    for (const defaultSize of ["wide", "32x32", "1024X768", " 512 x 512 "]) {
      const tools = buildMediaTools(
        nodeWithImagesTool("image-generation", { defaultSize }),
        {
          appConfig: baseConfig,
          llmProviderFactory: imageModelFactory("unused"),
          imageProviderFactory: () =>
            imageModelStub((c) => void sizes.push(c.size)),
          emit: async () => {},
        },
      );
      await (tools.generate_image as EditExecutableTool).execute(
        { prompt: "x" },
        {},
      );
    }
    // Malformed and sub-64 sizes degrade to the server default (undefined);
    // the accepted ones normalise to `WxH`.
    expect(sizes).toEqual([undefined, undefined, "1024x768", "512x512"]);
  });

  test("parks the produced image as img-N and names the edit tool", async () => {
    const registry = newRegistry();
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}),
      imageRefs: registry,
      emit: async () => {},
    });
    const result = await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "a red cat" },
      {},
    );
    expect(result.image_refs).toEqual(["img-1"]);
    expect(String(result.message)).toContain("img-1");
    expect(registry.resolve("img-1")).toBeDefined();
  });

  test("publishes a URL instead of a data-URI when publishMedia is wired", async () => {
    const emitted: string[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}),
      publishMedia: () => "https://media.test/abc.png",
      emit: async (t) => {
        emitted.push(t);
      },
    });
    await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "x" },
      {},
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("![](https://media.test/abc.png)");
  });

  test("reports media_mode_unsupported for a provider without an images endpoint", async () => {
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => {
        throw new Error(
          'Provider "googleai" (protocol google) has no OpenAI-compatible images endpoint.',
        );
      },
      emit: async () => {},
    });
    const result = await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "x" },
      {},
    );
    expect(result.error).toBe("media_mode_unsupported");
    // A configuration mistake must name the provider so the operator fixes the
    // flow rather than retrying the prompt.
    expect(String(result.message)).toContain("googleai");
  });

  test("reports media_provider_error without leaking the failure detail", async () => {
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => {
        throw new Error(PROVIDER_ERROR_CANARY);
      },
      emit: async () => {},
    });
    const result = await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "x" },
      {},
    );
    expect(result.error).toBe("media_provider_error");
    expect(result.message).toBe("Could not initialise the media model.");
    expect(JSON.stringify(result)).not.toContain(PROVIDER_ERROR_CANARY);
  });

  test("reports media_generation_failed when the call throws", async () => {
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () =>
        imageModelStub(() => {
          throw new Error(PROVIDER_ERROR_CANARY);
        }),
      emit: async () => {},
    });
    const result = await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "x" },
      {},
    );
    expect(result.error).toBe("media_generation_failed");
    expect(result.message).toBe("Media generation failed.");
    expect(JSON.stringify(result)).not.toContain(PROVIDER_ERROR_CANARY);
  });

  test("reports no_media when the model returns no image", async () => {
    const emitted: string[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}, { images: [] }),
      emit: async (t) => {
        emitted.push(t);
      },
    });
    const result = await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "x" },
      {},
    );
    expect(emitted).toHaveLength(0);
    expect(result.status).toBe("no_media");
  });

  test("counts the call in metrics even when the server reports no usage", async () => {
    // mflux answers without a `usage` block. Dropping the sample there would
    // make every self-hosted image generation invisible in the per-model
    // metrics, which the chat path (Gemini) always reported.
    const llmCalls: unknown[][] = [];
    const spend: number[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}),
      emit: async () => {},
      metrics: {
        recordLlmCall: (...a: unknown[]) => {
          llmCalls.push(a);
        },
      } as never,
      costTracker: {
        record: async (_t: string, amount: number) => {
          spend.push(amount);
        },
      } as never,
      clientId: "acme",
    });
    await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "x" },
      { toolCallId: "call-1" },
    );
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]?.[0]).toBe("litellm");
    expect(llmCalls[0]?.[1]).toBe("qwen-image");
    expect(llmCalls[0]?.[3]).toBe(0);
    expect(llmCalls[0]?.[4]).toBe(0);
    // Zero tokens means zero cost, so spend accounting stays untouched.
    expect(llmCalls[0]?.[5]).toBe(0);
    expect(spend).toHaveLength(0);
  });

  test("accounts for tokens and cost when the server does report usage", async () => {
    const llmCalls: unknown[][] = [];
    const spend: number[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-generation"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () =>
        imageModelStub(() => {}, {
          usage: { inputTokens: 1_000, outputTokens: 2_000, totalTokens: 3_000 },
        }),
      emit: async () => {},
      pricingOverrides: { "litellm/qwen-image": { prompt: 1, completion: 1 } },
      metrics: {
        recordLlmCall: (...a: unknown[]) => {
          llmCalls.push(a);
        },
      } as never,
      costTracker: {
        record: async (_t: string, amount: number) => {
          spend.push(amount);
        },
      } as never,
      clientId: "acme",
    });
    await (tools.generate_image as EditExecutableTool).execute(
      { prompt: "x" },
      { toolCallId: "call-2" },
    );
    expect(llmCalls[0]?.[3]).toBe(1_000);
    expect(llmCalls[0]?.[4]).toBe(2_000);
    expect(spend).toEqual([0.003]);
  });
});

describe("media tools — images API (mode image-edit)", () => {
  test("resolves a named img-N and sends its bytes to the model", async () => {
    const registry = newRegistry();
    registry.register(otherPngBytes(3), "image/png");
    const calls: ImageCall[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub((c) => void calls.push(c)),
      imageRefs: registry,
      emit: async () => {},
    });
    const result = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "mach das Logo größer", image: "img-1" },
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("mach das Logo größer");
    expect(calls[0]?.files).toHaveLength(1);
    expect(calls[0]?.files?.[0]?.mediaType).toBe("image/png");
    expect(calls[0]?.size).toBe("1024x1024");
    expect(result.status).toBe("ok");
  });

  test("resolves a quoted /v1/media URL to the same bytes", async () => {
    // In a later turn the model has usually only seen the published URL, so it
    // quotes that instead of the img-N handle.
    const store = new InMemoryMediaStore({});
    const registry = new HashedImageRefRegistry({ store });
    const id = store.put(otherPngBytes(4), "image/png");
    if (id === undefined) throw new Error("test setup: media rejected");
    const calls: ImageCall[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub((c) => void calls.push(c)),
      imageRefs: registry,
      emit: async () => {},
    });
    const result = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "schreib CCCP drauf", image: `https://example/v1/media/${id}.png` },
      {},
    );
    expect(result.status).toBe("ok");
    expect(calls[0]?.files).toHaveLength(1);
  });

  test("still reports unknown_image for a URL whose media is gone", async () => {
    const registry = newRegistry();
    registry.register(otherPngBytes(5), "image/png");
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}),
      imageRefs: registry,
      emit: async () => {},
    });
    const result = await (tools.edit_image as EditExecutableTool).execute(
      {
        prompt: "x",
        image: "https://example/v1/media/00000000-0000-4000-8000-000000000000.png",
      },
      {},
    );
    expect(result.status).toBe("unknown_image");
  });

  test("falls back to the newest image when no reference is named", async () => {
    // A vision-capable host sees the attached picture and reasonably expects
    // "mache das heller" to apply to it without quoting a handle it never got.
    const registry = newRegistry();
    registry.register(otherPngBytes(1), "image/png");
    const newest = otherPngBytes(2);
    registry.register(newest, "image/png");
    const calls: ImageCall[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub((c) => void calls.push(c)),
      imageRefs: registry,
      emit: async () => {},
    });
    const result = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "heller" },
      {},
    );
    expect(result.status).toBe("ok");
    const sent = calls[0]?.files?.[0]?.data;
    expect(sent instanceof Uint8Array ? Buffer.from(sent).toString("hex") : sent)
      .toBe(Buffer.from(newest).toString("hex"));
  });

  test("reports no_image_available when nothing has been shown yet", async () => {
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}),
      imageRefs: newRegistry(),
      emit: async () => {},
    });
    const result = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "heller" },
      {},
    );
    expect(result.status).toBe("no_image_available");
    expect(String(result.message)).toContain("kein Bild");
  });

  test("lists the live references when the model names an unknown one", async () => {
    const registry = newRegistry();
    registry.register(otherPngBytes(4), "image/png");
    const calls: ImageCall[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub((c) => void calls.push(c)),
      imageRefs: registry,
      emit: async () => {},
    });
    const result = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "x", image: "img-9" },
      {},
    );
    expect(result.status).toBe("unknown_image");
    expect(String(result.message)).toContain("img-9");
    expect(String(result.message)).toContain("img-1");
    // The generation slot must not be spent on a request that cannot work.
    expect(calls).toHaveLength(0);
  });

  test("fails closed without an image store rather than generating from text", async () => {
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}),
      emit: async () => {},
    });
    const result = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "x", image: "img-1" },
      {},
    );
    expect(result.error).toBe("media_input_unavailable");
  });

  test("accepts several references up to maxInputImages", async () => {
    const registry = newRegistry();
    registry.register(otherPngBytes(5), "image/png");
    registry.register(otherPngBytes(6), "image/png");
    const calls: ImageCall[] = [];
    const tools = buildMediaTools(
      nodeWithImagesTool("image-edit", { maxInputImages: 3 }),
      {
        appConfig: baseConfig,
        llmProviderFactory: imageModelFactory("unused"),
        imageProviderFactory: () => imageModelStub((c) => void calls.push(c)),
        imageRefs: registry,
        emit: async () => {},
      },
    );
    const result = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "verschmelze beide", image: ["img-1", "img-2"] },
      {},
    );
    expect(result.status).toBe("ok");
    expect(calls[0]?.files).toHaveLength(2);
  });

  test("reports the effective args as prompt plus resolved references", async () => {
    const registry = newRegistry();
    registry.register(otherPngBytes(7), "image/png");
    const effective: string[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () => imageModelStub(() => {}),
      imageRefs: registry,
      emit: async () => {},
      onEffectiveArgs: (_id, _name, argsJson) => {
        effective.push(argsJson);
      },
    });
    await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "heller", image: "img-1" },
      { toolCallId: "call-3" },
    );
    expect(JSON.parse(effective[0] ?? "")).toEqual({
      prompt: "heller",
      image: ["img-1"],
    });
  });

  test("advertises the image argument as optional", () => {
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      emit: async () => {},
    });
    const schema = (
      tools.edit_image as {
        inputSchema: { jsonSchema?: { required?: string[] } };
      }
    ).inputSchema.jsonSchema;
    expect(schema?.required).toEqual(["prompt"]);
  });
});

describe("editMediaToolNames", () => {
  test("returns the keys of a node's edit-mode media tools", () => {
    const node: FlowNode = {
      id: "n",
      type: "llm",
      config: {
        mediaTools: [
          {
            name: "generate_image",
            mode: "image-generation",
            llm: { provider: "litellm", model: "qwen-image" },
          },
          {
            name: "edit_image",
            mode: "image-edit",
            llm: { provider: "litellm", model: "qwen-image-edit" },
          },
        ],
      },
    };
    expect(editMediaToolNames(node)).toEqual(["edit_image"]);
  });

  test("is empty for a chat-mode node (the legacy default)", () => {
    expect(editMediaToolNames(nodeWithMediaTool())).toEqual([]);
  });

  test("reports the de-duplicated key a colliding name actually gets", () => {
    const node: FlowNode = {
      id: "n",
      type: "llm",
      config: {
        mediaTools: [
          { name: "edit_image", llm: { provider: "google", model: "a" } },
          {
            name: "edit_image",
            mode: "image-edit",
            llm: { provider: "litellm", model: "b" },
          },
        ],
      },
    };
    // The placeholder must name the tool the model can actually call.
    expect(editMediaToolNames(node)).toEqual(["edit_image_2"]);
    expect(Object.keys(buildMediaTools(node, {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("AAAA"),
      emit: async () => {},
    }))).toEqual(["edit_image", "edit_image_2"]);
  });

  test("is empty for a node without media tools", () => {
    expect(editMediaToolNames({ id: "n", type: "llm" })).toEqual([]);
  });
});

// Two-turn regression: generation in turn 1, edit in turn 2.
// After rehydration the edit tool should resolve the published URL back to
// img-1 and the model should call edit_image(image="img-1").
describe("media tools — two-turn generation then edit (regression)", () => {
  test("rehydrates a published URL back to img-1 so edit_image resolves", async () => {
    const registry = newRegistry();
    const store = new InMemoryMediaStore({});
    const bytes = otherPngBytes(42);
    const id = store.put(bytes, "image/png");
    expect(id).toBeDefined();
    const BASE = "https://aiperator.example";
    const publishedUrl = `${BASE}/v1/media/${id}.png`;

    // Turn 1: generate_image tool result (what the model saw after generation),
    // mirroring the shape the engine persists: the tool output object sits one
    // level inside the tool-result part.
    const turn1ToolResult = {
      role: "assistant",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_b8763016",
          toolName: "generate_image",
          output: {
            type: "json",
            value: [
              {
                status: "ok",
                generated: 1,
                image_refs: ["img-1"],
                message:
                  'Generated 1 media file(s) and displayed it to the user. Do not repeat the media as text or a data URI. To change one of these images, call the image-edit tool with the reference img-1.',
              },
            ],
          },
        },
        {
          type: "text",
          text: `\n\n![](${publishedUrl})\n\n`,
        },
      ],
    } as unknown as ModelMessage;

    // Turn 2: user asks to edit (no img-1 in the prompt — the model only
    // saw the published URL in turn 1's assistant message).
    const turn2User: ModelMessage = {
      role: "user",
      content: "schreib CCCP drauf",
    };

    const history: ModelMessage[] = [turn1ToolResult, turn2User];

    // Rehydrate: this is what llm-message-build does before sending to the model.
    const result = rehydrateMediaRefs(
      history,
      registry,
      store,
      BASE,
      { editToolName: "edit_image" },
    );

    // The URL should have been replaced by a placeholder containing img-1.
    expect(result.rehydrated).toBe(1);
    expect(result.refs).toContain("img-1");
    expect(result.unresolved).toBe(0);

    // The rewritten assistant message should contain the placeholder text.
    const rewritten = result.messages[0] as ModelMessage;
    const content = rewritten.content as Array<{ type: string; text?: string }>;
    const textPart = content.find((p) => p.type === "text");
    expect(textPart?.text).toBeTypeOf("string");
    expect(textPart?.text).toContain("img-1");
    expect(textPart?.text).toContain("edit_image");

    // Now build the edit tool with the rehydrated registry.
    const editCalls: ImageCall[] = [];
    const tools = buildMediaTools(nodeWithImagesTool("image-edit"), {
      appConfig: baseConfig,
      llmProviderFactory: imageModelFactory("unused"),
      imageProviderFactory: () =>
        imageModelStub((c) => void editCalls.push(c)),
      imageRefs: registry,
      emit: async () => {},
    });

    // The model, seeing img-1 in the placeholder, calls edit_image(image="img-1").
    const editResult = await (tools.edit_image as EditExecutableTool).execute(
      { prompt: "mach das Logo größer", image: "img-1" },
      {},
    );

    expect(editResult.status).toBe("ok");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.files).toHaveLength(1);
    expect(editCalls[0]?.files?.[0]?.mediaType).toBe("image/png");
  });
});
