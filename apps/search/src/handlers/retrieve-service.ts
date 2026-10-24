// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The retrieval collaborators of `retrieve_for_answer`, wired to the real
 * pipeline. Shared by the MCP tool and `POST /v2/retrieve`, so both answer the
 * same question the same way.
 *
 * Each sub-question runs through the ordinary retrieval pipeline — embedding,
 * hybrid candidates, the caller's access scope and filters — without rerank,
 * grouping or diversification; fusion, de-duplication, the optional rerank
 * against the original question and the token packing happen in
 * `retrieve-for-answer.ts`.
 */

import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import type { DecomposeClient } from "../decompose-client.js";
import { prepareFtsContent } from "../postgres-client.js";
import type { SearchFilter } from "../postgres-client.js";
import type { SearchResult } from "../pg-types.js";
import {
  heuristicTokenCount,
  type TokenCounter,
} from "../token-counter.js";
import {
  rerankStage,
  runRetrievalPipeline,
  type RetrievalClients,
} from "./retrieval-pipeline.js";
import {
  retrieveForAnswer,
  type DecompositionMethod,
  type RetrieveForAnswerDeps,
  type RetrieveForAnswerOutput,
} from "../retrieve-for-answer.js";

export interface RetrieveRequest {
  question: string;
  collection: string;
  scope: AccessScope;
  budgetTokens?: number | undefined;
  maxSubqueries?: number | undefined;
  filter?: SearchFilter | undefined;
  pathPrefix?: string | undefined;
  /** RFC 3339 instant (already parsed to the canonical string the pipeline takes). */
  validAt?: string | undefined;
  includeAllVersions?: boolean | undefined;
  hybrid: boolean;
  candidateMultiplier: number;
  /** `"llm"` asks the decomposition model first; anything else uses the rules. */
  decomposition?: DecompositionMethod | undefined;
}

export interface RetrieveServiceClients extends RetrievalClients {
  tokenCounter?: TokenCounter | null;
  /** Model-based question decomposition; null/absent = rules only. */
  decomposeClient?: DecomposeClient | null;
}

/** The pipeline-backed collaborators of {@link retrieveForAnswer} for one request. */
export function retrieveDeps(
  clients: RetrieveServiceClients,
  logger: Logger,
  req: RetrieveRequest,
): RetrieveForAnswerDeps {
  const { tokenCounter = null } = clients;
  return {
    async search(query: string, limit: number): Promise<SearchResult[]> {
      const pipeline = await runRetrievalPipeline(clients, logger, {
        query,
        embedText: prepareFtsContent(query) || query,
        collection: req.collection,
        scope: req.scope,
        ...(req.filter !== undefined ? { filter: req.filter } : {}),
        limit,
        fetchLimit: limit,
        hybrid: req.hybrid,
        includeAllVersions: req.includeAllVersions ?? false,
        offset: 0,
        candidateMultiplier: req.candidateMultiplier,
        ftsOnly: false,
        ...(req.pathPrefix !== undefined ? { pathPrefix: req.pathPrefix } : {}),
        ...(req.validAt !== undefined ? { validAt: req.validAt } : {}),
        logSparseFailure: false,
        rerank: { active: false },
        documentGroups: false,
        legacyGroupByDocument: false,
        diversify: "none",
        groupBy: "none",
        minScore: null,
        resolveFigures: false,
      });
      return pipeline.results;
    },
    ...(clients.rerankerClient
      ? {
          async rerank(question: string, results: SearchResult[]): Promise<SearchResult[] | undefined> {
            const staged = await rerankStage(clients, question, results, logger, {
              active: true,
              tokenCounter,
              minResults: 2,
            });
            return staged.outcome?.applied ? staged.results : undefined;
          },
        }
      : {}),
    ...(clients.decomposeClient
      ? {
          decompose: (
            question: string,
            maxSubqueries: number,
            tenantId?: string,
          ): Promise<string[] | undefined> => {
            const decomposeClient = clients.decomposeClient;
            if (decomposeClient == null) return Promise.resolve(undefined);
            return decomposeClient.decompose(question, maxSubqueries, tenantId);
          },
        }
      : {}),
    countTokens: async (text: string): Promise<number> =>
      tokenCounter !== null ? tokenCounter.count(text) : heuristicTokenCount(text),
  };
}

export async function runRetrieveForAnswer(
  clients: RetrieveServiceClients,
  logger: Logger,
  req: RetrieveRequest,
): Promise<RetrieveForAnswerOutput> {
  return retrieveForAnswer(retrieveDeps(clients, logger, req), {
    question: req.question,
    budgetTokens: req.budgetTokens,
    maxSubqueries: req.maxSubqueries,
    decomposition: req.decomposition,
    tenantId: req.scope.tenantId,
  });
}
