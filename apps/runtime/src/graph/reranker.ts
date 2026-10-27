// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Reranker service (`src/graph/reranker.ts`)
 *
 * Wraps the AWS Bedrock **Rerank API** (`bedrock-agent-runtime`) so the RAG
 * pipeline can fuse the chunks retrieved in parallel from several collections
 * into ONE globally-reranked, deduplicated, top-N context — instead of handing
 * the model several independently-ranked per-source blocks (which is what the
 * `parallel` rag-context node produced before, with `scoreWeight` carried but
 * never actually fused).
 *
 * A reranker is a cross-encoder: it scores each (query, passage) pair jointly,
 * which is far more precise than the bi-encoder cosine/​hybrid score the vector
 * store returns. Cohere Rerank 3.5 (`cohere.rerank-v3-5:0`) is the default and
 * is strong on multilingual (DE/EN) content; Amazon Rerank 1.0
 * (`amazon.rerank-v1:0`) is the cheaper AWS-native alternative. Both are billed
 * per 1,000 queries (one query = up to 100 documents), so a handful of chunks
 * per request costs a fraction of a cent.
 *
 * This module keeps the AWS dependency and the pure fusion/parse helpers in one
 * focused, testable place; the parallel node handler consumes it and turns the
 * selected chunks into the fused context + citation messages.
 *
 * No `any` at module boundaries.
 */

import {
  BedrockAgentRuntimeClient,
  RerankCommand,
  type RerankCommandOutput,
} from "@aws-sdk/client-bedrock-agent-runtime";
import type { AppConfig } from "../config/index.js";
import { getProviderInstance } from "../config/providers.js";
import type { Logger } from "../observability/logger.js";
import { egressFetch } from "../security/egress.js";

/**
 * One asset attached to a v2 search hit (via `include_assets`). Mirrors the
 * `assets[]` entries of the `/v2/search` response: a figure with
 * its classified `figureKind`, `caption`, `page`, `bbox`, and the variant URLs
 * (`thumbUrl` for the thumbnail, `url` for the ACL-checked full/preview asset).
 * All fields but `assetId` are optional so a partial ref (no thumbnail) still
 * parses.
 */
export interface RagAsset {
  assetId: string;
  /** Coarse asset kind (e.g. "figure"). */
  kind?: string;
  /** Classified figure type (bpmn | flowchart | ui_mask | …). */
  figureKind?: string;
  caption?: string;
  page?: number;
  bbox?: [number, number, number, number];
  /** Thumbnail URL (variant `thumb`). */
  thumbUrl?: string;
  /** Full/preview asset URL (the ACL-checked `/v2/assets/{id}?variant=…`). */
  url?: string;
}

/** A single retrieved passage, parsed from a vectorsearch tool result. */
export interface RagChunk {
  /** Stable chunk/document id from the vector store. */
  id: string;
  /** Document title (top-level or metadata). */
  title: string;
  /** Source URL/link, or "" when none. */
  url: string;
  /** The passage text the reranker scores and the model reads. */
  content: string;
  /** Original retrieval score (cosine/hybrid), in [0,1]. */
  retrievalScore: number;
  /**
   * Per-source relevance multiplier from `ragProfiles` (`scoreWeight`), applied
   * by {@link selectByRetrievalScore} during score-only fusion so a source's
   * chunks compete at `retrievalScore * scoreWeight` rather than raw score.
   * Undefined means 1.0 (no down/upweighting). Kept separate from
   * `retrievalScore` so citations/rendering still show the source's own score.
   */
  scoreWeight?: number;
  /** Tags carried through for diagnostics (e.g. client tag). */
  tags?: string[];
  /**
   * Parent-document reference from the vector store (`base_ref`, falling back to
   * the chunk `reference`). A document-level identity, stable across the
   * document's chunks — used for cross-turn "already seen" tracking
   * (rag-followup) so a follow-up can down-weight documents already shown.
   * Undefined when the source result carried no such field.
   */
  baseRef?: string;
  citationId?: string;
  documentId?: string;
  version?: string;
  page?: string | number;
  /** Inclusive page range supplied by document evidence. */
  pageStart?: number;
  pageEnd?: number;
  /** Image provenance retained from vectorsearch evidence. */
  modality?: "image";
  figureId?: string;
  assetId?: string;
  bbox?: [number, number, number, number];
  assetUrl?: string;
  section?: string;
  /**
   * v2 hit provenance for the evidence line / citations (Requirement 16.4).
   * `sectionPath` is the ordered breadcrumb (e.g. ["4 Antragseingang","4.2
   * Anmeldung"]); `pages` the covered page numbers; `figureKind` the classified
   * figure type of the hit unit (bpmn/flowchart/ui_mask/…); `caption` its
   * caption. All optional — a legacy (pre-v2) hit carries none of them and the
   * evidence line falls back to the existing `Ref/S./Modalität/Abbildung`
   * fields unchanged.
   */
  sectionPath?: string[];
  pages?: number[];
  figureKind?: string;
  caption?: string;
  /**
   * v2 assets attached to the hit (from `include_assets`: refs or thumbnails).
   * Each carries the figure metadata (`figureKind`, `caption`, `page`, `bbox`)
   * and the variant URLs. The RAG node's `assets.attach` policy decides whether
   * to attach any of these as image parts to the responder's message, gated on
   * the responder model's `visionInput` capability (Requirement 16.2).
   */
  assets?: RagAsset[];
  charStart?: number;
  charEnd?: number;
  chunkId?: string;
  /**
   * Injection verdict from the Search service's content-trust scan
   * (`injection_risk` on the hit, or the response envelope applied to every
   * hit). `"suspected"` means Search saw instruction-override signals in the
   * stored text — the runtime taints the run from this label even when its own
   * tool-output scan misses the pattern (the two signal lists diverge).
   * Undefined when the source carried no label (legacy hits, non-Search tools).
   */
  injectionRisk?: "none" | "suspected";
  /**
   * Trust classification from Search (`content_trust`); currently always
   * `"untrusted"` when present. Informational — carried through for trace
   * rendering, not scanned again.
   */
  contentTrust?: string;
  /**
   * Full chunk metadata from the vector store (e.g. points, status, project,
   * board). Carried through reranking and document-dedup so downstream
   * consumers (context rendering, citations) never lose it. When several
   * passages of the same document are grouped, the retained chunk's metadata is
   * used — these are expected to be identical across a document's chunks.
   */
  metadata?: Record<string, unknown>;
}

/** A single rerank hit: the index into the input documents + its relevance. */
export interface RerankHit {
  index: number;
  score: number;
}

/**
 * Reranks `documents` against `query`, returning the most relevant ones first
 * as `{ index, score }` (index points back into the input array). Returns at
 * most `topN` hits. Implementations must never throw for an empty input — they
 * return `[]` so callers can fall back to the un-reranked order.
 *
 * `rerank` is lenient: a failed call is logged and degrades to `[]`. Callers
 * that must distinguish "no hits" from "reranker down" (e.g. the coverage
 * summary triage, which may only make deterministic decisions on a complete
 * score set) use the optional strict {@link Reranker.rerankOrThrow}.
 */
export interface Reranker {
  rerank(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]>;
  /**
   * Strict variant: same contract as {@link Reranker.rerank} for empty input,
   * but throws a {@link RerankError} instead of degrading to `[]` when the
   * backend fails or answers with an unusable payload. Optional so lightweight
   * fakes stay valid.
   */
  rerankOrThrow?(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]>;
  /**
   * Returns a session that pins ONE backend for a sequence of calls (e.g. all
   * chunks of a coverage rerank pass), so scores from different, uncalibrated
   * cross-encoders are never mixed. Optional: single-backend rerankers are
   * already consistent and need no session.
   */
  pinBackend?(): Reranker;
}

/** Per-call options of a rerank request. */
export interface RerankCallOptions {
  /**
   * Aborts the in-flight backend request(s) (pass deadline, execution abort).
   * An aborted strict call throws {@link RerankError} with kind `aborted`.
   */
  signal?: AbortSignal;
}

/** Failure category of a strict rerank call. */
export type RerankErrorKind =
  | "http"
  | "invalid_response"
  | "timeout"
  | "network"
  | "too_many_documents"
  /** The caller's {@link RerankCallOptions.signal} aborted the call. */
  | "aborted";

/** Raised by {@link Reranker.rerankOrThrow} when no complete result is available. */
export class RerankError extends Error {
  readonly kind: RerankErrorKind;
  readonly status: number | undefined;
  readonly batchIndex: number | undefined;
  readonly detail: string | undefined;

  constructor(
    kind: RerankErrorKind,
    message: string,
    options: { status?: number; batchIndex?: number; detail?: string } = {},
  ) {
    super(message);
    this.name = "RerankError";
    this.kind = kind;
    this.status = options.status;
    this.batchIndex = options.batchIndex;
    this.detail = options.detail;
  }
}

/** Max passages sent to the Rerank API in one call (Cohere allows up to 1000). */
export const RERANK_MAX_DOCUMENTS_PER_CALL = 1000;
const MAX_DOCUMENTS = RERANK_MAX_DOCUMENTS_PER_CALL;
/** Max characters per passage sent to the reranker (keeps the request lean). */
const MAX_DOC_CHARS = 4096;
const DEFAULT_TEI_TIMEOUT_MS = 30_000;
/**
 * Default overall deadline of ONE TEI `rerank`/`rerankOrThrow` call across all
 * of its sequential batches. Without it, a slow backend could hold a call for
 * up to 32 batches × 30 s (16 min), including lenient callers such as the
 * `parallel` RAG node. 2 min is conservative: a live 838-summary coverage pass
 * took 1.5–4.3 s.
 */
export const DEFAULT_TEI_TOTAL_TIMEOUT_MS = 120_000;
/**
 * Default texts per TEI `/rerank` request. TEI rejects requests above its
 * `max_client_batch_size` (default 32) with HTTP 422, so larger inputs are
 * split client-side.
 */
export const DEFAULT_TEI_BATCH_SIZE = 32;
const MAX_ERROR_DETAIL_CHARS = 200;

function clampScore(score: number): number {
  return Math.min(1, Math.max(0, score));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structured log fields for a failed rerank call. */
function rerankErrorFields(err: unknown): Record<string, unknown> {
  if (err instanceof RerankError) {
    return {
      error: err.message,
      error_kind: err.kind,
      ...(err.status !== undefined ? { status: err.status } : {}),
      ...(err.batchIndex !== undefined ? { batch_index: err.batchIndex } : {}),
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
    };
  }
  return { error: errorMessage(err) };
}

/** HTTP client for a Text Embeddings Inference `/rerank` endpoint. */
export class TeiReranker implements Reranker {
  readonly batchSize: number;

  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly logger?: Logger,
    private readonly timeoutMs = DEFAULT_TEI_TIMEOUT_MS,
    /** Outbound fetch: the process-wide Egress_Guard by default (SSRF-safe). */
    private readonly fetchFn: typeof fetch = egressFetch,
    /** Max texts per `/rerank` request (TEI `max_client_batch_size`). */
    batchSize: number = DEFAULT_TEI_BATCH_SIZE,
    /**
     * Overall deadline per call across all batches (also bounds the lenient
     * {@link rerank}); see {@link DEFAULT_TEI_TOTAL_TIMEOUT_MS}.
     */
    private readonly totalTimeoutMs: number = DEFAULT_TEI_TOTAL_TIMEOUT_MS,
  ) {
    this.batchSize =
      Number.isInteger(batchSize) && batchSize > 0
        ? batchSize
        : DEFAULT_TEI_BATCH_SIZE;
  }

  /** Lenient rerank: logs the failure (status, batch) and returns `[]`. */
  async rerank(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]> {
    try {
      return await this.rerankOrThrow(query, documents, topN, options);
    } catch (err) {
      this.logger?.warn("TEI rerank call failed; trying configured fallback", {
        ...rerankErrorFields(err),
        batch_size: this.batchSize,
        documents: Math.min(documents.length, MAX_DOCUMENTS),
      });
      return [];
    }
  }

  /**
   * Strict rerank: sends the documents in sequential batches of at most
   * {@link batchSize}, maps each batch's local indices back to global input
   * indices, and sorts globally. All-or-nothing — any failing batch throws a
   * {@link RerankError}; partial results are never returned.
   */
  async rerankOrThrow(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]> {
    const docs = documents.slice(0, MAX_DOCUMENTS);
    if (query.trim() === "" || docs.length === 0 || topN <= 0) return [];

    const external = options?.signal;
    const total = new AbortController();
    const totalTimer = setTimeout(() => total.abort(), this.totalTimeoutMs);
    try {
      const hits: RerankHit[] = [];
      for (
        let offset = 0, batchIndex = 0;
        offset < docs.length;
        offset += this.batchSize, batchIndex++
      ) {
        // Never start another batch once the call is aborted or out of time.
        this.throwIfStopped(external, total.signal, batchIndex);
        const batch = docs.slice(offset, offset + this.batchSize);
        const batchHits = await this.rerankBatch(
          query,
          batch,
          batchIndex,
          external,
          total.signal,
        );
        for (const hit of batchHits) {
          hits.push({ index: hit.index + offset, score: hit.score });
        }
      }
      return hits
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, topN);
    } finally {
      clearTimeout(totalTimer);
    }
  }

  /** Throws the matching {@link RerankError} when the call must stop. */
  private throwIfStopped(
    external: AbortSignal | undefined,
    total: AbortSignal,
    batchIndex: number,
  ): void {
    if (external?.aborted === true) {
      throw new RerankError(
        "aborted",
        `TEI rerank batch ${batchIndex} aborted by caller`,
        { batchIndex },
      );
    }
    if (total.aborted) {
      throw new RerankError(
        "timeout",
        `TEI rerank batch ${batchIndex} exceeded total deadline of ${this.totalTimeoutMs} ms`,
        { batchIndex },
      );
    }
  }

  /** Classifies a failed batch: caller abort → total deadline → batch timer. */
  private stoppedError(
    external: AbortSignal | undefined,
    total: AbortSignal,
    batch: AbortSignal,
    batchIndex: number,
  ): RerankError | undefined {
    if (external?.aborted === true || total.aborted) {
      try {
        this.throwIfStopped(external, total, batchIndex);
      } catch (err) {
        return err as RerankError;
      }
    }
    if (batch.aborted) {
      return new RerankError(
        "timeout",
        `TEI rerank batch ${batchIndex} timed out after ${this.timeoutMs} ms`,
        { batchIndex },
      );
    }
    return undefined;
  }

  private async rerankBatch(
    query: string,
    batch: string[],
    batchIndex: number,
    external: AbortSignal | undefined,
    total: AbortSignal,
  ): Promise<RerankHit[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // One signal for the request: batch timer, total deadline, caller abort.
    const signal = AbortSignal.any(
      external !== undefined
        ? [controller.signal, total, external]
        : [controller.signal, total],
    );
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          query: query.slice(0, MAX_DOC_CHARS),
          texts: batch.map((text) => text.slice(0, MAX_DOC_CHARS)),
          top_n: batch.length,
        }),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw (
        this.stoppedError(external, total, controller.signal, batchIndex) ??
        new RerankError(
          "network",
          `TEI rerank batch ${batchIndex} failed: ${errorMessage(err)}`,
          { batchIndex },
        )
      );
    }

    try {
      if (!response.ok) {
        let detail: string | undefined;
        try {
          detail = (await response.text()).slice(0, MAX_ERROR_DETAIL_CHARS);
        } catch {
          detail = undefined;
        }
        throw new RerankError(
          "http",
          `TEI rerank batch ${batchIndex} returned HTTP ${response.status}`,
          {
            status: response.status,
            batchIndex,
            ...(detail !== undefined && detail !== "" ? { detail } : {}),
          },
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw (
          this.stoppedError(external, total, controller.signal, batchIndex) ??
          new RerankError(
            "invalid_response",
            `TEI rerank batch ${batchIndex} returned no valid JSON: ${errorMessage(err)}`,
            { batchIndex },
          )
        );
      }
      if (!Array.isArray(payload)) {
        throw new RerankError(
          "invalid_response",
          `TEI rerank batch ${batchIndex} returned a non-array payload`,
          { batchIndex },
        );
      }

      const hits: RerankHit[] = [];
      const seen = new Set<number>();
      for (const row of payload) {
        const { index, score } =
          row !== null && typeof row === "object"
            ? (row as Record<string, unknown>)
            : {};
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= batch.length ||
          typeof score !== "number" ||
          !Number.isFinite(score) ||
          seen.has(index)
        ) {
          throw new RerankError(
            "invalid_response",
            `TEI rerank batch ${batchIndex} returned an invalid hit`,
            { batchIndex },
          );
        }
        seen.add(index);
        hits.push({ index, score: clampScore(score) });
      }
      return hits;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Uses the secondary reranker only when the primary produces no usable hits. */
export class FallbackReranker implements Reranker {
  constructor(
    private readonly primary: Reranker,
    private readonly secondary: Reranker,
    private readonly logger?: Logger,
  ) {}

  async rerank(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]> {
    const primaryHits = await this.primary.rerank(
      query,
      documents,
      topN,
      options,
    );
    if (primaryHits.length > 0) return primaryHits;
    if (options?.signal?.aborted === true) return [];
    this.logger?.warn(
      "Primary reranker returned no hits; using Bedrock fallback",
    );
    return this.secondary.rerank(query, documents, topN, options);
  }

  /**
   * Strict: primary first; on a primary error (or an empty result for a
   * non-empty input) the secondary, strict as well. Throws when both fail.
   * A caller abort is rethrown and never triggers the secondary.
   */
  async rerankOrThrow(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]> {
    return (await this.strictWithFallback(query, documents, topN, options))
      .hits;
  }

  /** Strict primary → secondary call that also reports who answered. */
  private async strictWithFallback(
    query: string,
    documents: string[],
    topN: number,
    options: RerankCallOptions | undefined,
  ): Promise<{ hits: RerankHit[]; backend: Reranker | undefined }> {
    if (query.trim() === "" || documents.length === 0 || topN <= 0) {
      return { hits: [], backend: undefined };
    }
    let primaryError: unknown;
    try {
      const hits = await strictRerank(
        this.primary,
        query,
        documents,
        topN,
        options,
      );
      if (hits.length > 0) return { hits, backend: this.primary };
    } catch (err) {
      if (options?.signal?.aborted === true) throw abortedError(err);
      primaryError = err;
    }
    this.logger?.warn("Primary reranker failed; using Bedrock fallback", {
      ...(primaryError !== undefined
        ? rerankErrorFields(primaryError)
        : { error: "primary returned no hits" }),
    });
    const hits = await strictRerank(
      this.secondary,
      query,
      documents,
      topN,
      options,
    );
    return { hits, backend: this.secondary };
  }

  /**
   * Pins ONE backend for a sequence of strict calls (a coverage rerank pass).
   * The first non-empty call goes primary → secondary as usual; whichever
   * backend answered is fixed and every later call of the session goes ONLY
   * to it. A failure of the pinned backend is thrown, never retried on the
   * other one: TEI and Bedrock scores are not calibrated against each other,
   * so a pass must never mix them. When the primary is already down at the
   * start, the secondary scores the whole pass consistently.
   */
  pinBackend(): Reranker {
    let pinned: Reranker | undefined;
    const strict = async (
      query: string,
      documents: string[],
      topN: number,
      options?: RerankCallOptions,
    ): Promise<RerankHit[]> => {
      if (pinned !== undefined) {
        return strictRerank(pinned, query, documents, topN, options);
      }
      const { hits, backend } = await this.strictWithFallback(
        query,
        documents,
        topN,
        options,
      );
      if (backend !== undefined) {
        pinned = backend;
        if (backend === this.secondary) {
          this.logger?.warn(
            "Rerank session pinned to the Bedrock fallback; primary unavailable",
          );
        }
      }
      return hits;
    };
    return {
      rerankOrThrow: strict,
      rerank: async (query, documents, topN, options) => {
        try {
          return await strict(query, documents, topN, options);
        } catch (err) {
          this.logger?.warn("Pinned rerank session call failed", {
            ...rerankErrorFields(err),
          });
          return [];
        }
      },
    };
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Normalises a failure caused by a caller abort to kind `aborted`. */
function abortedError(err: unknown): RerankError {
  if (err instanceof RerankError && err.kind === "aborted") return err;
  return new RerankError("aborted", `Rerank aborted: ${errorMessage(err)}`);
}

/**
 * Calls {@link Reranker.rerankOrThrow} when available. For a lenient-only
 * reranker, an empty result for a non-empty input is treated as a failure.
 */
export async function strictRerank(
  reranker: Reranker,
  query: string,
  documents: string[],
  topN: number,
  options?: RerankCallOptions,
): Promise<RerankHit[]> {
  if (reranker.rerankOrThrow !== undefined) {
    return reranker.rerankOrThrow(query, documents, topN, options);
  }
  const hits = await reranker.rerank(query, documents, topN, options);
  if (options?.signal?.aborted === true) {
    throw new RerankError("aborted", "Rerank aborted by caller");
  }
  if (
    hits.length === 0 &&
    query.trim() !== "" &&
    documents.length > 0 &&
    topN > 0
  ) {
    throw new RerankError(
      "invalid_response",
      "Reranker returned no hits for a non-empty input",
    );
  }
  return hits;
}

/**
 * {@link Reranker} backed by the Bedrock Rerank API. `modelArn` is the full
 * foundation-model ARN (or inference-profile ARN) of the reranker model.
 */
export class BedrockReranker implements Reranker {
  constructor(
    private readonly client: Pick<BedrockAgentRuntimeClient, "send">,
    private readonly modelArn: string,
    private readonly logger?: Logger,
  ) {}

  async rerank(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]> {
    try {
      return await this.rerankOrThrow(query, documents, topN, options);
    } catch (err) {
      this.logger?.warn("Rerank call failed; falling back to retrieval order", {
        ...rerankErrorFields(err),
      });
      return [];
    }
  }

  async rerankOrThrow(
    query: string,
    documents: string[],
    topN: number,
    options?: RerankCallOptions,
  ): Promise<RerankHit[]> {
    const signal = options?.signal;
    if (signal?.aborted === true) {
      throw new RerankError("aborted", "Bedrock rerank aborted by caller");
    }
    const docs = documents.slice(0, MAX_DOCUMENTS);
    if (query.trim() === "" || docs.length === 0 || topN <= 0) return [];
    const numberOfResults = Math.min(topN, docs.length);
    const command = new RerankCommand({
      queries: [
        { type: "TEXT", textQuery: { text: query.slice(0, MAX_DOC_CHARS) } },
      ],
      sources: docs.map((text) => ({
        type: "INLINE" as const,
        inlineDocumentSource: {
          type: "TEXT" as const,
          textDocument: { text: text.slice(0, MAX_DOC_CHARS) },
        },
      })),
      rerankingConfiguration: {
        type: "BEDROCK_RERANKING_MODEL" as const,
        bedrockRerankingConfiguration: {
          numberOfResults,
          modelConfiguration: { modelArn: this.modelArn },
        },
      },
    });
    let res: RerankCommandOutput;
    try {
      // The cast narrows the structural client type accepted for testability.
      res = await (this.client as BedrockAgentRuntimeClient).send(
        command,
        signal !== undefined ? { abortSignal: signal } : {},
      );
    } catch (err) {
      // Re-read the signal: it may have aborted while the request was pending.
      if (isAborted(signal)) {
        throw new RerankError(
          "aborted",
          `Bedrock rerank aborted: ${errorMessage(err)}`,
        );
      }
      throw new RerankError("network", `Bedrock rerank failed: ${errorMessage(err)}`);
    }
    const results = res.results ?? [];
    const hits: RerankHit[] = [];
    for (const r of results) {
      if (typeof r.index === "number") {
        hits.push({ index: r.index, score: r.relevanceScore ?? 0 });
      }
    }
    return hits;
  }
}

/**
 * Builds the foundation-model ARN for a rerank model id. Pass-through when the
 * id already looks like an ARN; otherwise assembles the standard on-demand
 * foundation-model ARN for the given region.
 */
export function rerankModelArn(modelId: string, region: string): string {
  if (modelId.startsWith("arn:")) return modelId;
  return `arn:aws:bedrock:${region}::foundation-model/${modelId}`;
}

/**
 * Constructs a {@link BedrockReranker} from {@link AppConfig}.
 *
 * Region and credentials come from the NAMED provider in `RERANK_PROVIDER`
 * (`PROVIDERS` is the single source for endpoints and credentials), so the
 * reranker authenticates exactly like the Bedrock LLM provider without a second
 * set of environment variables. `RERANK_REGION` may still override the region,
 * because Rerank is not offered in every region a deployment runs models in.
 *
 * Returns undefined — leaving reranking disabled rather than failing every call —
 * when the named provider is missing, does not speak the bedrock protocol, or no
 * region is resolvable (the Rerank API is region-scoped).
 */
export function createBedrockReranker(
  appConfig: AppConfig,
  logger?: Logger,
): Reranker | undefined {
  const providerName = appConfig.rerankProvider;
  const instance =
    providerName === undefined ? undefined : getProviderInstance(providerName);
  if (providerName !== undefined && instance === undefined) {
    logger?.warn("RERANK_PROVIDER names no configured provider", {
      provider: providerName,
    });
    return undefined;
  }
  if (instance !== undefined && instance.protocol !== "bedrock") {
    logger?.warn("RERANK_PROVIDER must name a bedrock-protocol provider", {
      provider: instance.name,
      protocol: instance.protocol,
    });
    return undefined;
  }
  const region = appConfig.rerankRegion ?? instance?.region;
  if (region === undefined || region.trim() === "") return undefined;
  const modelId = appConfig.rerankModel ?? "cohere.rerank-v3-5:0";
  const client = new BedrockAgentRuntimeClient({
    region,
    // Static credentials are an atomic bundle; without both, fall through to the
    // ambient AWS credential chain rather than sending a half-formed identity.
    ...(instance?.accessKeyId !== undefined &&
    instance.secretAccessKey !== undefined
      ? {
          credentials: {
            accessKeyId: instance.accessKeyId,
            secretAccessKey: instance.secretAccessKey,
            ...(instance.sessionToken !== undefined
              ? { sessionToken: instance.sessionToken }
              : {}),
          },
        }
      : {}),
  });
  return new BedrockReranker(client, rerankModelArn(modelId, region), logger);
}

/**
 * Creates the configured runtime reranker. With `RERANK_URL`, TEI is primary
 * and an optional Bedrock client built from the fallback fields is secondary.
 * Without `RERANK_URL`, this delegates to the legacy Bedrock-only factory.
 */
export function createReranker(
  appConfig: AppConfig,
  logger?: Logger,
): Reranker | undefined {
  const rerankUrl = appConfig.rerankUrl?.trim();
  if (rerankUrl === undefined || rerankUrl === "") {
    return createBedrockReranker(appConfig, logger);
  }
  const model = appConfig.rerankModel?.trim();
  if (model === undefined || model === "") {
    logger?.warn("RERANK_URL requires RERANK_MODEL; reranking stays disabled");
    return undefined;
  }

  const primary = new TeiReranker(
    rerankUrl,
    model,
    logger,
    DEFAULT_TEI_TIMEOUT_MS,
    egressFetch,
    appConfig.rerankBatchSize ?? DEFAULT_TEI_BATCH_SIZE,
    DEFAULT_TEI_TOTAL_TIMEOUT_MS,
  );
  const fallbackModel = appConfig.rerankFallbackModel?.trim();
  if (fallbackModel === undefined || fallbackModel === "") return primary;

  const fallbackConfig: AppConfig = {
    ...appConfig,
    rerankModel: fallbackModel,
  };
  delete fallbackConfig.rerankProvider;
  delete fallbackConfig.rerankRegion;
  if (appConfig.rerankFallbackProvider !== undefined) {
    fallbackConfig.rerankProvider = appConfig.rerankFallbackProvider;
  }
  if (appConfig.rerankFallbackRegion !== undefined) {
    fallbackConfig.rerankRegion = appConfig.rerankFallbackRegion;
  }
  const fallback = createBedrockReranker(fallbackConfig, logger);
  if (fallback === undefined) {
    logger?.warn(
      "TEI reranker enabled, but the configured Bedrock fallback could not be built",
    );
    return primary;
  }
  return new FallbackReranker(primary, fallback, logger);
}

// ---------------------------------------------------------------------------
// Pure helpers (parse + fuse) — no AWS dependency, unit-testable in isolation.
// ---------------------------------------------------------------------------

/**
 * Stable document identity used to deduplicate/number citations consistently.
 * Prefers the parent-document reference (`base_ref`) — the identity that both
 * `search` (as `base_ref`) and `get_summaries` (as `reference`) expose for a
 * document — so a passage and its summary/overview entry collapse to ONE
 * citation. Falls back to a real URL, then the title. Lives here (a leaf
 * module) so both {@link RagChunk} fusion and the grounding builder share it
 * without an import cycle.
 */
export function docKeyOf(parts: {
  reference?: string | undefined;
  url?: string | undefined;
  title: string;
}): string {
  const ref = parts.reference?.trim();
  if (ref !== undefined && ref !== "") return ref;
  if (parts.url !== undefined && parts.url.length > 0) return parts.url;
  return parts.title;
}

/** {@link docKeyOf} for a parsed chunk (base_ref → url → title). */
function chunkDocKey(c: RagChunk): string {
  return docKeyOf({ reference: c.baseRef, url: c.url, title: c.title });
}

/**
 * Parses the `assets[]` array of a v2 search hit into {@link RagAsset}s. Each
 * entry needs a non-empty `asset_id` (the identity used to attach/inspect the
 * image); everything else is optional and copied through when present. Returns
 * undefined when the field is absent or holds no valid asset, so legacy hits
 * carry no `assets`.
 */
function parseRagAssets(raw: unknown): RagAsset[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RagAsset[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const a = entry as Record<string, unknown>;
    const assetId =
      typeof a.asset_id === "string" && a.asset_id.trim() !== ""
        ? a.asset_id
        : typeof a.id === "string" && a.id.trim() !== ""
          ? a.id
          : undefined;
    if (assetId === undefined) continue;
    const kind =
      typeof a.kind === "string" && a.kind.trim() !== "" ? a.kind : undefined;
    const figureKind =
      typeof a.figure_kind === "string" && a.figure_kind.trim() !== ""
        ? a.figure_kind
        : undefined;
    const caption =
      typeof a.caption === "string" && a.caption.trim() !== ""
        ? a.caption
        : undefined;
    const page =
      typeof a.page === "number" && Number.isFinite(a.page) && a.page >= 0
        ? Math.floor(a.page)
        : undefined;
    const bbox =
      Array.isArray(a.bbox) &&
      a.bbox.length === 4 &&
      a.bbox.every((v) => typeof v === "number" && Number.isFinite(v))
        ? (a.bbox as [number, number, number, number])
        : undefined;
    const thumbUrl =
      typeof a.thumb_url === "string" && a.thumb_url.trim() !== ""
        ? a.thumb_url
        : undefined;
    const url =
      typeof a.url === "string" && a.url.trim() !== "" ? a.url : undefined;
    out.push({
      assetId,
      ...(kind !== undefined ? { kind } : {}),
      ...(figureKind !== undefined ? { figureKind } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(bbox !== undefined ? { bbox } : {}),
      ...(thumbUrl !== undefined ? { thumbUrl } : {}),
      ...(url !== undefined ? { url } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Normalise a Search content-trust `injection_risk` label. Only the two values
 * the Search service emits are accepted; anything else (missing, a typo, a
 * future value the runtime does not know) yields undefined so the chunk keeps
 * no label rather than a wrong one. Fail-safe: an unknown label never clears a
 * taint — the runtime's own scan still runs on the text.
 */
function parseInjectionRiskLabel(value: unknown): "none" | "suspected" | undefined {
  return value === "none" || value === "suspected" ? value : undefined;
}

/**
 * Parses the chunks out of a vectorsearch tool result. Handles the MCP
 * text-content wrapper (`[{type:"text", text:"<json>"}]`), a raw JSON string,
 * or an already-parsed `{ results: [...] }` object. Returns [] for anything
 * that is not a vectorsearch payload (so it is safe to call on any tool result).
 *
 * Mirrors the field resolution used for citation extraction: title/link live at
 * the top level of each result item, dates in `metadata`.
 */
export function parseVectorSearchResults(toolContent: unknown): RagChunk[] {
  let parsed: unknown = toolContent;
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
    return [];
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("results" in (parsed as Record<string, unknown>))
  ) {
    return [];
  }
  const results = (parsed as { results: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  // Response-level trust labels from Search (`aggregateTrustLabels`): when the
  // envelope carries a label, it applies to every hit that has no own label.
  const envelopeRisk = parseInjectionRiskLabel(
    (parsed as Record<string, unknown>).injection_risk,
  );
  const envelopeTrust =
    typeof (parsed as Record<string, unknown>).content_trust === "string"
      ? ((parsed as Record<string, unknown>).content_trust as string)
      : undefined;
  const chunks: RagChunk[] = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i] as Record<string, unknown>;
    const meta = (item.metadata as Record<string, unknown> | undefined) ?? {};
    const evidence =
      item.evidence !== null &&
      typeof item.evidence === "object" &&
      !Array.isArray(item.evidence)
        ? (item.evidence as Record<string, unknown>)
        : {};
    const title =
      (typeof item.title === "string" && item.title) ||
      (typeof meta.title === "string" && meta.title) ||
      (typeof meta.name === "string" && meta.name) ||
      (typeof item.id === "string" ? `Dokument ${item.id}` : `Quelle ${i + 1}`);
    const url =
      (typeof item.link === "string" && item.link) ||
      (typeof item.url === "string" && item.url) ||
      (typeof meta.url === "string" && meta.url) ||
      (typeof meta.link === "string" && meta.link) ||
      "";
    const content =
      typeof item.content === "string"
        ? (item.content as string)
        : typeof item.text === "string"
          ? (item.text as string)
          : "";
    const retrievalScore =
      typeof item.score === "number" ? (item.score as number) : 0;
    const tags = Array.isArray(item.tags)
      ? (item.tags as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : undefined;
    // Document-level identity: prefer base_ref (parent doc), fall back to the
    // chunk reference, then metadata. Used for cross-turn seen-doc tracking.
    const baseRef =
      (typeof item.base_ref === "string" && (item.base_ref as string)) ||
      (typeof item.reference === "string" && (item.reference as string)) ||
      (typeof meta.base_ref === "string" && (meta.base_ref as string)) ||
      undefined;
    const stringField = (name: string): string | undefined => {
      const value = item[name] ?? meta[name];
      return typeof value === "string" && value.trim() !== ""
        ? value
        : undefined;
    };
    const numberField = (name: string): number | undefined => {
      const value = item[name] ?? meta[name];
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
    };
    const rawPage = item.page ?? meta.page;
    const page =
      typeof rawPage === "number" && Number.isFinite(rawPage) && rawPage >= 0
        ? Math.floor(rawPage)
        : typeof rawPage === "string" && rawPage.trim() !== ""
          ? rawPage
          : undefined;
    const citationId = stringField("citation_id");
    const documentId =
      stringField("document_id") ??
      (typeof evidence.root_document_id === "string" &&
      evidence.root_document_id.trim() !== ""
        ? evidence.root_document_id
        : undefined);
    const version = stringField("version");
    const section =
      stringField("section") ??
      (Array.isArray(evidence.section_path)
        ? evidence.section_path
            .filter((value): value is string => typeof value === "string")
            .join(" > ") || undefined
        : undefined);
    const charStart =
      numberField("char_start") ??
      (typeof evidence.char_start === "number" &&
      Number.isFinite(evidence.char_start) &&
      evidence.char_start >= 0
        ? Math.floor(evidence.char_start)
        : undefined);
    const charEnd =
      numberField("char_end") ??
      (typeof evidence.char_end === "number" &&
      Number.isFinite(evidence.char_end) &&
      evidence.char_end >= 0
        ? Math.floor(evidence.char_end)
        : undefined);
    const chunkId =
      stringField("chunk_id") ??
      (typeof evidence.chunk_id === "string" && evidence.chunk_id.trim() !== ""
        ? evidence.chunk_id
        : undefined);
    const evidencePage = evidence.page_start;
    const pageStart =
      typeof evidencePage === "number" &&
      Number.isFinite(evidencePage) &&
      evidencePage >= 0
        ? Math.floor(evidencePage)
        : undefined;
    const rawPageEnd = evidence.page_end;
    const pageEnd =
      typeof rawPageEnd === "number" &&
      Number.isFinite(rawPageEnd) &&
      rawPageEnd >= 0
        ? Math.floor(rawPageEnd)
        : undefined;
    const modality =
      evidence.modality === "image" ? ("image" as const) : undefined;
    const figureId =
      typeof evidence.figure_id === "string" && evidence.figure_id.trim() !== ""
        ? evidence.figure_id
        : undefined;
    const assetId =
      typeof evidence.asset_id === "string" && evidence.asset_id.trim() !== ""
        ? evidence.asset_id
        : undefined;
    const rawBbox = evidence.bbox;
    const bbox =
      Array.isArray(rawBbox) &&
      rawBbox.length === 4 &&
      rawBbox.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
        ? (rawBbox as [number, number, number, number])
        : undefined;
    const assetUrl =
      typeof item.asset_url === "string" && item.asset_url.trim() !== ""
        ? item.asset_url
        : undefined;
    // v2 hit provenance: top-level `section_path` breadcrumb,
    // `pages` numbers, the hit's `figure_kind`/`caption`, and the `assets[]`
    // array from `include_assets`. Read from the item first, then evidence, so
    // both response shapes parse. Undefined for legacy hits.
    const rawSectionPath = item.section_path ?? evidence.section_path;
    const sectionPath = Array.isArray(rawSectionPath)
      ? rawSectionPath.filter(
          (value): value is string =>
            typeof value === "string" && value.trim() !== "",
        )
      : undefined;
    const rawPages = item.pages ?? evidence.pages;
    const pages = Array.isArray(rawPages)
      ? rawPages
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value) && value >= 0,
          )
          .map((value) => Math.floor(value))
      : undefined;
    const figureKind =
      (typeof item.figure_kind === "string" && item.figure_kind.trim() !== ""
        ? item.figure_kind
        : undefined) ??
      (typeof evidence.figure_kind === "string" &&
      evidence.figure_kind.trim() !== ""
        ? evidence.figure_kind
        : undefined);
    const caption =
      (typeof item.caption === "string" && item.caption.trim() !== ""
        ? item.caption
        : undefined) ??
      (typeof evidence.caption === "string" && evidence.caption.trim() !== ""
        ? evidence.caption
        : undefined);
    const assets = parseRagAssets(item.assets);
    const resolvedPage = page ?? pageStart;
    // Per-hit trust label from Search, falling back to the response envelope.
    const injectionRisk =
      parseInjectionRiskLabel(item.injection_risk) ?? envelopeRisk;
    const contentTrust =
      typeof item.content_trust === "string"
        ? item.content_trust
        : envelopeTrust;
    chunks.push({
      id: typeof item.id === "string" ? (item.id as string) : String(i),
      title: String(title),
      url: String(url),
      content,
      retrievalScore,
      ...(tags !== undefined ? { tags } : {}),
      ...(baseRef !== undefined && baseRef !== "" ? { baseRef } : {}),
      ...(citationId !== undefined ? { citationId } : {}),
      ...(documentId !== undefined ? { documentId } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(resolvedPage !== undefined ? { page: resolvedPage } : {}),
      ...(pageStart !== undefined ? { pageStart } : {}),
      ...(pageEnd !== undefined ? { pageEnd } : {}),
      ...(modality !== undefined ? { modality } : {}),
      ...(figureId !== undefined ? { figureId } : {}),
      ...(assetId !== undefined ? { assetId } : {}),
      ...(bbox !== undefined ? { bbox } : {}),
      ...(assetUrl !== undefined ? { assetUrl } : {}),
      ...(sectionPath !== undefined && sectionPath.length > 0
        ? { sectionPath }
        : {}),
      ...(pages !== undefined && pages.length > 0 ? { pages } : {}),
      ...(figureKind !== undefined ? { figureKind } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(assets !== undefined && assets.length > 0 ? { assets } : {}),
      ...(section !== undefined ? { section } : {}),
      ...(charStart !== undefined ? { charStart } : {}),
      ...(charEnd !== undefined ? { charEnd } : {}),
      ...(chunkId !== undefined ? { chunkId } : {}),
      ...(injectionRisk !== undefined ? { injectionRisk } : {}),
      ...(contentTrust !== undefined ? { contentTrust } : {}),
      ...(meta !== null &&
      typeof meta === "object" &&
      Object.keys(meta).length > 0
        ? { metadata: meta }
        : {}),
    });
  }
  return chunks;
}

/** One document summary parsed from a vectorsearch `get_summaries` result. */
export interface RagSummary {
  /** Document reference/path (base_ref). */
  reference: string;
  /** Document title (falls back to reference). */
  title: string;
  /** Source URL/link, or "" when none. */
  url: string;
  /** The stored summary text (may be "" when none was stored). */
  summary: string;
}

/**
 * Parse a vectorsearch `get_summaries` tool result into document summaries.
 * Accepts the MCP text-content wrapper, a raw JSON string, or an already-parsed
 * `{ summaries: [...] }` object. Returns [] for anything else (so it is safe to
 * call on any tool result — a `search`/`get_document` result yields []).
 */
export function parseVectorSearchSummaries(toolContent: unknown): RagSummary[] {
  let parsed: unknown = toolContent;
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
    return [];
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("summaries" in (parsed as Record<string, unknown>))
  ) {
    return [];
  }
  const summaries = (parsed as { summaries: unknown[] }).summaries;
  if (!Array.isArray(summaries)) return [];
  const out: RagSummary[] = [];
  for (let i = 0; i < summaries.length; i++) {
    const item = summaries[i] as Record<string, unknown>;
    const reference =
      typeof item.reference === "string" ? (item.reference as string) : "";
    const title =
      (typeof item.title === "string" && (item.title as string)) ||
      reference ||
      `Dokument ${i + 1}`;
    const url =
      (typeof item.link === "string" && (item.link as string)) ||
      (typeof item.url === "string" && (item.url as string)) ||
      "";
    const summary =
      typeof item.summary === "string" ? (item.summary as string) : "";
    out.push({
      reference: String(reference),
      title: String(title),
      url: String(url),
      summary,
    });
  }
  return out;
}

/**
 * Reads the pagination envelope of a vectorsearch `get_summaries` result:
 * `count` (items in this response) and `total` (documents matching overall).
 * When `total > count` the summaries list is CAPPED — the caller must not
 * present it as the complete document set. Returns {} for non-summaries results.
 */
export function parseVectorSearchSummaryMeta(toolContent: unknown): {
  count?: number;
  total?: number;
} {
  let parsed: unknown = toolContent;
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
    return {};
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("summaries" in (parsed as Record<string, unknown>))
  ) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const count = typeof obj.count === "number" ? (obj.count as number) : undefined;
  const total = typeof obj.total === "number" ? (obj.total as number) : undefined;
  return {
    ...(count !== undefined ? { count } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

/**
 * Applies rerank hits to the parsed chunk union and returns the selected chunks
 * in reranked order, deduplicated by document (url, falling back to title) so a
 * document that contributed several passages is represented once (by its
 * highest-ranked passage). At most `topNDocs` documents are returned; when
 * `minScore` is given, hits below it are dropped first.
 *
 * Pure — no I/O. When `hits` is empty (reranker unavailable/failed) the caller
 * should fall back to the un-fused per-source behaviour rather than calling
 * this with a degenerate order.
 */
export function selectRerankedChunks(
  chunks: readonly RagChunk[],
  hits: readonly RerankHit[],
  topNDocs: number,
  minScore?: number,
): RagChunk[] {
  const seen = new Set<string>();
  const out: RagChunk[] = [];
  for (const hit of hits) {
    // `hits` is already sorted descending by score — once we drop below
    // minScore, every remaining hit will too, so stop instead of skipping.
    if (minScore !== undefined && hit.score < minScore) break;
    const chunk = chunks[hit.index];
    if (chunk === undefined) continue;
    const key = chunkDocKey(chunk);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...chunk, retrievalScore: hit.score });
    if (out.length >= topNDocs) break;
  }
  return out;
}

/**
 * Score-only fusion, no model call: orders the chunks by their **effective**
 * score — `retrievalScore * (scoreWeight ?? 1)` — deduplicates by document, and
 * keeps the top `topNDocs` at/above `minScore`. The `scoreWeight` multiplier is
 * how `ragProfiles` down/upweights a source relative to others (e.g. a cross-
 * client fallback at 0.4 competes at 40% of its raw score against a primary
 * tag source at 1.0); it is applied here — previously `scoreWeight` was carried
 * through the pipeline but never actually fused. `minScore` is compared against
 * the effective score too, so low-weight sources are also filtered more
 * aggressively. Used both as the resilience fallback for
 * {@link selectRerankedChunks} (reranker unavailable/failed) and as the primary
 * path for `ragProfiles.maxDocuments` (sources that already rerank themselves).
 * Pure.
 */
export function selectByRetrievalScore(
  chunks: readonly RagChunk[],
  topNDocs: number,
  minScore?: number,
): RagChunk[] {
  const effective = (c: RagChunk): number =>
    c.retrievalScore *
    (typeof c.scoreWeight === "number" && c.scoreWeight >= 0
      ? c.scoreWeight
      : 1);
  const sorted = [...chunks].sort((a, b) => effective(b) - effective(a));
  const seen = new Set<string>();
  const out: RagChunk[] = [];
  for (const chunk of sorted) {
    // `sorted` is descending by effective score — once we drop below minScore,
    // every remaining chunk will too, so stop instead of skipping.
    if (minScore !== undefined && effective(chunk) < minScore) break;
    const key = chunkDocKey(chunk);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chunk);
    if (out.length >= topNDocs) break;
  }
  return out;
}
