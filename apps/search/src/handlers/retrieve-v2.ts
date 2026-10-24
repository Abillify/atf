// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/retrieve-v2.ts
 *
 * POST /v2/retrieve — answer-ready retrieval over HTTP. The same operation as
 * the MCP tool `retrieve_for_answer` (see `retrieve-for-answer.ts`), behind the
 * same auth / tenant / collection-ACL chain as `/v2/search`.
 *
 * Request (JSON):
 *   {
 *     "question": "…",                 // required, cut at SEARCH_MAX_QUERY_CHARS
 *     "budget_tokens": 4000,           // 256..32000
 *     "max_subqueries": 4,             // 1..6, the original question included
 *     "filter": { "product": "acme" }, // metadata equality
 *     "path_prefix": "/Unterlagen",
 *     "valid_at": "2026-03-01T00:00:00Z",
 *     "include_all_versions": false
 *   }
 *
 * The collection comes from the `X-Collection` header like on every v2 route
 * (`documents` by default); `X-Valid-At` works as on `/v2/search`. A body
 * `collection` is accepted only when it equals the header, because the ACL
 * check ran for the header's collection.
 */

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { accessScopeForRequest } from "../access-scope.js";
import type { DecomposeClient } from "../decompose-client.js";
import { aggregateTrustLabels, trustLabels } from "../content-trust.js";
import type { EmbeddingClient } from "../embedding-client.js";
import type { Metadata } from "../metadata.js";
import { getPrincipal } from "../request-principal.js";
import { readHeader } from "../header-utils.js";
import { clampQuery, DEFAULT_MAX_QUERY_CHARS } from "../query-limits.js";
import type { PostgresClient, SearchFilter } from "../postgres-client.js";
import { normalizePathPrefix } from "../postgres-client.js";
import type { QueryEmbeddingCache } from "../query-cache.js";
import type { RerankerClient } from "../reranker-client.js";
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_SUBQUERIES,
} from "../retrieve-for-answer.js";
import { parseRfc3339DateTime } from "../rfc3339.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { TokenCounter } from "../token-counter.js";
import { CandidateSearchError, EmbeddingFailedError } from "./retrieval-pipeline.js";
import { runRetrieveForAnswer } from "./retrieve-service.js";

export interface RetrieveV2HandlerOptions {
  rerankerClient?: RerankerClient | null;
  candidateMultiplier?: number;
  hybridSearch?: boolean;
  sparseClient?: SparseEmbeddingClient | null;
  queryCache?: QueryEmbeddingCache | null;
  tokenCounter?: TokenCounter | null;
  /** Model-based question decomposition; null/absent = rules only. */
  decomposeClient?: DecomposeClient | null;
  /** SEARCH_MAX_QUERY_CHARS: an over-long question is cut at the last space before it. */
  maxQueryChars?: number;
}

/** A validation failure carrying the HTTP 400 message. */
class BadRequest extends Error {}

function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function createRetrieveV2Handler(
  embeddingClient: EmbeddingClient,
  postgresClient: PostgresClient,
  logger: Logger,
  options: RetrieveV2HandlerOptions = {},
): RequestHandler {
  const rerankerClient = options.rerankerClient ?? null;
  const candidateMultiplier = options.candidateMultiplier ?? 4;
  const hybrid = options.hybridSearch ?? true;
  const sparseClient = options.sparseClient ?? null;
  const queryCache = options.queryCache ?? null;
  const tokenCounter = options.tokenCounter ?? null;
  const decomposeClient = options.decomposeClient ?? null;
  const maxQueryChars = options.maxQueryChars ?? DEFAULT_MAX_QUERY_CHARS;

  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const started = Date.now();
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body !== "object" || Array.isArray(body)) {
        res.status(400).json({ error: "Request body must be a JSON object" });
        return;
      }
      const collection = readHeader(req, "x-collection") || "documents";

      let question: string;
      let questionTruncated = false;
      let budgetTokens: number | undefined;
      let maxSubqueries: number | undefined;
      let pathPrefix: string | undefined;
      let filter: SearchFilter | undefined;
      let validAt: string | undefined;
      let decomposition: "rules" | "llm" | undefined;
      try {
        if (typeof body.question !== "string" || body.question.trim() === "") {
          throw new BadRequest("question must be a non-empty string");
        }
        const clamped = clampQuery(body.question, maxQueryChars);
        question = clamped.query;
        questionTruncated = clamped.truncated;
        budgetTokens = optionalInt(body.budget_tokens, "budget_tokens", 256, 32000);
        maxSubqueries = optionalInt(body.max_subqueries, "max_subqueries", 1, 6);
        if (body.collection !== undefined && body.collection !== collection) {
          throw new BadRequest("collection must match the X-Collection header (default: documents)");
        }
        if (body.path_prefix !== undefined) {
          if (typeof body.path_prefix !== "string") throw new BadRequest("path_prefix must be a string");
          pathPrefix = normalizePathPrefix(body.path_prefix);
        }
        if (body.include_all_versions !== undefined && typeof body.include_all_versions !== "boolean") {
          throw new BadRequest("include_all_versions must be a boolean");
        }
        if (body.decomposition !== undefined) {
          if (body.decomposition !== "rules" && body.decomposition !== "llm") {
            throw new BadRequest('decomposition must be "rules" or "llm"');
          }
          decomposition = body.decomposition;
        }
        if (body.filter !== undefined && body.filter !== null) {
          if (typeof body.filter !== "object" || Array.isArray(body.filter)) {
            throw new BadRequest("filter must be an object");
          }
        }
        const metadata: Metadata = (res.locals as { metadata?: Metadata }).metadata ?? {};
        const metaEntries = Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null);
        const merged = {
          ...(metaEntries.length > 0 ? Object.fromEntries(metaEntries) : {}),
          ...((body.filter as SearchFilter | undefined) ?? {}),
        };
        if (Object.keys(merged).length > 0) filter = merged;
        // valid_at: the body field, else the X-Valid-At header (as on /v2/search).
        const rawValidAt =
          typeof body.valid_at === "string" ? body.valid_at : readHeader(req, "x-valid-at");
        validAt = parseRfc3339DateTime(rawValidAt);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }

      const scope = accessScopeForRequest(req);
      const { userId, userGroups } = getPrincipal(req);
      // Data minimisation: no question text and no identity in operator logs.
      log.info(
        {
          questionLength: question.length,
          collection,
          budgetTokens: budgetTokens ?? DEFAULT_BUDGET_TOKENS,
          maxSubqueries: maxSubqueries ?? DEFAULT_MAX_SUBQUERIES,
          authenticatedUser: userId !== undefined,
          userGroupCount: userGroups?.length ?? 0,
        },
        "Incoming v2 retrieve",
      );

      let out: Awaited<ReturnType<typeof runRetrieveForAnswer>>;
      try {
        out = await runRetrieveForAnswer(
          { embeddingClient, postgresClient, queryCache, sparseClient, rerankerClient, tokenCounter, decomposeClient },
          log,
          {
            question,
            collection,
            scope,
            budgetTokens,
            maxSubqueries,
            decomposition,
            filter,
            pathPrefix,
            validAt,
            includeAllVersions: body.include_all_versions === true,
            hybrid,
            candidateMultiplier,
          },
        );
      } catch (err) {
        if (err instanceof EmbeddingFailedError) {
          log.warn({ err }, "v2 retrieve embedding failed");
          res.status(502).json({ error: `Embedding failed: ${err.message}` });
          return;
        }
        if (err instanceof CandidateSearchError) {
          const status =
            err.code === "INVALID_COLLECTION_NAME" ? 400 : err.code === "COLLECTION_NOT_FOUND" ? 404 : 502;
          log.warn({ error: err.message }, "v2 retrieve search failed");
          res.status(status).json({ error: err.message });
          return;
        }
        throw err;
      }

      if (scope.tenantId) {
        postgresClient.recordSearchStat({
          tenantId: scope.tenantId,
          collection,
          query: question,
          durationMs: Date.now() - started,
          resultsCount: out.evidence.length,
          hybridSearch: hybrid,
          reranked: out.reranked,
        });
      }

      // Retrieved text is untrusted data; injection_risk is a heuristic hint.
      const evidence = out.evidence.map((item) => ({ ...item, ...trustLabels(item.content) }));
      res.status(200).json({
        ...out,
        evidence,
        ...(questionTruncated ? { query_truncated: true } : {}),
        ...aggregateTrustLabels(evidence.map((item) => item.injection_risk)),
      });
    } catch (err) {
      next(err);
    }
  };
}
