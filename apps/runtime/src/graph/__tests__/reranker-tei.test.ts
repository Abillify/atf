// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Tests for the TEI reranker client (`TeiReranker`) and the strict
 * `rerankOrThrow` contract of the fallback chain.
 *
 * TEI rejects `/rerank` requests above its `max_client_batch_size` (default 32)
 * with HTTP 422. The client must split larger inputs, merge the per-batch
 * indices back to global input indices, and surface failures instead of
 * silently returning `[]` from the strict path.
 */
import { describe, expect, test } from "bun:test";
import {
  BedrockReranker,
  createReranker,
  DEFAULT_TEI_BATCH_SIZE,
  FallbackReranker,
  RerankError,
  TeiReranker,
  type Reranker,
  type RerankHit,
} from "../reranker.js";
import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";

interface CapturedRequest {
  texts: string[];
  top_n: number;
  query: string;
}

/** Fake TEI: scores each text by a numeric suffix and records requests. */
function fakeTei(options: {
  failOnRequest?: number;
  status?: number;
  payload?: (texts: string[]) => unknown;
} = {}): { fetchFn: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    requests.push(body);
    if (options.failOnRequest === requests.length) {
      return new Response("batch size exceeds max_client_batch_size", {
        status: options.status ?? 422,
      });
    }
    const payload =
      options.payload?.(body.texts) ??
      body.texts.map((text, index) => ({
        index,
        score: Number(text.replace(/\D/g, "")) / 1000,
      }));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

function recordingLogger(): { logger: Logger; warns: Array<{ message: string; fields: unknown }> } {
  const warns: Array<{ message: string; fields: unknown }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, fields) => {
      warns.push({ message, fields });
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

const texts = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `doc ${i}`);

describe("TeiReranker batching", () => {
  test("70 texts at batch size 32 → 3 requests (32/32/6), global indices, global topN", async () => {
    const { fetchFn, requests } = fakeTei();
    const tei = new TeiReranker("http://tei/rerank", "m", undefined, 1000, fetchFn, 32);
    const hits = await tei.rerankOrThrow("q", texts(70), 5);
    expect(requests.map((r) => r.texts.length)).toEqual([32, 32, 6]);
    expect(requests.map((r) => r.top_n)).toEqual([32, 32, 6]);
    // Score = index/1000, so the globally best are the highest indices.
    expect(hits.map((h) => h.index)).toEqual([69, 68, 67, 66, 65]);
    expect(hits[0]?.score).toBeCloseTo(0.069);
  });

  test("returns all hits sorted when topN covers the input", async () => {
    const { fetchFn } = fakeTei();
    const tei = new TeiReranker("http://tei/rerank", "m", undefined, 1000, fetchFn, 4);
    const hits = await tei.rerank("q", texts(10), 10);
    expect(hits).toHaveLength(10);
    expect(new Set(hits.map((h) => h.index)).size).toBe(10);
    expect(hits.map((h) => h.index)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  test("HTTP 422 in batch 2: rerank logs status + batch index and returns []; rerankOrThrow throws", async () => {
    const { logger, warns } = recordingLogger();
    const lenient = new TeiReranker(
      "http://tei/rerank",
      "m",
      logger,
      1000,
      fakeTei({ failOnRequest: 2 }).fetchFn,
      32,
    );
    expect(await lenient.rerank("q", texts(70), 70)).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({
      status: 422,
      batch_index: 1,
      batch_size: 32,
      error_kind: "http",
    });

    const strict = new TeiReranker(
      "http://tei/rerank",
      "m",
      undefined,
      1000,
      fakeTei({ failOnRequest: 2 }).fetchFn,
      32,
    );
    const error = await strict.rerankOrThrow("q", texts(70), 70).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RerankError);
    expect(error).toMatchObject({ kind: "http", status: 422, batchIndex: 1 });
    expect((error as RerankError).detail).toContain("max_client_batch_size");
  });

  test("non-array payload and out-of-batch index → invalid_response", async () => {
    const nonArray = new TeiReranker(
      "http://tei/rerank",
      "m",
      undefined,
      1000,
      fakeTei({ payload: () => ({ error: "nope" }) }).fetchFn,
    );
    await expect(nonArray.rerankOrThrow("q", texts(3), 3)).rejects.toMatchObject({
      kind: "invalid_response",
    });

    // Index 5 is a valid GLOBAL index but outside the 4-text batch.
    const outOfBatch = new TeiReranker(
      "http://tei/rerank",
      "m",
      undefined,
      1000,
      fakeTei({ payload: () => [{ index: 5, score: 0.5 }] }).fetchFn,
      4,
    );
    await expect(outOfBatch.rerankOrThrow("q", texts(8), 8)).rejects.toMatchObject({
      kind: "invalid_response",
      batchIndex: 0,
    });
  });

  test("network error → kind network", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const tei = new TeiReranker("http://tei/rerank", "m", undefined, 1000, fetchFn);
    await expect(tei.rerankOrThrow("q", texts(2), 2)).rejects.toMatchObject({
      kind: "network",
    });
  });

  test("empty query or documents → [] without fetch", async () => {
    const { fetchFn, requests } = fakeTei();
    const tei = new TeiReranker("http://tei/rerank", "m", undefined, 1000, fetchFn);
    expect(await tei.rerankOrThrow("  ", texts(3), 3)).toEqual([]);
    expect(await tei.rerankOrThrow("q", [], 3)).toEqual([]);
    expect(await tei.rerank("q", texts(3), 0)).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe("createReranker batch size", () => {
  const base = {
    rerankUrl: "http://tei/rerank",
    rerankModel: "BAAI/bge-reranker-v2-m3",
  } as unknown as AppConfig;

  test("passes rerankBatchSize through to the TEI client", () => {
    const reranker = createReranker({ ...base, rerankBatchSize: 8 } as AppConfig);
    expect(reranker).toBeInstanceOf(TeiReranker);
    expect((reranker as TeiReranker).batchSize).toBe(8);
  });

  test("defaults to 32 without RERANK_BATCH_SIZE", () => {
    const reranker = createReranker(base);
    expect((reranker as TeiReranker).batchSize).toBe(DEFAULT_TEI_BATCH_SIZE);
    expect(DEFAULT_TEI_BATCH_SIZE).toBe(32);
  });
});

describe("FallbackReranker.rerankOrThrow", () => {
  const ok: RerankHit[] = [{ index: 0, score: 0.9 }];
  const throwing: Reranker = {
    rerank: async () => [],
    rerankOrThrow: async () => {
      throw new RerankError("http", "down", { status: 503 });
    },
  };
  const working: Reranker = {
    rerank: async () => ok,
    rerankOrThrow: async () => ok,
  };

  test("primary throws → secondary result", async () => {
    const chain = new FallbackReranker(throwing, working);
    expect(await chain.rerankOrThrow("q", ["a"], 1)).toEqual(ok);
  });

  test("both throw → throws", async () => {
    const chain = new FallbackReranker(throwing, throwing);
    await expect(chain.rerankOrThrow("q", ["a"], 1)).rejects.toBeInstanceOf(
      RerankError,
    );
  });

  test("lenient-only secondary with no hits counts as failure", async () => {
    const lenientEmpty: Reranker = { rerank: async () => [] };
    const chain = new FallbackReranker(throwing, lenientEmpty);
    await expect(chain.rerankOrThrow("q", ["a"], 1)).rejects.toBeInstanceOf(
      RerankError,
    );
  });
});

/** Fake TEI whose requests hang until their signal aborts; records signals. */
function hangingTei(options: { answerFirst?: number; delayMs?: number } = {}): {
  fetchFn: typeof fetch;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    const answer = (): Response =>
      new Response(
        JSON.stringify(body.texts.map((_, index) => ({ index, score: 0.5 }))),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    if (options.answerFirst !== undefined && signals.length <= options.answerFirst) {
      return answer();
    }
    return new Promise<Response>((resolve, reject) => {
      const timer =
        options.delayMs !== undefined
          ? setTimeout(() => resolve(answer()), options.delayMs)
          : undefined;
      signal.addEventListener(
        "abort",
        () => {
          if (timer !== undefined) clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
  return { fetchFn, signals };
}

describe("TeiReranker abort and total deadline", () => {
  test("caller abort cancels the in-flight batch and starts no further batch", async () => {
    const { fetchFn, signals } = hangingTei({ answerFirst: 1 });
    const tei = new TeiReranker("http://tei/rerank", "m", undefined, 10_000, fetchFn, 4);
    const controller = new AbortController();
    const pending = tei.rerankOrThrow("q", texts(12), 12, {
      signal: controller.signal,
    });
    await Bun.sleep(20);
    expect(signals).toHaveLength(2);
    controller.abort();
    const error = await pending.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RerankError);
    expect(error).toMatchObject({ kind: "aborted", batchIndex: 1 });
    expect(signals[1]?.aborted).toBe(true);
    await Bun.sleep(10);
    expect(signals).toHaveLength(2);
  });

  test("an already aborted signal sends no request", async () => {
    const { fetchFn, signals } = hangingTei();
    const tei = new TeiReranker("http://tei/rerank", "m", undefined, 10_000, fetchFn);
    await expect(
      tei.rerankOrThrow("q", texts(3), 3, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(signals).toHaveLength(0);
  });

  test("total deadline bounds sequential batches; lenient rerank returns [] quickly", async () => {
    // 4 batches of 30 ms each would take 120 ms; the total deadline is 50 ms.
    const strict = new TeiReranker(
      "http://tei/rerank",
      "m",
      undefined,
      10_000,
      hangingTei({ delayMs: 30 }).fetchFn,
      2,
      50,
    );
    const error = await strict.rerankOrThrow("q", texts(8), 8).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as RerankError).message).toContain("total deadline of 50 ms");

    const { logger, warns } = recordingLogger();
    const lenient = new TeiReranker(
      "http://tei/rerank",
      "m",
      logger,
      10_000,
      hangingTei({ delayMs: 30 }).fetchFn,
      2,
      50,
    );
    const started = Date.now();
    expect(await lenient.rerank("q", texts(8), 8)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(100);
    expect(warns[0]?.fields).toMatchObject({ error_kind: "timeout" });
  });

  test("batch timer keeps the per-batch timeout message", async () => {
    const tei = new TeiReranker(
      "http://tei/rerank",
      "m",
      undefined,
      20,
      hangingTei().fetchFn,
      4,
      10_000,
    );
    await expect(tei.rerankOrThrow("q", texts(2), 2)).rejects.toMatchObject({
      kind: "timeout",
      message: expect.stringContaining("timed out after 20 ms"),
    });
  });
});

describe("FallbackReranker.pinBackend", () => {
  const ok: RerankHit[] = [{ index: 0, score: 0.9 }];
  function scripted(results: Array<"ok" | "fail">): Reranker & { calls: number } {
    const backend = {
      calls: 0,
      rerank: async () => [] as RerankHit[],
      rerankOrThrow: async () => {
        const result = results[backend.calls] ?? "ok";
        backend.calls += 1;
        if (result === "fail") throw new RerankError("http", "down", { status: 503 });
        return ok;
      },
    };
    return backend;
  }

  test("primary pinned by call 1: a primary failure in call 2 throws, secondary untouched", async () => {
    const primary = scripted(["ok", "fail"]);
    const secondary = scripted([]);
    const session = new FallbackReranker(primary, secondary).pinBackend();
    expect(await session.rerankOrThrow?.("q", ["a"], 1)).toEqual(ok);
    await expect(session.rerankOrThrow?.("q", ["a"], 1)).rejects.toBeInstanceOf(
      RerankError,
    );
    expect(primary.calls).toBe(2);
    expect(secondary.calls).toBe(0);
  });

  test("primary fails in call 1: secondary pinned, call 2 only hits secondary", async () => {
    const { logger, warns } = recordingLogger();
    const primary = scripted(["fail", "ok"]);
    const secondary = scripted([]);
    const session = new FallbackReranker(primary, secondary, logger).pinBackend();
    expect(await session.rerankOrThrow?.("q", ["a"], 1)).toEqual(ok);
    expect(await session.rerankOrThrow?.("q", ["a"], 1)).toEqual(ok);
    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(2);
    expect(warns.some((w) => w.message.includes("pinned to the Bedrock fallback"))).toBe(
      true,
    );
  });

  test("a caller abort on the primary never falls through to the secondary", async () => {
    const secondary = scripted([]);
    const primary: Reranker = {
      rerank: async () => [],
      rerankOrThrow: async () => {
        throw new RerankError("aborted", "aborted");
      },
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      new FallbackReranker(primary, secondary).rerankOrThrow("q", ["a"], 1, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(secondary.calls).toBe(0);
  });
});

describe("BedrockReranker abort signal", () => {
  test("passes the caller signal as abortSignal and maps an abort to kind aborted", async () => {
    const sendOptions: unknown[] = [];
    const controller = new AbortController();
    const client = {
      send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
        sendOptions.push(options);
        controller.abort();
        throw new Error("Request aborted");
      },
    };
    const bedrock = new BedrockReranker(
      client as unknown as ConstructorParameters<typeof BedrockReranker>[0],
      "arn:aws:bedrock:eu-central-1::foundation-model/cohere.rerank-v3-5:0",
    );
    await expect(
      bedrock.rerankOrThrow("q", ["a"], 1, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(sendOptions[0]).toEqual({ abortSignal: controller.signal });
  });
});
