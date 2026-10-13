// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Debug-trace provider-attempt summary and tool-reported usage extraction.

 * Extracted from handler-factories.ts (Req 13.6 — module size). Pure
 * functions without closure state; re-exported from handler-factories for
 * existing importers.
 */

import type {
  DebugNodeDiagnostic,
  DebugNodeTrace,
} from "../../types/debug-trace.js";

// ---------------------------------------------------------------------------
// Provider-attempt summary for the debug trace
// ---------------------------------------------------------------------------

/**
 * Summarises the `llm_provider_attempt_completed` diagnostics of one node
 * attempt into the trace field `provider_attempts`. The node-level `attempt`
 * counts GRAPH attempts only, so without this an LLM node that needed two
 * provider calls looked like a single clean call in the trace. Returns
 * `undefined` when no provider attempt was recorded (non-LLM nodes, cache
 * hits), so the field stays absent.
 */
export function providerAttemptsSummary(
  diagnostics: readonly DebugNodeDiagnostic[] | undefined,
): { provider_attempts: NonNullable<DebugNodeTrace["provider_attempts"]> } | undefined {
  const completed = (diagnostics ?? []).filter(
    (d) => d.code === "llm_provider_attempt_completed",
  );
  const last = completed.at(-1);
  if (last === undefined) return undefined;
  const failed = completed.filter((d) => d.details?.outcome !== "ok").length;
  const lastAttempt = last.details?.attempt;
  return {
    provider_attempts: {
      total: completed.length,
      failed,
      final_attempt:
        typeof lastAttempt === "number" ? lastAttempt : completed.length,
      final_outcome: last.details?.outcome === "ok" ? "ok" : "error",
    },
  };
}

// ---------------------------------------------------------------------------
// Tool-reported usage/cost extraction
// ---------------------------------------------------------------------------

export interface ToolReportedUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Extracts a tool-reported `usage` block from a raw MCP tool result, when
 * present (e.g. vectorsearch's `search`/`ingest` tools report their own
 * embedding/rerank spend as `{ usage: { input_tokens, output_tokens,
 * cost, model_costs } }`). Handles the MCP text-content wrapper
 * (`[{type:"text", text:"<json>"}]`), a raw JSON string, or an
 * already-parsed object. Returns undefined for any tool result that isn't
 * shaped this way — safe to call on any tool's result.
 */
export function extractToolUsage(
  content: unknown,
): ToolReportedUsage | undefined {
  let parsed: unknown = content;
  try {
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === "object" &&
      parsed[0] !== null &&
      "text" in (parsed[0] as Record<string, unknown>)
    ) {
      parsed = JSON.parse((parsed[0] as { text: string }).text);
    } else if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const usage = (parsed as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const cost = u.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost))
    return undefined;
  const inputTokens =
    typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outputTokens =
    typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return { inputTokens, outputTokens, cost };
}
