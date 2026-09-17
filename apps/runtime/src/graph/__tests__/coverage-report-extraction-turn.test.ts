// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression tests for the message shape of the schema-enforced coverage-report
 * extraction call (`requestCoverageReport`, "structured-after-tools").
 *
 * ## The incident this pins down
 *
 * `requestCoverageReport` is called with the coverage worker's own reply, so the
 * naive message list is `[system, ...workerMessages]` and therefore ends on an
 * ASSISTANT turn. On llama.cpp that shape is fatal for a constrained-decoding
 * call: the server reads a trailing assistant message as a prefill to CONTINUE
 * and then has to seed the `json_schema` grammar with that free-text prefix.
 * The prefix is not a valid prefix of the report grammar, so sampler/grammar
 * setup aborts and the whole request fails closed with
 * `HTTP 400 "Failed to initialize samplers"` before a single token is sampled.
 *
 * Verified against a live llama.cpp endpoint (build b10975) serving
 * Qwen3.8-Flash-Next:
 *   - `[system, assistant]` + `response_format` → HTTP 400, for BOTH
 *     `json_schema` and `json_object` (so it is the constraint, not the schema);
 *   - `[system, assistant]` WITHOUT any `response_format` → 200 OK;
 *   - `[system, assistant, user]` + the very same schema → 200 OK with a fully
 *     valid 25-document report.
 *
 * Consequence in production: EVERY coverage report of a run was refused as
 * `structured_output_failed`, the queue never moved (0 reviewed / 0 excluded of
 * 838 documents), the harness stopped on `stagnation-limit` and the synthesizer
 * could only emit a fail-closed partial answer.
 *
 * The contract pinned here is therefore: the extraction prompt must NEVER end on
 * an assistant turn, and the worker's analysis must still reach the model.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { ModelMessage } from "ai";
import type { ExecRuntime, UsageAccumulator } from "../graph-engine.js";
import type { AppConfig } from "../../config/index.js";
import type { LlmConfig } from "../../types/flow.js";
import { requestCoverageReport } from "../agent-harness/tools.js";
import type { CoverageAssignment } from "../agent-harness/coverage.js";

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
} as AppConfig;

/** Local llama.cpp / vLLM style config: resolves to the `response_format` path. */
const workerLlm: LlmConfig = {
  provider: "openai",
  model: "Qwen3.8-Flash-Next",
};

/**
 * Synthetic document ref. The shape matters — a nested path with a date prefix
 * and a section suffix, i.e. what the coverage queue actually carries — the
 * content does not, so this is deliberately a made-up sample document.
 */
const REF = "/2024-01-02_Musterakte/anlage-1.pdf/1. Abschnitt";

const assignment: CoverageAssignment = {
  id: "coverage-1",
  mode: "summary",
  documents: [{ ref: REF, title: "anlage-1.pdf", summary: "Musterinhalt" }],
} as unknown as CoverageAssignment;

const VALID_REPORT =
  '{"assignmentId":"coverage-1","documents":' +
  `[{"ref":${JSON.stringify(REF)},"decision":"excluded","reason":"nicht einschlaegig"}]}`;

interface Harness {
  runtime: ExecRuntime;
  /** Role sequence of every prompt the model was called with. */
  roles: string[][];
  /** Full flattened text of every prompt. */
  texts: string[];
  /** The LlmConfig each provider-factory call received. */
  configs: LlmConfig[];
}

function harness(responseText = VALID_REPORT): Harness {
  const roles: string[][] = [];
  const texts: string[] = [];
  const configs: LlmConfig[] = [];

  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt as Array<{
        role?: string;
        content?: unknown;
      }>;
      roles.push(prompt.map((p) => p.role ?? "?"));
      texts.push(
        prompt
          .map((p) =>
            typeof p.content === "string"
              ? p.content
              : JSON.stringify(p.content),
          )
          .join("\n"),
      );
      return {
        content: [{ type: "text" as const, text: responseText }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 100,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  const usage: UsageAccumulator = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  const runtime = {
    appConfig: baseConfig,
    ctx: { ssoToken: "t", executionId: "exec-1", clientId: "poc" },
    usage,
    llmProviderFactory: (cfg: LlmConfig) => {
      configs.push(cfg);
      return model;
    },
    onNodeDiagnostic: () => {},
    metrics: {
      recordLlmCall: () => {},
    } as unknown as ExecRuntime["metrics"],
    costTracker: { record: () => {} },
  } as unknown as ExecRuntime;

  return { runtime, roles, texts, configs };
}

const WORKER_PROSE =
  "Alle zugewiesenen Dokumente betreffen den Musterablauf und haben " +
  "keinen Bezug zum Pruefkriterium.";

const workerReply: ModelMessage[] = [
  { role: "assistant", content: WORKER_PROSE } as ModelMessage,
];

describe("coverage-report extraction never ends on an assistant turn", () => {
  test("a trailing assistant worker reply gets a user turn appended", async () => {
    const h = harness();

    const result = await requestCoverageReport(
      h.runtime,
      workerLlm,
      assignment,
      workerReply,
      "Fasse deine vorstehende Analyse in einem Coverage-Report zusammen.",
      12288,
    );

    // The call happened and produced a valid report.
    expect(h.roles).toHaveLength(1);
    expect(result.report?.assignmentId).toBe("coverage-1");
    expect(result.defect).toBeUndefined();

    // THE contract: the prompt must not end on an assistant turn, or llama.cpp
    // rejects the constrained call with "Failed to initialize samplers".
    const roles = h.roles[0] ?? [];
    expect(roles[roles.length - 1]).not.toBe("assistant");
    expect(roles[roles.length - 1]).toBe("user");

    // The system instruction and the worker's analysis both still reach the
    // model — appending a turn must not drop context.
    expect(h.texts[0]).toContain("Coverage-Report");
    expect(h.texts[0]).toContain("Pruefkriterium");
  });

  test("a worker reply that already ends on a user/tool turn is left unchanged", async () => {
    const h = harness();

    // Some worker turns end on a tool result rather than an assistant message;
    // that shape is already valid and must not grow a synthetic turn.
    const endsOnTool: ModelMessage[] = [
      { role: "assistant", content: WORKER_PROSE } as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "vectorsearch/search",
            output: { type: "text", value: "hit" },
          },
        ],
      } as unknown as ModelMessage,
    ];

    await requestCoverageReport(
      h.runtime,
      workerLlm,
      assignment,
      endsOnTool,
      "Fasse deine vorstehende Analyse in einem Coverage-Report zusammen.",
      12288,
    );

    const roles = h.roles[0] ?? [];
    expect(roles[roles.length - 1]).toBe("tool");
    // system + assistant + tool, with nothing appended.
    expect(roles).toEqual(["system", "assistant", "tool"]);
  });

  test("a provider rejection is reported as a defect, not thrown", async () => {
    // llama.cpp's HTTP 400 surfaces as a thrown provider error. The harness must
    // keep the assignment open via a stable defect code instead of crashing the
    // whole run.
    const h = harness();
    const failing = {
      ...h.runtime,
      llmProviderFactory: () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error("Failed to initialize samplers: std::exception");
          },
        }),
    } as unknown as ExecRuntime;

    const result = await requestCoverageReport(
      failing,
      workerLlm,
      assignment,
      workerReply,
      "Fasse deine vorstehende Analyse in einem Coverage-Report zusammen.",
      12288,
    );

    expect(result.report).toBeUndefined();
    expect(result.defect).toBe("structured_output_failed");
  });
});

/**
 * The extraction call is pure format conversion under a grammar that pins every
 * field, so a hybrid-reasoning model's thinking tokens buy nothing — and they are
 * billed against the SAME output ceiling as the report, so on a large batch they
 * can crowd out the JSON and truncate it.
 *
 * Measured on a live llama.cpp endpoint (b10975, Qwen3.8-Flash-Next), 25-document
 * batch: 34–73s / 4.5k–7.1k output tokens with thinking vs. 11–15s / 2.8k with it
 * off, at identical validity.
 *
 * This must fail CLOSED per model: the kwargs reach the request body for the
 * OpenAI-compatible protocols, and a hosted OpenAI endpoint rejects unrecognized
 * request arguments.
 */
describe("extraction suppresses the thinking channel where supported", () => {
  test("a verified local build gets enable_thinking=false for this call", async () => {
    const h = harness();

    await requestCoverageReport(
      h.runtime,
      workerLlm, // openai / Qwen3.8-Flash-Next
      assignment,
      workerReply,
      "Fasse deine vorstehende Analyse in einem Coverage-Report zusammen.",
      16384,
    );

    expect(h.configs).toHaveLength(1);
    expect(h.configs[0]?.parameters?.chatTemplateKwargs).toEqual({
      enable_thinking: false,
    });
  });

  test("a model without a declared toggle is passed through untouched", async () => {
    const h = harness();

    await requestCoverageReport(
      h.runtime,
      { provider: "openai", model: "gpt-4o" },
      assignment,
      workerReply,
      "Fasse deine vorstehende Analyse in einem Coverage-Report zusammen.",
      16384,
    );

    // No chat_template_kwargs invented — a hosted endpoint would reject it.
    expect(h.configs[0]?.parameters?.chatTemplateKwargs).toBeUndefined();
  });

  test("an operator's own chatTemplateKwargs survive, only the toggle is forced", async () => {
    const h = harness();

    await requestCoverageReport(
      h.runtime,
      {
        ...workerLlm,
        parameters: {
          temperature: 0,
          chatTemplateKwargs: { enable_thinking: true, custom_flag: "keep" },
        },
      },
      assignment,
      workerReply,
      "Fasse deine vorstehende Analyse in einem Coverage-Report zusammen.",
      16384,
    );

    expect(h.configs[0]?.parameters?.chatTemplateKwargs).toEqual({
      custom_flag: "keep",
      enable_thinking: false,
    });
    // The caller's config object must not be mutated in place.
    expect(workerLlm.parameters).toBeUndefined();
  });
});
