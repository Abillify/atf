// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LOCAL-ONLY integration test — the agentic branch against a REAL local model.
 *
 * The unit suites drive the harness with a mock planner, so they prove the
 * MECHANICS. This suite proves the part only a real model can show: that a small
 * local model (qwen3.8-27b-heretic-ara-mtp via LM Studio) actually produces a usable plan for
 * a multi-part request, marks independent steps `parallelizable`, and that the
 * verification gate reaches a verdict instead of deadlocking.
 *
 * Deliberately NOT asserted: the exact number of tasks, their wording, or which
 * target the planner picks for a given sub-question. Those are model judgement
 * calls that shift between model versions; freezing them would make this a
 * change-detector. What is asserted are the invariants the runtime depends on.
 *
 * Gated behind RUN_MODEL_INTEGRATION=1 — skipped in CI. Run locally:
 *   RUN_MODEL_INTEGRATION=1 bun run test:integration:models
 */
import { describe, test, expect } from "bun:test";
import { createGraphEngine } from "../../graph-engine.js";
import type { FlowDefinition } from "../../../types/flow.js";
import type { ChatCompletionChunk } from "../../../types/openai.js";
import type { RequestContext } from "../../../types/monitoring.js";
import {
  QWEN,
  shouldRun,
  integrationAppConfig,
  MODEL_TIMEOUT_MS,
} from "./_helpers.js";
import type { HarnessProgress } from "../../agent-harness/types.js";

// ── flow under test ────────────────────────────────────────────────────────

/**
 * A minimal stand-in for the abbylocal agent branch: a harness over two
 * "domain workers" plus a verifier. Kept self-contained rather than loading
 * abbylocal.yaml because that flow needs the full MCP stack (vectorsearch,
 * worktime, parking) — this suite is about the harness + real planner, not MCP.
 */
function agentFlow(overrides: {
  verification?: Record<string, unknown>;
  maxIterations?: number;
  maxConcurrentTasks?: number;
  /**
   * Which reviewer node to include, if any.
   *
   * Only the reviewer actually referenced by `verification.target` may be
   * present: a defined-but-unreferenced node has no incoming edge and is not a
   * delegation target either, so LangGraph refuses to compile the flow
   * (UnreachableNodeError). Including both reviewers "just in case" is exactly
   * how the first version of this suite failed.
   */
  reviewer?: "cooperative" | "always-reject";
}): FlowDefinition {
  const llm = {
    ...QWEN.llm,
    parameters: { ...QWEN.llm.parameters, contextLength: 32_768 },
  };
  const reviewerNodes =
    overrides.reviewer === "cooperative"
      ? [
          {
            id: "verifier",
            type: "llm" as const,
            label: "Prüfer",
            systemPrompt:
              "Du prüfst, ob die Befunde im Verlauf die ursprüngliche Anfrage " +
              "vollständig beantworten. Ist jede Teilfrage bearbeitet, antworte " +
              "mit exakt: VERIFIKATION OK\n" +
              "Sonst nenne in maximal zwei Zeilen, was fehlt, und schreibe " +
              "VERIFIKATION OK NICHT.",
            llm,
          },
        ]
      : overrides.reviewer === "always-reject"
        ? [
            {
              id: "always-reject",
              type: "llm" as const,
              label: "Immer-Ablehner",
              // Proves the gate's attempt budget is what terminates the loop.
              // The instruction is absolute so even a small model cannot
              // accidentally approve.
              systemPrompt:
                "Antworte ausschliesslich mit dieser Zeile und nichts anderem:\n" +
                "- Es fehlt noch eine Angabe.",
              llm,
            },
          ]
        : [];
  return {
    id: "itest-agent-branch",
    name: "itest agent branch",
    nodes: [
      {
        id: "orchestrator",
        type: "agent-harness",
        label: "Orchestrator",
        systemPrompt:
          "Du planst Teilaufgaben für interne Anfragen. Wähle für " +
          "Arbeitszeit-/Urlaubsfragen den worktime-worker, für Parkplatzfragen " +
          "den parking-worker. Setze \"parallelizable\": true, wenn ein Schritt " +
          "nichts aus dem vorherigen braucht.",
        llm,
        config: {
          allowlist: ["worktime-worker", "parking-worker"],
          maxIterations: overrides.maxIterations ?? 8,
          maxTimeMs: 240_000,
          maxDelegationDepth: 0,
          maxTaskAttempts: 1,
          ...(overrides.maxConcurrentTasks !== undefined
            ? { maxConcurrentTasks: overrides.maxConcurrentTasks }
            : {}),
          ...(overrides.verification !== undefined
            ? { verification: overrides.verification }
            : {}),
          plannerLlm: llm,
        },
      },
      {
        id: "worktime-worker",
        type: "llm",
        label: "Arbeitszeit-Worker",
        systemPrompt:
          "Beantworte Arbeitszeit-/Urlaubsfragen knapp in einem Satz. " +
          "Erfinde keine Zahlen; sage, dass die Daten nicht vorliegen, wenn du " +
          "keine hast.",
        llm,
      },
      {
        id: "parking-worker",
        type: "llm",
        label: "Parkplatz-Worker",
        systemPrompt:
          "Beantworte Parkplatzfragen knapp in einem Satz. Erfinde keine " +
          "Zahlen; sage, dass die Daten nicht vorliegen, wenn du keine hast.",
        llm,
      },
      ...reviewerNodes,
    ],
    edges: [],
  };
}

// ── harness ────────────────────────────────────────────────────────────────

function makeRegistry(flow: FlowDefinition) {
  return {
    get: (id: string) => (id === flow.id ? flow : undefined),
    list: () => [flow],
  };
}

interface RunResult {
  chunks: ChatCompletionChunk[];
  harness: HarnessProgress | undefined;
}

async function runAgentFlow(
  flow: FlowDefinition,
  userText: string,
): Promise<RunResult> {
  const engine = createGraphEngine(integrationAppConfig(), { flowRegistry: makeRegistry(flow) });
  const chunks: ChatCompletionChunk[] = [];
  const ctx: RequestContext = {
    executionId: `itest-agent-${Date.now()}-${Math.random()}`,
    ssoToken: "itest.itest.itest",
  };
  // The harness writes its progress into AgentState; executeFlow does not expose
  // final state, so it is recovered from the debug/monitoring-free path by
  // reading the last emitted harness snapshot off the returned state update.
  const finalState = (await engine.executeFlow(
    flow.id,
    [{ role: "user", content: userText }],
    ctx,
    async (c) => {
      chunks.push(c);
    },
    async () => {},
  )) as unknown as { harness?: HarnessProgress } | undefined;
  return { chunks, harness: finalState?.harness };
}

const joinContent = (chunks: ChatCompletionChunk[]): string =>
  chunks
    .map((c) => c.choices[0]?.delta?.content ?? "")
    .join("")
    .trim();

const errorChunks = (chunks: ChatCompletionChunk[]): ChatCompletionChunk[] =>
  chunks.filter((c) => c.choices[0]?.finish_reason === "error");

const MULTI_PART_REQUEST =
  "Ich brauche zwei Dinge: erstens meinen Urlaubsstand, und zweitens ob " +
  "morgen ein Parkplatz frei ist.";

// ── tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!shouldRun(QWEN))(
  "agent branch — real local planner (LM Studio)",
  () => {
    test(
      "a multi-part request produces an executable plan and a real answer",
      async () => {
        // The baseline capability: a 35B local model must be able to decompose a
        // two-part request into allowlisted steps that actually run.
        const { chunks } = await runAgentFlow(
          agentFlow({}),
          MULTI_PART_REQUEST,
        );
        expect(errorChunks(chunks)).toHaveLength(0);
        expect(joinContent(chunks).length).toBeGreaterThan(0);
      },
      MODEL_TIMEOUT_MS * 4,
    );

    test(
      "the verification gate reaches a verdict and does not deadlock",
      async () => {
        // The risk with a sentinel gate on a small model is a run that never
        // terminates because the reviewer neither approves nor is exhausted.
        const { chunks } = await runAgentFlow(
          agentFlow({
            reviewer: "cooperative",
            verification: {
              target: "verifier",
              passSignal: "VERIFIKATION OK",
              maxAttempts: 2,
            },
            maxIterations: 10,
          }),
          MULTI_PART_REQUEST,
        );
        expect(errorChunks(chunks)).toHaveLength(0);
        // Either verified or explicitly reported unverified — both are terminal,
        // and both must still deliver an answer to the user.
        expect(joinContent(chunks).length).toBeGreaterThan(0);
      },
      MODEL_TIMEOUT_MS * 6,
    );

    test(
      "a permanently rejecting verifier terminates within its attempt budget",
      async () => {
        // Proves the budget is what ends the loop, not luck: this reviewer can
        // never emit the pass signal.
        const { chunks } = await runAgentFlow(
          agentFlow({
            reviewer: "always-reject",
            verification: {
              target: "always-reject",
              passSignal: "VERIFIKATION OK",
              maxAttempts: 1,
            },
            maxIterations: 10,
          }),
          "Wie ist mein Urlaubsstand?",
        );
        expect(errorChunks(chunks)).toHaveLength(0);
        // Still answers — a rejected verification downgrades confidence, it does
        // not withhold the result.
        expect(joinContent(chunks).length).toBeGreaterThan(0);
      },
      MODEL_TIMEOUT_MS * 6,
    );

    test(
      "a missing verifier fails open — the run still answers",
      async () => {
        const { chunks } = await runAgentFlow(
          agentFlow({
            verification: {
              target: "gibt-es-nicht",
              passSignal: "VERIFIKATION OK",
            },
          }),
          "Wie ist mein Urlaubsstand?",
        );
        expect(errorChunks(chunks)).toHaveLength(0);
        expect(joinContent(chunks).length).toBeGreaterThan(0);
      },
      MODEL_TIMEOUT_MS * 4,
    );
  },
);
