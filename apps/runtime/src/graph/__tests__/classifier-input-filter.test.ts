// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the classifier node's `config.inputFilter` attachment gate.
 *
 * An optional vision-preprocessing classifier (image transcription ahead of
 * retrieval) must NOT cost a full LLM round-trip on text-only turns: with
 * `inputFilter` set and no attachments present, the node resolves to
 * `config.fallback` without ever calling the model, and the trace records the
 * skip (classifier block + diagnostic) instead of a model call.
 */
import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
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

/** 1x1 transparent PNG — a valid image data URL for the content processor. */
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function classifierFlow(
  config: Record<string, unknown>,
): FlowDefinition {
  return {
    id: "skip-flow",
    name: "Classifier skip",
    nodes: [
      {
        id: "transcribe",
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
          fallback: { status: "unchanged", imageContext: "" },
          ...config,
        },
      },
    ],
    edges: [],
  };
}

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

type TraceNode = NonNullable<
  ReturnType<InMemoryDebugTraceStore["getTrace"]>
>["nodes"][number];

interface RunResult {
  modelCalls: number;
  node: TraceNode | undefined;
}

async function runClassifier(
  flow: FlowDefinition,
  content: unknown,
): Promise<RunResult> {
  let modelCalls = 0;
  const debugStore = new InMemoryDebugTraceStore();
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: () =>
      new MockLanguageModelV3({
        doGenerate: async () => {
          modelCalls += 1;
          return mkGenerateResult(
            JSON.stringify({ status: "enriched", imageContext: "ein Bild" }),
            5,
            5,
          ) as never;
        },
      }),
  });
  engine.setDebugStore?.(debugStore);
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: content as never }],
    { ssoToken: "a.b.c", executionId: `exec-${flow.id}` },
    async () => {},
    async () => {},
  );
  const node = debugStore
    .getTrace(`exec-${flow.id}`)
    ?.nodes.find((entry) => entry.node_id === "transcribe");
  return { modelCalls, node };
}

describe("classifier node — config.inputFilter attachment gate", () => {
  test("skips the model call on a text-only turn and uses config.fallback", async () => {
    const result = await runClassifier(
      classifierFlow({ inputFilter: "current-turn-attachments" }),
      "hallo",
    );
    expect(result.modelCalls).toBe(0);
    expect(result.node?.status).toBe("completed");
    expect(result.node?.classifier?.used_fallback).toBe(true);
    expect(result.node?.classifier?.class_label).toBe("unchanged");
    expect(result.node?.classifier?.parsed).toEqual({
      status: "unchanged",
      imageContext: "",
    });
    expect(
      result.node?.diagnostics?.some(
        (d) => d.code === "classifier_skipped_no_attachments",
      ),
    ).toBe(true);
  });

  test("runs the model when the latest user message carries an image", async () => {
    const result = await runClassifier(
      classifierFlow({ inputFilter: "current-turn-attachments" }),
      [
        { type: "text", text: "Was ist auf dem Bild?" },
        { type: "image_url", image_url: { url: PNG_1PX } },
      ],
    );
    expect(result.modelCalls).toBe(1);
    expect(result.node?.classifier?.class_label).toBe("enriched");
  });

  test("current-turn-attachments ignores an image from an earlier turn", async () => {
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(
        classifierFlow({ inputFilter: "current-turn-attachments" }),
      ),
      llmProviderFactory: () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error("model must not be called");
          },
        }),
    });
    // Two turns threaded: the FIRST carries the image, the latest is text-only.
    // Without checkpointing both messages arrive in one request, so
    // `current-turn-attachments` must look only at the LAST user message.
    await engine.executeFlow(
      "skip-flow",
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Bildfrage" },
            { type: "image_url", image_url: { url: PNG_1PX } },
          ] as never,
        },
        { role: "assistant", content: "Bildantwort" },
        { role: "user", content: "und jetzt ohne bild?" },
      ],
      { ssoToken: "a.b.c", executionId: "exec-current-turn" },
      async () => {},
      async () => {},
    );
  });

  test("attachments looks at the whole conversation", async () => {
    const result = await runClassifier(
      classifierFlow({ inputFilter: "attachments" }),
      [
        {
          type: "text",
          text: "Bildfrage",
        },
        { type: "image_url", image_url: { url: PNG_1PX } },
      ],
    );
    expect(result.modelCalls).toBe(1);
  });

  test("without inputFilter the classifier always runs (unchanged)", async () => {
    const result = await runClassifier(classifierFlow({}), "hallo");
    expect(result.modelCalls).toBe(1);
    expect(result.node?.classifier?.class_label).toBe("enriched");
  });

  test("inputFilter without config.fallback warns and still runs the model", async () => {
    const flow: FlowDefinition = {
      id: "skip-flow-nofb",
      name: "Classifier skip no fallback",
      nodes: [
        {
          id: "transcribe",
          type: "classifier",
          systemPrompt: "Transcribe the image.",
          classifierSchema: {
            classKey: "status",
            schema: {
              type: "object",
              properties: { status: { type: "string" } },
              required: ["status"],
            },
          },
          config: { inputFilter: "current-turn-attachments" },
        },
      ],
      edges: [],
    };
    const debugStore = new InMemoryDebugTraceStore();
    let modelCalls = 0;
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(flow),
      llmProviderFactory: () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            modelCalls += 1;
            return mkGenerateResult(
              JSON.stringify({ status: "enriched" }),
              5,
              5,
            ) as never;
          },
        }),
    });
    engine.setDebugStore?.(debugStore);
    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "hallo" }],
      { ssoToken: "a.b.c", executionId: `exec-${flow.id}` },
      async () => {},
      async () => {},
    );
    expect(modelCalls).toBe(1);
    const node = debugStore
      .getTrace(`exec-${flow.id}`)
      ?.nodes.find((entry) => entry.node_id === "transcribe");
    expect(
      node?.diagnostics?.some(
        (d) => d.code === "classifier_input_filter_without_fallback",
      ),
    ).toBe(true);
  });
});
