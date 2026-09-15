// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — Execution Loop Handler
 *
 * This module contains the `createAgentHarnessNodeHandler` factory and its
 * private helper functions. The handler orchestrates over the graph by
 * planning, delegating, re-planning, and stopping on limits.
 *
 * @module agent-harness/loop
 */

import { createHash } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { resolveAssistantScope } from "../../assistants/types.js";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import type { Citation, StreamError } from "../../types/openai.js";
import { approvalRequestedBy } from "../approval-gate.js";
import { combineAbortSignals, isRagContextMessage } from "../exec-runtime.js";
import type { AgentState, ExecRuntime } from "../graph-engine.js";
import { baseMessagesToModelMessages } from "../message-mapping.js";
import type {
  CoverageAssignment,
  CoverageDocumentEvidence,
  CoverageLedger,
  CoverageSearchEvidence,
  CoverageSearchParseResult,
} from "./coverage.js";
import {
  applyCoverageReport,
  coverageCompletionStatus,
  coverageEvidenceFromToolResult,
  coverageFindingText,
  coverageSummary,
  coverageVerificationManifest,
  describeCoverageReportDefect,
  freezeCoverageCandidates,
  hasRequiredHybridSearchEvidence,
  isCoverageTerminal,
  markCoverageAssignmentIssued,
  markCoverageDiscoveryCompleted,
  markCoverageQueriesObserved,
  mergeCoverageEvidence,
  nextCoverageAssignment,
  normalizedSearchQuery,
  novelCoverageSearchEvidence,
  parseCoverageReport,
  parseCoverageSearchToolResult,
  promoteCoverageSearchHits,
  qualifyingCoverageSearchEvidence,
  renderCoverageAssignment,
  reopenCoverageFromCritique,
  seedCoverageLedger,
  settleCoveragePhase,
} from "./coverage.js";
import type { HarnessProgress, StopReason, Task } from "./types.js";

/**
 * Hard cap (chars) on a single condensed finding carried into the shared
 * context per iteration. Even with the worker-side repetition guard, a
 * defensive ceiling here guarantees the shared context grows by a BOUNDED
 * amount per delegation — so a degenerate or unusually verbose worker output
 * can never explode the context that the planner / next worker / synthesizer
 * receive (the root cause of the empty-response failure on a small KV cache).
 * ~4000 chars ≈ 1000 tokens; ample for a condensed, cited finding.
 */
const CONDENSED_FINDING_MAX = 6000;

/**
 * Applies the {@link CONDENSED_FINDING_MAX} ceiling to a worker's condensed
 * finding before it is carried into the shared context. Text within the limit
 * is returned unchanged; longer text is truncated with a visible marker so the
 * downstream model knows the finding was clipped. Exported for unit testing.
 */
export function capCondensedFinding(
  text: string,
  max: number = CONDENSED_FINDING_MAX,
): string {
  return text.length > max ? `${text.slice(0, max)}\n[…gekuerzt]` : text;
}

/**
 * Phrases the deterministic, natural-language research and decision status of a
 * completed step.
 *
 * Deliberately without an LLM: this sentence is the fallback when the progress
 * narrator is disabled, fails, or has no dependable basis. It may therefore
 * only restate runtime-confirmed facts (observed phase, counted search passes,
 * ledger updates, new findings) and must never claim a domain relevance
 * decision that only the worker made. Exported for unit testing.
 */
export function describeResearchPhase(input: {
  modes: Array<"summary" | "discovery" | "original">;
  newFindingCount: number;
  citationCount: number;
  coverageProgress: number;
  observedSearchPasses: number;
  stagnantIterations?: number;
  maxStagnantIterations?: number;
}): string {
  const phase = input.modes.includes("original")
    ? "The original review of this step is complete; the passages read have been evaluated."
    : input.modes.includes("discovery")
      ? "The targeted search of this step is complete; qualifying hits are recorded as candidates for original review."
      : input.modes.includes("summary")
        ? "The summary triage of this batch is complete; the per-document relevance decision is recorded in the coverage ledger."
        : "The research step is complete.";
  const evidence =
    input.newFindingCount > 0
      ? ` It produced ${input.newFindingCount === 1 ? "one new evidence-backed finding" : `${input.newFindingCount} new evidence-backed findings`} with ${input.citationCount} source reference(s).`
      : input.coverageProgress > 0
        ? ` No standalone textual finding was required; ${input.coverageProgress} document decision(s) were committed.`
        : input.stagnantIterations !== undefined && input.stagnantIterations > 0
          ? ` No new finding and no new decision emerged (${input.stagnantIterations}/${input.maxStagnantIterations ?? "no limit"} passes without progress).`
          : " No new standalone finding emerged.";
  const searches =
    input.observedSearchPasses > 0
      ? ` ${input.observedSearchPasses} search pass(es) were confirmed runtime-side.`
      : "";
  return `${phase}${evidence}${searches}`;
}

function compactStatusText(value: string, max = 180): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function formatCoverageSearchStatus(item: CoverageSearchEvidence): string {
  const rerankStatus =
    item.rerankApplied === true
      ? item.rerankComplete === true
        ? "rerank complete"
        : "rerank incomplete"
      : item.rerankRequested === true
        ? "rerank not applied"
        : "rerank off";
  const hydeStatus = item.hyde
    ? item.hydeApplied === true
      ? "HyDE active"
      : "HyDE requested, not applied"
    : "HyDE off";
  const parts = [
    `query "${compactStatusText(item.query)}"`,
    ...(item.collection !== undefined
      ? [`collection ${compactStatusText(item.collection, 80)}`]
      : []),
    ...(item.limit !== undefined ? [`limit ${item.limit}`] : []),
    "hybrid",
    hydeStatus,
    rerankStatus,
    item.groupByDocument ? "grouped by document" : "not grouped",
    ...(item.pathPrefix !== undefined
      ? [`path ${compactStatusText(item.pathPrefix, 100)}`]
      : []),
    ...(item.tags !== undefined && item.tags.length > 0
      ? [`tags ${compactStatusText(item.tags.join(", "), 100)}`]
      : []),
    ...(item.filterKeys !== undefined && item.filterKeys.length > 0
      ? [`filter fields ${item.filterKeys.join(", ")}`]
      : []),
    ...(item.rerankInputCount !== undefined
      ? [`${item.rerankInputCount} chunk candidates`]
      : []),
    ...(item.rerankScoredCount !== undefined
      ? [`${item.rerankScoredCount} ranked`]
      : []),
    ...(item.returnedHitCount !== undefined
      ? [`${item.returnedHitCount} hits returned`]
      : []),
    ...(item.candidateDocumentCount !== undefined
      ? [`${item.candidateDocumentCount} candidate documents`]
      : []),
  ];
  return `Search pass: ${parts.join(" · ")}`;
}

import {
  partitionCyclicTargets,
  readAncestorChain,
  readDelegationDepth,
  resolveMaxDelegationDepth,
  withChildDelegationDepth,
} from "./depth.js";
import {
  delegate,
  narrateProgress,
  type PlannerBudget,
  plan,
} from "./tools.js";
import {
  checkLimits,
  DEFAULT_MAX_ITERATIONS,
  formatTaskReference,
  mergeReplan,
  normalize,
  parseHarnessConfig,
  renderTaskList,
  resolveAllowlist,
  resolveMaxConcurrentTasks,
  resolveMaxTaskAttempts,
  resolveVerificationAttempts,
  selectTaskBatch,
} from "./types.js";

/**
 * Replaces only the streaming callbacks in a child RunnableConfig.
 *
 * Delegated workers still retain their tools, citations, telemetry, lifecycle,
 * costs, and state updates. Suppressing only token/reasoning events prevents a
 * research intermediate from appearing as an assistant response before the
 * configured final synthesizer writes its answer.
 */
function withDelegateRuntime(
  config: LangGraphRunnableConfig,
  runtime: ExecRuntime,
  streamDelegates: boolean,
  ownerNodeId: string,
): LangGraphRunnableConfig {
  return {
    ...config,
    configurable: {
      ...config.configurable,
      runtime: {
        ...runtime,
        onToolCall: (
          toolCallId: string,
          toolName: string,
          argsJson: string,
        ) => runtime.onToolCall(toolCallId, toolName, argsJson, ownerNodeId),
        ...(streamDelegates
          ? {}
          : {
              onToken: async () => {},
              onReasoning: async () => {},
            }),
      },
    },
  };
}

/** Coverage-relevant tool categories observed during an original assignment. */
export type CoverageToolKind = "document" | "search";

/**
 * Classifies a tool identifier as coverage-relevant, independent of which
 * naming form the caller uses.
 *
 * The runtime sees TWO different identifiers for the same MCP tool: the
 * deterministic `tool` node reports the ref (`vectorsearch/get_document`),
 * while an `llm` node reports the AI SDK key produced by `uniqueToolKey`
 * (`vectorsearch__get_document`, plus a `_2`-style suffix on collision).
 * Matching only the slash form silently missed every worker tool call — so no
 * window or search evidence was ever recorded for the researcher, and original
 * decisions could never be accepted. Exported for unit testing.
 */
export function coverageToolKind(
  toolName: string,
): CoverageToolKind | undefined {
  const bare = (toolName.split("/").pop() ?? toolName).split("__").pop() ?? "";
  // Strip a numeric disambiguation suffix appended on key collision.
  const normalized = bare.replace(/_\d+$/u, "");
  if (normalized === "get_document") return "document";
  if (normalized === "search") return "search";
  return undefined;
}

function canonicalCoverageSearchArgs(
  args: Record<string, unknown>,
): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([entryKey, entryValue]) => [
            entryKey,
            canonicalize(entryValue),
          ]),
      );
    }
    return value;
  };
  const normalizedArgs = {
    ...args,
    ...(typeof args.query === "string"
      ? { query: normalizedSearchQuery(args.query) }
      : {}),
  };
  return JSON.stringify(canonicalize(normalizedArgs));
}

/**
 * Records successful get_document calls made by one private coverage assignment
 * while forwarding every callback to the real runtime unchanged. The report
 * parser can therefore require independently observed, gap-free source windows
 * instead of trusting a worker's self-declared `reviewed` decision.
 */
function withCoverageEvidenceRuntime(
  runtime: ExecRuntime,
  assignment: CoverageAssignment,
  evidence: CoverageDocumentEvidence[],
  searchEvidence: CoverageSearchEvidence[],
  searchParseStatuses: CoverageSearchParseResult["status"][],
  onSearchEvidence?: (item: CoverageSearchEvidence) => void,
): ExecRuntime {
  // Two independent maps keyed by tool call id. The AI SDK invokes `execute`
  // (which reports the effective args) and emits the `tool-call` stream part
  // without a guaranteed order, so neither callback may depend on the other
  // having run first. Effective args always win: they are what actually
  // reached the MCP server after forced flow args, egress handling and
  // contextual enrichment.
  type PendingCall = { kind: CoverageToolKind; argsJson: string };
  const fromModel = new Map<string, PendingCall>();
  const fromExecution = new Map<string, PendingCall>();
  const searchFlights = new Map<
    string,
    { promise: Promise<unknown>; sourceToolCallId: string }
  >();
  const assignedRefs = new Set(
    assignment.documents.map((document) => document.ref),
  );
  const remember = (
    target: Map<string, PendingCall>,
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ): void => {
    const kind = coverageToolKind(toolName);
    if (kind === undefined) return;
    // Window evidence is only meaningful for the assigned originals, while
    // search evidence matters in EVERY mode: a discovery pass (and any search
    // run during triage) can surface a document the summaries hide.
    if (kind === "document" && assignment.mode !== "original") return;
    target.set(toolCallId, { kind, argsJson });
  };
  const forget = (toolCallId: string): void => {
    fromModel.delete(toolCallId);
    fromExecution.delete(toolCallId);
  };
  return {
    ...runtime,
    onToolCall: async (toolCallId, toolName, argsJson, ownerNodeId) => {
      remember(fromModel, toolCallId, toolName, argsJson);
      await runtime.onToolCall(toolCallId, toolName, argsJson, ownerNodeId);
    },
    onToolEffectiveArgs: async (toolCallId, toolName, argsJson) => {
      remember(fromExecution, toolCallId, toolName, argsJson);
      await runtime.onToolEffectiveArgs?.(toolCallId, toolName, argsJson);
    },
    executeToolCall: async (toolCallId, toolName, args, execute) => {
      const dispatch = () =>
        runtime.executeToolCall !== undefined
          ? runtime.executeToolCall(toolCallId, toolName, args, execute)
          : execute();
      if (coverageToolKind(toolName) !== "search") return dispatch();
      const canonicalArgs = canonicalCoverageSearchArgs(args);
      const fingerprint = createHash("sha256")
        .update(canonicalArgs)
        .digest("hex");
      const query =
        typeof args.query === "string" ? normalizedSearchQuery(args.query) : "";
      if (query === "") {
        runtime.onToolTraceMetadata?.(toolCallId, {
          effective_args_fingerprint: fingerprint,
          dedupe: { status: "miss" },
        });
        return dispatch();
      }
      const key = `${toolName}\u0000${canonicalArgs}`;
      const existing = searchFlights.get(key);
      if (existing !== undefined) {
        runtime.onToolTraceMetadata?.(toolCallId, {
          effective_args_fingerprint: fingerprint,
          dedupe: {
            status: "hit",
            source_tool_call_id: existing.sourceToolCallId,
          },
        });
        return existing.promise;
      }
      runtime.onToolTraceMetadata?.(toolCallId, {
        effective_args_fingerprint: fingerprint,
        dedupe: { status: "miss" },
      });
      const pending = dispatch();
      const flight = { promise: pending, sourceToolCallId: toolCallId };
      searchFlights.set(key, flight);
      void pending.catch(() => {
        if (searchFlights.get(key) === flight) searchFlights.delete(key);
      });
      return pending;
    },
    onToolResult: async (toolCallId, content, execTimeSec, options) => {
      const call = fromExecution.get(toolCallId) ?? fromModel.get(toolCallId);
      if (call !== undefined) {
        if (call.kind === "document") {
          const item = coverageEvidenceFromToolResult(
            assignedRefs,
            call.argsJson,
            content,
          );
          if (item !== undefined) evidence.push(item);
        } else {
          const parsed = parseCoverageSearchToolResult(call.argsJson, content);
          searchParseStatuses.push(parsed.status);
          runtime.onToolTraceMetadata?.(toolCallId, {
            parse_status: parsed.status,
          });
          if (parsed.status === "parsed") {
            searchEvidence.push(parsed.evidence);
            onSearchEvidence?.(parsed.evidence);
          }
        }
      }
      forget(toolCallId);
      await runtime.onToolResult(toolCallId, content, execTimeSec, options);
    },
    onToolError: async (toolCallId, errorMessage, execTimeSec) => {
      const call = fromExecution.get(toolCallId) ?? fromModel.get(toolCallId);
      if (call?.kind === "search") {
        searchParseStatuses.push("tool-error");
        runtime.onToolTraceMetadata?.(toolCallId, {
          parse_status: "tool-error",
        });
      }
      forget(toolCallId);
      await runtime.onToolError?.(toolCallId, errorMessage, execTimeSec);
    },
  };
}

// ---------------------------------------------------------------------------
// Message filtering for planner
// ---------------------------------------------------------------------------

/**
 * Filters messages to remove tool-related content that would cause
 * tool call/result mismatch errors when sent to the planner LLM.
 *
 * The planner only needs to see:
 * - User messages (the original request and any follow-ups)
 * - System messages (context and instructions)
 * - Assistant messages with text content (final answers from delegated nodes)
 *
 * Tool execution details (assistant messages with tool_calls and tool
 * messages with results) are filtered out because:
 * 1. They're not relevant to the planning task
 * 2. They can cause validation errors if tool calls and results don't match
 *    perfectly (e.g., when delegated nodes use tools that the planner doesn't
 *    have access to)
 *
 * For assistant messages that have both text content AND tool calls, we:
 * - Create a new message with ONLY the text content (no tool calls)
 * - This preserves the assistant's textual response while avoiding tool call/result mismatches
 *
 * @param messages - The full message history from state.messages
 * @returns Filtered messages safe to send to the planner LLM
 */
function filterMessagesForPlanner(messages: BaseMessage[]): BaseMessage[] {
  const result: BaseMessage[] = [];

  for (const msg of messages) {
    const type =
      (msg as { _getType?: () => string })._getType?.() ??
      (msg as { getType?: () => string }).getType?.();

    // Remove tool result messages entirely
    if (type === "tool") continue;

    // Handle assistant messages
    if (type === "ai") {
      const toolCalls = (msg as { tool_calls?: unknown[] }).tool_calls;
      const content = (msg as { content?: unknown }).content;

      // If the message has tool calls but also has text content, preserve the text
      if (toolCalls && toolCalls.length > 0) {
        const textContent = typeof content === "string" ? content.trim() : "";
        if (textContent.length > 0) {
          // Create a new AIMessage with only the text content, no tool calls
          result.push(new AIMessage(textContent));
        }
        // If no text content, skip this message entirely (it's purely a tool call)
        continue;
      }

      // No tool calls - keep the message as is
      result.push(msg);
      continue;
    }

    // Keep user and system messages
    result.push(msg);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Planner context slimming — folder digest instead of the full doc overview
// ---------------------------------------------------------------------------

/** Max folders listed in the planner's folder digest (keeps it bounded). */
const PLANNER_DIGEST_MAX_FOLDERS = 60;

/** Returns the folder (dirname) of a document reference path. */
function folderOf(ref: string): string {
  const trimmed = ref.trim();
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return trimmed.length > 0 ? trimmed : "(root)";
  return trimmed.slice(0, idx);
}

/**
 * Derives a COMPACT folder-level structure digest from an injected
 * COLLECTION OVERVIEW system message. The planner only needs the collection's
 * shape ("one step per folder") — not all N document titles, which can be tens
 * of thousands of characters. This parses each overview line's `(Ref: /path/…)`,
 * folds it to its folder, and emits `folder → count` entries.
 *
 * Returns "" when the content has no parseable overview lines (caller then
 * drops the message rather than injecting an empty digest). Exported for tests.
 */
export function folderDigestFromOverview(content: string): string {
  const refRe = /\(Ref:\s*([^)]+)\)/;
  const counts = new Map<string, number>();
  let docsSeen = 0;
  for (const line of content.split("\n")) {
    const m = line.match(refRe);
    if (m === null) continue;
    docsSeen++;
    const folder = folderOf(m[1] ?? "");
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  if (counts.size === 0) return "";

  // Prefer the store's true total from the header ("… of TOTAL N documents") so
  // the planner sees the real size even when the overview was char-capped; fall
  // back to the number of parsed lines.
  //
  // The `INSGESAMT` alternative is the pre-translation wording. A checkpointed
  // conversation can still carry a German overview, and losing the total there
  // would silently understate the collection size to the planner rather than
  // fail visibly. See LEGACY_RAG_MARKERS in exec-runtime.ts.
  const totalMatch = content.match(
    /(?:TOTAL|INSGESAMT)\s+(\d+)\s+(?:documents?|dokument)/i,
  );
  const total =
    totalMatch !== null && Number.isFinite(Number(totalMatch[1]))
      ? Number(totalMatch[1])
      : docsSeen;

  const folders = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const shown = folders.slice(0, PLANNER_DIGEST_MAX_FOLDERS);
  const lines = shown.map(([f, n]) => `- ${f}: ${n} doc(s)`);
  const moreNote =
    folders.length > shown.length
      ? `\n- … and ${folders.length - shown.length} more folders`
      : "";
  const capNote =
    docsSeen < total
      ? ` (folder structure derived from the first ${docsSeen} of ${total} documents)`
      : "";

  return (
    `COLLECTION STRUCTURE (folder overview for PLANNING — derived from the ` +
    `collection overview, NOT the complete document list). ${total} documents ` +
    `in total across ${counts.size} folders${capNote}. Typically plan ONE ` +
    `research step per folder or per sub-aspect of the question; the ` +
    `researcher sees the complete document list itself and picks the ` +
    `individual documents.\n${lines.join("\n")}${moreNote}`
  );
}

/**
 * Rewrites the message list for a planner call so the planner never carries the
 * full (up to ~40k-char) AKTEN-UEBERBLICK:
 *   - initial plan (`replan === false`): each RAG-context system message is
 *     REPLACED by its compact {@link folderDigestFromOverview}. (#4a)
 *   - re-plan (`replan === true`): RAG-context messages are DROPPED entirely —
 *     the planner decides "continue or stop?" from `priorProgress` + the
 *     condensed findings alone, so the map is redundant. (#1)
 * Non-RAG messages pass through untouched. Pure; does not mutate the argument.
 */
function transformRagForPlanner(
  messages: BaseMessage[],
  replan: boolean,
): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    const text = typeof content === "string" ? content : "";
    if (text.length > 0 && isRagContextMessage(text)) {
      if (replan) continue; // #1: drop the map on re-plan
      const digest = folderDigestFromOverview(text); // #4a: folder digest
      if (digest.length > 0) out.push(new SystemMessage({ content: digest }));
      continue;
    }
    out.push(msg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler — internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable summary from the completed tasks' results.
 * Used to assemble the AIMessage content on every exit path.
 */
function assembleResult(tasks: Task[]): string {
  const completed = tasks.filter((t) => t.status === "completed");
  if (completed.length === 0) {
    return "No tasks were completed.";
  }
  return completed
    .map((t) => `[${t.id}] ${t.description}: ${t.result ?? "(done)"}`)
    .join("\n");
}

/**
 * Summarizes a delegate update into a short result string stored on the task.
 * Picks the last AI message content if available, otherwise falls back to a
 * generic marker.
 */
function summarizeDelegateResult(update: Partial<AgentState>): string {
  if (update.messages) {
    const msgs = Array.isArray(update.messages)
      ? update.messages
      : [update.messages];
    // Find the last message with content
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg && typeof (msg as { content?: unknown }).content === "string") {
        const text = (msg as { content: string }).content;
        if (text.length > 0) {
          // Truncate to keep progress compact
          return text.length > 200 ? `${text.slice(0, 200)}\u2026` : text;
        }
      }
    }
  }
  return "(completed)";
}

/**
 * Returns true when a message is a non-empty AI (assistant) answer — used to
 * collect the real responder output for the harness's final user-facing
 * message, while excluding injected RAG/context SystemMessages and tool
 * messages that delegated nodes also emit.
 */
function isAiAnswer(msg: BaseMessage): boolean {
  if (msg === null || typeof msg !== "object") return false;
  const getType =
    (msg as { getType?: () => string }).getType ??
    (msg as { _getType?: () => string })._getType;
  const type =
    msg instanceof AIMessage
      ? "ai"
      : typeof getType === "function"
        ? getType.call(msg)
        : undefined;
  if (type !== "ai") return false;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.length > 0;
}

/** Flattens a single message's content into plain text (handles part arrays). */
function messageText(m: BaseMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : p !== null &&
              typeof p === "object" &&
              "text" in (p as Record<string, unknown>)
            ? String((p as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

const DEFAULT_COVERAGE_WORKER_CONTEXT_MAX_CHARS = 60_000;
const DEFAULT_VERIFICATION_CONTEXT_MAX_CHARS = 180_000;
const CONTEXT_TRUNCATION_MARKER = "\n[…context budgeted]";

function messageChars(messages: readonly BaseMessage[]): number {
  return messages.reduce((total, message) => total + messageText(message).length, 0);
}

/**
 * Keeps every message role represented while sharing a hard character budget
 * evenly. This is used only for stable request context and compact findings;
 * the authoritative coverage assignment/manifest is never truncated here.
 */
export function budgetHarnessMessages(
  messages: readonly BaseMessage[],
  maxChars: number,
): BaseMessage[] {
  const textual = messages.filter((message) => messageText(message) !== "");
  if (messageChars(textual) <= maxChars) return [...textual];
  if (textual.length === 0 || maxChars <= 0) return [];

  const perMessage = Math.floor(maxChars / textual.length);
  if (perMessage <= 0) return [];
  return textual.map((message) => {
    const text = messageText(message);
    const capped =
      text.length <= perMessage
        ? text
        : perMessage <= CONTEXT_TRUNCATION_MARKER.length
          ? text.slice(0, perMessage)
          : `${text.slice(
              0,
              perMessage - CONTEXT_TRUNCATION_MARKER.length,
            )}${CONTEXT_TRUNCATION_MARKER}`;
    const type = message._getType();
    if (type === "system") return new SystemMessage(capped);
    if (type === "human") return new HumanMessage(capped);
    return new AIMessage(capped);
  });
}

function coverageRequestMessages(messages: readonly BaseMessage[]): BaseMessage[] {
  return messages.filter((message) => {
    const type = message._getType();
    if (type !== "system" && type !== "human") return false;
    return !(type === "system" && isRagContextMessage(messageText(message)));
  });
}

/**
 * Minimum trimmed length for a line to be eligible for cross-line
 * deduplication. Short/structural lines (headings, bullets like "- …", blank
 * lines) are kept verbatim to preserve formatting; only substantial content
 * lines are collapsed when they recur identically.
 */
const DEDUPE_MIN_LINE_LEN = 40;

/**
 * Collapses degenerate duplication inside a carried finding.
 *
 * Small local thinking models (the trace that motivated this) restate their
 * FULL findings block in both their reasoning channel and their visible answer,
 * so the merged worker text carries the same substantial lines two or more
 * times. Left intact, that duplicated block is exactly the pattern that pushes
 * the next node (synthesizer) into a repetition loop — the same identical block
 * appearing several times in-context is the classic degeneration trigger.
 *
 * This removes later occurrences of an already-seen substantial line
 * (>= {@link DEDUPE_MIN_LINE_LEN} chars, trimmed), keeping the FIRST occurrence
 * and preserving order. Short/structural lines and blanks pass through so
 * legitimate formatting (headings, bullets, citations) is untouched; runs of
 * blank lines left behind are collapsed. Exported for unit testing.
 */
export function collapseDuplicateLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const norm = line.trim();
    if (norm.length >= DEDUPE_MIN_LINE_LEN) {
      if (seen.has(norm)) continue;
      seen.add(norm);
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Minimum token count before fuzzy cross-task deduplication is attempted. */
const FINDING_DEDUPE_MIN_TOKENS = 24;

/** Builds stable word trigrams while ignoring citation-number differences. */
function findingShingles(text: string): Set<string> {
  const tokens =
    text
      .toLocaleLowerCase("de-DE")
      .replace(/\[\d+\]/g, " ")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const shingles = new Set<string>();
  for (let i = 0; i <= tokens.length - 3; i++) {
    shingles.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return shingles;
}

/**
 * Detects a near-identical finding produced by a different harness task.
 *
 * Exact whitespace-normalised equality also covers short findings. Longer
 * findings use trigram Jaccard similarity plus a length-ratio guard: this drops
 * repeated full syntheses with minor framing changes, but keeps a short new
 * detail that merely overlaps a larger prior report.
 */
export function areNearDuplicateFindings(a: string, b: string): boolean {
  const normalizeFinding = (text: string): string =>
    text
      .toLocaleLowerCase("de-DE")
      .replace(/\[\d+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedA = normalizeFinding(a);
  const normalizedB = normalizeFinding(b);
  if (normalizedA === normalizedB) return true;

  const evidenceKeys = (text: string): string[] =>
    [...new Set(text.match(/\[\d+\]|\[Ref:\s*[^\]]+\]/gi) ?? [])]
      .map((key) => key.toLocaleLowerCase("de-DE"))
      .sort();
  const coverageKey = (text: string): string | undefined => {
    const line = text
      .split("\n")
      .find((candidate) =>
        candidate.trim().toLocaleUpperCase("de-DE").startsWith("ABGEDECKT:"),
      );
    return line === undefined ? undefined : normalizeFinding(line);
  };
  const evidenceA = evidenceKeys(a);
  const evidenceB = evidenceKeys(b);
  const coverageA = coverageKey(a);
  const coverageB = coverageKey(b);
  const hypothesisKeys = (text: string): string[] =>
    text
      .split("\n")
      .filter((line) =>
        /^\s*[-*]\s*\[(AKTIV|BESTAETIGT|BESTÄTIGT|VERWORFEN)\]/iu.test(line),
      )
      .map(normalizeFinding)
      .sort();
  const hypothesesA = hypothesisKeys(a);
  const hypothesesB = hypothesisKeys(b);
  const hypothesisStateChanged =
    hypothesesA.length !== hypothesesB.length ||
    hypothesesA.some((key, index) => key !== hypothesesB[index]);
  // A hypothesis transition is research progress even when coverage and source
  // stay identical; never let generic text similarity erase it.
  if (
    (hypothesesA.length > 0 || hypothesesB.length > 0) &&
    hypothesisStateChanged
  ) {
    return false;
  }
  if (
    coverageA !== undefined &&
    coverageA === coverageB &&
    evidenceA.length > 0 &&
    evidenceA.length === evidenceB.length &&
    evidenceA.every((key, index) => key === evidenceB[index])
  ) {
    return true;
  }

  const wordsA = normalizedA.match(/[\p{L}\p{N}]+/gu) ?? [];
  const wordsB = normalizedB.match(/[\p{L}\p{N}]+/gu) ?? [];
  const lengthRatio =
    Math.min(wordsA.length, wordsB.length) /
    Math.max(wordsA.length, wordsB.length);
  if (lengthRatio < 0.75) return false;

  if (
    wordsA.length < FINDING_DEDUPE_MIN_TOKENS ||
    wordsB.length < FINDING_DEDUPE_MIN_TOKENS
  ) {
    // Short findings do not have enough trigrams for the long-text detector.
    // Token-set Jaccard catches the same compact result with a changed heading,
    // citation number, or minor framing while retaining genuinely new details.
    if (wordsA.length < 4 || wordsB.length < 4) return false;
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) intersection += 1;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 && intersection / union >= 0.78;
  }

  const shinglesA = findingShingles(a);
  const shinglesB = findingShingles(b);
  if (shinglesA.size === 0 || shinglesB.size === 0) return false;
  let intersection = 0;
  for (const shingle of shinglesA) {
    if (shinglesB.has(shingle)) intersection += 1;
  }
  const union = shinglesA.size + shinglesB.size - intersection;
  return union > 0 && intersection / union >= 0.72;
}

/**
 * Extracts the worker's textual findings from a delegate update for the
 * `carryForward: "condensed"` strategy. Concatenates the text of EVERY AI
 * (assistant) message with non-empty content — not just the last — so a worker
 * that splits its findings across several assistant turns (e.g. an interim
 * finding before a tool call and a final summary after) does not silently lose
 * the earlier findings (and, critically, the source citations `[n]` they
 * carry). Ordered as produced; returns "" when the worker produced no text.
 *
 * Two dedup layers guard against the repetition that pushed the downstream
 * synthesizer into a loop (trace fbf8500d): a fully identical assistant turn is
 * dropped as a whole, and {@link collapseDuplicateLines} removes repeated
 * substantial lines within the joined result (e.g. a thinking model that echoes
 * its entire findings block in both reasoning and answer).
 */
function isEmptyResponseFallback(message: BaseMessage): boolean {
  const additionalKwargs = (
    message as { additional_kwargs?: Record<string, unknown> }
  ).additional_kwargs;
  return additionalKwargs?.aiperator_empty_response_fallback === true;
}

export function isTerminalBudgetErrorText(text: string): boolean {
  return /BudgetExceededError|Transaction budget exceeded/iu.test(text);
}

export function isSubstantiveFinding(
  text: string,
  requiredMarkers: string[] = [],
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Runtime/resource failures are never research findings, even if a model
  // wraps them in the flow's required marker structure. This is a defensive
  // boundary; typed terminal errors should normally prevent such text from
  // reaching the harness at all.
  if (
    isTerminalBudgetErrorText(trimmed) ||
    /maximum context length|context length is/iu.test(trimmed)
  ) {
    return false;
  }
  const saysNoNewFinding = trimmed
    .toLocaleUpperCase("de-DE")
    .includes("KEIN NEUER BEFUND");
  const containsHypothesisUpdate =
    /^\s*[-*]\s*\[(AKTIV|BESTAETIGT|BESTÄTIGT|VERWORFEN)\]/imu.test(trimmed);
  if (saysNoNewFinding && !containsHypothesisUpdate) return false;

  const lines = trimmed.split("\n");
  const normalizedMarkers = requiredMarkers.map((required) =>
    required.toLocaleUpperCase("de-DE"),
  );
  const markerIndexes = normalizedMarkers.map((normalized) =>
    lines.findIndex((line) =>
      line.trim().toLocaleUpperCase("de-DE").startsWith(normalized),
    ),
  );
  if (markerIndexes.some((index) => index < 0)) return false;
  if (
    markerIndexes.some(
      (index, position) =>
        position > 0 && index <= (markerIndexes[position - 1] ?? -1),
    )
  ) {
    return false;
  }

  for (const [markerPosition, required] of requiredMarkers.entries()) {
    const markerIndex = markerIndexes[markerPosition] ?? -1;
    const markerLine = lines[markerIndex]?.trim() ?? "";
    const inlineValue = markerLine.slice(required.length).trim();
    const nextMarkerIndex =
      markerIndexes
        .filter((index) => index > markerIndex)
        .sort((a, b) => a - b)[0] ?? lines.length;
    const followingValue = lines
      .slice(markerIndex + 1, nextMarkerIndex)
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (inlineValue.length === 0 && followingValue === undefined) return false;
  }
  return true;
}

export function finalAiAnswerText(msgs: readonly BaseMessage[]): string {
  for (let index = msgs.length - 1; index >= 0; index -= 1) {
    const message = msgs[index];
    if (message === undefined || !isAiAnswer(message)) continue;
    const text = messageText(message).trim();
    if (text !== "" && !isEmptyResponseFallback(message)) return text;
  }
  return "";
}

export function condensedFindingText(msgs: BaseMessage[]): string {
  const parts: string[] = [];
  const seenParts = new Set<string>();
  for (const m of msgs) {
    if (!isAiAnswer(m) || isEmptyResponseFallback(m)) continue;
    const text = messageText(m).trim();
    if (text === "") continue;
    // Drop a byte-identical assistant turn (normalised on whitespace) so a
    // reasoning-copy + answer-copy of the same block does not survive twice.
    const key = text.replace(/\s+/g, " ");
    if (seenParts.has(key)) continue;
    seenParts.add(key);
    parts.push(text);
  }
  return collapseDuplicateLines(parts.join("\n\n"));
}

/**
 * Produces a status message string for a given stop reason.
 */
function statusMessageFor(reason: StopReason): string {
  switch (reason) {
    case "completed":
      return "All tasks completed successfully.";
    case "no-tasks":
      return "No actionable tasks were produced by the planner.";
    case "iteration-limit":
      return "Stopped: iteration limit reached.";
    case "stagnation-limit":
      return "Stopped: no new research finding was produced in consecutive passes.";
    case "budget-limit":
      return "Stopped: the shared execution budget was exhausted.";
    case "cost-limit":
      return "Stopped: cost limit reached.";
    case "time-limit":
      return "Stopped: time limit reached.";
    case "planning-failure":
      return "Stopped: planner failed to produce a valid task list.";
    case "coverage-seed-failure":
      return "Stopped: coverage queue could not be seeded from a complete document overview.";
    case "coverage-provenance-failure":
      return "Stopped: a successful discovery search returned unparseable provenance.";
    case "exhausted":
      return "Stopped: all remaining tasks failed or no viable targets remain.";
    case "depth-limit":
      return "Stopped: harness nesting exceeded the delegation depth limit.";
    case "verification-failed":
      return "Stopped: the work completed but the verifier did not confirm the result.";
  }
}

// ---------------------------------------------------------------------------
// Handler factory — createAgentHarnessNodeHandler
// ---------------------------------------------------------------------------

/**
 * Creates the handler for an `agent-harness` node.
 *
 * The returned `NodeHandler` orchestrates over the graph by:
 * 1. Planning a task list from the user goal using a Planner LLM
 * 2. Iteratively delegating tasks to allowlisted worker nodes/subflows
 * 3. Re-planning after each delegation result
 * 4. Stopping when all tasks are done or a limit is reached
 *
 * Every exit goes through a local `stop()` helper that returns a well-typed
 * `Partial<AgentState>` with a non-error completion (AIMessage + harness
 * progress), even on limit/exhaustion stops.
 *
 * @param node    - The `agent-harness` FlowNode.
 * @param nodeMap - The compiled flow's full node map (for delegation).
 * @returns A NodeHandler `(state, config) => Promise<Partial<AgentState>>`.
 *
 * _Validates: Requirements 2.3, 3.3, 3.4, 4.1, 4.4, 4.5, 5.2, 6.2, 7.2,
 * 8.1, 8.2, 8.3, 10.3, 10.4, 12.1, 12.3, 12.4_
 */
export function createAgentHarnessNodeHandler(
  node: FlowNode,
  nodeMap: Map<string, FlowNode>,
  _testOverrides?: {
    registry?: {
      get(type: string):
        | {
            factory: (
              node: FlowNode,
              ctx: { nodeMap: Map<string, FlowNode> },
            ) => (
              state: AgentState,
              config?: LangGraphRunnableConfig,
            ) => Partial<AgentState> | Promise<Partial<AgentState>>;
          }
        | undefined;
    };
    extractJson?: (text: string) => Record<string, unknown> | null;
  },
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  return async (state, config): Promise<Partial<AgentState>> => {
    // --- Extract runtime ---
    const configurable = config?.configurable as
      | { runtime?: ExecRuntime }
      | undefined;
    const runtime = configurable?.runtime;
    if (runtime === undefined || config === undefined) {
      // No runtime (e.g. validation pass) — no-op. `config` is undefined here
      // too, since `configurable` (and thus `runtime`) derive from it — this
      // also hoists `config`'s type to non-optional for the rest of the
      // handler, including closures created later (e.g. delegation calls),
      // which TS's control-flow narrowing does not otherwise reach into.
      return { currentNodeId: node.id };
    }

    runtime.onNodeStart(node.id);

    const durableBinding = (() => {
      const runStore = runtime.assistants?.stores.runStore;
      if (runStore === undefined) return undefined;
      const resolution = resolveAssistantScope({
        tenantId: runtime.ctx.clientId,
        userId: runtime.ctx.userId ?? runtime.ctx.userEmail,
        assistantId:
          typeof runtime.ctx.requestParams?.assistant_id === "string"
            ? runtime.ctx.requestParams.assistant_id
            : undefined,
      });
      if (!resolution.ok) return undefined;
      const requestedParent = runtime.ctx.requestParams?.assistant_run_id;
      const parentRunId =
        typeof requestedParent === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestedParent,
        )
          ? requestedParent
          : undefined;
      return { runStore, scope: resolution.scope, parentRunId };
    })();

    const delegationFailure = (
      target: string,
    ): { update: Partial<AgentState>; ok: false } => ({
      update: {
        errors: [
          {
            message: "Delegated task failed.",
            type: "execution_error",
            details: { node_id: target },
          },
        ],
      },
      ok: false,
    });

    const runDelegation = async (
      target: string,
      taskKey: string,
      delegateState: AgentState,
      delegateConfig: LangGraphRunnableConfig,
    ): Promise<{ update: Partial<AgentState>; ok: boolean }> => {
      try {
        if (durableBinding === undefined) {
          return await delegate(
            target,
            delegateState,
            delegateConfig,
            runtime,
            nodeMap,
            _testOverrides?.registry,
            {
              trigger: "harness-delegation",
              parent_node_id: node.id,
              delegation_id: taskKey,
            },
          );
        }
        const workerId = runtime.ctx.executionId;
        const child = await durableBinding.runStore.startClaimed(
          durableBinding.scope,
          {
            idempotencyKey: `harness:${runtime.ctx.executionId}:${node.id}:${taskKey}:${target}`,
            ...(durableBinding.parentRunId !== undefined
              ? { parentRunId: durableBinding.parentRunId }
              : {}),
            workerId,
            resumePayload: {
              kind: "harness-delegation",
              executionId: runtime.ctx.executionId,
              harnessNodeId: node.id,
              taskKey,
              target,
            },
          },
        );
        const heartbeat = setInterval(
          () =>
            void durableBinding.runStore
              .heartbeat(durableBinding.scope, child.id, workerId)
              .catch(() => undefined),
          20_000,
        );
        heartbeat.unref?.();
        try {
          const result = await delegate(
            target,
            delegateState,
            delegateConfig,
            runtime,
            nodeMap,
            _testOverrides?.registry,
            {
              trigger: "harness-delegation",
              parent_node_id: node.id,
              delegation_id: child.id,
            },
          );
          const error = result.ok
            ? undefined
            : "Delegated handler returned an execution error.";
          await durableBinding.runStore.settle(
            durableBinding.scope,
            child.id,
            result.ok,
            error,
            workerId,
          );
          return result;
        } finally {
          clearInterval(heartbeat);
        }
      } catch {
        // Lifecycle and durable-store failures are operational details. Convert
        // them at this boundary so the generic graph/route catch cannot expose
        // connection strings, endpoints, or payload excerpts.
        return delegationFailure(target);
      }
    };

    // --- Parse config ---
    const cfg = parseHarnessConfig(
      node.config as Record<string, unknown> | undefined,
    );

    // --- Delegation depth guard ---
    // `delegate()` resolves handlers by NODE TYPE, and `agent-harness` is a
    // registered type — so a harness can enter another harness. That is what
    // makes hierarchical agents possible, and also what makes unbounded
    // recursion possible: a self-referential or cyclic allowlist re-enters
    // forever. The depth bound is checked BEFORE any planning so an over-deep
    // entry costs nothing.
    const currentDepth = readDelegationDepth(config);
    const ancestorChain = readAncestorChain(config);
    const maxDepth = resolveMaxDelegationDepth(cfg.maxDelegationDepth);

    // Concurrency cap for `parallelizable` task batches, and how many times a
    // failed task may be retried before it is recorded as failed.
    const maxConcurrentTasks = resolveMaxConcurrentTasks(
      cfg.maxConcurrentTasks,
    );
    const maxTaskAttempts = resolveMaxTaskAttempts(cfg.maxTaskAttempts);

    /**
     * How many task ids have been issued so far, used as the id offset for
     * re-plans.
     *
     * Without it every re-plan restarted numbering at `t1`, so a new pending task
     * could reuse the id of a settled one — and since task id is the merge key in
     * `mergeHarnessProgress`, the completed task's record was silently overwritten
     * by the new pending one.
     */
    let issuedTaskIds = 0;

    // --- Resolve allowlist ---
    const { valid: resolvedTargets, dropped } = resolveAllowlist(
      cfg.allowlist,
      nodeMap,
    );

    // Refuse targets that would re-enter this harness or an ancestor. Only the
    // offending entries are removed (not the whole node), mirroring how unknown
    // ids are handled — a flow with one bad allowlist entry keeps working.
    const { allowed: validTargets, cyclic } = partitionCyclicTargets(
      resolvedTargets,
      node.id,
      ancestorChain,
    );

    // Plannerless mode skips planner calls. Generic runs use the first
    // allowlist target; coverage assignments may select an allowlisted target
    // per mode and fall back to that first target when no override is set.
    const plannerless = cfg.plannerless === true;
    const plannerlessTarget = validTargets[0];
    const coverageConfig = plannerless ? cfg.coverageQueue : undefined;
    const coverageTargetForAssignment = (
      assignment: CoverageAssignment | undefined,
    ): string | undefined => {
      if (assignment === undefined) return plannerlessTarget;
      const configured = coverageConfig?.targets?.[assignment.mode];
      return configured ?? plannerlessTarget;
    };
    let coverageLedger: CoverageLedger | undefined;
    let currentCoverageAssignment: CoverageAssignment | undefined;
    let plannerlessSeq = 0;

    /** Human-readable task label for a coverage assignment. */
    const coverageTaskLabel = (
      assignment: CoverageAssignment,
      prefix: string,
    ): string =>
      assignment.mode === "discovery"
        ? `${prefix} discovery: targeted hybrid search`
        : `${prefix} ${assignment.mode}: ${assignment.documents.length} document(s)`;

    /**
     * Issues the next assignment with a unique monotone id. Discovery attempts
     * are counted here, but successful discovery rounds are counted only after
     * the required runtime-observed searches return successfully.
     *
     * When nothing can be issued while the queue is still non-terminal, this
     * reports the blockage once so a fail-closed stop is distinguishable from a
     * genuinely finished run.
     */
    let coverageUnassignableReported = false;
    const issueCoverageAssignment = (): CoverageAssignment | undefined => {
      if (coverageLedger === undefined || coverageConfig === undefined) {
        return undefined;
      }
      const assignment = nextCoverageAssignment(coverageLedger, coverageConfig);
      if (assignment !== undefined) {
        coverageLedger = markCoverageAssignmentIssued(
          coverageLedger,
          assignment,
        );
        progress.coverage = coverageLedger;
        return assignment;
      }
      // The queue owes work it can no longer hand out — an exhausted discovery
      // attempt budget, or a document whose ref/window state does not fit the
      // assignment budget. The run stays fail-closed either way, but without
      // this the only visible trace is a bare stop reason, which reads as "done"
      // rather than "blocked". Emitted once: the callers retry per iteration.
      if (
        !coverageUnassignableReported &&
        !isCoverageTerminal(coverageLedger, coverageConfig)
      ) {
        coverageUnassignableReported = true;
        const blocked = coverageLedger.documents.filter(
          (document) =>
            document.status === "open" ||
            document.status === "summary-reviewed",
        );
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "harness_coverage_unassignable",
          message:
            "Coverage is not terminal but no further assignment could be " +
            "issued; the run stays fail-closed and reports a partial result.",
          details: {
            unsettled_documents: blocked.length,
            discovery_rounds: coverageLedger.discoveryRounds,
            required_discovery_rounds:
              coverageConfig.searchDiscovery?.rounds ?? 0,
            discovery_attempts: coverageLedger.discoveryAttempts,
            assignment_char_budget: coverageConfig.assignmentCharBudget,
          },
        });
      }
      return undefined;
    };
    // Counts completed plannerless passes that added no unique condensed
    // finding. Unlike deduplication alone, this turns repeated work into a
    // deterministic stop instead of silently spending every remaining limit.
    let consecutiveStagnantIterations = 0;

    // --- Planner enrichment (engine patch): give the planner each target's
    // human-readable label, and prepend the node's systemPrompt as domain
    // guidance when present. Both are optional and default to prior behaviour. ---
    const targetLabels: Record<string, string> = {};
    for (const id of validTargets) {
      const label = nodeMap.get(id)?.label;
      if (typeof label === "string" && label.length > 0) {
        targetLabels[id] = label;
      }
    }
    const plannerOpts: {
      targetLabels?: Record<string, string>;
      plannerGuidance?: string;
      nodeId?: string;
      budget?: PlannerBudget;
    } = {
      targetLabels,
      nodeId: node.id,
      ...(typeof node.systemPrompt === "string" && node.systemPrompt.length > 0
        ? { plannerGuidance: node.systemPrompt }
        : {}),
    };

    /**
     * Snapshot of what is still available, rendered into the planner prompt.
     *
     * Recomputed per planner call rather than once: on a re-plan the remaining
     * iterations/time have shrunk, and a planner that still believes it has the
     * initial budget keeps emitting plans that cannot finish — the run then stops
     * on a limit with most tasks untouched, which reads to the user as a failure
     * rather than a bounded answer.
     */
    const currentBudget = (): PlannerBudget => {
      const maxIter = cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      return {
        remainingIterations: Math.max(0, maxIter - progress.iterations),
        ...(cfg.maxCost !== undefined
          ? { remainingCostUsd: Math.max(0, cfg.maxCost - progress.cost) }
          : {}),
        ...(cfg.maxTimeMs !== undefined
          ? {
              remainingTimeMs: Math.max(
                0,
                cfg.maxTimeMs - (Date.now() - startTime),
              ),
            }
          : {}),
        maxConcurrentTasks,
      };
    };

    // --- Record dropped-target errors (Req 2.3) ---
    const errors: StreamError[] = dropped.map((target) => ({
      message: `Allowlist target "${target}" not found in node map; excluded from selectable targets.`,
      type: "execution_error" as const,
      details: { node_id: node.id },
    }));

    // Cyclic targets are a flow-configuration error, not a runtime failure, so
    // they are surfaced as a diagnostic naming the cycle rather than as a
    // stream error that would surface to the end user.
    if (cyclic.length > 0) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "harness_cyclic_target",
        message:
          `Allowlist target(s) ${cyclic.map((t) => `"${t}"`).join(", ")} would ` +
          `re-enter a harness already on the stack ` +
          `(${[...ancestorChain, node.id].join(" → ")}) and were excluded. ` +
          "Self-delegation cannot make progress; remove the entry.",
        details: {
          cyclicTargets: cyclic,
          stack: [...ancestorChain, node.id],
          depth: currentDepth,
        },
      });
    }

    // --- Snapshot start time and initial cost (Req 6.1, 7.1) ---
    const startTime = Date.now();
    const runtimeForRemainingTime = (): ExecRuntime => {
      if (cfg.maxTimeMs === undefined) return runtime;
      const remainingMs = Math.max(1, cfg.maxTimeMs - (Date.now() - startTime));
      return {
        ...runtime,
        signal: combineAbortSignals(
          runtime.signal,
          AbortSignal.timeout(remainingMs),
        ),
      };
    };
    const emitHarnessStatus = (text: string): void => {
      const lineTerminated = `${text.replace(/\n+$/, "")}\n`;
      runtime.onReasoning(node.id, lineTerminated).catch(() => {});
    };
    // Emit a real reasoning-channel message before a potentially long planner
    // call. Open WebUI measures Thinking duration from the first to the last
    // reasoning delta, so this must happen before planning rather than after the
    // task list exists.
    emitHarnessStatus(
      "Starting research. I first survey the document inventory, break the question into verifiable sub-aspects, and then prioritise the documents with the strongest relation. Afterwards I reconcile relevant original passages and possible counter-evidence before accepting a finding as dependable.",
    );
    // We track cost via a running delta from the plan calls and delegate calls
    let accumulatedCost = 0;

    // --- Initialize progress ---
    const progress: HarnessProgress = {
      tasks: [],
      iterations: 0,
      cost: 0,
      depth: currentDepth,
      ...(dropped.length > 0 ? { droppedTargets: dropped } : {}),
      ...(cyclic.length > 0 ? { cyclicTargets: cyclic } : {}),
    };

    // --- Accumulators for the final user-facing output (engine patch) ---
    // Real assistant answers produced by delegated responders, plus citations
    // emitted by delegated RAG steps. These are returned as the harness's
    // output so the orchestrator path yields the full answer + sources instead
    // of a truncated status summary. Declared before `stop()` so its closure
    // observes the values accumulated during the Execution_Loop.
    const answerMessages: BaseMessage[] = [];
    // Task-marker-free findings used by `resultMode: "context"`. Kept separate
    // from answerMessages because task ids/descriptions are useful to the
    // planner, but are internal orchestration metadata a synthesizer must not
    // accidentally reproduce in the user-facing answer.
    const contextFindings: string[] = [];
    const answerCitations: Citation[] = [];
    let coverageUpdates = 0;
    // Reports the strict coverage gate refused. Monotonic like `coverageUpdates`:
    // the per-batch delta decides whether a pass counted as progress or as
    // stagnation (see `consecutiveStagnantIterations`).
    let coverageReportRejections = 0;

    // --- Verification gate state ---
    // Declared HERE, before `stop()`, because `stop()` reports the verification
    // outcome and is reachable from the early depth-limit exit above the gate's
    // own setup — a later `const` would be a temporal-dead-zone ReferenceError on
    // that path (which the depth tests caught).
    //
    // `verificationNotes` is deliberately separate from `answerMessages`: the
    // reviewer's critique must reach the PLANNER so a re-plan can act on it, but
    // must NOT become part of the user-facing answer.
    const verificationNotes: BaseMessage[] = [];
    let verificationRounds = 0;
    let verified = false;
    const verifierNode =
      cfg.verification !== undefined
        ? nodeMap.get(cfg.verification.target)
        : undefined;
    const verificationActive =
      cfg.verification !== undefined && verifierNode !== undefined;

    // Context strategy for carrying delegation results forward (see
    // HarnessConfig.carryForward). "condensed" rebuilds the shared context from
    // this immutable base + one condensed finding per task, so it never
    // accumulates the workers' raw output across iterations. Captured before
    // the loop, `baseMessages` is the entry context (user goal + any injected
    // overview from an upstream tool node).
    const carryForward = cfg.carryForward ?? "full";
    const baseMessages = state.messages;

    // --- Local stop helper (Req 8.1, 8.2, 8.3, 12.4) ---
    const stop = (
      reason: StopReason,
      prog: HarnessProgress,
      errs: StreamError[],
    ): Partial<AgentState> => {
      prog.stopReason = reason;
      prog.partial = reason !== "completed";
      prog.statusMessage = statusMessageFor(reason);
      // Only reported when a gate was actually configured, so an absent
      // `verified` field means "not checked" rather than "failed".
      if (verificationActive || cfg.verification?.failClosed === true) {
        prog.verificationRounds = verificationRounds;
        prog.verified = verified;
      }
      if (coverageLedger !== undefined) prog.coverage = coverageLedger;

      const assembled = assembleResult(prog.tasks);
      const statusNote = `[${prog.statusMessage}]`;
      const summary = prog.partial
        ? `${statusNote}\n\n${assembled}`
        : assembled;

      // Prefer the real responder answers as the user-facing message(s). When
      // the run produced no assistant answer (no-tasks / planning-failure /
      // exhausted), fall back to the assembled status summary so the node
      // always yields a non-empty assistant turn. On a partial stop the
      // assembled summary is prepended (Req 8.2: surface completed outcomes +
      // the limit reason) followed by whatever real answers were produced.
      //
      // A harness followed by a synthesizer opts into `resultMode: "context"`:
      // return ONE task-marker-free message so delegated findings cannot become
      // several competing final answers. The default remains backward
      // compatible for harnesses that are themselves user-facing end nodes.
      const findingContext = (
        contextFindings.length > 0
          ? contextFindings
          : answerMessages.map(messageText).filter((text) => text.trim() !== "")
      ).join("\n\n");
      const coverageContext =
        coverageLedger === undefined
          ? ""
          : coverageCompletionStatus(coverageLedger, coverageConfig, {
              partial: prog.partial === true,
              ...(prog.verified !== undefined ? { verified: prog.verified } : {}),
              ...(prog.stopReason !== undefined
                ? { stopReason: prog.stopReason }
                : {}),
            });
      const contextText = collapseDuplicateLines(
        [findingContext, coverageContext]
          .filter((text) => text !== "")
          .join("\n\n"),
      );
      const finalMessages: BaseMessage[] =
        cfg.resultMode === "context"
          ? [
              new AIMessage(
                contextText.length > 0
                  ? prog.partial
                    ? `${statusNote}\n\n${contextText}`
                    : contextText
                  : statusNote,
              ),
            ]
          : answerMessages.length > 0
            ? prog.partial
              ? [new AIMessage(summary), ...answerMessages]
              : [...answerMessages]
            : [new AIMessage(summary)];

      // Emit final status via onReasoning (Req 9.4). onNodeIo keeps the status
      // summary for the monitoring dashboard view.
      emitHarnessStatus(
        `--- Harness stopped: ${reason} ---\n${prog.statusMessage}`,
      );
      runtime.onNodeIo?.(node.id, { response: summary });
      // A bounded/verified partial stop is a successful harness completion: its
      // stop reason and coverage gaps are already carried in the structured
      // harness state and in the synthesis context. Marking every partial stop
      // as a node error made the whole flow fail, suppressed onFinalResponse,
      // and contradicted the usable partial answer produced downstream. Only a
      // stop that carries an actual StreamError ends the node as an error.
      runtime.onNodeEnd?.(
        node.id,
        errs.length > 0 ? prog.statusMessage : undefined,
      );

      const result: Partial<AgentState> & { harness?: HarnessProgress } = {
        currentNodeId: node.id,
        messages: finalMessages,
        harness: prog,
        ...(answerCitations.length > 0 ? { citations: answerCitations } : {}),
        ...(errs.length > 0 ? { errors: errs } : {}),
      };
      return result as Partial<AgentState>;
    };

    // --- Depth limit: refuse to run at all when entered too deep ---
    // Checked here (after `stop` is defined, before any planning) so the run
    // terminates without spending a planner call. Reported as its own stop
    // reason so an over-deep hierarchy is visible in the trace instead of
    // appearing only as latency and spend.
    if (currentDepth > maxDepth) {
      errors.push({
        message:
          `Agent harness "${node.id}" was entered at delegation depth ` +
          `${currentDepth}, above the configured maximum of ${maxDepth} ` +
          `(stack: ${[...ancestorChain, node.id].join(" → ")}). ` +
          "Raise `config.maxDelegationDepth` on the outer harness, or flatten " +
          "the hierarchy.",
        type: "execution_error",
        details: { node_id: node.id },
      });
      return stop("depth-limit", progress, errors);
    }

    // --- Determine planner LLM (Req 3.1) ---
    // Planner LLM is only required when a planner actually runs. In plannerless
    // mode there is no plan()/re-plan() call, so an absent LLM is fine.
    const plannerLlm: LlmConfig | undefined =
      cfg.plannerLlm ?? node.llm ?? runtime.appConfig.defaultLlm;

    if (!plannerless && plannerLlm === undefined) {
      errors.push({
        message: `Agent harness "${node.id}": no planner LLM configured and no default LLM available.`,
        type: "execution_error",
        details: { node_id: node.id },
      });
      return stop("planning-failure", progress, errors);
    }

    if (plannerless) {
      const invalidCoverageTargets = Object.entries(
        coverageConfig?.targets ?? {},
      ).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !validTargets.includes(entry[1]),
      );
      if (invalidCoverageTargets.length > 0) {
        errors.push({
          message:
            `Agent harness "${node.id}": coverage target(s) must resolve to ` +
            `allowlisted nodes (${invalidCoverageTargets
              .map(([mode, target]) => `${mode}=${target}`)
              .join(", ")}).`,
          type: "execution_error",
          details: { node_id: node.id },
        });
        return stop("no-tasks", progress, errors);
      }
      // No planner: the first allowlist target is the compatibility fallback;
      // coverage mode may override it per deterministic assignment mode.
      if (plannerlessTarget === undefined) {
        errors.push({
          message: `Agent harness "${node.id}": plannerless mode requires at least one valid allowlist target.`,
          type: "execution_error",
          details: { node_id: node.id },
        });
        return stop("no-tasks", progress, errors);
      }
      plannerlessSeq += 1;
      if (coverageConfig !== undefined) {
        try {
          coverageLedger = seedCoverageLedger(
            state.toolResults,
            coverageConfig.sourceTool,
          );
          progress.coverage = coverageLedger;
          currentCoverageAssignment = issueCoverageAssignment();
        } catch {
          errors.push({
            message: `Agent harness "${node.id}": coverage seed validation failed.`,
            type: "execution_error",
            details: {
              node_id: node.id,
              source_tool: coverageConfig.sourceTool,
            },
          });
          return stop("coverage-seed-failure", progress, errors);
        }
        if (currentCoverageAssignment === undefined) {
          return stop(
            isCoverageTerminal(coverageLedger, coverageConfig)
              ? "completed"
              : "exhausted",
            progress,
            errors,
          );
        }
      }
      progress.tasks = [
        {
          id: `t${plannerlessSeq}`,
          displayStep: plannerlessSeq,
          description:
            currentCoverageAssignment === undefined
              ? `Research step ${plannerlessSeq}`
              : coverageTaskLabel(currentCoverageAssignment, "Coverage"),
          target:
            coverageTargetForAssignment(currentCoverageAssignment) ??
            plannerlessTarget,
          status: "pending",
          ...(currentCoverageAssignment !== undefined
            ? {
                coverageAssignmentId: currentCoverageAssignment.id,
                coverageAssignmentMode: currentCoverageAssignment.mode,
                coverageRefs: currentCoverageAssignment.documents.map(
                  (document) => document.ref,
                ),
              }
            : {}),
        },
      ];
    } else {
      // --- Convert state.messages to ModelMessage[] for the planner ---
      // Filter out tool-related messages to avoid tool call/result mismatch
      // errors. The planner only needs user messages and final assistant
      // responses, not the detailed tool execution history from delegated
      // nodes. Initial plan: replace the full AKTEN-UEBERBLICK with a compact
      // folder digest so the planner plans by folder without carrying ~40k
      // chars (#4a).
      const filteredMessages = filterMessagesForPlanner(
        transformRagForPlanner(state.messages, false),
      );
      const modelMessages = baseMessagesToModelMessages(filteredMessages);

      if (plannerLlm === undefined) {
        // Unreachable: the guard above already returns when `!plannerless &&
        // plannerLlm === undefined`, and this is the `!plannerless` branch.
        throw new Error(
          `Agent harness "${node.id}": planner LLM missing (invariant violated).`,
        );
      }

      // --- Initial plan (Req 3.1, 3.2) ---
      const planResult = await plan(
        runtime,
        plannerLlm,
        modelMessages,
        validTargets,
        undefined,
        _testOverrides?.extractJson,
        { ...plannerOpts, budget: currentBudget() },
      );

      if (planResult === null) {
        // Planner output unparseable (Req 12.1)
        return stop("planning-failure", progress, errors);
      }

      // --- Normalize (Req 3.2, 2.4) ---
      progress.tasks = normalize(planResult, validTargets);
      issuedTaskIds = progress.tasks.length;

      if (progress.tasks.length === 0) {
        // No actionable tasks (Req 3.3)
        return stop("no-tasks", progress, errors);
      }
    }

    // --- Emit initial task list (Req 9.1) ---
    emitHarnessStatus(`Task list:\n${renderTaskList(progress.tasks)}`);

    // --- Write initial task list to state before the loop (Req 3.4, 10.3) ---
    // (The progress object is mutated in place and returned on every exit)

    // Tracks report-protocol failures by the logical assignment, rather than by
    // the transient monotone attempt id. A productive sibling must reset the
    // *global* no-progress guard, while this map preserves which document batch
    // still needs repair across retries.
    const coverageReportRejectionStreaks = new Map<string, number>();
    const coverageAssignmentKey = (assignment: CoverageAssignment): string =>
      `${assignment.mode}\u0000${assignment.documents
        .map((document) => document.ref)
        .sort((left, right) => left.localeCompare(right))
        .join("\u0000")}`;

    let coverageProvenanceFailure = false;
    let terminalBudgetFailure = false;

    /**
     * Folds ONE delegation outcome into the harness state.
     *
     * Extracted from the loop body because a batch produces several outcomes
     * that must be folded in TASK order (not completion order) — inlining it
     * would have meant duplicating the carryForward/citation/error handling per
     * code path. Mutates `progress`, `state`, `answerMessages`,
     * `answerCitations` and `errors` from the enclosing scope.
     *
     * Returns whether this outcome carried the configured stop signal.
     */
    const incorporateOutcome = (outcome: {
      task: Task;
      update: Partial<AgentState>;
      ok: boolean;
      coverageEvidence: CoverageDocumentEvidence[];
      searchEvidence: CoverageSearchEvidence[];
      searchParseStatuses: CoverageSearchParseResult["status"][];
    }): boolean => {
      const {
        task: t,
        update,
        ok,
        coverageEvidence,
        searchEvidence,
        searchParseStatuses,
      } = outcome;
      let signalHit = false;

      if (!ok) {
        const errorText = Array.isArray(update.errors)
          ? (update.errors as Array<{ message: string }>)
              .map((e) => e.message)
              .join("; ")
          : "Delegation failed";
        const terminalBudgetError = isTerminalBudgetErrorText(errorText);
        const safeErrorText = terminalBudgetError
          ? "Transaction budget exceeded."
          : "Delegated task failed.";

        // Retry BEFORE giving up: a delegated worker fails for transient
        // reasons (provider hiccup, a tool momentarily unavailable, an empty
        // completion from a local model) far more often than for reasons a
        // re-plan can fix. A shared budget failure is explicitly excluded: its
        // remaining allowance cannot recover during this execution.
        const attempts = t.attempts ?? 0;
        if (!terminalBudgetError && attempts < maxTaskAttempts) {
          t.attempts = attempts + 1;
          t.status = "pending";
          t.researchStatus =
            "The research step is being re-run after a technical error; a domain decision is still pending.";
          // Retain only a stable public failure category on task state. Raw
          // delegated errors may contain provider endpoints or credentials.
          t.error = safeErrorText;
          runtime.onNodeDiagnostic?.(node.id, {
            level: "info",
            code: "harness_task_retry",
            message:
              `Task ${t.id} failed on attempt ${t.attempts} of ` +
              `${maxTaskAttempts + 1} and will be retried.`,
            details: {
              task_id: t.id,
              attempt: t.attempts,
              maxAttempts: maxTaskAttempts + 1,
            },
          });
          emitHarnessStatus(
            `Task ${t.id} → retry ${t.attempts}/${maxTaskAttempts} (${safeErrorText})`,
          );
          return false;
        }

        t.status = "failed";
        t.researchStatus =
          "The research step could not be completed technically; no domain decision is available.";
        t.error = safeErrorText;
        terminalBudgetFailure ||= terminalBudgetError;
        // Preserve failure control flow without copying provider/tool payloads
        // into the harness result or the execution error stream.
        if (Array.isArray(update.errors)) {
          errors.push({
            message: safeErrorText,
            type: "execution_error",
            details: { node_id: node.id, task_id: t.id },
          });
        }
        return false;
      }

      t.status = "completed";
      t.result = summarizeDelegateResult(update);

      // Incorporate the delegate's output so subsequent delegations and
      // re-plans see prior work. Strategy is governed by config.carryForward:
      //   - "condensed": carry ONLY a single condensed finding per task (the
      //     worker's final answer), rebuilt onto the immutable base context.
      //     The shared context grows by one bounded finding per iteration
      //     instead of the whole worker transcript (doc dumps, tool traffic).
      //   - "full" (default): append the worker's entire message output
      //     (legacy behaviour; context grows unbounded).
      if (update.messages) {
        const newMsgs = Array.isArray(update.messages)
          ? update.messages
          : [update.messages];
        let findingMsgs = newMsgs;
        const assignment = currentCoverageAssignment;
        if (
          coverageConfig !== undefined &&
          coverageLedger !== undefined &&
          assignment !== undefined &&
          assignment.id === t.coverageAssignmentId
        ) {
          if (coverageEvidence.length > 0) {
            const evidenceStateBefore = JSON.stringify(
              coverageLedger.documents.map((document) => ({
                ref: document.ref,
                totalChars: document.totalChars,
                modified: document.modified,
                windows: document.windows,
              })),
            );
            coverageLedger = mergeCoverageEvidence(
              coverageLedger,
              coverageEvidence,
            );
            const evidenceStateAfter = JSON.stringify(
              coverageLedger.documents.map((document) => ({
                ref: document.ref,
                totalChars: document.totalChars,
                modified: document.modified,
                windows: document.windows,
              })),
            );
            if (evidenceStateAfter !== evidenceStateBefore)
              coverageUpdates += 1;
            progress.coverage = coverageLedger;
          }
          const workerText = condensedFindingText(newMsgs);
          // Coverage reports are a strict final-turn protocol. Findings may span
          // multiple turns, but aggregating them here turns valid final reports
          // into invalid multi-marker blobs whenever the worker had an interim
          // answer before its final report.
          const finalWorkerText = finalAiAnswerText(newMsgs);
          // A discovery assignment decides nothing, so it owes no report. Its
          // value is the observed search provenance handled above.
          const parsed =
            assignment.mode === "discovery"
              ? undefined
              : parseCoverageReport(
                  finalWorkerText,
                  assignment,
                  coverageConfig.markers,
                );
          // Keep report JSON private. `coverageFindingText` deliberately uses
          // the aggregate so all pre-report factual findings remain available.
          const finding = coverageFindingText(
            workerText,
            coverageConfig.markers,
          );
          findingMsgs = finding === "" ? [] : [new AIMessage(finding)];
          if (parsed !== undefined) {
            coverageReportRejectionStreaks.delete(coverageAssignmentKey(assignment));
            const applied = applyCoverageReport(
              coverageLedger,
              assignment,
              parsed.report,
              searchEvidence,
              coverageConfig.mode === "staged"
                ? undefined
                : coverageConfig.hybridSearch,
              coverageConfig.mode === "staged",
            );
            coverageLedger = applied.ledger;
            progress.coverage = coverageLedger;
            coverageUpdates += applied.changed;
            if (applied.rejectedRefs.length > 0) {
              runtime.onNodeDiagnostic?.(node.id, {
                level: "warn",
                code: "harness_coverage_windows_incomplete",
                message:
                  `Task ${t.id} reported terminal original decisions without ` +
                  `gap-free runtime-observed get_document coverage; status stayed open.`,
                details: {
                  task_id: t.id,
                  assignment_id: assignment.id,
                  rejected_document_count: applied.rejectedRefs.length,
                },
              });
            }
            if (applied.rejectedSearchRefs.length > 0) {
              runtime.onNodeDiagnostic?.(node.id, {
                level: "warn",
                code: "harness_coverage_hybrid_search_incomplete",
                message:
                  `Task ${t.id} reported terminal original decisions without ` +
                  `the required runtime-observed complementary hybrid searches; status stayed open.`,
                details: {
                  task_id: t.id,
                  assignment_id: assignment.id,
                  rejected_document_count: applied.rejectedSearchRefs.length,
                  observed_search_count: searchEvidence.length,
                  hyde_search_count: searchEvidence.filter((item) => item.hyde)
                    .length,
                  grouped_search_count: searchEvidence.filter(
                    (item) => item.groupByDocument,
                  ).length,
                },
              });
            }
            if (applied.rejectedUnexpectedSearchRefs.length > 0) {
              runtime.onNodeDiagnostic?.(node.id, {
                level: "warn",
                code: "harness_coverage_unexpected_original_search",
                message:
                  `Task ${t.id} used search during a staged original analysis; ` +
                  "the terminal decision was rejected and the document stays open.",
                details: {
                  task_id: t.id,
                  assignment_id: assignment.id,
                  rejected_document_count:
                    applied.rejectedUnexpectedSearchRefs.length,
                  observed_search_count: searchEvidence.length,
                },
              });
            }
          } else if (assignment.mode !== "discovery") {
            const defect = describeCoverageReportDefect(
              finalWorkerText,
              assignment,
              coverageConfig.markers,
            );
            // The gate refused the report, so the assignment stays open and comes
            // back in the very next pass unchanged: whatever else the batch did,
            // this document did not move. Counted against
            // `maxStagnantIterations` below so the refusal cannot be masked by an
            // unrelated task's progress in the same batch.
            coverageReportRejections += 1;
            const assignmentKey = coverageAssignmentKey(assignment);
            const rejectionStreak =
              (coverageReportRejectionStreaks.get(assignmentKey) ?? 0) + 1;
            coverageReportRejectionStreaks.set(assignmentKey, rejectionStreak);
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "harness_coverage_report_invalid",
              message:
                `Task ${t.id} did not return a valid coverage report; ` +
                `coverage status was not changed (rule: ${defect}).`,
              details: {
                task_id: t.id,
                assignment_mode: assignment.mode,
                rejection_streak: rejectionStreak,
                defect_code: defect,
              },
            });
          }

          if (
            assignment.mode === "discovery" &&
            searchParseStatuses.includes("unparseable-success")
          ) {
            const message =
              `Task ${t.id} received a successful search response whose provenance ` +
              "could not be parsed; discovery stopped without retrying or invoking verification.";
            coverageProvenanceFailure = true;
            t.status = "failed";
            t.error = message;
            errors.push({
              message,
              type: "execution_error",
              details: {
                node_id: node.id,
                task_id: t.id,
                assignment_id: assignment.id,
                parse_statuses: searchParseStatuses,
              },
            });
            runtime.onNodeDiagnostic?.(node.id, {
              level: "error",
              code: "harness_coverage_search_provenance_unparseable",
              message,
              details: {
                task_id: t.id,
                assignment_id: assignment.id,
                parse_statuses: searchParseStatuses,
              },
            });
            return false;
          }

          let discoveryCompleted = false;
          let promotionEvidence = searchEvidence;
          if (assignment.mode === "discovery") {
            const allNovelEvidence = novelCoverageSearchEvidence(
              coverageLedger,
              searchEvidence,
            );
            const expansionQueryLimit =
              coverageConfig.mode === "staged" &&
              (assignment.discoveryGeneration ?? 0) > 0
                ? coverageConfig.searchDiscovery
                    ?.maxQueriesPerExpansionRound ?? Number.POSITIVE_INFINITY
                : Number.POSITIVE_INFINITY;
            const exceededExpansionQueryLimit =
              allNovelEvidence.length > expansionQueryLimit;
            const novelEvidence = allNovelEvidence.slice(0, expansionQueryLimit);
            const qualifiedEvidence = qualifyingCoverageSearchEvidence(
              novelEvidence,
              coverageConfig.hybridSearch,
            );
            if (coverageConfig.mode === "staged") {
              promotionEvidence = qualifiedEvidence;
            }
            discoveryCompleted =
              !exceededExpansionQueryLimit &&
              novelEvidence.length > 0 &&
              (coverageConfig.mode !== "staged" ||
                qualifiedEvidence.length === novelEvidence.length) &&
              hasRequiredHybridSearchEvidence(
                qualifiedEvidence,
                coverageConfig.hybridSearch,
              );
            if (discoveryCompleted) {
              coverageLedger = markCoverageDiscoveryCompleted(
                coverageLedger,
                qualifiedEvidence,
              );
              progress.coverage = coverageLedger;
              coverageUpdates += 1;
            } else {
              runtime.onNodeDiagnostic?.(node.id, {
                level: exceededExpansionQueryLimit ? "error" : "warn",
                code: exceededExpansionQueryLimit
                  ? "harness_coverage_expansion_query_overflow"
                  : "harness_coverage_discovery_incomplete",
                message: exceededExpansionQueryLimit
                  ? `Task ${t.id} exceeded the configured expansion query limit; ` +
                    "the discovery generation remains open fail-closed."
                  : `Task ${t.id} did not produce the required successful, globally new ` +
                    "complementary hybrid searches; the discovery round remains open.",
                details: {
                  task_id: t.id,
                  assignment_id: assignment.id,
                  previous_search_count:
                    coverageLedger.discoverySearches.length,
                  observed_search_count: searchEvidence.length,
                  novel_search_count: novelEvidence.length,
                  hyde_search_count: searchEvidence.filter((item) => item.hyde)
                    .length,
                  grouped_search_count: searchEvidence.filter(
                    (item) => item.groupByDocument,
                  ).length,
                  expansion_query_limit:
                    Number.isFinite(expansionQueryLimit)
                      ? expansionQueryLimit
                      : null,
                  expansion_query_limit_exceeded:
                    exceededExpansionQueryLimit,
                },
              });
            }
            // Every staged query is globally consumed, including capped or
            // incomplete expansion attempts; retries must use a new perspective.
            // Legacy retries intentionally preserve their prior semantics.
            if (coverageConfig.mode === "staged") {
              coverageLedger = markCoverageQueriesObserved(
                coverageLedger,
                searchEvidence,
              );
              progress.coverage = coverageLedger;
            }
          }

          // Apply search promotion AFTER the summary report. This ordering is
          // deliberate: if a ref appears in both, the search hit wins and the
          // summary-only exclusion cannot immediately undo original review.
          const promotion = coverageConfig.searchDiscovery;
          if (
            promotion !== undefined &&
            promotionEvidence.length > 0 &&
            (coverageConfig.mode !== "staged" ||
              (assignment.mode === "discovery" && discoveryCompleted))
          ) {
            const promoted = promoteCoverageSearchHits(
              coverageLedger,
              promotionEvidence,
              promotion.maxHitsPerPass,
              coverageConfig.mode === "staged"
                ? promotion.rerankScoreThreshold
                : undefined,
            );
            coverageLedger = promoted.ledger;
            progress.coverage = coverageLedger;
            const candidateCount = new Set(
              promotionEvidence.flatMap((item) => item.resultRefs),
            ).size;
            const queuedForOriginalReview = coverageLedger.documents.filter(
              (document) => document.status === "summary-reviewed",
            ).length;
            const selectionRule =
              coverageConfig.mode === "staged" &&
              promotion.rerankScoreThreshold !== undefined
                ? `top ${promotion.maxHitsPerPass} per search pass or rerank score >= ${promotion.rerankScoreThreshold}`
                : `top ${promotion.maxHitsPerPass} per search pass`;
            emitHarnessStatus(
              `Candidate selection: ${candidateCount} candidate documents · ` +
                `${selectionRule} · ${promoted.selectedRefs.length} considered · ` +
                `${promoted.promotedRefs.length} newly queued · ` +
                `${queuedForOriginalReview} queued for original review in total`,
            );
            if (promoted.promotedRefs.length > 0) {
              coverageUpdates += promoted.promotedRefs.length;
              runtime.onNodeDiagnostic?.(node.id, {
                level: "info",
                code: "harness_coverage_search_promoted",
                message:
                  `Task ${t.id} promoted ${promoted.promotedRefs.length} document(s) ` +
                  "to original review from targeted search hits.",
                details: {
                  task_id: t.id,
                  assignment_id: assignment.id,
                  promoted_document_count: promoted.promotedRefs.length,
                },
              });
            }
          }

          if (
            coverageConfig.mode === "staged" &&
            assignment.mode === "discovery" &&
            discoveryCompleted
          ) {
            const frozen = freezeCoverageCandidates(
              coverageLedger,
              coverageConfig.searchDiscovery?.maxCandidates,
            );
            coverageLedger = frozen.ledger;
            progress.coverage = coverageLedger;
            runtime.onNodeDiagnostic?.(node.id, {
              level: frozen.overflowRefs.length > 0 ? "error" : "info",
              code:
                frozen.overflowRefs.length > 0
                  ? "harness_coverage_candidate_overflow"
                  : "harness_coverage_candidates_frozen",
              message:
                frozen.overflowRefs.length > 0
                  ? "Staged candidate budget overflowed; completeness remains fail-closed."
                  : `Staged candidate generation ${assignment.discoveryGeneration ?? 0} frozen.`,
              details: {
                assignment_id: assignment.id,
                generation: assignment.discoveryGeneration ?? 0,
                frozen_document_count: frozen.frozenRefs.length,
                expansion_seed_count: assignment.expansionSeeds?.length ?? 0,
                overflow_document_count: frozen.overflowRefs.length,
                candidate_count: coverageLedger.candidateRefs.length,
              },
            });
          }

          coverageLedger = settleCoveragePhase(
            coverageLedger,
            coverageConfig,
          );
          progress.coverage = coverageLedger;

          // Task progress/checkpoints must not retain the private JSON report.
          t.result =
            findingMsgs.length > 0
              ? summarizeDelegateResult({ messages: findingMsgs })
              : `(coverage report processed — ${coverageSummary(coverageLedger)})`;
        }
        // Detect the deterministic stop signal in the worker's finding text
        // (the same condensed text used for carryForward).
        if (cfg.stopSignal !== undefined) {
          const findingForSignal = condensedFindingText(findingMsgs);
          if (
            isSubstantiveFinding(
              findingForSignal,
              cfg.requiredFindingMarkers,
            ) &&
            findingForSignal
              .toLowerCase()
              .includes(cfg.stopSignal.toLowerCase())
          ) {
            signalHit = true;
          }
          if (
            coverageLedger !== undefined &&
            !isCoverageTerminal(coverageLedger, coverageConfig)
          ) {
            signalHit = false;
          }
        }
        if (carryForward === "condensed") {
          // Defensive ceiling: bound the finding carried forward so one
          // verbose/degenerate worker output cannot explode the shared
          // context across iterations (see CONDENSED_FINDING_MAX).
          const answerText = capCondensedFinding(
            condensedFindingText(findingMsgs),
            cfg.condensedFindingMaxChars,
          );
          const substantiveFinding = isSubstantiveFinding(
            answerText,
            cfg.requiredFindingMarkers,
          );
          const findingText = substantiveFinding
            ? answerText
            : "(abgeschlossen, kein neuer Textbefund)";
          const duplicateOf = contextFindings.findIndex((prior) =>
            areNearDuplicateFindings(prior, findingText),
          );
          if (substantiveFinding && duplicateOf < 0) {
            contextFindings.push(findingText);
            answerMessages.push(
              new AIMessage(`[${t.id}] ${t.description}\n${findingText}`),
            );
          } else if (!substantiveFinding) {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "info",
              code: "harness_no_new_finding",
              message: `Task ${t.id} completed without a new substantive finding.`,
              details: { task_id: t.id },
            });
          } else {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "info",
              code: "harness_duplicate_finding_dropped",
              message:
                `Task ${t.id} produced a near-duplicate of finding ` +
                `${duplicateOf + 1}; it was not carried to the synthesizer.`,
              details: { task_id: t.id, duplicate_of: duplicateOf + 1 },
            });
          }
          // Rebuild from the immutable base (user goal + injected overview)
          // plus the unique condensed findings so far — never raw worker output.
          state = {
            ...state,
            messages: [
              ...baseMessages,
              ...answerMessages,
              ...verificationNotes,
            ],
          };
        } else {
          state = { ...state, messages: [...state.messages, ...findingMsgs] };
          // Capture the real assistant answers for the final output,
          // excluding injected RAG/context SystemMessages and tool messages.
          for (const m of findingMsgs) {
            if (!isAiAnswer(m)) continue;
            const text = messageText(m).trim();
            const substantiveFinding =
              !isEmptyResponseFallback(m) &&
              isSubstantiveFinding(text, cfg.requiredFindingMarkers);
            // In context mode, non-substantive worker placeholders must not
            // re-enter the synthesizer via stop()'s answerMessages fallback.
            // Delegated/user-facing mode preserves legacy visibility.
            if (substantiveFinding || cfg.resultMode !== "context") {
              answerMessages.push(m);
            }
            if (
              substantiveFinding &&
              !contextFindings.some((prior) =>
                areNearDuplicateFindings(prior, text),
              )
            ) {
              contextFindings.push(text);
            }
          }
        }
      }
      if (update.toolResults) {
        const newResults = Array.isArray(update.toolResults)
          ? update.toolResults
          : [update.toolResults];
        state = {
          ...state,
          toolResults: [...(state.toolResults ?? []), ...newResults],
        };
      }
      // Propagate citations emitted by delegated RAG steps to the client.
      if (update.citations) {
        const newCites = Array.isArray(update.citations)
          ? update.citations
          : [update.citations];
        for (const c of newCites) answerCitations.push(c);
      }
      return signalHit;
    };

    if (cfg.verification !== undefined && verifierNode === undefined) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: cfg.verification.failClosed === true ? "error" : "warn",
        code: "harness_verifier_missing",
        message:
          `Verification target "${cfg.verification.target}" was not found in the ` +
          (cfg.verification.failClosed === true
            ? "flow; fail-closed verification will reject completion."
            : "flow; the run will complete WITHOUT verification. Fix the id in config.verification.target."),
        details: {
          target: cfg.verification.target,
          fail_closed: cfg.verification.failClosed === true,
        },
      });
    }

    const maxVerificationAttempts = resolveVerificationAttempts(
      cfg.verification?.maxAttempts,
    );

    /**
     * Runs the verification gate once.
     *
     * Returns `"pass"` when the reviewer emitted the pass signal, `"fail"` when
     * it did not (its critique has then been recorded for the re-plan), or
     * `"unavailable"` when the delegation itself failed. The completion gate
     * then follows `verification.failClosed`: reject in strict mode, preserve
     * the legacy fail-open behaviour otherwise.
     */
    const runVerification = async (): Promise<
      "pass" | "fail" | "unavailable"
    > => {
      // The verifier judges only the stable user/system request, compacted
      // findings and the complete sanitized ledger. The dossier RAG map is
      // useful to researchers but is neither original evidence nor part of the
      // verifier contract. Prior worker turns are rebuilt from contextFindings
      // under one aggregate budget instead of being replayed unbounded.
      const requestMessages = coverageRequestMessages(baseMessages);
      // `verificationActive` (checked by the sole caller, gateCompletion) is
      // exactly `cfg.verification !== undefined && verifierNode !== undefined`,
      // so this is never hit in practice — but the local narrowing lets us
      // avoid `cfg.verification!` throughout the rest of this closure.
      const verification = cfg.verification;
      if (verification === undefined) return "unavailable";

      const maxContextChars =
        cfg.verificationContextMaxChars ??
        DEFAULT_VERIFICATION_CONTEXT_MAX_CHARS;
      const verifierInstruction =
        "Review now according to your system instruction and emit either " +
        "the pass signal or exclusively the numbered rework list.";
      // Reserve request and fixed verifier instruction first; the manifest then
      // deterministically sheds only verbose fields while retaining every ref
      // and status. This applies the context limit to the real assembled turn,
      // not merely to the ledger in isolation.
      const manifestBudget = Math.max(
        0,
        maxContextChars - messageChars(requestMessages) - verifierInstruction.length - 2,
      );
      const manifest =
        coverageLedger === undefined
          ? undefined
          : coverageVerificationManifest(
              coverageLedger,
              coverageConfig,
              manifestBudget,
            );
      const manifestChars = manifest?.length ?? 0;
      // The ledger is the LAST message and must be a HUMAN turn, for two
      // reasons that both broke the gate in production:
      //
      //  1. Role semantics. As a trailing SystemMessage it is not provider-valid
      //     outside position 0, so `sanitizeSystemMessages` folds it into the
      //     preceding message — the last carried finding, an ASSISTANT turn. The
      //     verifier is then asked to distrust completeness claims in the free
      //     finding text while the authoritative ledger sits inside exactly that
      //     text, indistinguishable from it.
      //  2. Turn structure. The folded list then ENDS on an assistant turn, and
      //     a Qwen chat template renders that as a second consecutive assistant
      //     turn — answered with an immediate end token, i.e. an empty
      //     completion on every retry and every fallback candidate. That is how
      //     a 17-minute run died on "empty LLM response" in this fail-closed
      //     gate (see `ensureTrailingUserTurn` in exec-runtime.ts, which is the
      //     engine-wide backstop for the same shape).
      const manifestMessage =
        manifest === undefined
          ? undefined
          : new HumanMessage({
              content: `${manifest}\n\n${verifierInstruction}`,
            });
      const fixedMessages = [
        ...requestMessages,
        ...(manifestMessage === undefined ? [] : [manifestMessage]),
      ];
      const fixedChars = messageChars(fixedMessages);
      if (fixedChars > maxContextChars) {
        const message =
          `Verifier context requires ${fixedChars} characters for the request ` +
          `and complete ledger, above the ${maxContextChars}-character budget.`;
        errors.push({
          message: `Agent harness "${node.id}": ${message}`,
          type: "execution_error",
          details: { node_id: node.id },
        });
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "harness_verifier_context_over_budget",
          message,
          details: {
            phase: "coverage-verifier",
            max_chars: maxContextChars,
            request_chars: messageChars(requestMessages),
            manifest_chars: manifestChars,
            ledger_documents: coverageLedger?.documents.length ?? 0,
            finding_count: contextFindings.length,
          },
        });
        return "unavailable";
      }

      const findingBudget = maxContextChars - fixedChars;
      const findingMessages = budgetHarnessMessages(
        [
          ...contextFindings.map((finding) => new AIMessage(finding)),
          ...verificationNotes,
        ],
        findingBudget,
      );
      const verifierMessages = [
        ...requestMessages,
        ...findingMessages,
        ...(manifestMessage === undefined ? [] : [manifestMessage]),
      ];

      verificationRounds += 1;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "harness_prompt_budget",
        message: "Built bounded coverage-verifier context.",
        details: {
          phase: "coverage-verifier",
          max_chars: maxContextChars,
          total_chars: messageChars(verifierMessages),
          request_chars: messageChars(requestMessages),
          findings_chars: messageChars(findingMessages),
          manifest_chars: manifestChars,
          message_count: verifierMessages.length,
          ledger_documents: coverageLedger?.documents.length ?? 0,
          finding_count: contextFindings.length,
        },
      });
      emitHarnessStatus(
        `→ Verifikation (Runde ${verificationRounds}/${maxVerificationAttempts}) via ${verification.target}`,
      );

      const verificationState = { ...state, messages: verifierMessages };
      const { update, ok } = await runDelegation(
        verification.target,
        `verification-${verificationRounds}`,
        verificationState,
        withDelegateRuntime(
          withChildDelegationDepth(config, node.id),
          runtimeForRemainingTime(),
          cfg.streamDelegates !== false,
          verification.target,
        ),
      );
      // The verifier is a real delegated step and is billed as one iteration.
      progress.iterations += 1;

      if (!ok) {
        // Fail-closed semantics require an error, not the verifier's raw
        // provider/tool payload. The latter may contain credentials or private
        // endpoints and must not enter the parent execution stream.
        if (verification.failClosed === true && Array.isArray(update.errors)) {
          errors.push({
            message: "Verification worker failed.",
            type: "execution_error",
            details: { node_id: node.id },
          });
        }
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "harness_verifier_failed",
          message:
            `Verifier "${verification.target}" could not be run; the result ` +
            (verification.failClosed === true
              ? "is rejected by fail-closed verification."
              : "is reported as complete but UNVERIFIED."),
          details: {
            target: verification.target,
            fail_closed: verification.failClosed === true,
          },
        });
        return "unavailable";
      }

      const msgs = update.messages
        ? Array.isArray(update.messages)
          ? update.messages
          : [update.messages]
        : [];
      let verdictText = condensedFindingText(msgs);
      if (
        verdictText.trim().toLowerCase() ===
        verification.passSignal.toLowerCase()
      ) {
        const coverageIsTerminal =
          coverageLedger === undefined ||
          isCoverageTerminal(coverageLedger, coverageConfig);
        if (coverageIsTerminal) {
          emitHarnessStatus("Verifikation bestanden.");
          return "pass";
        }
        // A reviewer may assess quality, but it may never override deterministic
        // queue invariants. Treat a premature PASS as a rejection and re-open
        // the bounded repair cycle instead of reporting completed coverage.
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "harness_verifier_pass_nonterminal_coverage",
          message:
            `Verifier "${verification.target}" emitted PASS while deterministic ` +
            "coverage work remained open; the PASS was ignored.",
          details: {
            target: verification.target,
            coverage: coverageLedger
              ? coverageSummary(coverageLedger)
              : undefined,
          },
        });
        verdictText =
          "GLOBAL COVERAGE: Deterministic coverage remains non-terminal. " +
          "Complete every open document assignment and all required discovery rounds.";
      }

      if (coverageLedger !== undefined) {
        const reopened = reopenCoverageFromCritique(
          coverageLedger,
          verdictText,
          coverageConfig,
        );
        coverageLedger = reopened.ledger;
        progress.coverage = coverageLedger;
        if (reopened.discoveryReopened) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "info",
            code: "harness_coverage_discovery_reopened",
            message:
              `Verification round ${verificationRounds} reopened one global ` +
              "discovery round while retaining prior query provenance.",
            details: {
              completed_rounds: coverageLedger.discoveryRounds,
              required_rounds: coverageConfig?.searchDiscovery?.rounds ?? 0,
            },
          });
        }
        if (reopened.reopenedRefs.length > 0) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "info",
            code: "harness_coverage_reopened",
            message:
              `Verification round ${verificationRounds} reopened ` +
              `${reopened.reopenedRefs.length} referenced coverage item(s).`,
            details: { reopened_document_count: reopened.reopenedRefs.length },
          });
        }
      }

      // Record the critique so the re-plan can act on something concrete rather
      // than merely learning that "verification failed".
      verificationNotes.push(
        new AIMessage(
          `[VERIFICATION FAILED — round ${verificationRounds}] ` +
            "The following critique must be resolved before the assignment " +
            `counts as done:\n${capCondensedFinding(verdictText, cfg.condensedFindingMaxChars)}`,
        ),
      );
      state = {
        ...state,
        messages: [...baseMessages, ...answerMessages, ...verificationNotes],
      };
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "harness_verification_rejected",
        message:
          `Verification round ${verificationRounds} of ` +
          `${maxVerificationAttempts} rejected the result; re-planning.`,
        details: { round: verificationRounds, target: verification.target },
      });
      return "fail";
    };

    /**
     * Intercepts a would-be successful exit.
     *
     * Returns `undefined` when the run may finish (verification passed, was not
     * configured, or is unavailable), or a `StopReason` when it must stop
     * unverified. Returns `"retry"` to signal that the loop should re-plan and
     * keep going.
     */
    const gateCompletion = async (): Promise<
      | { action: "finish" }
      | { action: "retry" }
      | { action: "stop"; reason: StopReason }
    > => {
      if (cfg.verification === undefined || verified) {
        return { action: "finish" };
      }
      if (!verificationActive) {
        return cfg.verification.failClosed === true
          ? { action: "stop", reason: "verification-failed" }
          : { action: "finish" };
      }

      const verdict = await runVerification();
      if (verdict === "pass") {
        verified = true;
        return { action: "finish" };
      }
      if (verdict === "unavailable") {
        return cfg.verification.failClosed === true
          ? { action: "stop", reason: "verification-failed" }
          : { action: "finish" };
      }

      if (verificationRounds >= maxVerificationAttempts) {
        return { action: "stop", reason: "verification-failed" };
      }
      // Reopen the plan: everything settled, so without new pending work the
      // loop would immediately re-enter this gate. The re-plan below produces it.
      return { action: "retry" };
    };

    /**
     * Re-plans after a rejected verification and returns whether new actionable
     * work was produced.
     *
     * A dedicated call rather than falling through to the loop's normal re-plan:
     * at this point every task is settled, so the loop's `allSettled` branch
     * would re-enter the gate immediately and spin. New pending tasks are
     * required for the loop to make progress.
     *
     * In plannerless mode there is no planner to consult, so the single worker is
     * re-seeded once — it now sees the critique in context.
     */
    const replanAfterVerification = async (): Promise<boolean> => {
      if (plannerless) {
        if (plannerlessTarget === undefined) return false;
        if (coverageLedger !== undefined && coverageConfig !== undefined) {
          currentCoverageAssignment = issueCoverageAssignment();
          if (currentCoverageAssignment === undefined) return false;
        } else {
          currentCoverageAssignment = undefined;
        }
        plannerlessSeq += 1;
        progress.tasks.push({
          id: `v${verificationRounds}-${plannerlessSeq}`,
          description:
            currentCoverageAssignment === undefined
              ? `Nacharbeit nach Verifikation (${verificationRounds})`
              : coverageTaskLabel(
                  currentCoverageAssignment,
                  "Coverage-Nacharbeit",
                ),
          target:
            coverageTargetForAssignment(currentCoverageAssignment) ??
            plannerlessTarget,
          status: "pending",
          ...(currentCoverageAssignment !== undefined
            ? {
                coverageAssignmentId: currentCoverageAssignment.id,
                coverageAssignmentMode: currentCoverageAssignment.mode,
                coverageRefs: currentCoverageAssignment.documents.map(
                  (document) => document.ref,
                ),
              }
            : {}),
        });
        return true;
      }
      if (plannerLlm === undefined) return false;

      const filteredMsgs = filterMessagesForPlanner(
        transformRagForPlanner(state.messages, true),
      );
      const replanResult = await plan(
        runtime,
        plannerLlm,
        baseMessagesToModelMessages(filteredMsgs),
        validTargets,
        progress,
        _testOverrides?.extractJson,
        { ...plannerOpts, budget: currentBudget() },
      );
      if (replanResult === null) return false;
      const replanTasks = normalize(replanResult, validTargets, issuedTaskIds);
      if (replanTasks.length === 0) return false;
      progress.tasks = mergeReplan(progress.tasks, replanTasks);
      issuedTaskIds += replanTasks.length;
      emitHarnessStatus(
        `Nacharbeit nach Verifikation:\n${renderTaskList(progress.tasks)}`,
      );
      return true;
    };

    // --- Execution Loop ---
    while (true) {
      // Limit checks BEFORE starting another task (Req 5.2, 6.2, 7.2)
      const limitHit = checkLimits(progress, cfg, startTime);
      if (limitHit !== undefined) {
        return stop(limitHit, progress, errors);
      }

      // Select the next batch of pending tasks (Req 4.1). A batch holds more
      // than one task only when the planner marked contiguous pending tasks
      // `parallelizable` — otherwise it is a single task and behaviour is
      // identical to the previous strictly sequential loop.
      const batch = selectTaskBatch(
        progress.tasks,
        maxConcurrentTasks,
        (t) =>
          cfg.consequentialTargets?.includes(t.target) === true &&
          runtime.approvalGate?.enabled === true,
      );

      if (batch.length === 0) {
        // No pending tasks remain
        const anyCompleted = progress.tasks.some(
          (t) => t.status === "completed",
        );
        if (anyCompleted) {
          return stop("completed", progress, errors);
        } else {
          return stop("exhausted", progress, errors);
        }
      }

      for (const t of batch) {
        t.status = "in-progress";
        t.researchStatus =
          t.coverageAssignmentMode === "summary"
            ? "Summary triage in progress: the relevance of the assigned documents is being decided against the question."
            : t.coverageAssignmentMode === "discovery"
              ? "Targeted search in progress: hits are being assessed as candidates for original review."
              : t.coverageAssignmentMode === "original"
                ? "Original review in progress: evidence passages and possible counter-evidence are being reconciled for a dependable decision."
                : "Research in progress: the next sub-aspect is being examined against the available sources.";
      }
      const task = batch[0];
      if (task === undefined) {
        // Unreachable: `batch.length === 0` already returned above.
        return stop("exhausted", progress, errors);
      }
      emitHarnessStatus(
        batch.length === 1
          ? `Task ${formatTaskReference(task)} → in-progress`
          : `Tasks ${batch.map((t) => formatTaskReference(t)).join(", ")} → in-progress (parallel)`,
      );

      // The approval gate below handles a single task. `selectTaskBatch`
      // guarantees an approval-gated task is returned ALONE, so this is safe —
      // and it is why approval prompts can never interleave within a batch.

      // --- Approval gate for consequential targets (Req 11.1, 11.2, 11.3, 11.4) ---
      if (
        cfg.consequentialTargets?.includes(task.target) &&
        runtime.approvalGate?.enabled
      ) {
        const requestedBy = approvalRequestedBy(runtime.ctx);
        const decision = await runtime.approvalGate.request(
          {
            executionId: runtime.ctx.executionId,
            nodeId: node.id,
            tool: task.target,
            args: { taskId: task.id, description: task.description },
            ...(runtime.ctx.clientId !== undefined
              ? { tenantId: runtime.ctx.clientId }
              : {}),
            ...(requestedBy !== undefined ? { requestedBy } : {}),
          },
          runtime.onApprovalRequired,
        );

        if (!decision.approved) {
          task.status = "failed";
          task.error = decision.reason ?? "approval rejected";
          errors.push({
            message: `Task "${task.id}" target "${task.target}" was not approved: ${task.error}`,
            type: "execution_error" as const,
            details: {
              node_id: node.id,
              task_id: task.id,
              target: task.target,
            },
          });
          emitHarnessStatus(
            `Task ${formatTaskReference(task)} → failed (approval rejected)`,
          );

          // Accumulate iteration for the rejected task
          progress.iterations += 1;
          progress.cost = accumulatedCost;

          // Re-plan after rejection (Req 11.4)
          // Filter out tool-related messages to avoid tool call/result mismatch
          // errors; drop the RAG overview entirely on re-plan (#1 — progress
          // + condensed findings suffice for the continue/stop decision).
          const filteredMsgs = filterMessagesForPlanner(
            transformRagForPlanner(state.messages, true),
          );
          const updatedModelMessages =
            baseMessagesToModelMessages(filteredMsgs);
          if (plannerLlm === undefined) {
            // Unreachable: re-planning only occurs in planned mode, where the
            // guard at the top of the handler already ensured a planner LLM.
            throw new Error(
              `Agent harness "${node.id}": planner LLM missing (invariant violated).`,
            );
          }
          const replanResult = await plan(
            runtime,
            plannerLlm,
            updatedModelMessages,
            validTargets,
            progress,
            _testOverrides?.extractJson,
            { ...plannerOpts, budget: currentBudget() },
          );
          if (replanResult !== null) {
            const replanTasks = normalize(
              replanResult,
              validTargets,
              issuedTaskIds,
            );
            if (replanTasks.length > 0) {
              progress.tasks = mergeReplan(progress.tasks, replanTasks);
              // Advance the id counter so the NEXT re-plan cannot reuse these ids.
              issuedTaskIds += replanTasks.length;
              emitHarnessStatus(
                `Updated task list:\n${renderTaskList(progress.tasks)}`,
              );
            }
          }
          continue;
        }
      }

      // Approval and progress callbacks may themselves consume the remaining
      // wall-clock budget. Re-check immediately before launching expensive
      // delegations; each child also receives a signal capped to the exact
      // remaining harness time via runtimeForRemainingTime().
      const preDelegationLimit = checkLimits(progress, cfg, startTime);
      if (preDelegationLimit !== undefined) {
        for (const pending of batch) {
          if (pending.status === "in-progress") pending.status = "pending";
        }
        return stop(preDelegationLimit, progress, errors);
      }

      // --- Delegate (Req 4.2) ---
      // The batch runs concurrently, but results are incorporated in TASK
      // order, not completion order. That matters beyond tidiness: the shared
      // context is rebuilt from the findings, so completion-order incorporation
      // would make the next prompt depend on network timing — losing prompt-cache
      // reuse and making runs irreproducible.
      emitHarnessStatus(
        batch.length === 1
          ? `→ delegating to ${task.target}`
          : `→ delegating in parallel to ${batch.map((t) => t.target).join(", ")}`,
      );

      const outcomes = await Promise.all(
        batch.map(async (t) => {
          const assignment =
            currentCoverageAssignment?.id === t.coverageAssignmentId
              ? currentCoverageAssignment
              : undefined;
          const delegateState = (() => {
            if (
              assignment === undefined ||
              coverageConfig === undefined ||
              coverageLedger === undefined
            ) {
              return state;
            }

            const maxContextChars =
              cfg.coverageWorkerContextMaxChars ??
              DEFAULT_COVERAGE_WORKER_CONTEXT_MAX_CHARS;
            // Coverage assignments are self-contained. Replaying the global
            // dossier overview and every prior finding made prompt size grow
            // with dossier size and iteration count (trace cc79ff74). Preserve
            // only the stable request plus bounded verifier feedback.
            const requestMessages = coverageRequestMessages(baseMessages);
            const workerContext = budgetHarnessMessages(
              [...requestMessages, ...verificationNotes],
              maxContextChars,
            );
            // A HUMAN turn, not a trailing SystemMessage: from verification
            // round 2 on, `verificationNotes` puts an AIMessage last, so a
            // trailing system message would be folded into that assistant turn
            // by `sanitizeSystemMessages` — hiding the assignment inside the
            // reviewer's critique and leaving the prompt ending on an assistant
            // turn, which local Qwen answers with an empty completion. Same
            // reasoning as the verifier manifest above.
            const assignmentMessage = new HumanMessage({
              content: renderCoverageAssignment(
                assignment,
                coverageConfig,
                coverageLedger,
              ),
            });
            const messages = [...workerContext, assignmentMessage];
            runtime.onNodeDiagnostic?.(node.id, {
              level: "info",
              code: "harness_prompt_budget",
              message: "Built bounded coverage-worker context.",
              details: {
                phase: "coverage-worker",
                target: t.target,
                assignment_id: assignment.id,
                assignment_mode: assignment.mode,
                max_context_chars: maxContextChars,
                context_chars: messageChars(workerContext),
                assignment_chars: messageText(assignmentMessage).length,
                total_chars: messageChars(messages),
                message_count: messages.length,
                dropped_rag_messages: baseMessages.filter(
                  (message) =>
                    message._getType() === "system" &&
                    isRagContextMessage(messageText(message)),
                ).length,
                omitted_prior_findings: answerMessages.length,
                verifier_note_count: verificationNotes.length,
              },
            });
            return { ...state, messages };
          })();
          const coverageEvidence: CoverageDocumentEvidence[] = [];
          const searchEvidence: CoverageSearchEvidence[] = [];
          const searchParseStatuses: CoverageSearchParseResult["status"][] = [];
          const childRuntime = runtimeForRemainingTime();
          const delegatedRuntime =
            assignment === undefined
              ? childRuntime
              : withCoverageEvidenceRuntime(
                  childRuntime,
                  assignment,
                  coverageEvidence,
                  searchEvidence,
                  searchParseStatuses,
                  (item) =>
                    emitHarnessStatus(formatCoverageSearchStatus(item)),
                );
          const res = await runDelegation(
            t.target,
            `${t.id}-attempt-${(t.attempts ?? 0) + 1}`,
            delegateState,
            // Child config carries depth+1 and this node appended to the
            // ancestor chain. Built per delegation (not once before the loop)
            // because `withChildDelegationDepth` must not mutate the parent's
            // config — otherwise the depth would keep climbing across SIBLING
            // tasks and the effective limit would depend on how many ran first.
            withDelegateRuntime(
              withChildDelegationDepth(config, node.id),
              delegatedRuntime,
              cfg.streamDelegates !== false,
              t.target,
            ),
          );
          return {
            task: t,
            coverageEvidence,
            searchEvidence,
            searchParseStatuses,
            ...res,
          };
        }),
      );

      // --- Incorporate results (Req 4.3, 4.6) ---
      // One iteration per delegated step: a parallel batch saves wall-clock
      // time, not budget. Counting a batch as a single iteration would let a
      // planner evade the iteration limit by marking everything parallelizable.
      progress.iterations += outcomes.length;

      // #2: set when a just-completed worker finding contains cfg.stopSignal
      // (case-insensitive) — the loop then ends without another planner call.
      let stopSignalHit = false;
      const findingCountBeforeBatch = contextFindings.length;
      const coverageUpdatesBeforeBatch = coverageUpdates;
      const coverageRejectionsBeforeBatch = coverageReportRejections;

      for (const outcome of outcomes) {
        stopSignalHit = incorporateOutcome(outcome) || stopSignalHit;
      }
      if (terminalBudgetFailure) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "harness_budget_limit",
          message:
            "Harness stopped immediately because a delegated worker exhausted the shared execution budget.",
          details: {
            iterations: progress.iterations,
            completed_tasks: progress.tasks.filter(
              (task) => task.status === "completed",
            ).length,
          },
        });
        return stop("budget-limit", progress, []);
      }
      if (coverageProvenanceFailure) {
        return stop("coverage-provenance-failure", progress, errors);
      }

      const newFindingCount = contextFindings.length - findingCountBeforeBatch;
      const newFindings = contextFindings.slice(findingCountBeforeBatch);
      const coverage = newFindings
        .map((finding) =>
          finding
            .split("\n")
            .find((line) => line.trim().toUpperCase().startsWith("ABGEDECKT:")),
        )
        .filter((line): line is string => line !== undefined)
        .join("; ");
      const citationCount = new Set(
        newFindings.flatMap((finding) => finding.match(/\[\d+\]/g) ?? []),
      ).size;

      let narratedProgress: string | null = null;
      let narratedResearchStatus: string | null = null;
      let hypothesisStatus:
        | import("./tools.js").ProgressHypothesisStatus
        | undefined;
      if (
        outcomes.some((outcome) => outcome.ok) &&
        cfg.progressNarrator !== undefined &&
        cfg.progressNarrator.enabled !== false
      ) {
        const narration = await narrateProgress(
          runtime,
          cfg.progressNarrator,
          {
            iteration: progress.iterations,
            totalIterations: cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            phase:
              outcomes.find((outcome) => outcome.ok)?.task.coverageAssignmentMode ??
              "research",
            finding: newFindings.join("\n\n"),
            citationCount,
          },
          node.id,
        );
        if (narration !== null) {
          narratedProgress = narration.text;
          narratedResearchStatus = narration.researchStatus;
          hypothesisStatus = narration.hypothesisStatus;
          accumulatedCost += narration.cost;
        }
      }

      const coverageProgress = coverageUpdates - coverageUpdatesBeforeBatch;
      const coverageRejections =
        coverageReportRejections - coverageRejectionsBeforeBatch;
      const observedSearchPasses = outcomes
        .filter((outcome) => outcome.ok)
        .reduce((total, outcome) => total + outcome.searchEvidence.length, 0);
      const coverageModes = new Set<"summary" | "discovery" | "original">();
      for (const outcome of outcomes) {
        if (!outcome.ok) continue;
        const mode = outcome.task.coverageAssignmentMode;
        if (mode === "summary" || mode === "discovery" || mode === "original") {
          coverageModes.add(mode);
        }
      }
      if (plannerless && outcomes.some((outcome) => outcome.ok)) {
        // A rejected report keeps only its assignment open. A coverage commit
        // elsewhere in a parallel batch resets global no-progress detection,
        // so a bad sibling cannot terminate productive work.
        consecutiveStagnantIterations =
          coverageProgress > 0 || (coverageRejections === 0 && newFindingCount > 0)
            ? 0
            : consecutiveStagnantIterations + 1;
      }

      // A missing condensed text finding does not mean that retrieval found
      // nothing relevant. Summary decisions, observed searches and promotions
      // are tracked in the coverage ledger rather than in contextFindings.
      // The deterministic sentence therefore reports the observed phase in plain
      // language; the narrator may replace it with a richer, still
      // evidence-bound one.
      const phaseSentence = describeResearchPhase({
        modes: Array.from(coverageModes),
        newFindingCount,
        citationCount,
        coverageProgress,
        observedSearchPasses,
        ...(plannerless
          ? { stagnantIterations: consecutiveStagnantIterations }
          : {}),
        ...(cfg.maxStagnantIterations !== undefined
          ? { maxStagnantIterations: cfg.maxStagnantIterations }
          : {}),
      });
      const taskResearchStatus = narratedResearchStatus ?? phaseSentence;
      for (const outcome of outcomes) {
        if (outcome.ok) outcome.task.researchStatus = taskResearchStatus;
      }
      // Progress is only claimed when a delegation actually succeeded. A batch
      // in which everything failed or was queued for retry must not surface as
      // research progress.
      if (outcomes.some((outcome) => outcome.ok)) {
        const coverageDetail =
          coverageLedger === undefined
            ? ""
            : ` — coverage: ${coverageSummary(coverageLedger)}`;
        const hypothesisDetail =
          hypothesisStatus === undefined
            ? ""
            : ` — hypotheses (this step): ${hypothesisStatus.active} active, ${hypothesisStatus.confirmed} confirmed, ${hypothesisStatus.rejected} rejected; ` +
              `detail [${hypothesisStatus.detailState.toLocaleUpperCase("de-DE")}]: ${compactStatusText(hypothesisStatus.detail, 180)}`;
        const coveredScope =
          coverage.length > 0 ? ` — ${compactStatusText(coverage, 220)}` : "";
        emitHarnessStatus(
          `Research progress: ${
            narratedProgress ??
            `Step ${progress.iterations}/${cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS}: ${phaseSentence}`
          }${hypothesisDetail}${coveredScope}${coverageDetail}`,
        );
      }

      // Emit status changes (Req 9.2)
      emitHarnessStatus(
        batch
          .map((t) => `Task ${formatTaskReference(t)} → ${t.status}`)
          .join("\n"),
      );

      // --- Accumulate cost (Req 6.1) ---
      progress.cost = accumulatedCost;
      // Narration runs after delegation, so its cost was not visible to the
      // pre-iteration limit check. Enforce maxCost again before any terminal
      // completion path can bypass the newly incurred narrator spend.
      if (cfg.maxCost !== undefined && progress.cost >= cfg.maxCost) {
        return stop("cost-limit", progress, errors);
      }

      // --- Check if all tasks are completed (Req 4.5) ---
      const allSettled = progress.tasks.every(
        (t) => t.status === "completed" || t.status === "failed",
      );
      if (allSettled) {
        // Plannerless: unless the worker just signalled completion, re-seed the
        // next research pass and keep looping — the limits (checkLimits at the
        // top) bound the run. This replaces the planner re-plan entirely.
        if (
          plannerless &&
          !stopSignalHit &&
          plannerlessTarget !== undefined &&
          (coverageLedger === undefined ||
            !isCoverageTerminal(coverageLedger, coverageConfig))
        ) {
          if (
            cfg.maxStagnantIterations !== undefined &&
            consecutiveStagnantIterations >= cfg.maxStagnantIterations
          ) {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "harness_stagnation_limit",
              message:
                `Plannerless harness stopped after ${consecutiveStagnantIterations} ` +
                "consecutive completed passes without a unique finding." +
                (coverageReportRejections > 0
                  ? ` ${coverageReportRejections} coverage report(s) were refused by the gate; see harness_coverage_report_invalid.`
                  : ""),
              details: {
                stagnant_iterations: consecutiveStagnantIterations,
                unique_findings: contextFindings.length,
                coverage_report_rejections: coverageReportRejections,
              },
            });
            return stop("stagnation-limit", progress, errors);
          }
          plannerlessSeq += 1;
          currentCoverageAssignment = issueCoverageAssignment();
          if (
            coverageLedger !== undefined &&
            currentCoverageAssignment === undefined
          ) {
            // The queue still owes work it can no longer assign — typically a
            // discovery round whose bounded attempts are spent. Completeness
            // stays fail-closed, but the configured verifier must still judge
            // the findings: it sees discoveryRounds and the global
            // discoverySearches provenance. A rejection starts a bounded repair
            // cycle by resetting the current discovery attempt budget and can
            // additionally reopen explicitly named refs. Only an actual
            // verifier PASS upgrades this to "completed"; without a gate, or
            // with a rejecting one, the run stays partial.
            const gate = await gateCompletion();
            if (gate.action === "stop") {
              return stop(gate.reason, progress, errors);
            }
            if (gate.action === "retry") {
              const replanned = await replanAfterVerification();
              if (replanned) continue;
              return stop("verification-failed", progress, errors);
            }
            return stop(verified ? "completed" : "exhausted", progress, errors);
          }
          progress.tasks.push({
            id: `t${plannerlessSeq}`,
            displayStep: plannerlessSeq,
            description:
              currentCoverageAssignment === undefined
                ? `Research step ${plannerlessSeq}`
                : coverageTaskLabel(currentCoverageAssignment, "Coverage"),
            target:
              coverageTargetForAssignment(currentCoverageAssignment) ??
              plannerlessTarget,
            status: "pending",
            ...(currentCoverageAssignment !== undefined
              ? {
                  coverageAssignmentId: currentCoverageAssignment.id,
                  coverageAssignmentMode: currentCoverageAssignment.mode,
                  coverageRefs: currentCoverageAssignment.documents.map(
                    (document) => document.ref,
                  ),
                }
              : {}),
          });
          emitHarnessStatus(
            `Next research step (${plannerlessSeq}) …`,
          );
          continue;
        }
        const anyCompleted = progress.tasks.some(
          (t) => t.status === "completed",
        );
        // Only a run that actually produced something is worth verifying; an
        // "exhausted" run has nothing for a reviewer to look at.
        if (anyCompleted) {
          const gate = await gateCompletion();
          if (gate.action === "stop") {
            return stop(gate.reason, progress, errors);
          }
          if (gate.action === "retry") {
            // Re-plan with the reviewer's critique now in context, then continue.
            const replanned = await replanAfterVerification();
            if (replanned) continue;
            // The planner produced nothing actionable to fix the critique —
            // report the result as unverified rather than looping.
            return stop("verification-failed", progress, errors);
          }
        }
        return stop(anyCompleted ? "completed" : "exhausted", progress, errors);
      }

      // #2: deterministic stop — the worker signalled global completeness
      // (cfg.stopSignal). End now WITHOUT another planner re-plan call: mark the
      // remaining planned steps as not needed so the record stays coherent.
      if (stopSignalHit) {
        for (const t of progress.tasks) {
          if (t.status === "pending" || t.status === "in-progress") {
            t.status = "completed";
            t.result =
              t.result ??
              "(not needed — worker reported the research as complete)";
          }
        }
        emitHarnessStatus(
          `Stop signal detected ("${cfg.stopSignal}") — research complete, re-plan skipped.`,
        );
        // The stop signal says the WORKER considers itself done — the verifier
        // still gets the final say, otherwise a self-declared completion would
        // bypass the gate entirely.
        const gate = await gateCompletion();
        if (gate.action === "stop") {
          return stop(gate.reason, progress, errors);
        }
        if (gate.action === "retry") {
          const replanned = await replanAfterVerification();
          if (replanned) continue;
          return stop("verification-failed", progress, errors);
        }
        return stop("completed", progress, errors);
      }

      // --- Re-plan (Req 4.4) — planner mode only. In plannerless mode the
      // allSettled branch above already re-seeded the next pass, so this LLM
      // re-plan never runs. ---
      if (!plannerless) {
        // Update model messages with latest context for re-plan. Drop the RAG
        // overview entirely on re-plan (#1) — the planner decides continue/stop
        // from priorProgress + condensed findings, so the map is redundant.
        const filteredMsgs = filterMessagesForPlanner(
          transformRagForPlanner(state.messages, true),
        );
        const updatedModelMessages = baseMessagesToModelMessages(filteredMsgs);
        if (plannerLlm === undefined) {
          // Unreachable: this branch only runs in planned mode, where the
          // guard at the top of the handler already ensured a planner LLM.
          throw new Error(
            `Agent harness "${node.id}": planner LLM missing (invariant violated).`,
          );
        }
        const replanResult = await plan(
          runtime,
          plannerLlm,
          updatedModelMessages,
          validTargets,
          progress,
          _testOverrides?.extractJson,
          { ...plannerOpts, budget: currentBudget() },
        );
        if (replanResult !== null) {
          const replanTasks = normalize(
            replanResult,
            validTargets,
            issuedTaskIds,
          );
          if (replanTasks.length > 0) {
            progress.tasks = mergeReplan(progress.tasks, replanTasks);
            // Advance the id counter so the NEXT re-plan cannot reuse these ids.
            issuedTaskIds += replanTasks.length;
            // Emit updated task list (Req 9.1)
            emitHarnessStatus(
              `Updated task list:\n${renderTaskList(progress.tasks)}`,
            );
          }
        }
      }
    }
  };
}
