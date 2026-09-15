// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Engine-level proof of the inline-image offload (see `image-reference.ts`).
 *
 * The registry and the `inspect_image` tool are covered in isolation elsewhere;
 * what an operator actually depends on is the wiring inside the real `llm`
 * handler: the base64 must be gone *before* the provider request is built, the
 * bytes must still be reachable afterwards, and a node that did not opt in must
 * behave exactly as it did before. These run a one-node flow through
 * `createGraphEngine` with a mock model that records the prompt and the tool set
 * it was handed, so a regression in the handler ordering fails here rather than
 * showing up as a silently ballooning prompt in production.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { FlowDefinition } from "../../types/flow.js";
import { createGraphEngine } from "../graph-engine.js";
import { InMemoryMediaStore } from "../media-store.js";
import type { MediaStore, StoredMedia } from "../media-store.js";
import { IMAGE_INSPECTION_TOOL_NAME } from "../image-reference.js";
import type { AppConfig } from "../../config/index.js";
import type {
  ChatCompletionChunk,
  ChatMessage,
  OpenAITool,
  TokenUsage,
} from "../../types/openai.js";

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
  defaultLlm: { provider: "openai", model: "text-mock" },
};

/** Distinctive payload so a leak into the prompt is greppable in a failure. */
const IMAGE_B64 =
  "aW1hZ2UtYnl0ZXMtdGhhdC1tdXN0LW5ldmVyLXJlYWNoLXRoZS1ob3N0aW5nLW1vZGVs";
const IMAGE_URL = `data:image/png;base64,${IMAGE_B64}`;

function imageMessages(): ChatMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "Was ist auf dem Bild?" },
        { type: "image_url", image_url: { url: IMAGE_URL } },
      ],
    },
  ];
}

/** A flow whose single `llm` node may or may not opt into image inspection. */
function flowWith(opts: {
  id: string;
  imageInspection?: boolean;
  visionInput?: boolean;
}): FlowDefinition {
  return {
    id: opts.id,
    name: opts.id,
    nodes: [
      {
        id: "answer",
        type: "llm",
        llm: {
          provider: "openai",
          model: "text-mock",
          ...(opts.visionInput === true
            ? { parameters: { visionInput: true } }
            : {}),
        },
        ...(opts.imageInspection === true
          ? {
              config: {
                imageInspection: {
                  llm: { provider: "openai", model: "vision-mock" },
                },
              },
            }
          : {}),
      },
    ],
    edges: [],
  };
}

/** Media store wrapper that records what the runtime parked in it. */
function spyMediaStore(): {
  store: MediaStore;
  puts: { bytes: Uint8Array; mediaType: string }[];
} {
  const inner = new InMemoryMediaStore();
  const puts: { bytes: Uint8Array; mediaType: string }[] = [];
  return {
    puts,
    store: {
      put(data: Uint8Array, mediaType: string): string | undefined {
        puts.push({ bytes: data, mediaType });
        return inner.put(data, mediaType);
      },
      get(id: string): StoredMedia | undefined {
        return inner.get(id);
      },
    },
  };
}

interface RunResult {
  /** Serialized provider prompts, one per model request. */
  prompts: string[];
  /** Serialized tool definitions handed to the model, per request. */
  toolSets: string[];
  chunks: ChatCompletionChunk[];
  error?: string;
}

async function runFlow(
  flow: FlowDefinition,
  messages: ChatMessage[],
  opts: { mediaStore?: MediaStore; clientTools?: OpenAITool[] } = {},
): Promise<RunResult> {
  const prompts: string[] = [];
  const toolSets: string[] = [];
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: {
      get: (id: string) => (id === flow.id ? flow : undefined),
      list: () => [flow],
    },
    llmProviderFactory: (() =>
      new MockLanguageModelV3({
        doStream: async (options) => {
          prompts.push(JSON.stringify(options.prompt ?? ""));
          toolSets.push(JSON.stringify(options.tools ?? []));
          return {
            stream: new ReadableStream({
              start(c: ReadableStreamDefaultController<unknown>) {
                c.enqueue({ type: "text-start", id: "1" });
                c.enqueue({
                  type: "text-delta",
                  id: "1",
                  delta: "auf dem Bild",
                });
                c.enqueue({ type: "text-end", id: "1" });
                c.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: 1,
                      text: undefined,
                      reasoning: undefined,
                    },
                  },
                });
                c.close();
              },
            }),
          } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
        },
      })) as never,
    ...(opts.mediaStore !== undefined ? { mediaStore: opts.mediaStore } : {}),
  });

  const chunks: ChatCompletionChunk[] = [];
  let error: string | undefined;
  try {
    await engine.executeFlow(
      flow.id,
      messages,
      {
        ssoToken: "a.b.c",
        executionId: `exec-${flow.id}`,
        clientId: "acme",
        ...(opts.clientTools !== undefined ? { clientTools: opts.clientTools } : {}),
      },
      async (c: ChatCompletionChunk) => {
        chunks.push(c);
      },
      async (_usage: TokenUsage) => {},
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    prompts,
    toolSets,
    chunks,
    ...(error !== undefined ? { error } : {}),
  };
}

function answerOf(result: RunResult): string {
  return result.chunks
    .map((c) => c.choices?.[0]?.delta?.content ?? "")
    .join("");
}

describe("inline-image offload in the live llm handler", () => {
  test("sends the reference instead of the bytes and exposes inspect_image", async () => {
    const media = spyMediaStore();
    const result = await runFlow(
      flowWith({ id: "offload-on", imageInspection: true }),
      imageMessages(),
      { mediaStore: media.store },
    );

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]).toContain("img-1");
    expect(result.prompts[0]).not.toContain(IMAGE_B64);
    expect(result.toolSets[0]).toContain(IMAGE_INSPECTION_TOOL_NAME);
    // The answer reaches the client unchanged — offloading is invisible to it.
    expect(answerOf(result)).toContain("auf dem Bild");
  });

  test("parks the bytes so inspect_image can read them back", async () => {
    const media = spyMediaStore();
    await runFlow(
      flowWith({ id: "offload-park", imageInspection: true }),
      imageMessages(),
      { mediaStore: media.store },
    );

    expect(media.puts).toHaveLength(1);
    expect(media.puts[0].mediaType).toBe("image/png");
    expect(Buffer.from(media.puts[0].bytes).toString("base64")).toBe(IMAGE_B64);
  });

  test("reuses one reference for the same image pasted twice", async () => {
    const media = spyMediaStore();
    const messages = [...imageMessages(), ...imageMessages()];
    const result = await runFlow(
      flowWith({ id: "offload-dedup", imageInspection: true }),
      messages,
      { mediaStore: media.store },
    );

    expect(media.puts).toHaveLength(1);
    expect(result.prompts[0]).toContain("img-1");
    expect(result.prompts[0]).not.toContain("img-2");
  });

  test("reserves a suffix when a caller exposes inspect_image", async () => {
    const result = await runFlow(
      flowWith({ id: "offload-client-collision", imageInspection: true }),
      imageMessages(),
      {
        mediaStore: spyMediaStore().store,
        clientTools: [
          {
            type: "function",
            function: {
              name: IMAGE_INSPECTION_TOOL_NAME,
              description: "Client-owned inspection tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    );

    // The caller's passthrough name remains available while the internal tool
    // is assigned its final collision-free key after all tool sources merge.
    expect(result.toolSets[0]).toContain('"name":"inspect_image"');
    expect(result.toolSets[0]).toContain('"name":"inspect_image_2"');
  });

  test("leaves the bytes inline when the node does not opt in", async () => {
    const media = spyMediaStore();
    const result = await runFlow(
      // `visionInput: true` attests that the model can see, so the request is
      // built instead of being skipped by the capability guard — what this case
      // pins down is what the provider receives, not the guard.
      flowWith({ id: "offload-off", visionInput: true }),
      imageMessages(),
      { mediaStore: media.store },
    );

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]).toContain(IMAGE_B64);
    expect(result.prompts[0]).not.toContain("img-1");
    expect(result.toolSets[0]).not.toContain(IMAGE_INSPECTION_TOOL_NAME);
    expect(media.puts).toHaveLength(0);
  });

  test("still rejects an inline image for a model without vision support", async () => {
    const media = spyMediaStore();
    const result = await runFlow(
      flowWith({ id: "offload-guard" }),
      imageMessages(),
      { mediaStore: media.store },
    );

    // No opt-in, no vision attestation: the guard must keep failing closed.
    expect(result.prompts).toHaveLength(0);
    expect(`${result.error ?? ""}${JSON.stringify(result.chunks)}`).toContain(
      "vision",
    );
  });
});
