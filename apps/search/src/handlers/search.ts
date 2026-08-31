// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { RequestHandler } from "express";
import { accessScopeForRequest } from "../access-scope.js";
import type { Logger } from "pino";
import type { EmbeddingClient } from "../embedding-client.js";
import type { RerankerClient } from "../reranker-client.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { HydeClient } from "../hyde-client.js";
import type {
  PostgresClient,
  SearchFilter,
  SearchResult,
  SearchCursor,
} from "../postgres-client.js";
import {
  encodeCursor,
  decodeCursor,
  prepareFtsContent,
} from "../postgres-client.js";
import { FILTER_V2, normalizeFilterV2, type Metadata } from "../metadata.js";
import type { QueryEmbeddingCache } from "../query-cache.js";
import { runAsyncRerankStream } from "./search-async-rerank.js";
import { readHeader, parseBooleanHeader } from "../header-utils.js";
import { emitActivity } from "../activity-emitter.js";
import { newActivityId } from "./activity-stream.js";
import { getUsageContext } from "../usage-context.js";
import { getPrincipal } from "../request-principal.js";

export interface SearchHandlerOptions {
  rerankerClient?: RerankerClient | null;
  candidateMultiplier?: number;
  hybridSearch?: boolean;
  hydeClient?: HydeClient | null;
  sparseClient?: SparseEmbeddingClient | null;
  /** LRU cache for query embeddings. null / undefined = no caching. */
  queryCache?: QueryEmbeddingCache | null;
}

// ─── Header parsers ───────────────────────────────────────────────────────────

export function parseIncludeAllVersionsFlag(
  header: string | undefined,
): boolean | null | undefined {
  return parseBooleanHeader(header);
}

export function parseHybridFlag(
  header: string | undefined,
): boolean | null | undefined {
  return parseBooleanHeader(header);
}

export function parseGroupByDocumentFlag(
  header: string | undefined,
): boolean | null | undefined {
  return parseBooleanHeader(header);
}

/**
 * Parse the X-Rerank header.
 *   false   — off (absent, empty, or falsy value)
 *   true    — synchronous reranking
 *   "async" — async SSE reranking
 *   null    — invalid value → HTTP 400
 */
export function parseRerankFlag(
  header: string | undefined,
): boolean | "async" | null {
  if (header === undefined) return false;
  const v = header.trim().toLowerCase();
  if (v === "") return false;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  if (v === "async") return "async";
  return null;
}

// ─── Handler factory ──────────────────────────────────────────────────────────

export function createSearchHandler(
  embeddingClient: EmbeddingClient,
  postgresClient: PostgresClient,
  logger: Logger,
  options: SearchHandlerOptions = {},
): RequestHandler {
  const rerankerClient = options.rerankerClient ?? null;
  const candidateMultiplier = options.candidateMultiplier ?? 4;
  const hybridDefault = options.hybridSearch ?? true;
  const hydeClient = options.hydeClient ?? null;
  const sparseClient = options.sparseClient ?? null;
  const queryCache = options.queryCache ?? null;

  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    try {
      const searchStartTime = Date.now();
      // 1. Body
      const body = req.body as string;
      if (!body || body.trim() === "") {
        res.status(400).json({ error: "Request body must not be empty" });
        return;
      }

      // 2. X-Max-Results (default 10, max 100)
      const maxResultsHeader = readHeader(req, "x-max-results");
      let limit = 10;
      if (maxResultsHeader !== undefined) {
        const parsed = parseInt(maxResultsHeader, 10);
        if (
          !Number.isInteger(parsed) ||
          parsed <= 0 ||
          String(parsed) !== maxResultsHeader.trim()
        ) {
          res
            .status(400)
            .json({ error: "X-Max-Results must be a positive integer" });
          return;
        }
        limit = Math.min(parsed, 100);
      }

      // 3. X-Offset (default 0) — legacy; prefer X-Cursor for large datasets
      const offsetHeader = readHeader(req, "x-offset");
      let offset = 0;
      if (offsetHeader !== undefined) {
        const parsed = parseInt(String(offsetHeader), 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          res
            .status(400)
            .json({ error: "X-Offset must be a non-negative integer" });
          return;
        }
        offset = parsed;
      }

      // 3b. X-Cursor — keyset pagination (preferred over X-Offset for large datasets)
      const cursorHeader = readHeader(req, "x-cursor");
      let cursor: SearchCursor | undefined;
      if (cursorHeader) {
        const decoded = decodeCursor(cursorHeader);
        if (!decoded) {
          res.status(400).json({ error: "Invalid X-Cursor value" });
          return;
        }
        cursor = decoded;
        // When a cursor is provided, offset is ignored to avoid ambiguity.
        offset = 0;
      }

      // 4. X-Collection
      const collectionRaw = readHeader(req, "x-collection") || "documents";

      // 5. X-Rerank
      const rerankFlag = parseRerankFlag(readHeader(req, "x-rerank"));
      if (rerankFlag === null) {
        res.status(400).json({
          error:
            "X-Rerank must be one of: 1/0, true/false, yes/no, on/off, async",
        });
        return;
      }
      const rerankMode: "off" | "sync" | "async" =
        rerankFlag === "async" ? "async" : rerankFlag === true ? "sync" : "off";

      if (rerankMode !== "off" && rerankerClient === null) {
        log.warn(
          "X-Rerank requested but no reranker configured (set RERANK_MODEL); serving vector-search order",
        );
      }
      const rerankActive = rerankMode !== "off" && rerankerClient !== null;

      // 6. X-Hybrid / X-Search-Mode
      // X-Search-Mode takes precedence: "dense" | "hybrid" | "fts"
      // X-Hybrid is kept for backwards compatibility.
      const searchModeHeader = readHeader(req, "x-search-mode")
        ?.trim()
        .toLowerCase();
      let hybridRequested: boolean;
      let ftsOnly: boolean;

      if (searchModeHeader !== undefined && searchModeHeader !== "") {
        if (!["dense", "hybrid", "fts"].includes(searchModeHeader)) {
          res.status(400).json({
            error: "X-Search-Mode must be one of: dense, hybrid, fts",
          });
          return;
        }
        hybridRequested = searchModeHeader === "hybrid";
        ftsOnly = searchModeHeader === "fts";
      } else {
        const hybridFlag = parseHybridFlag(readHeader(req, "x-hybrid"));
        if (hybridFlag === null) {
          res.status(400).json({
            error: "X-Hybrid must be one of: 1/0, true/false, yes/no, on/off",
          });
          return;
        }
        hybridRequested = hybridFlag ?? hybridDefault;
        ftsOnly = false;
      }

      // 6b. Reject a cursor for hybrid search up front, with a usable message.
      //     RRF scores are pool-relative, so filtering the candidate pool by a
      //     cursor reranks everything left in it — keyset pagination cannot be
      //     stable here. Previously this combination was accepted and silently
      //     lost high-ranking results.
      if (cursor && hybridRequested) {
        res.status(400).json({
          error:
            "X-Cursor is not supported for hybrid search: reciprocal-rank fusion " +
            "scores depend on the candidate pool, so a keyset cursor cannot page " +
            "stably. Use X-Offset, or switch X-Search-Mode to dense or fts.",
        });
        return;
      }

      // 7. X-Include-All-Versions
      const includeAllVersionsFlag = parseIncludeAllVersionsFlag(
        readHeader(req, "x-include-all-versions"),
      );
      if (includeAllVersionsFlag === null) {
        res.status(400).json({
          error:
            "X-Include-All-Versions must be one of: 1/0, true/false, yes/no, on/off",
        });
        return;
      }
      const includeAllVersions = includeAllVersionsFlag ?? false;

      // 8. X-Group-By-Document: collapse chunk results into one result per document
      const groupByDocumentFlag = parseGroupByDocumentFlag(
        readHeader(req, "x-group-by-document"),
      );
      if (groupByDocumentFlag === null) {
        res.status(400).json({
          error:
            "X-Group-By-Document must be one of: 1/0, true/false, yes/no, on/off",
        });
        return;
      }
      const groupByDocument = groupByDocumentFlag ?? false;

      // 9. X-Hyde: use HyDE query expansion if a hydeClient is configured
      const hydeHeader = parseBooleanHeader(readHeader(req, "x-hyde"));
      if (hydeHeader === null) {
        res.status(400).json({
          error: "X-Hyde must be one of: 1/0, true/false, yes/no, on/off",
        });
        return;
      }
      const hydeRequested = hydeHeader === true && hydeClient !== null;

      // 10. Over-fetch for reranking or document-grouping
      // When grouping by document we need to fetch more chunks than `limit`
      // so we can fill `limit` distinct documents even if many chunks belong
      // to the same document.  Use the same candidateMultiplier heuristic.
      const fetchLimit =
        rerankActive || groupByDocument
          ? Math.min(limit * Math.max(1, candidateMultiplier), 500)
          : limit;

      // 11. Metadata filter from middleware
      const metadata: Metadata =
        (res.locals as { metadata?: Metadata }).metadata ?? {};

      // 11. X-Filter (additional JSON filter)
      // NOTE: X-Filter is merged on top of X-Metadata — if the same key appears
      // in both, X-Filter wins. This is intentional (per-request override), but
      // callers should be aware that X-Filter cannot be used to weaken a
      // middleware-enforced metadata constraint (it can only add more fields).
      const xFilterStr = readHeader(req, "x-filter");
      const xFilterV2Str = readHeader(req, "x-filter-v2");

      // 11b. X-Base-Ref (restrict results to a specific base document reference)
      const xBaseRef = readHeader(req, "x-base-ref") || undefined;

      // 11b-2. X-Path-Prefix (restrict results to documents beneath a folder
      // path, matched against base_ref — e.g. "/Unterlagen Teil 1").
      const xPathPrefix = readHeader(req, "x-path-prefix") || undefined;

      // 11c. X-Include-Query-Vector — opt-in: send the query embedding in the response.
      // Omitted by default to avoid ~12–64 KB of unnecessary payload per request.
      const includeQueryVector =
        parseBooleanHeader(readHeader(req, "x-include-query-vector")) === true;

      // 12. X-Tags (tag filter: document must contain ALL specified tags)
      const xTagsStr = readHeader(req, "x-tags");
      const tagsFilter = xTagsStr
        ? xTagsStr
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

      // 13. Row-level access control: return only docs visible to the acting
      //     identity. Taken from the principal resolved by the auth middleware
      //     (see src/request-principal.ts) rather than read from X-User /
      //     X-Groups here — a verified JWT identity must win over any header,
      //     and reading the headers directly meant a forwarded end-user token
      //     produced NO identity, which the row filter treats as "see
      //     everything".
      const { userId, userGroups } = getPrincipal(req);

      log.info(
        {
          query: body,
          limit,
          offset,
          cursor: cursor ? `${cursor.created}|${cursor.id}` : undefined,
          fetchLimit,
          rerank: rerankMode,
          hybrid: hybridRequested,
          ftsOnly,
          includeAllVersions,
          hyde: hydeRequested,
          groupByDocument,
          sparse: sparseClient !== null,
          collection: collectionRaw,
          metadata,
          xFilter: xFilterStr,
          tags: tagsFilter,
          userId,
          userGroups,
        },
        "Incoming search query",
      );

      // 12. Determine query text (optionally expanded via HyDE)
      // Apply the same pre-processing used at ingest time: strip URLs and other
      // noise tokens so the embedding and FTS query match what is actually indexed.
      // The original `body` is preserved for logging, reranking, and the response.
      let queryText = prepareFtsContent(body);
      let hydeExpanded: string | undefined;

      if (hydeRequested) {
        const hydeRes = await hydeClient!.expand(body);
        if (hydeRes.ok) {
          hydeExpanded = hydeRes.result;
          queryText = hydeRes.result;
          log.debug(
            { hydeLen: hydeRes.result.length },
            "HyDE expansion applied",
          );
        } else {
          log.warn(
            { error: hydeRes.error },
            "HyDE expansion failed; falling back to original query",
          );
        }
      }

      // 13. Embed query — skipped entirely for FTS-only mode since no vector is needed.
      //     This avoids a pointless round-trip to the embedding server.
      let vector: number[] = [];
      if (!ftsOnly) {
        if (queryCache) {
          try {
            vector = await queryCache.getOrEmbed(queryText, async () => {
              const r = await embeddingClient.embed(queryText);
              if (!r.ok) throw new Error(r.error.message);
              return r.result.vector;
            });
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Embedding failed";
            log.warn({ err }, "Embedding failed");
            res.status(502).json({ error: `Embedding failed: ${message}` });
            return;
          }
        } else {
          const embedResult = await embeddingClient.embed(queryText);
          if (!embedResult.ok) {
            log.warn({ error: embedResult.error }, "Embedding failed");
            res.status(502).json({
              error: `Embedding failed: ${embedResult.error.message}`,
            });
            return;
          }
          vector = embedResult.result.vector;
        }
      }

      // 14. Sparse embed (if sparse client configured and hybrid active)
      let sparseVec = undefined;
      if (sparseClient !== null && hybridRequested && !ftsOnly) {
        const sparseRes = await sparseClient.embedSparse(queryText);
        if (sparseRes.ok) {
          sparseVec = sparseRes.result;
        } else {
          log.warn(
            { error: sparseRes.error },
            "Sparse embedding failed; skipping sparse branch",
          );
        }
      }

      // 15. Build filter
      let filter = buildPostgresFilter(metadata);
      if (xFilterStr) {
        try {
          const parsedXFilter = JSON.parse(xFilterStr) as SearchFilter;
          filter = filter ? { ...filter, ...parsedXFilter } : parsedXFilter;
        } catch (err) {
          log.warn({ err }, "Failed to parse X-Filter header");
          res.status(400).json({ error: "Invalid JSON in X-Filter header" });
          return;
        }
      }
      if (xFilterV2Str) {
        try {
          const filterV2 = normalizeFilterV2(JSON.parse(xFilterV2Str));
          filter = { ...(filter ?? {}) };
          (filter as SearchFilter & { [FILTER_V2]?: typeof filterV2 })[FILTER_V2] = filterV2;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid filter";
          res.status(400).json({ error: `Invalid X-Filter-V2: ${message}` });
          return;
        }
      }

      // 16. Search
      const scope = accessScopeForRequest(req);
      const searchOffset = rerankActive ? 0 : offset;
      const searchResult = await postgresClient.search(
        body, // original query for PostgreSQL FTS/ts_rank (not HyDE text)
        vector,
        fetchLimit,
        collectionRaw,
        scope,
        filter,
        hybridRequested,
        includeAllVersions,
        searchOffset,
        candidateMultiplier,
        sparseVec,
        tagsFilter?.length ? tagsFilter : undefined,
        cursor,
        ftsOnly,
        xBaseRef,
        xPathPrefix,
      );
      if (!searchResult.ok) {
        const status =
          searchResult.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502;
        log.warn({ error: searchResult.error }, "Search failed");
        res.status(status).json({ error: searchResult.error.message });
        return;
      }

      // 17. Reranking
      let results = searchResult.result;

      if (rerankMode === "async" && rerankerClient !== null) {
        await runAsyncRerankStream(res, body, results, limit, {
          rerankerClient,
          candidateMultiplier,
          logger: log,
        });
        // Stats for async rerank: reranked=true since the stream always attempts reranking.
        postgresClient.recordSearchStat({
          tenantId: scope.tenantId!,
          collection: collectionRaw,
          query: body,
          durationMs: Date.now() - searchStartTime,
          resultsCount: Math.min(results.length, limit),
          hybridSearch: hybridRequested,
          reranked: true,
        });
        const asyncSlice = results.slice(0, limit);
        const usage = getUsageContext();
        emitActivity({
          id: newActivityId(),
          type: "search",
          status: "ok",
          summary: buildSearchSummary({
            query: body,
            collection: collectionRaw,
            mode: hybridRequested ? "hybrid" : ftsOnly ? "fts" : "dense",
            reranked: true,
            asyncRerank: true,
            results: asyncSlice,
            filter,
            tags: tagsFilter,
          }),
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - searchStartTime,
          detail: buildSearchDetail({
            results: asyncSlice,
            hybrid: hybridRequested,
            reranked: true,
            collection: collectionRaw,
            filter,
            tags: tagsFilter,
          }),
          usage: usage ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cost: usage.cost,
            modelCosts: usage.modelCosts,
          } : undefined,
        });
        return;
      }

      if (
        rerankMode === "sync" &&
        rerankerClient !== null &&
        results.length > 1
      ) {
        results = await rerankResults(rerankerClient, body, results, log);
      }

      // Group chunks into documents (best score wins, content merged dedup'd).
      if (groupByDocument) {
        results = groupResultsByDocument(results);
      }

      results = results.slice(0, limit);

      // Build next-page cursor from the last result (only when not reranking,
      // since reranking changes the order and makes keyset pagination unreliable).
      let nextCursor: string | undefined;
      if (!rerankActive && results.length === limit) {
        const last = results[results.length - 1];
        if (last) {
          // `score` is the value the query ordered by, so it completes the
          // keyset key. Without it the next page filters on `created` alone
          // against a relevance-ordered set and silently drops top hits.
          nextCursor = encodeCursor({
            created: last.created.toISOString(),
            id: last.id,
            score: last.score,
          });
        }
      }

      const response: Record<string, unknown> = { results };
      if (nextCursor) response["next_cursor"] = nextCursor;
      if (hydeExpanded) response["hyde_query"] = hydeExpanded;
      if (includeQueryVector) response["query_vector"] = vector;

      // Record search stats after reranking so the `reranked` flag is accurate.
      postgresClient.recordSearchStat({
        tenantId: scope.tenantId!,
        collection: collectionRaw,
        query: body,
        durationMs: Date.now() - searchStartTime,
        resultsCount: results.length,
        hybridSearch: hybridRequested,
        reranked: rerankActive,
      });

      const usage = getUsageContext();
      emitActivity({
        id: newActivityId(),
        type: "search",
        status: "ok",
        summary: buildSearchSummary({
          query: body,
          collection: collectionRaw,
          mode: ftsOnly ? "fts" : hybridRequested ? "hybrid" : "dense",
          reranked: rerankActive,
          results,
          filter,
          tags: tagsFilter,
        }),
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - searchStartTime,
        detail: buildSearchDetail({
          results,
          hybrid: hybridRequested,
          reranked: rerankActive,
          collection: collectionRaw,
          filter,
          tags: tagsFilter,
        }),
        usage: usage ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: usage.cost,
          modelCosts: usage.modelCosts,
        } : undefined,
      });

      if (usage) {
        res.setHeader("X-Usage-Input-Tokens", String(usage.inputTokens));
        res.setHeader("X-Usage-Output-Tokens", String(usage.outputTokens));
        res.setHeader("X-Usage-Total-Cost", String(usage.cost));
        response["usage"] = {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_cost: usage.cost,
          model_costs: usage.modelCosts,
        };
      }

      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  };
}

// ─── Reranking helper ─────────────────────────────────────────────────────────

export type RerankFallbackReason = "failed" | "empty-or-invalid" | null;

export interface RerankOutcome {
  results: SearchResult[];
  applied: boolean;
  complete: boolean;
  scoredCount: number;
  inputCount: number;
  fallbackReason: RerankFallbackReason;
}

export async function rerankResultsWithStatus(
  rerankerClient: RerankerClient,
  query: string,
  results: SearchResult[],
  logger: Logger,
): Promise<RerankOutcome> {
  const documents = results.map((r) => r.content);
  const rerankResponse = await rerankerClient.rerank(query, documents);

  if (!rerankResponse.ok) {
    logger.warn(
      { error: rerankResponse.error },
      "Reranking failed; falling back to vector-search order",
    );
    return {
      results,
      applied: false,
      complete: false,
      scoredCount: 0,
      inputCount: results.length,
      fallbackReason: "failed",
    };
  }

  const validScores = new Map<number, number>();
  for (const score of rerankResponse.result) {
    if (score.index >= 0 && score.index < results.length) {
      validScores.set(score.index, score.score);
    }
  }
  const reranked = Array.from(validScores, ([index, score]) => {
    const original = results[index] as SearchResult;
    return {
      ...original,
      score,
      vector_score:
        typeof original.score === "number"
          ? original.score
          : parseFloat(original.score as unknown as string),
    };
  }).sort((a, b) => b.score - a.score);

  if (reranked.length === 0) {
    logger.warn(
      "Reranking produced no scores; falling back to vector-search order",
    );
    return {
      results,
      applied: false,
      complete: false,
      scoredCount: 0,
      inputCount: results.length,
      fallbackReason: "empty-or-invalid",
    };
  }

  const complete = reranked.length === results.length;
  logger.debug(
    { count: reranked.length, inputCount: results.length, complete },
    "Reranked search results",
  );
  return {
    results: reranked,
    applied: true,
    complete,
    scoredCount: reranked.length,
    inputCount: results.length,
    fallbackReason: null,
  };
}

export async function rerankResults(
  rerankerClient: RerankerClient,
  query: string,
  results: SearchResult[],
  logger: Logger,
): Promise<SearchResult[]> {
  return (await rerankResultsWithStatus(rerankerClient, query, results, logger))
    .results;
}

// ─── Activity helpers ─────────────────────────────────────────────────────────

interface SearchActivityOptions {
  query: string;
  collection: string;
  mode: "hybrid" | "dense" | "fts";
  reranked: boolean;
  asyncRerank?: boolean;
  results: SearchResult[];
  filter?: SearchFilter | undefined;
  tags?: string[] | undefined;
}

/**
 * Format a score as a percentage string, e.g. 0.534 → "53.4%".
 * Values > 1 are treated as already-percentage (PostgreSQL FTS/ts_rank / RRF can exceed 1).
 */
function fmtScore(v: number): string {
  const pct = v <= 1 ? v * 100 : v;
  return pct.toFixed(1) + "%";
}

/**
 * Build the one-line activity summary for a search operation.
 *
 * Example outputs:
 *   "hallo" in clientdocs [hybrid, V:53.4% F:18.2% R:78.5%]
 *   "hallo" [dense, V:72.1%]
 *   "hallo" [fts, F:45.0%]
 */
export function buildSearchSummary(opts: SearchActivityOptions): string {
  const { query, collection, mode, reranked, asyncRerank, results } = opts;
  const truncated =
    '"' + query.slice(0, 80) + (query.length > 80 ? "…" : "") + '"';
  const colPart = collection !== "documents" ? " in " + collection : "";

  // Compute best scores across all returned results.
  let bestVector: number | undefined;
  let bestText: number | undefined;
  let bestRerank: number | undefined;

  for (const r of results) {
    if (r.vector_score != null && (bestVector == null || r.vector_score > bestVector))
      bestVector = r.vector_score;
    if (r.text_score != null && (bestText == null || r.text_score > bestText))
      bestText = r.text_score;
    // After reranking `score` holds the reranker score; `vector_score` is the
    // pre-rerank vector score saved by rerankResults().
    if (reranked && (bestRerank == null || r.score > bestRerank))
      bestRerank = r.score;
  }

  const scoreParts: string[] = [];
  if (mode !== "fts" && bestVector != null) scoreParts.push("V:" + fmtScore(bestVector));
  if (mode !== "dense" && bestText != null)  scoreParts.push("F:" + fmtScore(bestText));
  if (reranked && bestRerank != null)        scoreParts.push("R:" + fmtScore(bestRerank));

  const modePart = mode + (asyncRerank ? ", async-rerank" : reranked ? ", rerank" : "");
  const scoreStr = scoreParts.length > 0 ? " " + scoreParts.join(" ") : "";

  return truncated + colPart + " [" + modePart + scoreStr + "]";
}

/**
 * Build the structured detail payload for a search activity event.
 */
export function buildSearchDetail(opts: {
  results: SearchResult[];
  hybrid: boolean;
  reranked: boolean;
  collection: string;
  filter?: SearchFilter | undefined;
  tags?: string[] | undefined;
  source?: string;
}): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    results: opts.results.length,
    hybrid: opts.hybrid,
    reranked: opts.reranked,
    collection: opts.collection,
  };
  if (opts.source) detail["source"] = opts.source;
  if (opts.tags && opts.tags.length > 0) detail["tags"] = opts.tags;
  if (opts.filter && Object.keys(opts.filter).length > 0)
    detail["filter"] = opts.filter;
  return detail;
}

// ─── Filter builder ───────────────────────────────────────────────────────────

export function buildPostgresFilter(
  metadata: Metadata,
): SearchFilter | undefined {
  const entries = Object.entries(metadata).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return undefined;

  const filter: SearchFilter = {};
  for (const [key, value] of entries) {
    filter[key] = value;
  }
  return filter;
}

// ─── Document grouping ────────────────────────────────────────────────────────

/**
 * Collapse chunk-level results into one result per document (base_ref).
 *
 * - Score: the highest chunk score of the document.
 * - Content: all chunk contents concatenated in chunk_index order, with
 *   overlapping regions deduplicated (overlap_start / overlap_end from
 *   ChunkInfo are used when available; otherwise a longest-common-suffix
 *   heuristic is applied).
 * - All other fields (reference, metadata, title, …) are taken from the
 *   highest-scoring chunk so the representative chunk "wins".
 * - The final array is sorted by document score descending.
 */
export function groupResultsByDocument(results: SearchResult[]): SearchResult[] {
  // Group by base_ref, preserving the order chunks were returned in.
  const groups = new Map<string, SearchResult[]>();
  for (const r of results) {
    const key = r.base_ref || r.reference;
    const existing = groups.get(key);
    if (existing) {
      existing.push(r);
    } else {
      groups.set(key, [r]);
    }
  }

  const docs: SearchResult[] = [];

  for (const chunks of groups.values()) {
    // Sort chunks by chunk_index so we assemble content in document order.
    const sorted = [...chunks].sort((a, b) => {
      const ia = a.chunk?.chunk_index ?? 0;
      const ib = b.chunk?.chunk_index ?? 0;
      return ia - ib;
    });

    // Best score (max across all chunks of this document).
    const bestScore = Math.max(...chunks.map((c) => c.score));
    // Representative chunk: the one with the highest score.
    const rep = chunks.reduce((best, c) => (c.score > best.score ? c : best));

    // Merge content, trimming overlapping regions between adjacent chunks.
    let merged = sorted[0]?.content ?? "";
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      const nextContent = curr.content;

      // How many chars of overlap exist at the end of `prev` / start of `curr`?
      // Prefer the explicit metadata; fall back to a suffix-match heuristic.
      const overlapChars = resolveOverlap(prev, curr);

      if (overlapChars > 0 && merged.endsWith(nextContent.slice(0, overlapChars))) {
        // The overlap region is already present at the tail of `merged`.
        merged += nextContent.slice(overlapChars);
      } else {
        // No clean overlap match — just append with a newline separator.
        merged += "\n" + nextContent;
      }
    }

    docs.push({
      ...rep,
      score: bestScore,
      content: merged,
    });
  }

  // Sort by document score descending (preserves relative ranking).
  docs.sort((a, b) => b.score - a.score);
  return docs;
}

/**
 * Determine how many characters of overlap exist between the end of `prev`
 * and the beginning of `curr`.
 *
 * 1. If both chunks have explicit ChunkInfo with overlap values, use those.
 * 2. Otherwise try a longest-common-suffix match (capped at 512 chars) to
 *    handle cases where ChunkInfo is absent or the overlap was rounded.
 */
function resolveOverlap(prev: SearchResult, curr: SearchResult): number {
  // Explicit metadata path. The chunker adjusts BOTH sides of a shared
  // boundary independently, so the duplicated region between two ADJACENT
  // chunks is the SUM of prev's forward extension and curr's backward
  // extension. (For non-adjacent retrieved chunks the sum won't match the
  // text, and the caller's endsWith() check falls back to a separator.)
  const prevEnd   = prev.chunk?.chunk_overlap_end;
  const currStart = curr.chunk?.chunk_overlap_start;
  const combined  = (prevEnd ?? 0) + (currStart ?? 0);
  if (combined > 0) return combined;

  // Heuristic: find the longest suffix of prev.content that is a prefix of curr.content.
  const MAX_PROBE = 512;
  const prevContent = prev.content;
  const currContent = curr.content;
  const probeLen = Math.min(MAX_PROBE, prevContent.length, currContent.length);

  for (let len = probeLen; len >= 16; len--) {
    if (prevContent.endsWith(currContent.slice(0, len))) {
      return len;
    }
  }
  return 0;
}
