// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Reranker batching: a long candidate list is split into requests of
 * `RERANK_BATCH_SIZE` documents (it was a hard-coded 16 that no setting
 * reached), and `RERANK_BATCH_CONCURRENCY` of them run at once instead of
 * 100 hits costing ⌈100/16⌉ serial round-trips. Scores must still land on the
 * right documents, and the first failing batch still fails the whole call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createRerankerClient } from "../src/reranker-client.js";

const logger = pino({ level: "silent" });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(extra: { batchSize?: number; batchConcurrency?: number } = {}) {
  return createRerankerClient({
    rerankUrl: "http://rerank.test/rerank",
    rerankModel: "m",
    separator: "\n",
    endpoint: "rerank",
    logger,
    ...extra,
  });
}

/**
 * A reranker whose score for a document is the number in it / 1000, so a
 * wrongly attributed score is visible. Records request sizes and concurrency.
 */
function installFetch(options: { failOnCall?: number; delayMs?: number } = {}) {
  const requestSizes: number[] = [];
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    const callNo = calls;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const body = JSON.parse(String(init?.body)) as { texts: string[] };
    requestSizes.push(body.texts.length);
    await new Promise((r) => setTimeout(r, options.delayMs ?? 5));
    inFlight -= 1;
    if (options.failOnCall === callNo) {
      return new Response("boom", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        results: body.texts.map((doc, index) => ({
          index,
          relevance_score: Number(doc.replace(/\D/g, "")) / 1000,
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return {
    requestSizes,
    peak: () => peak,
    calls: () => calls,
  };
}

const docs = (n: number) => Array.from({ length: n }, (_, i) => `doc ${i}`);

describe("createRerankerClient · batching", () => {
  it("splits at the configured batch size (not a hard-coded 16)", async () => {
    const seen = installFetch();
    const res = await client({ batchSize: 4, batchConcurrency: 1 }).rerank("q", docs(10));
    expect(res.ok).toBe(true);
    expect(seen.requestSizes).toEqual([4, 4, 2]);
  });

  it("defaults to batches of 16", async () => {
    const seen = installFetch();
    await client().rerank("q", docs(40));
    expect(seen.requestSizes.sort((a, b) => b - a)).toEqual([16, 16, 8]);
  });

  it("runs the batches concurrently up to the configured limit", async () => {
    const seen = installFetch({ delayMs: 20 });
    await client({ batchSize: 2, batchConcurrency: 3 }).rerank("q", docs(20));
    expect(seen.calls()).toBe(10);
    expect(seen.peak()).toBeGreaterThan(1);
    expect(seen.peak()).toBeLessThanOrEqual(3);
  });

  it("concurrency 1 is strictly sequential, as before", async () => {
    const seen = installFetch({ delayMs: 10 });
    await client({ batchSize: 2, batchConcurrency: 1 }).rerank("q", docs(8));
    expect(seen.peak()).toBe(1);
  });

  it("maps every score back to its own document across batches", async () => {
    installFetch({ delayMs: 15 });
    const res = await client({ batchSize: 3, batchConcurrency: 4 }).rerank("q", docs(11));
    if (!res.ok) throw new Error("expected ok");
    const byIndex = new Map(res.result.map((s) => [s.index, s.score]));
    expect(byIndex.size).toBe(11);
    for (let i = 0; i < 11; i++) {
      // The fake scores doc i with i/1000; the transform keeps the ordering.
      expect(byIndex.has(i)).toBe(true);
    }
    const ordered = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
    const sorted = [...ordered].sort((a, b) => a - b);
    expect(ordered).toEqual(sorted);
  });

  it("the first failing batch fails the whole call", async () => {
    installFetch({ failOnCall: 2 });
    const res = await client({ batchSize: 2, batchConcurrency: 1 }).rerank("q", docs(8));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("RERANK_HTTP_ERROR");
  });

  it("a failure with concurrent batches still fails the call and starts no further batches afterwards", async () => {
    const seen = installFetch({ failOnCall: 1, delayMs: 20 });
    const res = await client({ batchSize: 1, batchConcurrency: 2 }).rerank("q", docs(12));
    expect(res.ok).toBe(false);
    // Two were in flight when the first failed; the rest never started.
    expect(seen.calls()).toBeLessThan(12);
  });

  it("a list that fits in one batch is a single request", async () => {
    const seen = installFetch();
    await client({ batchSize: 16 }).rerank("q", docs(16));
    expect(seen.requestSizes).toEqual([16]);
  });
});
