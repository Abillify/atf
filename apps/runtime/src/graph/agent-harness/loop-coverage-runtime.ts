// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — coverage evidence runtime plumbing.

 * Pure (closure-free) helpers that wrap a child RunnableConfig / ExecRuntime
 * for delegated coverage work and phrase the search-pass status line, plus
 * the structured coverage-report extraction prompt. Extracted verbatim from
 * loop.ts (Req 13.6).
 *
 * @module agent-harness/loop-coverage-runtime
 */

import { createHash } from "node:crypto";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ExecRuntime } from "../graph-engine.js";
import {
  coverageEvidenceFromToolResult,
  normalizedSearchQuery,
  parseCoverageSearchToolResult,
} from "./coverage.js";
import type {
  CoverageAssignment,
  CoverageDocumentEvidence,
  CoverageSearchEvidence,
  CoverageSearchParseResult,
} from "./coverage.js";
import { compactStatusText } from "./loop-findings.js";

export function formatCoverageSearchStatus(item: CoverageSearchEvidence): string {
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

/**
 * Replaces only the streaming callbacks in a child RunnableConfig.
 *
 * Delegated workers still retain their tools, citations, telemetry, lifecycle,
 * costs, and state updates. Suppressing only token/reasoning events prevents a
 * research intermediate from appearing as an assistant response before the
 * configured final synthesizer writes its answer.
 */
export function withDelegateRuntime(
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
export function withCoverageEvidenceRuntime(
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

/**
 * Output-token ceiling for the structured coverage-report extraction call. A
 * report is a compact per-document decision list, but it still costs roughly
 * 120 output tokens per document, and on a reasoning model the thinking tokens
 * are billed against this same ceiling.
 *
 * Measured against a live llama.cpp endpoint (build b10975, Qwen3.8-Flash-Next),
 * a full batch consumed: 25 docs → ~5.9k, 50 docs → ~7.5k, 75 docs → ~9.1k,
 * 100 docs → ~12.3k output tokens. The previous 12288 ceiling therefore sat just
 * BELOW the largest supported batch: a 100-document assignment stopped on
 * `length` with truncated JSON and the report was refused as `invalid_json`,
 * silently capping the queue. 16384 keeps ~33% headroom over the measured
 * 100-document cost while still bounding a degenerate model that never stops.
 */
export const COVERAGE_REPORT_EXTRACTION_MAX_TOKENS = 16384;

/**
 * System prompt for the schema-enforced coverage-report extraction
 * ("structured-after-tools"). States the task, the mode-specific decision
 * semantics and — critically — ENUMERATES the refs to decide. It never asks for
 * markers or code fences; the schema pins the shape.
 *
 * ## Why the refs must be listed here, not left to the schema
 *
 * It is tempting to rely on `buildCoverageReportSchema`, which already pins the
 * ref set as a JSON-Schema `enum`. That is a decoding CONSTRAINT, not
 * information: it tells the sampler which strings are legal, it does not tell
 * the model which documents exist or which ones it has already emitted. With
 * the refs absent from the prompt, a constrained model satisfies the grammar the
 * cheapest way available — it repeats the FIRST legal enum value for every
 * array element.
 *
 * Measured against a live llama.cpp endpoint (build b10975, Qwen3.8-Flash-Next)
 * on a 25-document summary assignment, 3 of 3 runs returned
 * `documents.length = 25` with exactly ONE distinct ref and 24 refs missing, so
 * `validateCoverageReportObject` rejected every report as a duplicate ref and
 * the coverage queue never advanced. Listing the refs (ordered, counted, with an
 * explicit "each exactly once") made 3 of 3 runs return 25 unique refs and 0
 * missing.
 *
 * The listing is therefore load-bearing for correctness, not a prompt nicety.
 * The refs are already carried in the schema enum, so this costs prompt tokens
 * but adds no new content.
 */
export function buildCoverageReportExtractionSystemPrompt(
  assignment: CoverageAssignment,
): string {
  const decisions =
    assignment.mode === "summary"
      ? "`relevant`, `possibly_relevant` oder `excluded`"
      : "`reviewed` oder `excluded`";
  const refs = assignment.documents
    .map((document, index) => `${index + 1}. ${document.ref}`)
    .join("\n");
  return (
    "Fasse deine vorstehende Analyse in einem Coverage-Report zusammen. " +
    `Entscheide jedes zugewiesene Dokument (Feld \`ref\`) genau einmal mit ${decisions} ` +
    "und gib je einen knappen, sachlichen Grund (Feld `reason`) an. " +
    "Verwende exakt die vorgegebene `assignmentId`. Antworte ausschliesslich mit " +
    "dem geforderten JSON-Objekt.\n\n" +
    `Entscheide genau diese ${assignment.documents.length} Dokumente, in exakt ` +
    "dieser Reihenfolge, jedes genau einmal. Gib kein Dokument doppelt und kein " +
    `zusaetzliches aus:\n${refs}`
  );
}
