// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * token-counter.ts
 *
 * Measures the token count of a string as seen by the embedding model's
 * tokenizer (bge-m3 behind EMBED_URL), so the unit builder can size
 * chunks to the 350–500-token target of Requirement 11.2.
 *
 * Token counting is a MEASUREMENT, not a hard dependency. The primary path asks
 * TEI's `POST /tokenize` endpoint for the exact tokenization; if TEI is
 * unreachable, errors, times out, or the backend has no `/tokenize` (e.g.
 * Bedrock, or a disabled/non-TEI embedding server), the counter degrades to a
 * character-based heuristic. It NEVER throws: a TEI outage lowers accuracy, it
 * does not fail ingest.
 *
 * A bounded in-process LRU cache keyed by the input text avoids re-hitting TEI
 * for the same chunk/header text repeatedly during a single ingest.
 *
 * The HTTP transport mirrors the conventions of embedding-client.ts /
 * reranker-client.ts (trace-header injection, AbortController timeout, tolerant
 * response parsing) and the `fetch` call is injectable so the cache, fallback
 * and parsing are unit-testable with a stubbed fetch.
 */

import type pino from "pino";
import { injectTraceHeaders } from "./trace-context.js";

/**
 * Character-based token estimate used when TEI tokenization is unavailable.
 *
 * Mirrors the `Math.ceil(text.length / 4)` heuristic already used across
 * embedding-client.ts / reranker-client.ts for input-token estimation: on
 * average a token is roughly four characters of general text. It is a coarse
 * upper-ish approximation, never exact, but it is deterministic and cheap and
 * never throws. Exported so callers (and tests) can reason about the fallback
 * explicitly.
 */
export function heuristicTokenCount(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Injectable fetch signature so tests can stub `globalThis.fetch`. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface TokenCounterConfig {
  /**
   * Full URL of the TEI `/tokenize` endpoint (e.g.
   * "http://localhost:8080/tokenize"). When derived from EMBED_URL the origin
   * is reused and the path replaced with `/tokenize` (see {@link deriveTokenizeUrl}).
   */
  tokenizeUrl: string;
  /**
   * When false the counter never calls TEI and always uses the heuristic. Set
   * this for backends without a `/tokenize` endpoint (Bedrock) or when TEI
   * tokenization is intentionally disabled.
   */
  enabled: boolean;
  logger: pino.Logger;
  /** Abort the tokenize call after this many ms. 0 disables the timeout. Default: 5 000. */
  timeoutMs?: number;
  /** Maximum number of distinct texts held in the LRU cache. 0 disables caching. Default: 2 048. */
  cacheSize?: number;
  /**
   * JSON field used to pass text to TEI. TEI expects "inputs". Default: "inputs".
   */
  inputField?: string;
  /** Optional correlation-ID accessor, forwarded as X-Request-Id (mirrors embedding-client). */
  getRequestId?: () => string | undefined;
  /** Injectable fetch. Defaults to `globalThis.fetch`. Present for testing. */
  fetchImpl?: FetchLike;
}

export interface TokenCounter {
  /**
   * Return the number of tokens in `text` as measured by the embedding model's
   * tokenizer, falling back to the heuristic when TEI is unavailable. Never throws.
   */
  count(text: string, signal?: AbortSignal): Promise<number>;
  /**
   * Count several texts. Uses a single batched `/tokenize` call when possible,
   * serving cached entries without a round-trip. Order matches the input. Never throws.
   */
  countBatch(texts: string[], signal?: AbortSignal): Promise<number[]>;
  /** Current number of cached entries (for tests/metrics). */
  readonly cacheSize: number;
}

/**
 * Derive a TEI `/tokenize` URL from an embeddings URL by reusing the origin and
 * replacing the path. `http://tei:8080/v1/embeddings` and `http://tei:8080/embed`
 * both become `http://tei:8080/tokenize`.
 *
 * Returns null when no TEI tokenize endpoint applies: a `bedrock…` pseudo-URL
 * (no HTTP tokenizer) or an unparseable URL. Callers treat null as "disabled →
 * use the heuristic".
 */
export function deriveTokenizeUrl(embedUrl: string): string | null {
  if (!embedUrl) return null;
  if (embedUrl.startsWith("bedrock")) return null;
  try {
    const parsed = new URL(embedUrl);
    parsed.pathname = "/tokenize";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

// ─── Bounded LRU cache (Map preserves insertion order) ────────────────────────

class LRUCache<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const val = this.store.get(key);
    if (val === undefined) return undefined;
    // Re-insert to mark most-recently-used.
    this.store.delete(key);
    this.store.set(key, val);
    return val;
  }

  set(key: K, val: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, val);
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Parse a TEI `/tokenize` response into a token count per input.
 *
 * TEI returns an array with one entry per input; each entry is an array of
 * token objects (`{ id, text, start, stop, special }`). The token COUNT is that
 * inner array's length. We tolerate:
 *   - nested batch shape:  [[t,t,t], [t,t]]              → [3, 2]
 *   - single-input nested: [[t,t,t]]                     → [3]
 *   - a flat token array for a single input: [t,t,t]     → [3]
 *
 * Returns null when the shape is not recognisable, so the caller falls back to
 * the heuristic rather than trusting a bogus count.
 */
export function parseTokenizeResponse(
  data: unknown,
  expectedCount: number,
): number[] | null {
  if (!Array.isArray(data)) return null;

  const isTokenObject = (x: unknown): boolean =>
    typeof x === "object" && x !== null && !Array.isArray(x);

  // Flat array of token objects → a single input's tokens.
  if (data.length > 0 && data.every((el) => isTokenObject(el))) {
    if (expectedCount === 1) return [data.length];
    return null;
  }

  // Nested: one array of tokens per input.
  if (data.every((el) => Array.isArray(el))) {
    const counts = (data as unknown[][]).map((row) => row.length);
    if (counts.length !== expectedCount) return null;
    return counts;
  }

  // Empty top-level array: only meaningful for an empty batch.
  if (data.length === 0 && expectedCount === 0) return [];

  return null;
}

export function createTokenCounter(config: TokenCounterConfig): TokenCounter {
  const {
    tokenizeUrl,
    enabled,
    logger,
    timeoutMs = 5_000,
    cacheSize = 2_048,
    inputField = "inputs",
    getRequestId,
    fetchImpl,
  } = config;

  const cache = cacheSize > 0 ? new LRUCache<string, number>(cacheSize) : null;

  /**
   * Call TEI `/tokenize` for a batch of inputs. Returns per-input counts on
   * success, or null on any failure (unreachable, timeout, HTTP error, invalid
   * body). NEVER throws — a null return means "use the heuristic".
   */
  async function tokenizeViaTei(
    inputs: string[],
    externalSignal?: AbortSignal,
  ): Promise<number[] | null> {
    if (!enabled) return null;
    if (inputs.length === 0) return [];

    const fetchFn = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchFn !== "function") return null;

    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    const timer =
      timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const reqId = getRequestId?.();
      if (reqId) headers["X-Request-Id"] = reqId;
      injectTraceHeaders(headers);

      // TEI accepts a single string or an array for `inputs`. Send a string for
      // a single input so servers that only accept the scalar shape still work.
      const payload =
        inputs.length === 1 ? { [inputField]: inputs[0] } : { [inputField]: inputs };

      const response = await fetchFn(tokenizeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger.debug(
          { status: response.status, body: body.slice(0, 200) },
          "TEI tokenize returned HTTP error; using heuristic",
        );
        return null;
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (cause) {
        logger.debug({ cause }, "TEI tokenize returned invalid JSON; using heuristic");
        return null;
      }

      const counts = parseTokenizeResponse(data, inputs.length);
      if (counts === null) {
        logger.debug(
          { sample: JSON.stringify(data).slice(0, 200) },
          "TEI tokenize response shape not recognised; using heuristic",
        );
        return null;
      }
      return counts;
    } catch (cause) {
      const isTimeout = cause instanceof Error && cause.name === "AbortError";
      logger.debug(
        { cause, isTimeout },
        isTimeout
          ? "TEI tokenize timed out; using heuristic"
          : "TEI tokenize unreachable; using heuristic",
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function count(text: string, signal?: AbortSignal): Promise<number> {
    const cached = cache?.get(text);
    if (cached !== undefined) return cached;

    const teiCounts = await tokenizeViaTei([text], signal);
    const result =
      teiCounts && teiCounts.length === 1 && typeof teiCounts[0] === "number"
        ? (teiCounts[0] as number)
        : heuristicTokenCount(text);

    cache?.set(text, result);
    return result;
  }

  async function countBatch(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (texts.length === 0) return [];

    // Serve cache hits directly; only ask TEI for the misses.
    const results = new Array<number>(texts.length);
    const missIndexes: number[] = [];
    const missTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] as string;
      const hit = cache?.get(text);
      if (hit !== undefined) {
        results[i] = hit;
      } else {
        missIndexes.push(i);
        missTexts.push(text);
      }
    }

    if (missTexts.length === 0) return results;

    const teiCounts = await tokenizeViaTei(missTexts, signal);
    for (let j = 0; j < missTexts.length; j++) {
      const text = missTexts[j] as string;
      const teiCount = teiCounts?.[j];
      const value =
        typeof teiCount === "number" ? teiCount : heuristicTokenCount(text);
      const idx = missIndexes[j] as number;
      results[idx] = value;
      cache?.set(text, value);
    }
    return results;
  }

  return {
    count,
    countBatch,
    get cacheSize(): number {
      return cache?.size ?? 0;
    },
  };
}
