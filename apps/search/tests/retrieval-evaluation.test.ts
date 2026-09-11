// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { calculateRetrievalMetrics } from "../src/retrieval-evaluation.js";

describe("retrieval evaluation metrics", () => {
  it("computes deterministic document-level Recall@k, MRR and graded nDCG", () => {
    expect(calculateRetrievalMetrics([
      { id: "q1", qrels: [{ reference: "a", relevance: 3 }, { reference: "b", relevance: 1 }], retrieved: ["a", "a", "x", "b"] },
      { id: "q2", qrels: [{ reference: "c", relevance: 1 }], retrieved: ["x", "c"] },
    ], 3)).toEqual({ recallAtK: 1, mrr: 0.75, ndcgAtK: 0.806885990739, evaluatedQueries: 2, skippedQueries: 0 });
  });
  it("skips qrel-less rows and never divides by zero", () => {
    expect(calculateRetrievalMetrics([{ id: "empty", qrels: [], retrieved: ["a"] }], 10)).toEqual({ recallAtK: 0, mrr: 0, ndcgAtK: 0, evaluatedQueries: 0, skippedQueries: 1 });
  });
});


import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { createRetrievalEvaluationHandler } from "../src/handlers/evaluation.js";
import type { EmbeddingClient } from "../src/embedding-client.js";
import type { PostgresClient } from "../src/postgres-client.js";

async function invokeEvaluation(body: Record<string, unknown>, headerCollection = "header_collection") {
  const collections: string[] = [];
  const searchCalls: unknown[][] = [];
  const postgres = {
    getCollectionAcl: async (collection: string) => {
      collections.push(`acl:${collection}`);
      return { ok: true as const, result: { allowedUsers: [], allowedGroups: [] } };
    },
    search: async (...args: unknown[]) => {
      const collection = args[3] as string;
      searchCalls.push(args);
      collections.push(`search:${collection}`);
      return { ok: true as const, result: [] };
    },
  } as unknown as PostgresClient;
  const embedding = {
    embed: async () => ({ ok: true as const, result: { vector: [1, 0] } }),
  } as unknown as EmbeddingClient;
  const handler = createRetrievalEvaluationHandler(
    embedding,
    postgres,
    { info: () => undefined } as unknown as Logger,
  );
  const req = Object.assign(new EventEmitter(), {
    body,
    aborted: false,
    headers: { "x-collection": headerCollection },
    principal: {
      userId: "alice",
      userGroups: [],
      tenantId: "tenant-a",
      scopes: ["vectorsearch.read"],
      source: "jwt" as const,
    },
  }) as unknown as Request;
  let payload: unknown;
  const response = {
    statusCode: 200,
    destroyed: false,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { payload = value; return this; },
  } as unknown as Response;
  let forwarded: unknown;
  await Promise.resolve(handler(req, response, (error?: unknown) => { forwarded = error; }));
  return { status: response.statusCode, payload, collections, searchCalls, forwarded };
}

describe("retrieval evaluation boundary", () => {
  it("authorizes and searches exactly body.collection, ignoring X-Collection", async () => {
    const result = await invokeEvaluation({
      collection: "body_collection",
      queries: [{ id: "q1", query: "needle", qrels: [{ reference: "doc" }] }],
    });
    expect(result.forwarded).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.collections).toEqual(["acl:body_collection", "search:body_collection"]);
  });

  it("forwards and reports the normalized temporal retrieval contract", async () => {
    const result = await invokeEvaluation({
      collection: "documents",
      include_all_versions: true,
      valid_at: "2026-03-01T12:00:00+01:00",
      queries: [{ id: "q1", query: "needle", qrels: [{ reference: "doc" }] }],
    });
    expect(result.status).toBe(200);
    expect(result.searchCalls[0]?.[7]).toBe(true);
    expect(result.searchCalls[0]?.[19]).toBe("2026-03-01T11:00:00.000Z");
    expect(result.payload).toMatchObject({ parameters: { include_all_versions: true, valid_at: "2026-03-01T11:00:00.000Z" } });
  });

  it("rejects offset-less valid_at", async () => {
    const result = await invokeEvaluation({
      collection: "documents",
      valid_at: "2026-03-01T12:00:00",
      queries: [{ id: "q1", query: "needle", qrels: [{ reference: "doc" }] }],
    });
    expect(result.status).toBe(400);
  });

  it("requires an explicit canonical body collection", async () => {
    const result = await invokeEvaluation({
      queries: [{ id: "q1", query: "needle", qrels: [{ reference: "doc" }] }],
    });
    expect(result.status).toBe(400);
    expect(result.collections).toEqual([]);
  });

  it("rejects non-finite or out-of-range release thresholds", async () => {
    const result = await invokeEvaluation({
      collection: "documents",
      baseline: { min_mrr: 2 },
      queries: [{ id: "q1", query: "needle", qrels: [{ reference: "doc" }] }],
    });
    expect(result.status).toBe(400);
  });
});