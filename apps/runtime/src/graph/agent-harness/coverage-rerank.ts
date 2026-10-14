// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Reranker-backed summary triage for the staged coverage queue
 * (`coverageQueue.summaryTriage`).
 *
 * Runs ONCE, directly after the ledger seed and before the first Stage-1
 * assignment. A cross-encoder scores every open summary against the user
 * question (plus optional templated queries; the score per document is the
 * maximum over all queries). The scores
 *
 * - always order the Stage-1 batches and the candidate freeze (variant 3), and
 * - in `hybrid`/`rerank` mode additionally decide the clear cases
 *   deterministically, by RANK (scores are uncalibrated): the top share is
 *   accepted, the low tail with a near-zero score is excluded, the gray zone
 *   stays open for LLM triage.
 *
 * Fail-closed: any reranker failure, timeout, incomplete score set, missing
 * query, or a too small collection yields NO stored scores and NO decisions —
 * the ledger is returned unchanged except for the `summaryRerank` record, so
 * every summary goes through LLM triage in ledger order. Deterministic
 * exclusions set neither `totalChars` nor `windows`, so global discovery
 * (path B) can always reopen them.
 */

import type { NodeDiagnosticInput } from "../../types/debug-trace.js";
import {
  RERANK_MAX_DOCUMENTS_PER_CALL,
  RerankError,
  strictRerank,
  type Reranker,
} from "../reranker.js";
import {
  type CoverageDocument,
  type CoverageLedger,
  type CoverageSummaryRerank,
  type CoverageSummaryTriageConfig,
  DEFAULT_SUMMARY_TRIAGE_ACCEPT_TOP_K,
  DEFAULT_SUMMARY_TRIAGE_EXCLUDE_BELOW_RANK,
  DEFAULT_SUMMARY_TRIAGE_EXCLUDE_MAX_SCORE,
  DEFAULT_SUMMARY_TRIAGE_QUERIES,
  MAX_SUMMARY_TRIAGE_QUERIES,
} from "./coverage.js";

/** Below this many open documents rank shares are meaningless; no decisions. */
export const MIN_SUMMARY_RERANK_DOCUMENTS = 20;
/** Summaries shorter than this are never excluded by the reranker. */
export const MIN_SUMMARY_CHARS_FOR_RERANK_EXCLUSION = 80;
/** Overall deadline for all rerank calls of one pass. */
export const DEFAULT_SUMMARY_RERANK_DEADLINE_MS = 120_000;

export type SummaryRerankFallbackReason =
  | "reranker_not_configured"
  | "reranker_error"
  | "incomplete_scores"
  | "timeout"
  | "no_query"
  | "too_few_documents"
  /** The execution was aborted while the pass ran. */
  | "aborted";

/** Effective configuration with defaults applied (mode llm when absent). */
export function resolveSummaryTriageConfig(
  config: CoverageSummaryTriageConfig | undefined,
): CoverageSummaryTriageConfig {
  return {
    mode: config?.mode ?? "llm",
    rerankOrder: config?.rerankOrder ?? true,
    acceptTopK: config?.acceptTopK ?? DEFAULT_SUMMARY_TRIAGE_ACCEPT_TOP_K,
    excludeBelowRank:
      config?.excludeBelowRank ?? DEFAULT_SUMMARY_TRIAGE_EXCLUDE_BELOW_RANK,
    excludeMaxScore:
      config?.excludeMaxScore ?? DEFAULT_SUMMARY_TRIAGE_EXCLUDE_MAX_SCORE,
    queries:
      config?.queries !== undefined && config.queries.length > 0
        ? config.queries
        : [...DEFAULT_SUMMARY_TRIAGE_QUERIES],
  };
}

function normalizeQuery(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Builds the rerank queries: `"user"` → the latest human message, any other
 * entry → a resolved template. Empty or unresolved results and duplicates
 * (after whitespace normalization) are dropped; at most 6 queries.
 */
export function buildSummaryRerankQueries(
  entries: readonly string[],
  context: {
    userText: string;
    resolveTemplate: (template: string) => string;
  },
): { queries: string[]; sources: string[] } {
  const queries: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (queries.length >= MAX_SUMMARY_TRIAGE_QUERIES) return;
    const isUser = entry.trim() === "user";
    let raw: string;
    try {
      raw = isUser ? context.userText : context.resolveTemplate(entry);
    } catch {
      raw = "";
    }
    const query = normalizeQuery(raw);
    // A placeholder that survived resolution is not a question.
    if (query === "" || query.includes("{{")) return;
    const key = query.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(query);
    sources.push(isUser ? "user" : `template:${index}`);
  });
  return { queries, sources };
}

/** Reranker input per document: `TITLE — <last ref segment>\nSUMMARY`. */
export function summaryRerankText(
  document: Pick<CoverageDocument, "ref" | "title" | "summary">,
): string {
  const segments = document.ref.split("/").filter((part) => part.trim() !== "");
  const last = segments.at(-1)?.trim() ?? "";
  const title = document.title.trim();
  const head =
    last === "" || last.toLocaleLowerCase() === title.toLocaleLowerCase()
      ? title
      : `${title} — ${last}`;
  return `${head}\n${document.summary}`;
}

export type SummaryScoringResult =
  | { ok: true; scores: number[]; latencyMs: number; calls: number }
  | {
      ok: false;
      reason: SummaryRerankFallbackReason;
      error?: string;
      status?: number;
      latencyMs: number;
      calls: number;
    };

class IncompleteScoresError extends Error {}
class DeadlineError extends Error {}
class ExecutionAbortError extends Error {}

/**
 * Scores every text against every query (chunks of ≤ 1000 per call; the TEI
 * client batches further). All-or-nothing: each call must return exactly one
 * valid score per input text, otherwise the whole pass fails.
 *
 * A pass uses exactly ONE reranker backend: when the reranker offers
 * {@link Reranker.pinBackend} (TEI → Bedrock fallback chain), the backend that
 * answers the first call is pinned and a later failure fails the whole pass
 * (`reranker_error`) instead of mixing uncalibrated scores of two models.
 *
 * The pass deadline and `options.signal` (execution abort) abort the in-flight
 * reranker request via the signal handed to every call; the `Promise.race`
 * additionally bounds rerankers that ignore the signal.
 */
export async function scoreCoverageSummaries(
  texts: readonly string[],
  queries: readonly string[],
  reranker: Reranker,
  options: { deadlineMs?: number; chunkSize?: number; signal?: AbortSignal } = {},
): Promise<SummaryScoringResult> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_SUMMARY_RERANK_DEADLINE_MS;
  const chunkSize = Math.max(
    1,
    Math.min(options.chunkSize ?? RERANK_MAX_DOCUMENTS_PER_CALL, RERANK_MAX_DOCUMENTS_PER_CALL),
  );
  const started = Date.now();
  let calls = 0;
  const scores = new Array<number>(texts.length).fill(Number.NEGATIVE_INFINITY);
  const external = options.signal;
  const pass = new AbortController();
  let rejectPass: ((reason: unknown) => void) | undefined;
  const stop = (reason: Error): void => {
    if (!pass.signal.aborted) pass.abort(reason);
    rejectPass?.(reason);
  };
  const onExternalAbort = (): void => {
    stop(new ExecutionAbortError("execution aborted during summary rerank"));
  };
  const session = reranker.pinBackend?.() ?? reranker;

  const work = async (): Promise<void> => {
    for (const query of queries) {
      for (let offset = 0; offset < texts.length; offset += chunkSize) {
        if (pass.signal.aborted) throw pass.signal.reason;
        const chunk = texts.slice(offset, offset + chunkSize);
        calls += 1;
        const hits = await strictRerank(session, query, chunk, chunk.length, {
          signal: pass.signal,
        });
        if (hits.length !== chunk.length) {
          throw new IncompleteScoresError(
            `expected ${chunk.length} scores, got ${hits.length}`,
          );
        }
        const seen = new Set<number>();
        for (const hit of hits) {
          if (
            !Number.isInteger(hit.index) ||
            hit.index < 0 ||
            hit.index >= chunk.length ||
            seen.has(hit.index) ||
            !Number.isFinite(hit.score)
          ) {
            throw new IncompleteScoresError("invalid or duplicate hit index");
          }
          seen.add(hit.index);
          const global = offset + hit.index;
          scores[global] = Math.max(scores[global] ?? Number.NEGATIVE_INFINITY, hit.score);
        }
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bound = new Promise<never>((_, reject) => {
      rejectPass = reject;
      timer = setTimeout(
        () => stop(new DeadlineError(`summary rerank exceeded ${deadlineMs} ms`)),
        deadlineMs,
      );
    });
    if (external?.aborted === true) onExternalAbort();
    else external?.addEventListener("abort", onExternalAbort, { once: true });
    await Promise.race([work(), bound]);
  } catch (err) {
    const latencyMs = Date.now() - started;
    // The pass signal's reason wins: a reranker that honours the signal throws
    // its own `aborted` error, but the cause is the deadline or the execution.
    const cause = pass.signal.aborted ? pass.signal.reason : err;
    if (cause instanceof DeadlineError) {
      return { ok: false, reason: "timeout", error: cause.message, latencyMs, calls };
    }
    if (
      cause instanceof ExecutionAbortError ||
      external?.aborted === true ||
      (err instanceof RerankError && err.kind === "aborted")
    ) {
      return {
        ok: false,
        reason: "aborted",
        error: cause instanceof Error ? cause.message : String(cause),
        latencyMs,
        calls,
      };
    }
    if (err instanceof IncompleteScoresError) {
      return {
        ok: false,
        reason: "incomplete_scores",
        error: err.message,
        latencyMs,
        calls,
      };
    }
    if (err instanceof RerankError) {
      return {
        ok: false,
        reason: err.kind === "timeout" ? "timeout" : "reranker_error",
        error: err.message,
        ...(err.status !== undefined ? { status: err.status } : {}),
        latencyMs,
        calls,
      };
    }
    return {
      ok: false,
      reason: "reranker_error",
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
      calls,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
  if (scores.some((score) => !Number.isFinite(score))) {
    return {
      ok: false,
      reason: "incomplete_scores",
      error: "missing score for at least one document",
      latencyMs: Date.now() - started,
      calls,
    };
  }
  return { ok: true, scores, latencyMs: Date.now() - started, calls };
}

function formatScore(score: number): string {
  return score >= 0.001 || score === 0 ? score.toFixed(3) : score.toExponential(2);
}

export interface SummaryRerankDecisionResult {
  ledger: CoverageLedger;
  accepted: number;
  excluded: number;
  gray: number;
  acceptCut: number;
  excludeCut: number;
  documentCount: number;
}

/**
 * Pure: stores score/rank on every OPEN document (`scores` is aligned with the
 * open documents in ledger order) and, for `hybrid`/`rerank`, applies the
 * deterministic decisions. Ranks are 1-based, descending by score, ties by
 * ledger order.
 */
export function applySummaryRerankDecisions(
  ledger: CoverageLedger,
  scores: readonly number[],
  config: CoverageSummaryTriageConfig,
): SummaryRerankDecisionResult {
  const openIndices: number[] = [];
  ledger.documents.forEach((document, index) => {
    if (document.status === "open") openIndices.push(index);
  });
  if (openIndices.length !== scores.length) {
    throw new Error(
      `summary rerank score count ${scores.length} does not match ${openIndices.length} open documents`,
    );
  }
  const n = openIndices.length;
  const order = openIndices
    .map((ledgerIndex, position) => ({
      ledgerIndex,
      score: scores[position] ?? Number.NEGATIVE_INFINITY,
    }))
    .sort((a, b) =>
      a.score === b.score ? a.ledgerIndex - b.ledgerIndex : b.score - a.score,
    );
  const rankByLedgerIndex = new Map<number, { rank: number; score: number }>();
  order.forEach((entry, position) => {
    rankByLedgerIndex.set(entry.ledgerIndex, {
      rank: position + 1,
      score: entry.score,
    });
  });

  // The epsilon keeps binary float error (0.07 * 100 = 7.000000000000001)
  // from adding a rank to a cut.
  const shareCut = (share: number): number => Math.ceil(share * n - 1e-9);
  const acceptCut = Math.max(1, shareCut(config.acceptTopK));
  const excludeCut = shareCut(config.excludeBelowRank);
  const deterministic = config.mode !== "llm";
  let accepted = 0;
  let excluded = 0;

  const documents = ledger.documents.map((document, index) => {
    const ranked = rankByLedgerIndex.get(index);
    if (ranked === undefined) return document;
    const { rank, score } = ranked;
    const scored: CoverageDocument = {
      ...document,
      rerankScore: score,
      rerankRank: rank,
    };
    if (!deterministic) return scored;
    const label = `Rerank-Rang ${rank}/${n}, Score ${formatScore(score)}`;
    if (rank <= acceptCut) {
      accepted += 1;
      return {
        ...scored,
        status: "summary-reviewed" as const,
        triageDecision: "possibly_relevant" as const,
        triageSource: "rerank" as const,
        reason: `${label} (Top-${acceptCut}, deterministische Aufnahme)`,
        candidateReasons: Array.from(
          new Set([
            ...(document.candidateReasons ?? []),
            `Summary-Rerank: Rang ${rank}/${n}`,
          ]),
        ),
      };
    }
    // Short/empty summaries carry too little signal for a negative decision;
    // the triage contract requires the LLM to keep them possibly_relevant.
    const excludable =
      document.summary.trim().length >= MIN_SUMMARY_CHARS_FOR_RERANK_EXCLUSION;
    const hybridExclude =
      config.mode === "hybrid" &&
      excludable &&
      rank > excludeCut &&
      score < config.excludeMaxScore;
    const rerankExclude = config.mode === "rerank" && excludable;
    if (hybridExclude || rerankExclude) {
      excluded += 1;
      return {
        ...scored,
        status: "excluded" as const,
        triageDecision: "irrelevant" as const,
        triageSource: "rerank" as const,
        reason: hybridExclude
          ? `${label} unterhalb der Ausschlussgrenze (Rang > ${excludeCut}, Score < ${config.excludeMaxScore}); per globaler Discovery wieder öffenbar`
          : `${label} außerhalb Top-${acceptCut} (Modus rerank); per globaler Discovery wieder öffenbar`,
      };
    }
    return scored;
  });
  return {
    ledger: { ...ledger, documents },
    accepted,
    excluded,
    gray: n - accepted - excluded,
    acceptCut,
    excludeCut,
    documentCount: n,
  };
}

export interface SummaryTriageRerankOutcome {
  ledger: CoverageLedger;
  /** Trace diagnostic; absent when no scoring was attempted (llm without reranker). */
  diagnostic?: NodeDiagnosticInput;
  /**
   * `summary_triage_config_invalid` warning when the configured summaryTriage
   * block was invalid and the runtime parser fell back to mode llm with the
   * default thresholds. Reported independently of {@link diagnostic}.
   */
  configDiagnostic?: NodeDiagnosticInput;
  /** One-line reasoning-stream status; absent when nothing ran. */
  status?: string;
}

/** Warning for a summaryTriage config the runtime parser had to replace. */
function summaryTriageConfigDiagnostic(
  config: CoverageSummaryTriageConfig | undefined,
): NodeDiagnosticInput | undefined {
  const error = config?.configError;
  if (error === undefined) return undefined;
  return {
    level: "warn",
    code: "summary_triage_config_invalid",
    message:
      `Invalid coverageQueue.summaryTriage config (${error}); ` +
      "falls back to mode llm with default thresholds.",
    details: { error },
  };
}

/**
 * Orchestrates the one-time summary rerank pass. Never throws: unexpected
 * errors become a `reranker_error` fallback (full LLM triage).
 */
export async function applySummaryTriageRerank(input: {
  ledger: CoverageLedger;
  config: CoverageSummaryTriageConfig | undefined;
  reranker: Reranker | undefined;
  userText: string;
  resolveTemplate: (template: string) => string;
  deadlineMs?: number;
  chunkSize?: number;
  /** Execution abort signal; aborts in-flight reranker requests. */
  signal?: AbortSignal;
}): Promise<SummaryTriageRerankOutcome> {
  const configDiagnostic = summaryTriageConfigDiagnostic(input.config);
  const outcome = await runSummaryTriageRerank(input);
  return configDiagnostic === undefined
    ? outcome
    : { ...outcome, configDiagnostic };
}

async function runSummaryTriageRerank(input: {
  ledger: CoverageLedger;
  config: CoverageSummaryTriageConfig | undefined;
  reranker: Reranker | undefined;
  userText: string;
  resolveTemplate: (template: string) => string;
  deadlineMs?: number;
  chunkSize?: number;
  signal?: AbortSignal;
}): Promise<SummaryTriageRerankOutcome> {
  const config = resolveSummaryTriageConfig(input.config);
  const deterministic = config.mode !== "llm";
  if (!deterministic && !config.rerankOrder) return { ledger: input.ledger };
  if (input.reranker === undefined && !deterministic) {
    return { ledger: input.ledger };
  }

  const openDocuments = input.ledger.documents.filter(
    (document) => document.status === "open",
  );
  const documentCount = openDocuments.length;
  let queryCount = 0;
  let querySources: string[] = [];

  const fallback = (
    reason: SummaryRerankFallbackReason,
    extra: { error?: string; status?: number; latencyMs?: number; calls?: number } = {},
  ): SummaryTriageRerankOutcome => {
    const latencyMs = extra.latencyMs ?? 0;
    const record: CoverageSummaryRerank = {
      mode: config.mode,
      status: "fallback",
      reason,
      documentCount,
      queryCount,
      accepted: 0,
      excluded: 0,
      gray: documentCount,
      latencyMs,
    };
    return {
      ledger: { ...input.ledger, summaryRerank: record },
      diagnostic: {
        level: "warn",
        code: "summary_triage_rerank_fallback",
        message:
          `Summary rerank unavailable (${reason}); all ${documentCount} summaries ` +
          "go to LLM triage in ledger order, no deterministic decisions.",
        details: {
          mode: config.mode,
          reason,
          document_count: documentCount,
          query_count: queryCount,
          query_sources: querySources,
          latency_ms: latencyMs,
          ...(extra.calls !== undefined ? { reranker_calls: extra.calls } : {}),
          ...(extra.error !== undefined ? { error: extra.error.slice(0, 500) } : {}),
          ...(extra.status !== undefined ? { status: extra.status } : {}),
        },
      },
      status: `Summary rerank unavailable (${reason}) - all summaries go to LLM triage`,
    };
  };

  try {
    if (input.reranker === undefined) return fallback("reranker_not_configured");
    if (deterministic && documentCount < MIN_SUMMARY_RERANK_DOCUMENTS) {
      return fallback("too_few_documents");
    }
    if (documentCount < 2) return { ledger: input.ledger };

    const { queries, sources } = buildSummaryRerankQueries(config.queries, {
      userText: input.userText,
      resolveTemplate: input.resolveTemplate,
    });
    queryCount = queries.length;
    querySources = sources;
    if (queries.length === 0) return fallback("no_query");

    const scoring = await scoreCoverageSummaries(
      openDocuments.map(summaryRerankText),
      queries,
      input.reranker,
      {
        ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        ...(input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
    );
    if (!scoring.ok) {
      return fallback(scoring.reason, {
        latencyMs: scoring.latencyMs,
        calls: scoring.calls,
        ...(scoring.error !== undefined ? { error: scoring.error } : {}),
        ...(scoring.status !== undefined ? { status: scoring.status } : {}),
      });
    }

    const decided = applySummaryRerankDecisions(
      input.ledger,
      scoring.scores,
      config,
    );
    const topScore = Math.max(...scoring.scores);
    const record: CoverageSummaryRerank = {
      mode: config.mode,
      status: "scored",
      documentCount,
      queryCount,
      accepted: decided.accepted,
      excluded: decided.excluded,
      gray: decided.gray,
      latencyMs: scoring.latencyMs,
    };
    const seconds = (scoring.latencyMs / 1000).toFixed(1);
    return {
      ledger: { ...decided.ledger, summaryRerank: record },
      diagnostic: {
        level: "info",
        code: "summary_triage_rerank_scored",
        message: deterministic
          ? `Summary rerank (${config.mode}) scored ${documentCount} summaries: ` +
            `${decided.accepted} accepted, ${decided.excluded} excluded, ${decided.gray} to LLM triage.`
          : `Summary rerank scored ${documentCount} summaries; LLM triage runs in score order.`,
        details: {
          mode: config.mode,
          document_count: documentCount,
          query_count: queryCount,
          query_sources: sources,
          accepted: decided.accepted,
          excluded: decided.excluded,
          gray: decided.gray,
          accept_cut: decided.acceptCut,
          exclude_cut: decided.excludeCut,
          exclude_max_score: config.excludeMaxScore,
          top_score: topScore,
          latency_ms: scoring.latencyMs,
          reranker_calls: scoring.calls,
        },
      },
      status: deterministic
        ? `Summary rerank: ${documentCount} scored in ${seconds} s · ${decided.accepted} accepted · ` +
          `${decided.excluded} excluded · ${decided.gray} to LLM triage`
        : `Summary rerank: ${documentCount} scored in ${seconds} s · LLM triage in score order`,
    };
  } catch (err) {
    return fallback("reranker_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
