// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { parseRfc3339DateTime } from "../rfc3339.js";
import {
  AccessDeniedError,
  accessScopeForRequest,
  requireCollectionAccess,
} from "../access-scope.js";
import type { EmbeddingClient } from "../embedding-client.js";
import type { PostgresClient } from "../postgres-client.js";
import {
  calculateRetrievalMetrics,
  buildEvaluationReport,
  type EvaluationQrel,
} from "../retrieval-evaluation.js";

const MAX_QUERIES = 100;
const MAX_QRELS_PER_QUERY = 100;
const MAX_TOTAL_QRELS = 2_000;
const MAX_ID_LENGTH = 256;
const MAX_QUERY_LENGTH = 8_192;
const MAX_REFERENCE_LENGTH = 2_048;
const MAX_DATASET_VERSION_LENGTH = 128;
const DEFAULT_DEADLINE_MS = 60_000;
const MAX_DEADLINE_MS = 300_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

interface EvaluationItem {
  id: string;
  query: string;
  qrels: EvaluationQrel[];
}

interface EvaluationOptions {
  hybridSearch: boolean;
  candidateMultiplier: number;
}

interface EvaluationFailure {
  status: number;
  error: string;
}

function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseBaseline(value: unknown):
  | {
      min_recall_at_k?: number;
      min_mrr?: number;
      min_ndcg_at_k?: number;
    }
  | undefined
  | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const knownKeys = [
    "min_recall_at_k",
    "min_mrr",
    "min_ndcg_at_k",
  ] as const;
  const suppliedKeys = Object.keys(raw);
  if (
    suppliedKeys.length === 0 ||
    suppliedKeys.some(
      (key) => !(knownKeys as readonly string[]).includes(key),
    )
  ) {
    return null;
  }
  const parsed: Record<string, number> = {};
  for (const key of knownKeys) {
    const threshold = raw[key];
    if (threshold === undefined) continue;
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    ) {
      return null;
    }
    parsed[key] = threshold;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

/** POST /evaluations/retrieval. Qrels remain in-memory and are never logged. */
export function createRetrievalEvaluationHandler(
  embeddingClient: EmbeddingClient,
  postgresClient: PostgresClient,
  logger: Logger,
  defaults: EvaluationOptions = { hybridSearch: true, candidateMultiplier: 4 },
): RequestHandler {
  return async (req, res, next) => {
    try {
      const scope = accessScopeForRequest(req);
      if (!scope.tenantId) {
        res.status(403).json({
          error: "A verified tenant claim is required for retrieval evaluation",
          code: "TENANT_REQUIRED",
        });
        return;
      }

      const body =
        typeof req.body === "object" && req.body !== null
          ? (req.body as Record<string, unknown>)
          : {};
      // Collection is required and canonical for both authorization and query.
      // X-Collection is deliberately ignored on this endpoint.
      const collection =
        typeof body["collection"] === "string"
          ? body["collection"].trim()
          : "";
      const suppliedK = typeof body["k"] === "number" && Number.isInteger(body["k"])
        ? body["k"] as number
        : undefined;
      const rawCutoffs = body["cutoffs"];
      const cutoffs = rawCutoffs === undefined
        ? (suppliedK === undefined ? [10, 20, 50] : [suppliedK])
        : Array.isArray(rawCutoffs)
          ? [...new Set(rawCutoffs)]
          : [];
      const validCutoffs = cutoffs.every((cutoff) => typeof cutoff === "number" && Number.isInteger(cutoff) && cutoff >= 1 && cutoff <= 100);
      const k = suppliedK ?? 10;
      const maxCutoff = validCutoffs && cutoffs.length > 0 ? Math.max(...cutoffs as number[]) : 0;
      const items = body["queries"];
      if (
        !collection ||
        k < 1 ||
        k > 100 ||
        !validCutoffs ||
        cutoffs.length === 0 ||
        !Array.isArray(items) ||
        items.length === 0 ||
        items.length > MAX_QUERIES
      ) {
        res.status(400).json({
          error: "collection, cutoffs (or compatible k; each 1..100), and 1..100 queries are required",
        });
        return;
      }

      try {
        await requireCollectionAccess(postgresClient, collection, scope);
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          res.status(403).json({
            error: "Access denied to evaluation collection",
            code: "AUTH_SCOPE_DENIED",
          });
          return;
        }
        throw error;
      }

      const parsed: EvaluationItem[] = [];
      let totalQrels = 0;
      for (const raw of items) {
        const item = raw as Record<string, unknown>;
        if (
          !item ||
          typeof item["id"] !== "string" ||
          !item["id"].trim() ||
          item["id"].trim().length > MAX_ID_LENGTH ||
          typeof item["query"] !== "string" ||
          !item["query"].trim() ||
          item["query"].trim().length > MAX_QUERY_LENGTH ||
          !Array.isArray(item["qrels"]) ||
          item["qrels"].length === 0 ||
          item["qrels"].length > MAX_QRELS_PER_QUERY
        ) {
          res.status(400).json({
            error:
              "Each query requires bounded non-empty id, query, and 1..100 qrels",
          });
          return;
        }
        totalQrels += item["qrels"].length;
        if (totalQrels > MAX_TOTAL_QRELS) {
          res.status(400).json({
            error: `Evaluation exceeds ${MAX_TOTAL_QRELS} total qrels`,
          });
          return;
        }
        const qrels: EvaluationQrel[] = [];
        for (const rawQrel of item["qrels"]) {
          if (typeof rawQrel !== "object" || rawQrel === null) {
            res.status(400).json({
              error:
                "Each qrel requires a bounded reference and optional non-negative numeric relevance",
            });
            return;
          }
          const qrel = rawQrel as Record<string, unknown>;
          const reference =
            typeof qrel["reference"] === "string"
              ? qrel["reference"].trim()
              : "";
          const relevance = qrel["relevance"];
          if (
            !reference ||
            reference.length > MAX_REFERENCE_LENGTH ||
            (relevance !== undefined &&
              (typeof relevance !== "number" ||
                !Number.isFinite(relevance) ||
                relevance < 0))
          ) {
            res.status(400).json({
              error:
                "Each qrel requires a bounded reference and optional non-negative numeric relevance",
            });
            return;
          }
          qrels.push({
            reference,
            relevance: typeof relevance === "number" ? relevance : 1,
          });
        }
        parsed.push({
          id: item["id"].trim(),
          query: item["query"].trim(),
          qrels,
        });
      }

      const requestedDeadline =
        typeof body["deadline_ms"] === "number" &&
        Number.isInteger(body["deadline_ms"])
          ? body["deadline_ms"]
          : DEFAULT_DEADLINE_MS;
      if (requestedDeadline < 1 || requestedDeadline > MAX_DEADLINE_MS) {
        res.status(400).json({
          error: `deadline_ms must be 1..${MAX_DEADLINE_MS}`,
        });
        return;
      }
      const requestedConcurrency =
        typeof body["concurrency"] === "number" &&
        Number.isInteger(body["concurrency"])
          ? body["concurrency"]
          : DEFAULT_CONCURRENCY;
      if (
        requestedConcurrency < 1 ||
        requestedConcurrency > MAX_CONCURRENCY
      ) {
        res.status(400).json({
          error: `concurrency must be 1..${MAX_CONCURRENCY}`,
        });
        return;
      }
      const hybrid =
        typeof body["hybrid"] === "boolean"
          ? body["hybrid"]
          : defaults.hybridSearch;
      const includeAllVersions = body["include_all_versions"] === true;
      let validAt: string | undefined;
      try {
        validAt = parseRfc3339DateTime(body["valid_at"]);
      } catch (error) {
        res.status(400).json({ error: `valid_at ${(error as Error).message}` });
        return;
      }
      const candidateMultiplier =
        typeof body["candidate_multiplier"] === "number" &&
        Number.isInteger(body["candidate_multiplier"])
          ? body["candidate_multiplier"]
          : defaults.candidateMultiplier;
      if (candidateMultiplier < 1 || candidateMultiplier > 20) {
        res.status(400).json({ error: "candidate_multiplier must be 1..20" });
        return;
      }
      const datasetVersion =
        typeof body["dataset_version"] === "string"
          ? body["dataset_version"].trim()
          : "";
      if (datasetVersion.length > MAX_DATASET_VERSION_LENGTH) {
        res.status(400).json({
          error: `dataset_version must be at most ${MAX_DATASET_VERSION_LENGTH} characters`,
        });
        return;
      }
      const baseline = parseBaseline(body["baseline"]);
      if (baseline === null) {
        res.status(400).json({
          error: "baseline thresholds must be finite numbers between 0 and 1",
        });
        return;
      }

      const controller = new AbortController();
      const deadlineAt = Date.now() + requestedDeadline;
      let deadlineExceeded = false;
      const onAborted = (): void => controller.abort();
      req.once("aborted", onAborted);
      const deadlineTimer = setTimeout(() => {
        deadlineExceeded = true;
        controller.abort();
      }, requestedDeadline);

      const evaluated: Array<
        | { id: string; qrels: EvaluationQrel[]; retrieved: string[]; scores: number[] }
        | undefined
      > = new Array(parsed.length);
      let cursor = 0;
      let failure: EvaluationFailure | undefined;
      const worker = async (): Promise<void> => {
        while (!failure && !controller.signal.aborted) {
          const index = cursor++;
          if (index >= parsed.length) return;
          const item = parsed[index]!;
          const embedded = await embeddingClient.embed(
            item.query,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (!embedded.ok) {
            failure = {
              status: 502,
              error: "Embedding failed during evaluation",
            };
            controller.abort();
            return;
          }
          const found = await postgresClient.search(
            item.query,
            embedded.result.vector,
            maxCutoff,
            collection,
            scope,
            undefined,
            hybrid,
            includeAllVersions,
            0,
            candidateMultiplier,
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            undefined,
            Math.max(1, deadlineAt - Date.now()),
            controller.signal,
            undefined,
            validAt,
          );
          if (controller.signal.aborted) return;
          if (!found.ok) {
            failure = {
              status:
                found.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502,
              error: found.error.message,
            };
            controller.abort();
            return;
          }
          const uniqueRetrieved = new Map<string, number>();
          for (const result of found.result) {
            const reference = result.base_ref || result.reference;
            if (!uniqueRetrieved.has(reference)) uniqueRetrieved.set(reference, result.score);
          }
          evaluated[index] = {
            id: item.id,
            qrels: item.qrels,
            retrieved: [...uniqueRetrieved.keys()],
            scores: [...uniqueRetrieved.values()],
          };
        }
      };

      try {
        await Promise.all(
          Array.from(
            { length: Math.min(requestedConcurrency, parsed.length) },
            worker,
          ),
        );
      } finally {
        clearTimeout(deadlineTimer);
        req.off("aborted", onAborted);
      }

      if (req.aborted || res.destroyed) return;
      if (deadlineExceeded) {
        res.status(408).json({ error: "Evaluation deadline exceeded" });
        return;
      }
      if (failure) {
        res.status(failure.status).json({ error: failure.error });
        return;
      }

      const complete = evaluated.filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      );
      const metrics = calculateRetrievalMetrics(complete, k);
      const report = buildEvaluationReport(complete, cutoffs as number[]);
      const parameters = {
        k,
        cutoffs: cutoffs as number[],
        max_cutoff: maxCutoff,
        hybrid,
        include_all_versions: includeAllVersions,
        valid_at: validAt ?? null,
        candidate_multiplier: candidateMultiplier,
      };
      const dataset = {
        version: datasetVersion || null,
        hash: stableJsonHash(parsed),
      };
      const thresholds = baseline
        ? {
            recall_at_k:
              baseline.min_recall_at_k === undefined ||
              metrics.recallAtK >= baseline.min_recall_at_k,
            mrr:
              baseline.min_mrr === undefined || metrics.mrr >= baseline.min_mrr,
            ndcg_at_k:
              baseline.min_ndcg_at_k === undefined ||
              metrics.ndcgAtK >= baseline.min_ndcg_at_k,
          }
        : undefined;
      const releaseGate = thresholds
        ? { passed: Object.values(thresholds).every(Boolean), thresholds }
        : undefined;
      logger.info(
        {
          collection,
          tenantId: scope.tenantId,
          queryCount: parsed.length,
          parameters,
          datasetHash: dataset.hash,
          releaseGatePassed: releaseGate?.passed,
        },
        "Retrieval evaluation completed",
      );
      res.status(200).json({
        status: "ok",
        collection,
        parameters,
        dataset,
        metrics: {
          recall_at_k: metrics.recallAtK,
          mrr: metrics.mrr,
          ndcg_at_k: metrics.ndcgAtK,
          evaluated_queries: metrics.evaluatedQueries,
          skipped_queries: metrics.skippedQueries,
        },
        metrics_by_cutoff: Object.fromEntries(
          Object.entries(report.metricsByCutoff).map(([cutoff, value]) => [cutoff, {
            recall: value.recallAtK,
            mrr: value.mrr,
            ndcg: value.ndcgAtK,
            evaluated_queries: value.evaluatedQueries,
            skipped_queries: value.skippedQueries,
          }]),
        ),
        queries: report.queries,
        score_statistics: report.scoreStatistics,
        ...(releaseGate ? { release_gate: releaseGate } : {}),
      });
    } catch (error) {
      next(error);
    }
  };
}
