// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the agent-harness verification gate.
 *
 * The contracts that matter:
 *   - without a gate nothing changes (settled tasks still mean "completed");
 *   - a run only reports "completed" once the reviewer emitted the pass signal;
 *   - a rejection feeds the reviewer's CRITIQUE into a re-plan, not just a flag;
 *   - the critique never leaks into the user-facing answer;
 *   - a self-declared `stopSignal` completion does NOT bypass the gate;
 *   - a missing or broken reviewer fails OPEN with a diagnostic (quality gate,
 *     not a security boundary) rather than withholding the answer;
 *   - the attempt budget is finite, so a permanently rejecting reviewer cannot
 *     loop forever.
 */

import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { FlowNode } from "../../types/flow.js";
import type { ToolResultEntry } from "../../types/monitoring.js";
import {
  DEFAULT_VERIFICATION_ATTEMPTS,
  MAX_ALLOWED_VERIFICATION_ATTEMPTS,
  parseHarnessConfig,
  parseVerificationConfig,
  resolveVerificationAttempts,
  type Task,
} from "../agent-harness/types.js";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";
import { HarnessConfigSchema } from "../flow-parser/validate.js";
import type {
  AgentState,
  ExecRuntime,
  UsageAccumulator,
} from "../graph-engine.js";

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("parseVerificationConfig", () => {
  test("reads a complete config", () => {
    expect(
      parseVerificationConfig({
        target: "reviewer",
        passSignal: "OK",
        maxAttempts: 2,
      }),
    ).toEqual({ target: "reviewer", passSignal: "OK", maxAttempts: 2 });
  });

  test("trims target and pass signal", () => {
    expect(
      parseVerificationConfig({ target: " reviewer ", passSignal: " OK " }),
    ).toEqual({ target: "reviewer", passSignal: "OK" });
  });

  test("a missing passSignal disables the gate rather than creating one that can never pass", () => {
    // A gate without a pass signal would turn every run into
    // verification-failed — strictly worse than having no gate.
    expect(parseVerificationConfig({ target: "reviewer" })).toBeUndefined();
    expect(
      parseVerificationConfig({ target: "reviewer", passSignal: "" }),
    ).toBeUndefined();
    expect(
      parseVerificationConfig({ target: "reviewer", passSignal: "   " }),
    ).toBeUndefined();
  });

  test("a missing target disables the gate", () => {
    expect(parseVerificationConfig({ passSignal: "OK" })).toBeUndefined();
    expect(
      parseVerificationConfig({ target: "", passSignal: "OK" }),
    ).toBeUndefined();
  });

  test("non-object input is ignored", () => {
    for (const bad of [undefined, null, "reviewer", 42, []]) {
      expect(parseVerificationConfig(bad)).toBeUndefined();
    }
  });

  test("parseHarnessConfig surfaces it under `verification`", () => {
    const cfg = parseHarnessConfig({
      allowlist: ["w"],
      verification: { target: "reviewer", passSignal: "OK" },
    });
    expect(cfg.verification?.target).toBe("reviewer");
    // An unusable block leaves the field absent.
    expect(
      parseHarnessConfig({ allowlist: ["w"], verification: { target: "r" } })
        .verification,
    ).toBeUndefined();
  });
});

describe("resolveVerificationAttempts", () => {
  test("defaults and clamps", () => {
    expect(resolveVerificationAttempts(undefined)).toBe(
      DEFAULT_VERIFICATION_ATTEMPTS,
    );
    expect(resolveVerificationAttempts(0)).toBe(DEFAULT_VERIFICATION_ATTEMPTS);
    expect(resolveVerificationAttempts(2)).toBe(2);
    expect(resolveVerificationAttempts(99)).toBe(
      MAX_ALLOWED_VERIFICATION_ATTEMPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end harness
// ---------------------------------------------------------------------------

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

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function mkState(toolResults: ToolResultEntry[] = []): AgentState {
  return {
    messages: [new HumanMessage("Erledige eine komplexe Aufgabe.")],
    context: { ssoToken: "t", executionId: "exec-1" },
    citations: [],
    toolResults,
    errors: [],
    turns: [],
  } as unknown as AgentState;
}

interface DelegatedToolResult extends ToolResultEntry {
  args_json?: string;
}

interface CapturedDiagnostic {
  code: string;
  level?: string;
  details?: Record<string, unknown>;
}

interface Behaviour {
  fail?: boolean;
  text?: string;
  toolResults?: DelegatedToolResult[];
  executeTools?: (runtime: ExecRuntime) => Promise<DelegatedToolResult[]>;
}

function mkRun(
  plans: Array<Array<{ description: string; target: string }>>,
  behaviour: (
    target: string,
    callIndex: number,
    state: AgentState,
  ) => Behaviour,
): {
  runtime: ExecRuntime;
  calls: string[];
  diagnostics: CapturedDiagnostic[];
  plannerPrompts: string[];
  toolTraceMetadata: Array<{
    toolCallId: string;
    metadata: Parameters<NonNullable<ExecRuntime["onToolTraceMetadata"]>>[1];
  }>;
  toolCallOwners: Array<{ toolCallId: string; ownerNodeId?: string }>;
  nodeStarts: Array<{
    nodeId: string;
    context?: Parameters<ExecRuntime["onNodeStart"]>[1];
  }>;
  registry: {
    get: (type: string) => {
      factory: (
        node: FlowNode,
      ) => (
        state: AgentState,
        config?: LangGraphRunnableConfig,
      ) => Promise<Partial<AgentState>>;
    };
  };
} {
  const calls: string[] = [];
  const diagnostics: CapturedDiagnostic[] = [];
  const plannerPrompts: string[] = [];
  const toolTraceMetadata: Array<{
    toolCallId: string;
    metadata: Parameters<NonNullable<ExecRuntime["onToolTraceMetadata"]>>[1];
  }> = [];
  const toolCallOwners: Array<{ toolCallId: string; ownerNodeId?: string }> = [];
  const nodeStarts: Array<{
    nodeId: string;
    context?: Parameters<ExecRuntime["onNodeStart"]>[1];
  }> = [];
  const counters = new Map<string, number>();
  let plannerCall = 0;

  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt as Array<{
        role?: string;
        content?: unknown;
      }>;
      // Capture the WHOLE prompt, not just the system message: the verifier's
      // critique travels as a conversation message (an AIMessage folded into
      // `state.messages`), not as part of the system prompt.
      plannerPrompts.push(
        prompt
          .map((p) =>
            typeof p.content === "string"
              ? p.content
              : JSON.stringify(p.content),
          )
          .join("\n"),
      );
      // Successive planner calls consume successive entries of `plans`; once
      // exhausted the planner returns nothing so the run can terminate.
      const tasks = plans[plannerCall] ?? [];
      plannerCall++;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ tasks }) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  const runtime = {
    appConfig: baseConfig,
    ctx: { ssoToken: "t", executionId: "exec-1" },
    usage: mkUsage(),
    llmProviderFactory: () => model,
    onToken: async () => {},
    onReasoning: async () => {},
    onToolCall: async (
      toolCallId: string,
      _toolName: string,
      _argsJson: string,
      ownerNodeId?: string,
    ) => {
      toolCallOwners.push({
        toolCallId,
        ...(ownerNodeId !== undefined ? { ownerNodeId } : {}),
      });
    },
    onToolTraceMetadata: (
      toolCallId: string,
      metadata: Parameters<
        NonNullable<ExecRuntime["onToolTraceMetadata"]>
      >[1],
    ) => {
      toolTraceMetadata.push({ toolCallId, metadata });
    },
    onToolResult: async () => {},
    onNodeStart: (
      nodeId: string,
      context?: Parameters<ExecRuntime["onNodeStart"]>[1],
    ) => {
      nodeStarts.push({ nodeId, ...(context !== undefined ? { context } : {}) });
    },
    onNodeEnd: async () => {},
    onNodeIo: () => {},
    onNodeDiagnostic: (_n: string, d: CapturedDiagnostic) =>
      diagnostics.push(d),
    metrics: {
      recordRequest: () => {},
      recordNode: () => {},
      recordLlmCall: () => {},
      recordLlmRetry: () => {},
      recordLlmFallback: () => {},
      recordRejected: () => {},
      recordCache: () => {},
      recordGuardrail: () => {},
      recordCounter: () => {},
      setActiveExecutions: () => {},
      setQueueDepth: () => {},
      render: () => "",
      summary: () => ({}) as never,
    } as unknown as ExecRuntime["metrics"],
    costTracker: { record: () => {} },
  } as unknown as ExecRuntime;

  const registry = {
    get: (_type: string) => ({
      factory:
        (targetNode: FlowNode) =>
        async (
          _state: AgentState,
          childConfig?: LangGraphRunnableConfig,
        ): Promise<Partial<AgentState>> => {
          const idx = counters.get(targetNode.id) ?? 0;
          counters.set(targetNode.id, idx + 1);
          calls.push(targetNode.id);
          const b = behaviour(targetNode.id, idx, _state);
          if (b.fail === true) {
            return {
              errors: [
                {
                  message: `worker ${targetNode.id} failed`,
                  type: "execution_error",
                  details: { node_id: targetNode.id },
                },
              ],
            };
          }
          const childRuntime = childConfig?.configurable?.runtime as
            | ExecRuntime
            | undefined;
          const delegatedResults = [
            ...(b.toolResults ?? []),
            ...(b.executeTools !== undefined && childRuntime !== undefined
              ? await b.executeTools(childRuntime)
              : []),
          ];
          const toolResults: ToolResultEntry[] = [];
          for (const result of delegatedResults) {
            await childRuntime?.onToolCall(
              result.tool_call_id,
              result.tool_name,
              result.args_json ?? "{}",
            );
            await childRuntime?.onToolResult(
              result.tool_call_id,
              result.result,
              result.execution_time_seconds,
            );
            const { args_json: _argsJson, ...entry } = result;
            toolResults.push(entry);
          }
          return {
            messages: [new AIMessage(b.text ?? `ok:${targetNode.id}`)],
            ...(toolResults.length > 0 ? { toolResults } : {}),
          };
        },
    }),
  };

  return {
    runtime,
    calls,
    diagnostics,
    plannerPrompts,
    toolTraceMetadata,
    toolCallOwners,
    nodeStarts,
    registry,
  };
}

function mkNodeMap(ids: string[]): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const id of ids) {
    map.set(id, { id, type: "llm" } as unknown as FlowNode);
  }
  return map;
}

const harnessNode = (config: Record<string, unknown>): FlowNode =>
  ({
    id: "orchestrator",
    type: "agent-harness",
    llm: { provider: "openai", model: "test-model" },
    config,
  }) as unknown as FlowNode;

type HarnessUpdate = {
  messages?: unknown;
  errors?: Array<{ message: string }>;
  harness?: {
    tasks: Task[];
    stopReason?: string;
    partial?: boolean;
    verified?: boolean;
    verificationRounds?: number;
    iterations: number;
    coverage?: {
      discoveryRounds: number;
      discoverySearches: unknown[];
      documents: Array<{ status: string }>;
    };
  };
};

async function run(
  node: FlowNode,
  nodeIds: string[],
  plans: Array<Array<{ description: string; target: string }>>,
  behaviour: (
    target: string,
    callIndex: number,
    state: AgentState,
  ) => Behaviour,
  initialToolResults: ToolResultEntry[] = [],
  initialMessages?: AgentState["messages"],
): Promise<{
  update: HarnessUpdate;
  calls: string[];
  diagnostics: CapturedDiagnostic[];
  plannerPrompts: string[];
  toolTraceMetadata: Array<{
    toolCallId: string;
    metadata: Parameters<NonNullable<ExecRuntime["onToolTraceMetadata"]>>[1];
  }>;
  toolCallOwners: Array<{ toolCallId: string; ownerNodeId?: string }>;
  nodeStarts: Array<{
    nodeId: string;
    context?: Parameters<ExecRuntime["onNodeStart"]>[1];
  }>;
}> {
  const h = mkRun(plans, behaviour);
  const handler = createAgentHarnessNodeHandler(node, mkNodeMap(nodeIds), {
    registry: h.registry,
  });
  const initialState = mkState(initialToolResults);
  if (initialMessages !== undefined) initialState.messages = initialMessages;
  const update = (await handler(initialState, {
    configurable: { runtime: h.runtime },
  } as LangGraphRunnableConfig)) as HarnessUpdate;
  return {
    update,
    calls: h.calls,
    diagnostics: h.diagnostics,
    plannerPrompts: h.plannerPrompts,
    toolTraceMetadata: h.toolTraceMetadata,
    toolCallOwners: h.toolCallOwners,
    nodeStarts: h.nodeStarts,
  };
}

describe("verification gate (end-to-end)", () => {
  const nodes = ["orchestrator", "worker", "reviewer"];
  const onePlan = [[{ description: "arbeite", target: "worker" }]];

  test("without a gate, settled tasks still mean completed (no behaviour change)", async () => {
    const { update, calls } = await run(
      harnessNode({ allowlist: ["worker"], maxIterations: 5 }),
      nodes,
      onePlan,
      () => ({}),
    );
    expect(update.harness?.stopReason).toBe("completed");
    expect(calls).toEqual(["worker"]);
    // Absent rather than false: "not checked" must be distinguishable.
    expect(update.harness?.verified).toBeUndefined();
  });

  test("a passing reviewer confirms the run", async () => {
    const { update, calls } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: { target: "reviewer", passSignal: "VERIFIKATION OK" },
      }),
      nodes,
      onePlan,
      (target) => (target === "reviewer" ? { text: "VERIFIKATION OK" } : {}),
    );
    expect(calls).toEqual(["worker", "reviewer"]);
    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.verified).toBe(true);
    expect(update.harness?.verificationRounds).toBe(1);
  });

  test("the verifier receives findings but not the dossier RAG context", async () => {
    let reviewerMessages: AgentState["messages"] = [];
    const ragContext =
      "Die folgenden Quellen wurden nach Relevanz zur Frage sortiert. " +
      "Wenn deine Antwort eine Quelle nutzt, zitiere sie inline als [n].\n\n" +
      "[1] Nur fuer den Researcher";
    const { update } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: { target: "reviewer", passSignal: "VERIFIKATION OK" },
      }),
      nodes,
      onePlan,
      (target, _idx, state) => {
        if (target === "reviewer") reviewerMessages = state.messages;
        return target === "reviewer"
          ? { text: "VERIFIKATION OK" }
          : { text: "belegter Originalbefund [1]" };
      },
      [],
      [
        new HumanMessage(
          "Pruefe die Akte. Gefragter Mandant: Der zitierte Marker gehoert zur Nutzerfrage.",
        ),
        new SystemMessage(ragContext),
      ],
    );

    expect(update.harness?.verified).toBe(true);
    const verifierContext = reviewerMessages
      .map((message) => String(message.content))
      .join("\n");
    expect(verifierContext).toContain("Pruefe die Akte.");
    expect(verifierContext).toContain("Der zitierte Marker gehoert zur Nutzerfrage");
    expect(verifierContext).toContain("belegter Originalbefund [1]");
    expect(verifierContext).not.toContain("Nur fuer den Researcher");
  });

  test("the pass signal is matched case-insensitively", async () => {
    const { update } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: { target: "reviewer", passSignal: "Verifikation OK" },
      }),
      nodes,
      onePlan,
      (target) => (target === "reviewer" ? { text: "verifikation ok" } : {}),
    );
    expect(update.harness?.verified).toBe(true);
  });

  test("rejecting text cannot pass by merely containing the signal", async () => {
    const { update } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 1,
          failClosed: true,
        },
      }),
      nodes,
      onePlan,
      (target) =>
        target === "reviewer"
          ? { text: "VERIFIKATION OK darf wegen /A nicht erteilt werden" }
          : {},
    );
    expect(update.harness?.stopReason).toBe("verification-failed");
    expect(update.harness?.verified).toBe(false);
  });

  test("a rejection triggers a re-plan whose prompt carries the critique", async () => {
    // The substantive part: the planner must learn WHAT was wrong, not merely
    // that verification failed.
    const { update, calls, plannerPrompts } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 8,
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 2,
        },
      }),
      nodes,
      [
        [{ description: "erster Versuch", target: "worker" }],
        [{ description: "Nacharbeit", target: "worker" }],
      ],
      (target, idx) => {
        if (target !== "reviewer") return {};
        // Reject the first round, accept the second.
        return idx === 0
          ? { text: "Die Quellenangabe fehlt vollständig." }
          : { text: "VERIFIKATION OK" };
      },
    );

    expect(calls).toEqual(["worker", "reviewer", "worker", "reviewer"]);
    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.verified).toBe(true);
    expect(update.harness?.verificationRounds).toBe(2);
    // The re-plan prompt (the last planner call) saw the critique.
    const lastPrompt = plannerPrompts[plannerPrompts.length - 1];
    if (lastPrompt === undefined) throw new Error("expected a planner prompt");
    expect(lastPrompt).toContain("Quellenangabe");
  });

  test("the reviewer's critique never reaches the user-facing answer", async () => {
    const { update } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 8,
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 2,
        },
        carryForward: "condensed",
      }),
      nodes,
      [
        [{ description: "erster Versuch", target: "worker" }],
        [{ description: "Nacharbeit", target: "worker" }],
      ],
      (target, idx) => {
        if (target === "reviewer") {
          return idx === 0
            ? { text: "GEHEIME-KRITIK: Quelle fehlt." }
            : { text: "VERIFIKATION OK" };
        }
        return { text: "fachliche Antwort" };
      },
    );
    const answer = (update.messages as Array<{ content: unknown }>)
      .map((m) => String(m.content))
      .join("\n");
    expect(answer).toContain("fachliche Antwort");
    expect(answer).not.toContain("GEHEIME-KRITIK");
  });

  test("a permanently rejecting reviewer stops with verification-failed", async () => {
    const { update, calls } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 12,
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 2,
        },
      }),
      nodes,
      [
        [{ description: "a", target: "worker" }],
        [{ description: "b", target: "worker" }],
        [{ description: "c", target: "worker" }],
      ],
      (target) => (target === "reviewer" ? { text: "immer noch falsch" } : {}),
    );
    // Two rounds, then it gives up rather than looping.
    expect(update.harness?.stopReason).toBe("verification-failed");
    expect(update.harness?.verified).toBe(false);
    expect(update.harness?.verificationRounds).toBe(2);
    expect(calls.filter((c) => c === "reviewer")).toHaveLength(2);
  });

  test("a missing reviewer fails OPEN with a diagnostic", async () => {
    // Quality gate, not a security boundary: a mistyped id must not withhold the
    // answer, but it must be loudly visible.
    const { update, diagnostics } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: { target: "tippfehler", passSignal: "OK" },
      }),
      nodes,
      onePlan,
      () => ({}),
    );
    expect(update.harness?.stopReason).toBe("completed");
    expect(diagnostics.map((d) => d.code)).toContain(
      "harness_verifier_missing",
    );
    // No gate ran, so the field stays absent.
    expect(update.harness?.verified).toBeUndefined();
  });

  test("a reviewer that itself errors fails OPEN with a diagnostic", async () => {
    const { update, diagnostics } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: { target: "reviewer", passSignal: "OK" },
      }),
      nodes,
      onePlan,
      (target) => (target === "reviewer" ? { fail: true } : {}),
    );
    expect(update.harness?.stopReason).toBe("completed");
    expect(diagnostics.map((d) => d.code)).toContain("harness_verifier_failed");
    // Ran but could not confirm — reported as unverified, not as a failure.
    expect(update.harness?.verified).toBe(false);
  });

  test("fail-closed rejects a missing reviewer", async () => {
    const { update } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: {
          target: "tippfehler",
          passSignal: "OK",
          failClosed: true,
        },
      }),
      nodes,
      onePlan,
      () => ({}),
    );
    expect(update.harness?.stopReason).toBe("verification-failed");
    expect(update.harness?.verified).toBe(false);
  });

  test("fail-closed rejects a verifier execution error", async () => {
    const { update } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: {
          target: "reviewer",
          passSignal: "OK",
          failClosed: true,
        },
      }),
      nodes,
      onePlan,
      (target) => (target === "reviewer" ? { fail: true } : {}),
    );
    expect(update.harness?.stopReason).toBe("verification-failed");
    expect(update.harness?.verified).toBe(false);
    expect(update.errors?.map((error) => error.message)).toContain(
      "worker reviewer failed",
    );
  });

  test("a self-declared stopSignal completion does not bypass the gate", async () => {
    const { update, calls } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        stopSignal: "FERTIG",
        verification: { target: "reviewer", passSignal: "VERIFIKATION OK" },
      }),
      nodes,
      [
        [
          { description: "a", target: "worker" },
          { description: "b", target: "worker" },
        ],
      ],
      (target) =>
        target === "reviewer"
          ? { text: "VERIFIKATION OK" }
          : { text: "Arbeit erledigt — FERTIG" },
    );
    expect(calls).toContain("reviewer");
    expect(update.harness?.verified).toBe(true);
    expect(update.harness?.stopReason).toBe("completed");
  });

  test("the verifier is billed as an iteration", async () => {
    const { update } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: { target: "reviewer", passSignal: "OK" },
      }),
      nodes,
      onePlan,
      (target) => (target === "reviewer" ? { text: "OK" } : {}),
    );
    // One worker + one verifier.
    expect(update.harness?.iterations).toBe(2);
  });

  test("an exhausted run is not sent to the reviewer", async () => {
    // Nothing succeeded, so there is nothing to review.
    const { update, calls } = await run(
      harnessNode({
        allowlist: ["worker"],
        maxIterations: 5,
        verification: { target: "reviewer", passSignal: "OK" },
      }),
      nodes,
      onePlan,
      (target) => (target === "worker" ? { fail: true } : { text: "OK" }),
    );
    expect(update.harness?.stopReason).toBe("exhausted");
    expect(calls).not.toContain("reviewer");
  });

  test("an incomplete summaries seed fails coverage before any reviewer runs", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [
          { reference: "/A", title: "A", summary: "Summary A" },
          { reference: "/B", title: "B", summary: "Summary B" },
        ],
        count: 2,
        total: 3,
      },
      execution_time_seconds: 0,
    };
    const { update, calls } = await run(
      harnessNode({
        allowlist: ["worker"],
        plannerless: true,
        maxIterations: 5,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          batchSize: 2,
          maxOriginalsPerBatch: 1,
          assignmentCharBudget: 1000,
          documentWindowChars: 1000,
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          failClosed: true,
        },
      }),
      ["orchestrator", "worker"],
      [],
      () => ({}),
      [seed],
    );

    expect(calls).toEqual([]);
    expect(update.harness?.stopReason).toBe("coverage-seed-failure");
    expect(update.harness?.partial).toBe(true);
    expect(update.harness?.verified).toBe(false);
    expect(update.errors?.map((error) => error.message).join("\n")).toContain(
      "Coverage seed incomplete: 2 unique references for reported total 3",
    );
  });

  test("an unassignable initial coverage item stops partial instead of completed", async () => {
    const longRef = `/${"R".repeat(900)}`;
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [
          {
            reference: longRef,
            title: "Title",
            summary: "S".repeat(500),
          },
        ],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };
    const { update, calls, diagnostics } = await run(
      harnessNode({
        allowlist: ["worker"],
        plannerless: true,
        maxIterations: 5,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          batchSize: 2,
          maxOriginalsPerBatch: 1,
          assignmentCharBudget: 1000,
          documentWindowChars: 1000,
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          failClosed: true,
        },
      }),
      ["orchestrator", "worker"],
      [],
      () => ({}),
      [seed],
    );

    expect(calls).toEqual([]);
    expect(update.harness?.stopReason).toBe("exhausted");
    expect(update.harness?.partial).toBe(true);
    expect(update.harness?.verified).toBe(false);
    expect(update.harness?.coverage?.documents[0]?.status).toBe("open");
    // A bare stop reason reads as "done"; the blocked queue must say so.
    const unassignable = diagnostics.filter(
      (diagnostic) => diagnostic.code === "harness_coverage_unassignable",
    );
    expect(unassignable).toHaveLength(1);
    expect(unassignable[0]?.level).toBe("error");
    expect(unassignable[0]?.details).toMatchObject({
      unsettled_documents: 1,
      blocked_refs: [longRef],
      assignment_char_budget: 1000,
    });
  });

  test("bounds coverage-worker context and omits dossier/prior findings", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [
          { reference: "/A", title: "A", summary: "Summary A" },
        ],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };
    let workerMessages: AgentState["messages"] = [];
    const ragContext =
      "Die folgenden Quellen wurden nach Relevanz zur Frage sortiert. " +
      "Wenn deine Antwort eine Quelle nutzt, zitiere sie inline als [n].\n" +
      "GLOBALER-AKTEN-UEBERBLICK ".repeat(1000);
    const { update, diagnostics } = await run(
      harnessNode({
        allowlist: ["worker"],
        plannerless: true,
        maxIterations: 4,
        carryForward: "condensed",
        coverageWorkerContextMaxChars: 16000,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          batchSize: 1,
          maxOriginalsPerBatch: 1,
          assignmentCharBudget: 1000,
          documentWindowChars: 1000,
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "OK",
          failClosed: true,
        },
      }),
      nodes,
      [],
      (target, _idx, state) => {
        if (target === "reviewer") return { text: "OK" };
        workerMessages = state.messages;
        return {
          text:
            "ABGEDECKT: /A\nBEFUNDE: keine.\n<COVERAGE>" +
            '{"assignmentId":"coverage-1","documents":[' +
            '{"ref":"/A","decision":"excluded","reason":"Nicht einschlaegig"}]}' +
            "</COVERAGE>",
        };
      },
      [seed],
      [
        new HumanMessage("Pruefe die Akte."),
        new SystemMessage(ragContext),
        new AIMessage("ALTER-BEFUND ".repeat(5000)),
      ],
    );

    expect(update.harness?.verified).toBe(true);
    const workerContext = workerMessages
      .map((message) => String(message.content))
      .join("\n");
    expect(workerContext).toContain("Pruefe die Akte.");
    expect(workerContext).toContain("PRIVATE COVERAGE ASSIGNMENT coverage-1");
    expect(workerContext).not.toContain("GLOBALER-AKTEN-UEBERBLICK");
    expect(workerContext).not.toContain("ALTER-BEFUND");
    const budget = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "harness_prompt_budget" &&
        diagnostic.details?.phase === "coverage-worker",
    );
    expect(budget?.details).toMatchObject({
      max_context_chars: 16000,
      dropped_rag_messages: 1,
      omitted_prior_findings: 0,
    });
    expect(Number(budget?.details?.context_chars)).toBeLessThanOrEqual(16000);
  });

  test("ignores reviewer PASS while a bounded discovery round remains open", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [
          { reference: "/A", title: "A", summary: "Summary A" },
          { reference: "/B", title: "B", summary: "Summary B" },
        ],
        count: 2,
        total: 2,
      },
      execution_time_seconds: 0,
    };
    const { update, calls, diagnostics } = await run(
      harnessNode({
        allowlist: ["worker"],
        plannerless: true,
        maxIterations: 6,
        carryForward: "condensed",
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          batchSize: 2,
          maxOriginalsPerBatch: 1,
          assignmentCharBudget: 1000,
          documentWindowChars: 1000,
          hybridSearch: {
            minDistinctQueries: 2,
            requireHydeVariants: true,
            requireGroupedResults: true,
          },
          searchDiscovery: {
            rounds: 2,
            maxAttemptsPerRound: 1,
            maxHitsPerPass: 2,
          },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 1,
          failClosed: true,
        },
      }),
      nodes,
      [],
      (target, idx) => {
        if (target === "reviewer") return { text: "VERIFIKATION OK" };
        if (idx === 0) {
          return {
            text: "Erste Discovery-Runde abgeschlossen.",
            toolResults: [
              {
                tool_call_id: "search-exact",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({
                  query: "Aktenzeichen 123 Frist 03.03.2024",
                  hybrid: true,
                  hyde: false,
                  group_by_document: true,
                }),
                result: { results: [] },
                execution_time_seconds: 0,
              },
              {
                tool_call_id: "search-concept",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({
                  query: "juristischer Fristbeginn und Zugang",
                  hybrid: true,
                  hyde: true,
                  group_by_document: true,
                }),
                result: { results: [] },
                execution_time_seconds: 0,
              },
            ],
          };
        }
        if (idx === 1) {
          return {
            text:
              '<COVERAGE>{"assignmentId":"coverage-2","documents":[' +
              '{"ref":"/A","decision":"excluded","reason":"Sachfremd A"},' +
              '{"ref":"/B","decision":"excluded","reason":"Sachfremd B"}' +
              "]}</COVERAGE>",
          };
        }
        return { text: "Zweite Discovery-Runde ohne Evidenz." };
      },
      [seed],
    );

    expect(calls).toEqual(["worker", "worker", "worker", "reviewer"]);
    expect(update.harness?.stopReason).toBe("verification-failed");
    expect(update.harness?.partial).toBe(true);
    expect(update.harness?.verified).toBe(false);
    expect(update.harness?.verificationRounds).toBe(1);
    expect(update.harness?.iterations).toBe(4);
    expect(update.harness?.coverage?.discoveryRounds).toBe(1);
    expect(update.harness?.coverage?.discoverySearches).toHaveLength(2);
    expect(
      update.harness?.coverage?.documents.map((document) => document.status),
    ).toEqual(["excluded", "excluded"]);
    expect(
      update.harness?.tasks.map((task) => task.coverageAssignmentMode),
    ).toEqual(["discovery", "summary", "discovery"]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "harness_coverage_discovery_incomplete",
        "harness_verifier_pass_nonterminal_coverage",
        "harness_verification_rejected",
      ]),
    );
  });

  test("fails fast when any successful discovery response has unparseable provenance", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [{ reference: "/A", title: "A", summary: "Summary A" }],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };
    const { update, calls, diagnostics } = await run(
      harnessNode({
        allowlist: ["worker"],
        plannerless: true,
        maxIterations: 6,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          hybridSearch: { minDistinctQueries: 1 },
          searchDiscovery: { rounds: 1, maxAttemptsPerRound: 2 },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 2,
          failClosed: true,
        },
      }),
      nodes,
      [],
      (target) =>
        target === "reviewer"
          ? { text: "VERIFIKATION OK" }
          : {
              text: "Discovery ausgeführt.",
              toolResults: [
                {
                  tool_call_id: "search-valid",
                  tool_name: "vectorsearch/search",
                  args_json: JSON.stringify({
                    query: "valide Perspektive",
                    hybrid: true,
                  }),
                  result: { results: [] },
                  execution_time_seconds: 0,
                },
                {
                  tool_call_id: "search-unparseable",
                  tool_name: "vectorsearch/search",
                  args_json: JSON.stringify({
                    query: "Aktenzeichen 123",
                    hybrid: true,
                  }),
                  result: {
                    content: [{ type: "text", text: "kein JSON" }],
                  },
                  execution_time_seconds: 0,
                },
              ],
            },
      [seed],
    );

    expect(calls).toEqual(["worker"]);
    expect(update.harness?.stopReason).toBe("coverage-provenance-failure");
    expect(update.errors).toHaveLength(1);
    expect(diagnostics.map((item) => item.code)).toContain(
      "harness_coverage_search_provenance_unparseable",
    );
  });

  test("single-flights duplicate search queries within one coverage assignment", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [{ reference: "/A", title: "A", summary: "Summary A" }],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };
    let externalCalls = 0;
    const args = {
      query: "  Aktenzeichen   123  ",
      hybrid: true,
      group_by_document: true,
    };
    const { toolTraceMetadata, toolCallOwners, nodeStarts } = await run(
      harnessNode({
        allowlist: ["worker"],
        plannerless: true,
        maxIterations: 4,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          hybridSearch: { minDistinctQueries: 1, requireGroupedResults: true },
          searchDiscovery: { rounds: 1, maxAttemptsPerRound: 1 },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
      }),
      nodes,
      [],
      (_target, idx) => {
        if (idx > 0) {
          return {
            text:
              '<COVERAGE>{"assignmentId":"coverage-2","documents":[' +
              '{"ref":"/A","decision":"excluded","reason":"Sachfremd"}' +
              "]}</COVERAGE>",
          };
        }
        return {
          text: "Discovery abgeschlossen.",
          executeTools: async (runtime) => {
            const execute = async () => {
              externalCalls += 1;
              await Promise.resolve();
              return { results: [] };
            };
            if (runtime.executeToolCall === undefined) {
              throw new Error("missing coverage execution hook");
            }
            const [first, second, third, fourth, invalid] = await Promise.all([
              runtime.executeToolCall("search-1", "vectorsearch/search", args, execute),
              runtime.executeToolCall(
                "search-2",
                "vectorsearch/search",
                { ...args, query: "aktenzeichen 123" },
                execute,
              ),
              runtime.executeToolCall(
                "search-3",
                "vectorsearch/search",
                {
                  ...args,
                  query: "aktenzeichen 123",
                  filter: { query: "ACME" },
                },
                execute,
              ),
              runtime.executeToolCall(
                "search-4",
                "vectorsearch/search",
                {
                  ...args,
                  query: "aktenzeichen 123",
                  filter: { query: "acme" },
                },
                execute,
              ),
              runtime.executeToolCall(
                "search-invalid",
                "vectorsearch/search",
                { query: "   " },
                execute,
              ),
            ]);
            return [
              {
                tool_call_id: "search-1",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify(args),
                result: first as Record<string, unknown>,
                execution_time_seconds: 0,
              },
              {
                tool_call_id: "search-2",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({ ...args, query: "aktenzeichen 123" }),
                result: second as Record<string, unknown>,
                execution_time_seconds: 0,
              },
              {
                tool_call_id: "search-3",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({
                  ...args,
                  query: "aktenzeichen 123",
                  filter: { query: "ACME" },
                }),
                result: third as Record<string, unknown>,
                execution_time_seconds: 0,
              },
              {
                tool_call_id: "search-4",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({
                  ...args,
                  query: "aktenzeichen 123",
                  filter: { query: "acme" },
                }),
                result: fourth as Record<string, unknown>,
                execution_time_seconds: 0,
              },
              {
                tool_call_id: "search-invalid",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({ query: "   " }),
                result: invalid as Record<string, unknown>,
                execution_time_seconds: 0,
              },
            ];
          },
        };
      },
      [seed],
    );

    expect(externalCalls).toBe(4);
    const metadataFor = (toolCallId: string) =>
      toolTraceMetadata
        .filter((entry) => entry.toolCallId === toolCallId)
        .reduce(
          (combined, entry) => Object.assign(combined, entry.metadata),
          {} as Parameters<NonNullable<ExecRuntime["onToolTraceMetadata"]>>[1],
        );
    const first = metadataFor("search-1");
    const second = metadataFor("search-2");
    const third = metadataFor("search-3");
    const fourth = metadataFor("search-4");
    const invalid = metadataFor("search-invalid");
    expect(first.dedupe).toEqual({ status: "miss" });
    expect(first.parse_status).toBe("parsed");
    expect(first.effective_args_fingerprint).toHaveLength(64);
    expect(second.dedupe).toEqual({
      status: "hit",
      source_tool_call_id: "search-1",
    });
    expect(second.effective_args_fingerprint).toBe(
      first.effective_args_fingerprint,
    );
    expect(third.dedupe).toEqual({ status: "miss" });
    expect(fourth.dedupe).toEqual({ status: "miss" });
    expect(third.effective_args_fingerprint).not.toBe(
      fourth.effective_args_fingerprint,
    );
    expect(invalid).toMatchObject({
      parse_status: "invalid-effective-args",
      dedupe: { status: "miss" },
    });
    expect(invalid.effective_args_fingerprint).toHaveLength(64);
    expect(
      toolCallOwners
        .filter((entry) => entry.toolCallId.startsWith("search-"))
        .map((entry) => entry.ownerNodeId),
    ).toEqual(["worker", "worker", "worker", "worker", "worker"]);
    expect(
      nodeStarts.find((entry) => entry.nodeId === "worker")?.context,
    ).toMatchObject({
      trigger: "harness-delegation",
      parent_node_id: "orchestrator",
      delegation_id: "t1-attempt-1",
    });
  });

  test("re-runs one discovery round after structured global verifier critique", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [
          { reference: "/A", title: "A", summary: "Summary A" },
          { reference: "/B", title: "B", summary: "Summary B" },
        ],
        count: 2,
        total: 2,
      },
      execution_time_seconds: 0,
    };
    const searchResults = (suffix: string): DelegatedToolResult[] => [
      {
        tool_call_id: `search-exact-${suffix}`,
        tool_name: "vectorsearch/search",
        args_json: JSON.stringify({
          query: `exakter Anker ${suffix}`,
          hybrid: true,
          hyde: false,
          group_by_document: true,
        }),
        result: { results: [] },
        execution_time_seconds: 0,
      },
      {
        tool_call_id: `search-concept-${suffix}`,
        tool_name: "vectorsearch/search",
        args_json: JSON.stringify({
          query: `konzeptuelle Gegenhypothese ${suffix}`,
          hybrid: true,
          hyde: true,
          group_by_document: true,
        }),
        result: { results: [] },
        execution_time_seconds: 0,
      },
    ];
    const { update, calls, diagnostics } = await run(
      harnessNode({
        allowlist: ["worker"],
        plannerless: true,
        maxIterations: 8,
        carryForward: "condensed",
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          batchSize: 2,
          maxOriginalsPerBatch: 1,
          assignmentCharBudget: 1000,
          documentWindowChars: 1000,
          hybridSearch: {
            minDistinctQueries: 2,
            requireHydeVariants: true,
            requireGroupedResults: true,
          },
          searchDiscovery: {
            rounds: 1,
            maxAttemptsPerRound: 1,
            maxHitsPerPass: 2,
          },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 2,
          failClosed: true,
        },
      }),
      nodes,
      [],
      (target, idx) => {
        if (target === "reviewer") {
          return idx === 0
            ? {
                text:
                  "1. GLOBAL DISCOVERY: Soll 1, Ist 1; neue Query-/HyDE-Evidenz erforderlich.",
              }
            : { text: "VERIFIKATION OK" };
        }
        if (idx === 0) {
          return {
            text: "Discovery abgeschlossen.",
            toolResults: searchResults("runde-eins"),
          };
        }
        if (idx === 1) {
          return {
            text:
              '<COVERAGE>{"assignmentId":"coverage-2","documents":[' +
              '{"ref":"/A","decision":"excluded","reason":"Sachfremd A"},' +
              '{"ref":"/B","decision":"excluded","reason":"Sachfremd B"}' +
              "]}</COVERAGE>",
          };
        }
        return {
          text: "Discovery-Nacharbeit abgeschlossen.",
          toolResults: searchResults("runde-zwei"),
        };
      },
      [seed],
    );

    expect(calls).toEqual([
      "worker",
      "worker",
      "reviewer",
      "worker",
      "reviewer",
    ]);
    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.verified).toBe(true);
    expect(update.harness?.verificationRounds).toBe(2);
    expect(update.harness?.coverage?.discoveryRounds).toBe(1);
    expect(update.harness?.coverage?.discoverySearches).toHaveLength(4);
    expect(
      update.harness?.tasks.map((task) => task.coverageAssignmentMode),
    ).toEqual(["discovery", "summary", "discovery"]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "harness_coverage_discovery_reopened",
    );
  });
});


describe("coverage worker targets", () => {
  test("parseHarnessConfig preserves trimmed mode-specific targets", () => {
    const config = parseHarnessConfig({
      allowlist: ["default-worker", "summary-worker", "discovery-worker"],
      coverageQueue: {
        enabled: true,
        sourceTool: "vectorsearch/get_summaries",
        targets: {
          summary: " summary-worker ",
          discovery: "discovery-worker",
          original: "default-worker",
        },
      },
    });

    expect(config.coverageQueue?.targets).toEqual({
      summary: "summary-worker",
      discovery: "discovery-worker",
      original: "default-worker",
    });
  });

  test("routes summary and discovery assignments to their configured workers", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [{ reference: "/A", title: "A", summary: "Summary A" }],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };

    const { update, calls } = await run(
      harnessNode({
        allowlist: ["default-worker", "summary-worker", "discovery-worker"],
        plannerless: true,
        maxIterations: 4,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          batchSize: 1,
          maxOriginalsPerBatch: 1,
          assignmentCharBudget: 1000,
          documentWindowChars: 1000,
          hybridSearch: {
            minDistinctQueries: 2,
            requireHydeVariants: true,
            requireGroupedResults: true,
          },
          searchDiscovery: {
            rounds: 1,
            maxAttemptsPerRound: 1,
            maxHitsPerPass: 2,
          },
          targets: {
            summary: "summary-worker",
            discovery: "discovery-worker",
          },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          failClosed: true,
        },
      }),
      [
        "orchestrator",
        "default-worker",
        "summary-worker",
        "discovery-worker",
        "reviewer",
      ],
      [],
      (target) => {
        if (target === "reviewer") return { text: "VERIFIKATION OK" };
        if (target === "summary-worker") {
          return {
            text:
              '<COVERAGE>{"assignmentId":"coverage-2","documents":[' +
              '{"ref":"/A","decision":"excluded","reason":"Sachfremd"}' +
              "]}</COVERAGE>",
          };
        }
        if (target === "discovery-worker") {
          return {
            text: "Discovery abgeschlossen.",
            toolResults: [
              {
                tool_call_id: "search-exact",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({
                  query: "Aktenzeichen 123",
                  hybrid: true,
                  hyde: false,
                  group_by_document: true,
                }),
                result: { results: [] },
                execution_time_seconds: 0,
              },
              {
                tool_call_id: "search-concept",
                tool_name: "vectorsearch/search",
                args_json: JSON.stringify({
                  query: "juristischer Fristbeginn",
                  hybrid: true,
                  hyde: true,
                  group_by_document: true,
                }),
                result: { results: [] },
                execution_time_seconds: 0,
              },
            ],
          };
        }
        return { text: "unerwarteter Fallback" };
      },
      [seed],
    );

    expect(calls).toEqual([
      "discovery-worker",
      "summary-worker",
      "reviewer",
    ]);
    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.tasks.map((task) => task.target)).toEqual([
      "discovery-worker",
      "summary-worker",
    ]);
  });
  test("routes original assignments to their configured worker", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed-original",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [{ reference: "/A", title: "A", summary: "Summary A" }],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };

    const { update, calls } = await run(
      harnessNode({
        allowlist: ["default-worker", "original-worker"],
        plannerless: true,
        maxIterations: 4,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          targets: { original: "original-worker" },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          failClosed: true,
        },
      }),
      ["orchestrator", "default-worker", "original-worker", "reviewer"],
      [],
      (target) => {
        if (target === "reviewer") return { text: "VERIFIKATION OK" };
        if (target === "default-worker") {
          return {
            text:
              '<COVERAGE>{"assignmentId":"coverage-1","documents":[' +
              '{"ref":"/A","decision":"relevant","reason":"Fristbezug"}' +
              "]}</COVERAGE>",
          };
        }
        return {
          text:
            '<COVERAGE>{"assignmentId":"coverage-2","documents":[' +
            '{"ref":"/A","decision":"reviewed","reason":"Vollständig geprüft"}' +
            "]}</COVERAGE>",
          toolResults: [
            {
              tool_call_id: "read-original",
              tool_name: "vectorsearch/get_document",
              args_json: JSON.stringify({
                reference: "/A",
                offset: 0,
                max_chars: 6,
              }),
              result: {
                reference: "/A",
                content: "abcdef",
                totalChars: 6,
                modified: "2026-09-14T00:00:00.000Z",
              },
              execution_time_seconds: 0,
            },
          ],
        };
      },
      [seed],
    );

    expect(calls).toEqual(["default-worker", "original-worker", "reviewer"]);
    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.tasks.map((task) => task.target)).toEqual([
      "default-worker",
      "original-worker",
    ]);
    expect(
      update.harness?.tasks.map((task) => task.coverageAssignmentMode),
    ).toEqual(["summary", "original"]);
  });

  test("uses the first valid allowlist target for an omitted mode override", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed-fallback",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [{ reference: "/A", title: "A", summary: "Summary A" }],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };

    const { update, calls } = await run(
      harnessNode({
        allowlist: ["default-worker", "original-worker"],
        plannerless: true,
        maxIterations: 3,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          targets: { original: "original-worker" },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          failClosed: true,
        },
      }),
      ["orchestrator", "default-worker", "original-worker", "reviewer"],
      [],
      (target) =>
        target === "reviewer"
          ? { text: "VERIFIKATION OK" }
          : {
              text:
                '<COVERAGE>{"assignmentId":"coverage-1","documents":[' +
                '{"ref":"/A","decision":"excluded","reason":"Sachfremd"}' +
                "]}</COVERAGE>",
            },
      [seed],
    );

    expect(calls).toEqual(["default-worker", "reviewer"]);
    expect(update.harness?.tasks[0]).toMatchObject({
      target: "default-worker",
      coverageAssignmentMode: "summary",
    });
  });

  test("keeps mode-specific routing for verification repair assignments", async () => {
    const seed: ToolResultEntry = {
      tool_call_id: "seed-repair",
      tool_name: "vectorsearch/get_summaries",
      result: {
        summaries: [{ reference: "/A", title: "A", summary: "Summary A" }],
        count: 1,
        total: 1,
      },
      execution_time_seconds: 0,
    };
    const searchResults = (suffix: string): DelegatedToolResult[] => [
      {
        tool_call_id: `search-exact-${suffix}`,
        tool_name: "vectorsearch/search",
        args_json: JSON.stringify({
          query: `exakter Anker ${suffix}`,
          hybrid: true,
          hyde: false,
          group_by_document: true,
        }),
        result: { results: [] },
        execution_time_seconds: 0,
      },
      {
        tool_call_id: `search-concept-${suffix}`,
        tool_name: "vectorsearch/search",
        args_json: JSON.stringify({
          query: `konzeptuelle Gegenhypothese ${suffix}`,
          hybrid: true,
          hyde: true,
          group_by_document: true,
        }),
        result: { results: [] },
        execution_time_seconds: 0,
      },
    ];

    const { update, calls } = await run(
      harnessNode({
        allowlist: ["default-worker", "summary-worker", "discovery-worker"],
        plannerless: true,
        maxIterations: 7,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          targets: {
            summary: "summary-worker",
            discovery: "discovery-worker",
          },
          hybridSearch: {
            minDistinctQueries: 2,
            requireHydeVariants: true,
            requireGroupedResults: true,
          },
          searchDiscovery: {
            rounds: 1,
            maxAttemptsPerRound: 1,
            maxHitsPerPass: 2,
          },
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          maxAttempts: 2,
          failClosed: true,
        },
      }),
      [
        "orchestrator",
        "default-worker",
        "summary-worker",
        "discovery-worker",
        "reviewer",
      ],
      [],
      (target, idx) => {
        if (target === "reviewer") {
          return idx === 0
            ? { text: "GLOBAL DISCOVERY: weitere Evidenz erforderlich." }
            : { text: "VERIFIKATION OK" };
        }
        if (target === "summary-worker") {
          return {
            text:
              '<COVERAGE>{"assignmentId":"coverage-2","documents":[' +
              '{"ref":"/A","decision":"excluded","reason":"Sachfremd"}' +
              "]}</COVERAGE>",
          };
        }
        return {
          text: `Discovery ${idx + 1} abgeschlossen.`,
          toolResults: searchResults(`runde-${idx + 1}`),
        };
      },
      [seed],
    );

    expect(calls).toEqual([
      "discovery-worker",
      "summary-worker",
      "reviewer",
      "discovery-worker",
      "reviewer",
    ]);
    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.tasks.map((task) => task.target)).toEqual([
      "discovery-worker",
      "summary-worker",
      "discovery-worker",
    ]);
  });
});


describe("coverage target validation", () => {
  test("schema rejects blank and non-allowlisted mode targets", () => {
    const base = {
      allowlist: ["default-worker"],
      coverageQueue: {
        enabled: true,
        sourceTool: "vectorsearch/get_summaries",
      },
    };

    expect(
      HarnessConfigSchema.safeParse({
        ...base,
        coverageQueue: {
          ...base.coverageQueue,
          targets: { summary: "   " },
        },
      }).success,
    ).toBe(false);
    expect(
      HarnessConfigSchema.safeParse({
        ...base,
        coverageQueue: {
          ...base.coverageQueue,
          targets: { summary: "summary-worker" },
        },
      }).success,
    ).toBe(false);
  });

  test("runtime fails closed when validation was bypassed with an invalid target", async () => {
    const { update, calls } = await run(
      harnessNode({
        allowlist: ["default-worker"],
        plannerless: true,
        maxIterations: 2,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          targets: { summary: "missing-worker" },
        },
      }),
      ["orchestrator", "default-worker"],
      [],
      () => ({ text: "unexpected" }),
    );

    expect(calls).toEqual([]);
    expect(update.harness?.stopReason).toBe("no-tasks");
    expect(update.errors?.map((error) => error.message).join("\n")).toContain(
      "summary=missing-worker",
    );
  });
});
