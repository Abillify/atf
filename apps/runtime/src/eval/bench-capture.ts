// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Bench-case capture (`src/eval/bench-capture.ts`)
 *
 * Turns recorded debug traces (`GET /monitoring/debug/:executionId`) into
 * bench cases for `<FLOWS_DIR>/bench/<flowId>.bench.yaml` — the input of
 * `cli.ts flows release`. Pure functions only: fetching and file I/O live in
 * the CLI so this module stays testable without a server.
 *
 * Capture rules:
 *  - `messages`: the trace's input conversation verbatim; `tool`-role messages
 *    are dropped because the bench schema replays user/assistant/system only.
 *  - `assert`: `toolCalled` per distinct tool the run invoked,
 *    `finishReason: stop`, `maxTokens`/`maxLatencyMs` with headroom over the
 *    observed usage, and `noDiagnostic` for every known error-level
 *    diagnostic code this run did NOT hit — capped at
 *    {@link MAX_ASSERTIONS_PER_BENCH_CASE}.
 *  - personal data in the input aborts the capture unless the operator
 *    explicitly opts into raw mode (`--allow-raw`).
 */
import { Document, isMap, isSeq, parseDocument, type YAMLSeq } from "yaml";
import { findPiiMatches } from "../graph/output-guardrails.js";
import type { DebugTrace } from "../types/debug-trace.js";
import {
  BENCH_FILE_VERSION,
  MAX_ASSERTIONS_PER_BENCH_CASE,
  type BenchCase,
  type BenchThresholds,
} from "./bench-contract.js";

/**
 * Error-level node-diagnostic codes the runtime can emit, collected from the
 * `onNodeDiagnostic` call sites in `src/graph` (`level: "error"`). A literal
 * list on purpose: a captured bench file must stay stable across refactors of
 * the emitting code, and a code that no longer exists simply never occurs —
 * the assertion stays valid.
 */
export const KNOWN_ERROR_DIAGNOSTIC_CODES: readonly string[] = [
  "empty_response",
  "harness_budget_limit",
  "harness_coverage_search_provenance_unparseable",
  "harness_coverage_unassignable",
  "harness_verifier_context_over_budget",
  "harness_verifier_pass_nonterminal_coverage",
  "image_inspection_remote_image_unavailable",
  "llm_prompt_schema_invalid",
  "llm_provider_candidate_failed",
  "pagination_incomplete",
  "pagination_total_missing",
  "require_tool_use_exhausted",
  "require_tool_use_fallback_suppressed",
  "structured_output_failed",
  "text_tool_call_unrecoverable",
  "tool_execution_failed",
  "tool_result_error",
  "transaction_budget_exceeded",
  "vision_not_supported",
];

/** One captured case plus the provenance comment rendered above it. */
export interface CapturedBenchCase {
  benchCase: BenchCase;
  /** Comment text without the leading `#`. */
  comment: string;
}

export type CaptureOutcome =
  | { ok: true; captured: CapturedBenchCase; warnings: string[] }
  | { ok: false; error: string };

/** Flatten a trace message's content (plain text or multimodal blocks) to text. */
function messageText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : JSON.stringify(content);
}

/**
 * Build one bench case from one debug trace. Returns a structured error (not
 * a throw) so the CLI can report every execution it refused.
 */
export function captureBenchCase(
  trace: DebugTrace,
  opts: { allowRaw?: boolean } = {},
): CaptureOutcome {
  const warnings: string[] = [];

  const messages = trace.input_messages
    .filter((m) => m.role !== "tool")
    .map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: messageText(m.content).slice(0, 50_000),
    }))
    .filter((m) => m.content.length > 0);

  // Personal data check over the captured input, using the runtime's own
  // regex detectors. Kinds are reported sorted for a stable message.
  const kinds = new Set<string>();
  for (const m of messages) {
    for (const match of findPiiMatches(m.content)) kinds.add(match.type);
  }
  if (kinds.size > 0) {
    const kindList = [...kinds].sort().join(", ");
    if (opts.allowRaw !== true) {
      return {
        ok: false,
        error: `execution ${trace.execution_id} contains personal data (${kindList}); review it or pass --allow-raw`,
      };
    }
    warnings.push(
      `execution ${trace.execution_id} contains personal data (${kindList}) — captured raw as requested`,
    );
  }

  const tools = new Set<string>();
  const observedErrors = new Set<string>();
  for (const node of trace.nodes) {
    for (const call of node.tool_calls ?? []) tools.add(call.name);
    for (const d of node.diagnostics ?? []) {
      if (d.level === "error") observedErrors.add(d.code);
    }
  }

  const assertions: NonNullable<BenchCase["assert"]> = [];
  for (const name of [...tools].sort()) assertions.push({ type: "toolCalled", name });
  assertions.push({ type: "finishReason", equals: "stop" });
  const totalTokens = trace.usage?.total_tokens ?? 0;
  if (totalTokens > 0) {
    assertions.push({ type: "maxTokens", value: Math.ceil(1.5 * totalTokens) });
  }
  if (trace.started_at !== "" && trace.finished_at !== null) {
    const ms = Date.parse(trace.finished_at) - Date.parse(trace.started_at);
    if (Number.isFinite(ms) && ms > 0) {
      assertions.push({ type: "maxLatencyMs", value: Math.ceil(2 * ms) });
    }
  }
  for (const code of KNOWN_ERROR_DIAGNOSTIC_CODES) {
    if (assertions.length >= MAX_ASSERTIONS_PER_BENCH_CASE) break;
    if (!observedErrors.has(code)) assertions.push({ type: "noDiagnostic", code });
  }

  const benchCase: BenchCase = {
    id: `captured-${trace.execution_id}`,
    messages,
    assert: assertions,
  };
  const comment = `captured from execution ${trace.execution_id} at ${new Date().toISOString()}; review the expectations before release`;
  return { ok: true, captured: { benchCase, comment }, warnings };
}

/** Locate the `cases` sequence of a bench document, or null when malformed. */
function caseSequence(doc: Document): YAMLSeq | null {
  const map = doc.contents;
  if (!isMap(map)) return null;
  const seq = map.get("cases", true);
  return isSeq(seq) ? seq : null;
}

function setComment(node: unknown, text: string): void {
  if (node !== null && typeof node === "object") {
    (node as { commentBefore?: string }).commentBefore = ` ${text}`;
  }
}

/**
 * Render a complete bench file (new file) with one provenance comment above
 * each case. The result is valid against the bench contract when the cases
 * are — the CLI still validates with `loadBenchFile` before writing.
 */
export function renderBenchFile(
  flow: string,
  cases: CapturedBenchCase[],
  thresholds: BenchThresholds,
): string {
  const doc = new Document({
    version: BENCH_FILE_VERSION,
    flow,
    cases: cases.map((c) => c.benchCase),
    thresholds,
  });
  const seq = caseSequence(doc);
  if (seq === null) throw new Error("internal: rendered bench file has no cases sequence");
  for (const [index, item] of seq.items.entries()) {
    const captured = cases[index];
    if (captured !== undefined) setComment(item, captured.comment);
  }
  return doc.toString();
}

/**
 * Append captured cases to an existing bench file's YAML text, preserving
 * the file's existing content and comments. Throws when the flow does not
 * match or a case id would be duplicated — ids must stay unique.
 */
export function appendCapturedCases(
  existingYaml: string,
  flow: string,
  cases: CapturedBenchCase[],
): string {
  const doc = parseDocument(existingYaml);
  if (doc.errors.length > 0) {
    throw new Error(`existing bench file is not valid YAML: ${doc.errors[0]?.message ?? "parse error"}`);
  }
  const map = doc.contents;
  if (!isMap(map)) throw new Error("existing bench file: expected a mapping at the document root");
  const existingFlow = map.get("flow");
  if (typeof existingFlow === "string" && existingFlow !== flow) {
    throw new Error(
      `existing bench file is for flow ${JSON.stringify(existingFlow)}, not ${JSON.stringify(flow)}`,
    );
  }
  const seq = caseSequence(doc);
  if (seq === null) throw new Error("existing bench file: `cases` must be a sequence");

  const ids = new Set<unknown>();
  for (const item of seq.items) {
    if (isMap(item)) ids.add(item.get("id"));
  }
  for (const captured of cases) {
    if (ids.has(captured.benchCase.id)) {
      throw new Error(`case id ${JSON.stringify(captured.benchCase.id)} already exists in the bench file`);
    }
    ids.add(captured.benchCase.id);
    const node = doc.createNode(captured.benchCase);
    setComment(node, captured.comment);
    seq.add(node);
  }
  return doc.toString();
}
