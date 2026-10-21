// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Model cascade for `llm` nodes (`config.cascade`).
 *
 * A cheap model answers first. When the evidence behind the answer is weak, the
 * node runs ONCE more from the same input with a stronger model
 * (`cascade.escalateTo`) and the second answer replaces the first completely.
 * "Weak" is decided by rules over signals the runtime already has — no model
 * judges the answer:
 *
 *   - fewer distinct `[n]` citations than `minCitations` (default 1),
 *   - a failed `sourcesCheck` (`sourcesCheckFailed`, default true),
 *   - the best grounding score of the run below `maxTopScore` (not checked
 *     unless set, and not checkable without any scored source),
 *   - an answer cut off for length (`finishReasonLength`, default true).
 *
 * The first attempt's TEXT (answer tokens and reasoning) is held back until the
 * decision is made: released unchanged when the node keeps its answer,
 * dropped when it escalates. Tool calls of the first attempt are not undone, so
 * `cascade` belongs on answering nodes whose tools only read.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { FlowNode } from "../types/flow.js";
import { getRuntime, type ExecRuntime } from "./exec-runtime.js";
import type { AgentState } from "./graph-engine.js";
import type { NodeDiagnosticInput } from "../types/debug-trace.js";

export interface CascadeWhen {
  minCitations?: number;
  sourcesCheckFailed?: boolean;
  maxTopScore?: number;
  finishReasonLength?: boolean;
}

export interface CascadeConfig {
  escalateTo: NonNullable<FlowNode["llm"]>;
  when?: CascadeWhen;
}

/** The defaults of the conditions the author did not write. */
export const CASCADE_DEFAULTS = {
  minCitations: 1,
  sourcesCheckFailed: true,
  finishReasonLength: true,
} as const;

/** Diagnostic codes the cascade reads from the first attempt. */
export const SOURCES_CHECK_DIAGNOSTIC = "answer_sources_check";
export const LENGTH_CUTOFF_DIAGNOSTIC = "llm_output_length_limit";
/** Diagnostics the cascade itself emits; the debug trace summarises them as `cascade`. */
export const CASCADE_ESCALATED_DIAGNOSTIC = "cascade_escalated";
export const CASCADE_KEPT_DIAGNOSTIC = "cascade_kept";
/** Counter of escalations, labelled by flow and node. */
export const CASCADE_ESCALATIONS_METRIC = "aiperator_cascade_escalations_total";

export interface CascadeSignalInput {
  /** The first attempt's answer text. */
  answer: string;
  sourcesCheckFailed: boolean;
  finishReasonLength: boolean;
  /** Best grounding score of the run; undefined = none registered. */
  topScore: number | undefined;
}

/** Number of DISTINCT `[n]` citation numbers in `answer`. */
export function countCitations(answer: string): number {
  const numbers = new Set<string>();
  for (const match of answer.matchAll(/\[(\d{1,3})\]/g)) {
    const number = match[1];
    if (number !== undefined) numbers.add(number);
  }
  return numbers.size;
}

/**
 * The reasons to escalate, empty when the answer stands. Pure: each condition
 * is judged on its own from the signals.
 */
export function evaluateCascadeSignals(input: CascadeSignalInput, when: CascadeWhen = {}): string[] {
  const reasons: string[] = [];
  const minCitations = when.minCitations ?? CASCADE_DEFAULTS.minCitations;
  const citations = countCitations(input.answer);
  if (minCitations > 0 && citations < minCitations) {
    reasons.push(`citations ${citations} < ${minCitations}`);
  }
  if ((when.sourcesCheckFailed ?? CASCADE_DEFAULTS.sourcesCheckFailed) && input.sourcesCheckFailed) {
    reasons.push("sources_check_failed");
  }
  if (when.maxTopScore !== undefined && input.topScore !== undefined && input.topScore < when.maxTopScore) {
    reasons.push(`top_score ${input.topScore} < ${when.maxTopScore}`);
  }
  if ((when.finishReasonLength ?? CASCADE_DEFAULTS.finishReasonLength) && input.finishReasonLength) {
    reasons.push("finish_reason_length");
  }
  return reasons;
}

export function shouldEscalate(reasons: readonly string[]): boolean {
  return reasons.length > 0;
}

/** The node's cascade config when it is present and usable, else undefined. */
export function parseCascadeConfig(config: unknown): CascadeConfig | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const raw = (config as { cascade?: unknown }).cascade;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { escalateTo, when } = raw as { escalateTo?: unknown; when?: unknown };
  if (typeof escalateTo !== "object" || escalateTo === null) return undefined;
  const llm = escalateTo as { provider?: unknown; model?: unknown };
  if (typeof llm.provider !== "string" || typeof llm.model !== "string") return undefined;
  return {
    escalateTo: escalateTo as CascadeConfig["escalateTo"],
    ...(typeof when === "object" && when !== null ? { when: when as CascadeWhen } : {}),
  };
}

/** Largest similarity score among the sources registered in this execution. */
export function topGroundingScore(lookup: ExecRuntime["lookupCitation"], limit = 500): number | undefined {
  if (lookup === undefined) return undefined;
  let best: number | undefined;
  for (let index = 1; index <= limit; index += 1) {
    const citation = lookup(index);
    if (citation === undefined) break;
    const score = citation.similarity_score;
    if (typeof score === "number" && Number.isFinite(score) && (best === undefined || score > best)) best = score;
  }
  return best;
}

function answerText(messages: readonly BaseMessage[] | undefined): string {
  const last = messages?.at(-1);
  if (last === undefined) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

type Handler = (state: AgentState, config?: LangGraphRunnableConfig) => Promise<Partial<AgentState>>;

/** What the first attempt held back or reported, for the decision. */
interface FirstAttempt {
  held: Array<{ channel: "token" | "reasoning"; text: string }>;
  diagnostics: NodeDiagnosticInput[];
}

/**
 * Wraps the `llm` node handler: with `config.cascade` the first attempt runs
 * with its text held back and its diagnostics observed, the signals decide, and
 * either the held text is released or the node runs again with `escalateTo`.
 * Without `config.cascade` the handler is returned unchanged.
 */
export function withCascade(node: FlowNode, createHandler: (node: FlowNode) => Handler): Handler {
  const cascade = parseCascadeConfig(node.config);
  if (cascade === undefined) return createHandler(node);

  const { cascade: _omit, ...rest } = (node.config ?? {}) as Record<string, unknown>;
  void _omit;
  const first = createHandler({ ...node, config: rest });
  // Routing and the objective solver pick the model themselves; the escalation
  // must run on exactly the model the author named.
  const { routing: _routing, objective: _objective, ...escalatedConfig } = rest;
  void _routing;
  void _objective;
  const second = createHandler({ ...node, llm: cascade.escalateTo, config: escalatedConfig });

  return async (state, config) => {
    const runtime = getRuntime(config);
    if (runtime === undefined) return first(state, config);

    const attempt: FirstAttempt = { held: [], diagnostics: [] };
    const held = new Proxy(runtime, {
      get(target, property, receiver) {
        if (property === "onToken") {
          return async (nodeId: string, text: string): Promise<void> => {
            if (nodeId === node.id) attempt.held.push({ channel: "token", text });
            else await target.onToken(nodeId, text);
          };
        }
        if (property === "onReasoning") {
          return async (nodeId: string, text: string): Promise<void> => {
            if (nodeId === node.id) attempt.held.push({ channel: "reasoning", text });
            else await target.onReasoning(nodeId, text);
          };
        }
        if (property === "onNodeDiagnostic") {
          return (nodeId: string, diagnostic: NodeDiagnosticInput): void => {
            if (nodeId === node.id) attempt.diagnostics.push(diagnostic);
            target.onNodeDiagnostic?.(nodeId, diagnostic);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const heldConfig = { ...config, configurable: { ...config?.configurable, runtime: held } } as LangGraphRunnableConfig;

    const firstResult = await first(state, heldConfig);

    const failed = (firstResult.errors?.length ?? 0) > 0;
    const sourcesCheckFailed = attempt.diagnostics.some(
      (d) => d.code === SOURCES_CHECK_DIAGNOSTIC && d.level === "warn",
    );
    const finishReasonLength = attempt.diagnostics.some((d) => d.code === LENGTH_CUTOFF_DIAGNOSTIC);
    const reasons = failed
      ? []
      : evaluateCascadeSignals(
          {
            answer: answerText(firstResult.messages),
            sourcesCheckFailed,
            finishReasonLength,
            topScore: topGroundingScore(runtime.lookupCitation),
          },
          cascade.when,
        );

    const modelOf = (llm: { provider?: string; model?: string } | undefined): string =>
      `${llm?.provider ?? "default"}/${llm?.model ?? "default"}`;
    if (!shouldEscalate(reasons)) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: CASCADE_KEPT_DIAGNOSTIC,
        message: "The answer had enough evidence; the cascade kept it.",
        details: { reasons: [], first_model: modelOf(node.llm), final_model: modelOf(node.llm) },
      });
      // The answer stands: release what was held, in the order it arrived.
      for (const piece of attempt.held) {
        if (piece.channel === "token") await runtime.onToken(node.id, piece.text);
        else await runtime.onReasoning(node.id, piece.text);
      }
      return firstResult;
    }

    runtime.onNodeDiagnostic?.(node.id, {
      level: "info",
      code: CASCADE_ESCALATED_DIAGNOSTIC,
      message: `The answer had weak evidence (${reasons.join("; ")}); the node ran again with the stronger model.`,
      details: { reasons, first_model: modelOf(node.llm), final_model: modelOf(cascade.escalateTo) },
    });
    runtime.metrics.recordCounter(CASCADE_ESCALATIONS_METRIC, {
      flow_id: runtime.flowId ?? "",
      node_id: node.id,
    });
    // The first answer is dropped; the second one streams normally. The node
    // has already started, so a second start event would only duplicate it.
    const resumed = new Proxy(runtime, {
      get(target, property, receiver) {
        if (property === "onNodeStart") {
          return (nodeId: string): void => {
            if (nodeId !== node.id) target.onNodeStart(nodeId);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const resumedConfig = { ...config, configurable: { ...config?.configurable, runtime: resumed } } as LangGraphRunnableConfig;
    return second(state, resumedConfig);
  };
}
