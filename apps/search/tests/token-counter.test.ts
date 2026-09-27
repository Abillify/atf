// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/token-counter.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import pino from "pino";
import {
  createTokenCounter,
  deriveTokenizeUrl,
  heuristicTokenCount,
  parseTokenizeResponse,
  type FetchLike,
} from "../src/token-counter.js";

const logger = pino({ level: "silent" });

/** Build a TEI-shaped token object array of a given length. */
function teiTokens(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    text: `t${i}`,
    start: i,
    stop: i + 1,
    special: false,
  }));
}

/** A stubbed fetch that returns a JSON body with HTTP 200. */
function okFetch(body: unknown): { fn: FetchLike; calls: () => number } {
  let calls = 0;
  const fn: FetchLike = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => "",
    };
  };
  return { fn, calls: () => calls };
}

describe("deriveTokenizeUrl", () => {
  it("reuses the origin and replaces the path with /tokenize", () => {
    expect(deriveTokenizeUrl("http://tei:8080/v1/embeddings")).toBe(
      "http://tei:8080/tokenize",
    );
    expect(deriveTokenizeUrl("http://tei:8080/embed")).toBe(
      "http://tei:8080/tokenize",
    );
    expect(deriveTokenizeUrl("https://host:443/a/b?x=1#h")).toBe(
      "https://host/tokenize",
    );
  });

  it("returns null for bedrock and unparseable URLs", () => {
    expect(deriveTokenizeUrl("bedrock")).toBeNull();
    expect(deriveTokenizeUrl("bedrock://us-east-1")).toBeNull();
    expect(deriveTokenizeUrl("")).toBeNull();
    expect(deriveTokenizeUrl("not a url")).toBeNull();
  });
});

describe("heuristicTokenCount", () => {
  it("is ceil(length/4) and zero for empty", () => {
    expect(heuristicTokenCount("")).toBe(0);
    expect(heuristicTokenCount("abcd")).toBe(1);
    expect(heuristicTokenCount("abcde")).toBe(2);
  });
});

describe("parseTokenizeResponse", () => {
  it("parses nested batch shape", () => {
    expect(
      parseTokenizeResponse([teiTokens(3), teiTokens(2)], 2),
    ).toEqual([3, 2]);
  });
  it("parses single-input nested shape", () => {
    expect(parseTokenizeResponse([teiTokens(5)], 1)).toEqual([5]);
  });
  it("parses flat token array for a single input", () => {
    expect(parseTokenizeResponse(teiTokens(4), 1)).toEqual([4]);
  });
  it("rejects a flat array when more than one input expected", () => {
    expect(parseTokenizeResponse(teiTokens(4), 2)).toBeNull();
  });
  it("rejects count mismatches and non-arrays", () => {
    expect(parseTokenizeResponse([teiTokens(3)], 2)).toBeNull();
    expect(parseTokenizeResponse({ tokens: [] }, 1)).toBeNull();
    expect(parseTokenizeResponse(null, 1)).toBeNull();
  });
});

describe("createTokenCounter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("(a) counts via TEI /tokenize as tokens.length", async () => {
    // Validates: Requirements 11.2
    const { fn } = okFetch([teiTokens(7)]);
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fn,
    });
    expect(await counter.count("hello world")).toBe(7);
  });

  it("sends the text to the tokenize URL with the inputs field", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fn: FetchLike = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse((init?.body as string) ?? "{}");
      return { ok: true, status: 200, json: async () => [teiTokens(3)], text: async () => "" };
    };
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fn,
    });
    await counter.count("abc");
    expect(seenUrl).toBe("http://tei:8080/tokenize");
    expect(seenBody).toEqual({ inputs: "abc" });
  });

  it("(b) serves a repeated count from cache without re-fetching", async () => {
    // Validates: Requirements 11.2
    const { fn, calls } = okFetch([teiTokens(9)]);
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fn,
    });
    expect(await counter.count("same text")).toBe(9);
    expect(await counter.count("same text")).toBe(9);
    expect(calls()).toBe(1);
    expect(counter.cacheSize).toBe(1);
  });

  it("(c) falls back to the heuristic on a TEI error, without throwing", async () => {
    // Validates: Requirements 11.2
    const fn: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fn,
    });
    const text = "x".repeat(40);
    await expect(counter.count(text)).resolves.toBe(heuristicTokenCount(text));
  });

  it("(c) falls back to the heuristic on an HTTP error", async () => {
    const fn: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    });
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fn,
    });
    const text = "abcdefgh";
    expect(await counter.count(text)).toBe(heuristicTokenCount(text));
  });

  it("(c) falls back to the heuristic on an unrecognised response shape", async () => {
    const { fn } = okFetch({ unexpected: true });
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fn,
    });
    const text = "abcdefgh";
    expect(await counter.count(text)).toBe(heuristicTokenCount(text));
  });

  it("(d) uses the heuristic directly when disabled, without any fetch", async () => {
    // Validates: Requirements 11.2
    const fetchSpy = vi.fn();
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: false,
      logger,
      fetchImpl: fetchSpy as unknown as FetchLike,
    });
    const text = "abcdefghij";
    expect(await counter.count(text)).toBe(heuristicTokenCount(text));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("(e) evicts the least-recently-used entry when the cache bound is exceeded", async () => {
    // Cache size 2: after counting three distinct texts only two remain.
    const fn: FetchLike = async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const input = body.inputs as string;
      return {
        ok: true,
        status: 200,
        json: async () => [teiTokens(input.length)],
        text: async () => "",
      };
    };
    let callCount = 0;
    const countingFn: FetchLike = async (url, init) => {
      callCount++;
      return fn(url, init);
    };
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      cacheSize: 2,
      fetchImpl: countingFn,
    });
    await counter.count("a"); // -> cache [a]
    await counter.count("bb"); // -> cache [a, bb]
    await counter.count("ccc"); // -> evicts a -> cache [bb, ccc]
    expect(counter.cacheSize).toBe(2);
    expect(callCount).toBe(3);
    // "a" was evicted: counting it again re-fetches.
    await counter.count("a");
    expect(callCount).toBe(4);
    // "bb" and "ccc" are still cached: no new fetch.
    await counter.count("ccc");
    expect(callCount).toBe(4);
  });

  it("batches misses in a single call and serves cache hits without re-fetching", async () => {
    let calls = 0;
    let lastBody: unknown;
    const fn: FetchLike = async (_url, init) => {
      calls++;
      lastBody = JSON.parse((init?.body as string) ?? "{}");
      const raw = (lastBody as { inputs: string | string[] }).inputs;
      // TEI accepts both a scalar and an array; the client sends a scalar for a
      // single input. Mirror that: respond with one token row per input.
      const inputs = Array.isArray(raw) ? raw : [raw];
      return {
        ok: true,
        status: 200,
        json: async () => inputs.map((s) => teiTokens(s.length)),
        text: async () => "",
      };
    };
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fn,
    });
    expect(await counter.countBatch(["a", "bb", "ccc"])).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
    // Second batch: "bb" is cached, only "dddd" is a miss.
    expect(await counter.countBatch(["bb", "dddd"])).toEqual([2, 4]);
    expect(calls).toBe(2);
    expect(lastBody).toEqual({ inputs: "dddd" });
  });

  it("uses the real globalThis.fetch when no fetchImpl is injected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [teiTokens(11)],
        text: async () => "",
      }),
    );
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
    });
    expect(await counter.count("via global fetch")).toBe(11);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://tei:8080/tokenize",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns an empty array for an empty batch without fetching", async () => {
    const fetchSpy = vi.fn();
    const counter = createTokenCounter({
      tokenizeUrl: "http://tei:8080/tokenize",
      enabled: true,
      logger,
      fetchImpl: fetchSpy as unknown as FetchLike,
    });
    expect(await counter.countBatch([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Live integration test — self-skips unless TOKENIZE_LIVE_URL is set ────────
const liveUrl = process.env["TOKENIZE_LIVE_URL"];
describe.skipIf(!liveUrl)("token-counter live TEI integration", () => {
  it("counts tokens against a real TEI /tokenize endpoint", async () => {
    const counter = createTokenCounter({
      tokenizeUrl: liveUrl as string,
      enabled: true,
      logger,
    });
    const n = await counter.count("What is Deep Learning?");
    expect(n).toBeGreaterThan(0);
  });
});
