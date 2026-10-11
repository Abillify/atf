// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Query-focused RAG compression (`src/graph/rag-compression.ts`)
 *
 * Optional post-retrieval step for the `rag-context` (parallel) node: after the
 * fused, deduplicated top-N findings are selected, a SMALL LLM condenses each
 * source down to only the parts relevant to the user's question and drops
 * sources that carry nothing relevant. The compressed findings are what the
 * responder actually reads.
 *
 * WHY: retrieved chunks are whole passages; most of their text is noise for a
 * given question. Passing the noise costs responder tokens/latency and can bury
 * the answer. A cheap extractive pass keeps only on-topic sentences, so the
 * (often larger, slower) responder gets a tight, relevant context.
 *
 * SAFETY / FAIL-OPEN: this is an extraction, not a rewrite. On ANY problem
 * (LLM error, unparseable output, empty result) the ORIGINAL chunks are
 * returned unchanged — compression must never lose grounding. The `[n]` source
 * numbering and citation identity (title/url/id) are preserved; only `content`
 * is condensed. Sources the model marks irrelevant are dropped from the
 * context (but never all of them — if every source is dropped we keep the
 * originals, since "retrieved but all filtered" is more likely a model mistake
 * than a genuinely empty result).
 *
 * No `any` at module boundaries.
 */

import { generateText } from "ai";
import type { ModelMessage } from "ai";
import type { LlmConfig } from "../types/flow.js";
import { UnknownProviderError, filterLlmParameters } from "./llm-factory.js";
import {
  estimateCost,
  estimateTokensFromText,
  buildCostAttribution,
} from "../observability/cost.js";
import type { RagChunk } from "./reranker.js";
import type { ExecRuntime } from "./exec-runtime.js";

/** Parsed `config.ragCompression` for the rag-context node. */
export interface RagCompressionConfig {
  /** Master switch. When false/absent the node behaves exactly as before. */
  enabled: boolean;
  /** Small model used for the extraction pass. */
  llm: LlmConfig;
  /**
   * Only compress a chunk whose content is at least this many characters; short
   * chunks are already tight and not worth an LLM round-trip. Default 400.
   */
  minChars?: number;
  /** Output-token budget for the extraction call. Default 2048. */
  maxTokens?: number;
}

/**
 * Parses and validates `node.config.ragCompression`. Returns undefined (feature
 * off) when the block is missing, disabled, or lacks a usable `llm` config.
 */
export function parseRagCompressionConfig(
  config: Record<string, unknown> | undefined,
): RagCompressionConfig | undefined {
  const raw = (config as { ragCompression?: unknown } | undefined)
    ?.ragCompression;
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return undefined;
  const llm = r.llm;
  if (llm === null || typeof llm !== "object") return undefined;
  const cfg: RagCompressionConfig = {
    enabled: true,
    llm: llm as LlmConfig,
  };
  if (typeof r.minChars === "number" && r.minChars >= 0)
    cfg.minChars = r.minChars;
  if (typeof r.maxTokens === "number" && r.maxTokens > 0)
    cfg.maxTokens = r.maxTokens;
  return cfg;
}

/** One entry of the extraction LLM's JSON array output. */
export interface CompressionEntry {
  i: number;
  keep: boolean;
  text: string;
}

/**
 * Extracts a JSON array from free-form model text: first ```json fenced block,
 * else the first balanced `[ … ]` span, else the whole trimmed text. Returns
 * null when nothing parses to an array.
 */
export function extractJsonArray(text: string): CompressionEntry[] | null {
  const tryParse = (s: string): CompressionEntry[] | null => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as CompressionEntry[]) : null;
    } catch {
      return null;
    }
  };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1] !== undefined) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== null) return parsed;
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed !== null) return parsed;
  }
  return tryParse(text.trim());
}

/**
 * Applies parsed extraction entries to the selected chunks:
 *   - no entry for a source  → keep the original (model forgot it);
 *   - keep === false         → drop the source (explicitly irrelevant);
 *   - keep === true, extract  → replace content with the extract;
 *   - keep === true, empty    → keep the original content (safer).
 * Fail-open guard: if this would drop EVERY source, return the originals
 * unchanged — "retrieved but all filtered" is more likely a model mistake than
 * a genuinely empty result, and we must never wipe out all grounding.
 */
export function applyCompressionEntries(
  chunks: RagChunk[],
  entries: CompressionEntry[],
): RagChunk[] {
  const byIndex = new Map<number, CompressionEntry>();
  for (const e of entries) {
    if (e !== null && typeof e === "object" && typeof e.i === "number")
      byIndex.set(e.i, e);
  }

  const compressed: RagChunk[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const entry = byIndex.get(i + 1);
    if (entry === undefined) {
      compressed.push(chunk);
      continue;
    }
    if (entry.keep === false) continue;
    const extract = typeof entry.text === "string" ? entry.text.trim() : "";
    compressed.push(extract.length > 0 ? { ...chunk, content: extract } : chunk);
  }

  return compressed.length === 0 ? chunks : compressed;
}

const SYSTEM_PROMPT =
  "You are an extraction filter for a knowledge base. You receive a user " +
  "question and several numbered sources. For EVERY source return ONLY the " +
  "passages relevant to answering the question — verbatim or slightly " +
  "shortened, invent NOTHING, rephrase NOTHING in a way that changes the " +
  "meaning. Discard sources without a relevant connection.\n\n" +
  "Respond EXCLUSIVELY with a JSON array, one object per source, in the " +
  'original order and numbering: [{"i":<source number>,' +
  '"keep":<true|false>,"text":"<relevant passages, or empty when keep=false>"}]. ' +
  "No markdown, no explanation.";

/**
 * Compresses the selected findings to the parts relevant to `query` using the
 * configured small model. Returns a NEW array (originals untouched). Fail-open:
 * returns the input findings unchanged on any error, unparseable output, or a
 * result that would drop every source.
 */
export async function compressRagChunks(
  runtime: ExecRuntime,
  query: string,
  chunks: RagChunk[],
  cfg: RagCompressionConfig,
): Promise<RagChunk[]> {
  if (chunks.length === 0 || query.trim().length === 0) return chunks;

  const minChars = cfg.minChars ?? 400;
  // If the total context is already tiny, skip the round-trip entirely.
  const totalChars = chunks.reduce((n, c) => n + c.content.length, 0);
  if (totalChars < minChars) return chunks;

  let model: ReturnType<typeof runtime.llmProviderFactory>;
  try {
    model = runtime.llmProviderFactory(cfg.llm, runtime.appConfig, {
      ...(runtime.ctx.providerKeyOverrides !== undefined
        ? { providerKeyOverrides: runtime.ctx.providerKeyOverrides }
        : {}),
    });
  } catch (err) {
    // Fail open — Req 7.8: count the degradation before returning the
    // uncompressed chunks.
    runtime.metrics.recordCounter("aiperator_degraded_total", {
      component: "rag_compression",
    });
    if (err instanceof UnknownProviderError) return chunks;
    return chunks;
  }

  const numberedSources = chunks
    .map((c, i) => `[${i + 1}] ${c.title}\n${c.content}`)
    .join("\n\n");
  const userContent = `Question: ${query}\n\nSources:\n${numberedSources}`;
  const messages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const params = filterLlmParameters(
    cfg.llm.parameters as Record<string, unknown> | undefined,
    cfg.llm.provider,
    cfg.llm.model,
  );
  const temperature = (params?.temperature as number | undefined) ?? 0;
  const maxOutputTokens = cfg.maxTokens ?? 2048;

  let text: string;
  let genUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  try {
    const res = await generateText({
      model,
      messages,
      allowSystemInMessages: true,
      maxOutputTokens,
      temperature,
      // Bind the flow's execution deadline — see ExecRuntime.signal. A hung
      // compression call would otherwise outlive the engine's timeout.
      ...(runtime.signal !== undefined ? { abortSignal: runtime.signal } : {}),
    });
    text = res.text;
    genUsage = res.usage;
  } catch {
    // Fail open on provider error — Req 7.8.
    runtime.metrics.recordCounter("aiperator_degraded_total", {
      component: "rag_compression",
    });
    return chunks;
  }

  // Cost/token accounting (mirrors the classifier handler): estimate when the
  // provider omits usage (local models often do), then attribute to the flow.
  try {
    const finite = (n: number | undefined): number =>
      typeof n === "number" && Number.isFinite(n) ? n : 0;
    let promptTokens = finite(genUsage?.inputTokens);
    let completionTokens = finite(genUsage?.outputTokens);
    if (promptTokens === 0)
      promptTokens = estimateTokensFromText(SYSTEM_PROMPT + userContent);
    if (completionTokens === 0 && text.length > 0)
      completionTokens = estimateTokensFromText(text);
    runtime.usage.promptTokens += promptTokens;
    runtime.usage.completionTokens += completionTokens;
    runtime.usage.totalTokens += promptTokens + completionTokens;
    const cost = estimateCost(
      cfg.llm.provider,
      cfg.llm.model,
      { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
    );
    if (cost > 0) {
      runtime.usage.costUsd = (runtime.usage.costUsd ?? 0) + cost;
      runtime.costTracker?.record(runtime.ctx.clientId, cost, {
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        promptTokens,
        completionTokens,
        ...buildCostAttribution(runtime.ctx, runtime.flowId),
      });
    }
  } catch {
    /* accounting is best-effort */
  }

  const entries = extractJsonArray(text);
  if (entries === null) {
    // Unparseable → fail open — Req 7.8.
    runtime.metrics.recordCounter("aiperator_degraded_total", {
      component: "rag_compression",
    });
    return chunks;
  }

  const compressed = applyCompressionEntries(chunks, entries);

  runtime.onNodeIo?.("rag-compression", {
    prompt: JSON.stringify({ query, sources: chunks.length }),
    response: JSON.stringify({
      kept: compressed.length,
      dropped: chunks.length - compressed.length,
    }),
  });

  return compressed;
}
