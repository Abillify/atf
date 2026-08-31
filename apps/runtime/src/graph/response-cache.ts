// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Response cache (`src/graph/response-cache.ts`)
 *
 * Exact-match caching of LLM node responses. When an LLM node is deterministic
 * (no tools, temperature 0 or unset) the generated text + token usage can be
 * reused for an identical request, which removes a provider round-trip — a
 * direct latency and cost win for repeated prompts (FAQ-style traffic, retries,
 * idempotent agent steps).
 *
 * The cache is keyed by a SHA-256 digest over the effective request
 * (provider, model, sampling params, full message list). The key function is a
 * pure, exported helper so it is unit-testable without a store.
 *
 * Two backends are provided behind a single {@link CacheStore} contract:
 *   - {@link InMemoryCacheStore}: bounded LRU + TTL, per-replica (default).
 *   - {@link RedisCacheStore}: shared across replicas when REDIS_URL is set.
 *
 * Caching is OPTIONAL and OFF by default; enabling it never changes correctness
 * for non-deterministic nodes because those are not cacheable.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { ModelMessage } from "ai";
import type { Logger } from "../observability/logger.js";
import { createRedisClient } from "../util/redis-client.js";
import type { Store as GenericStore } from "../db/store/index.js";

// ---------------------------------------------------------------------------
// Cached value + store contract
// ---------------------------------------------------------------------------

export interface CachedResponse {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Pluggable cache backend. */
export interface CacheStore {
  get(key: string): Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
  /** Best-effort size (entries) — used for diagnostics/tests. */
  size?(): number;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Key derivation (pure)
// ---------------------------------------------------------------------------

export interface CacheKeyInput {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  messages: ModelMessage[];
  /**
   * Tenant/client isolation scope. REQUIRED whenever the platform runs
   * multi-tenant (i.e. whenever `RequestContext.clientId` can be populated).
   * Mixed into the key so a cache hit can never cross tenants — without this a
   * response (including any RAG/grounding context it embeds) generated for one
   * tenant could be served verbatim to another. Use the fixed sentinel
   * {@link SINGLE_TENANT_SCOPE} for genuinely single-tenant deployments; never
   * pass `undefined` silently, since that would namespace every tenant into the
   * same bucket.
   */
  tenantScope: string;
}

/**
 * Sentinel scope for deployments that do not have multi-tenancy configured at
 * all (no `clientId` ever populated). Using a fixed, explicit sentinel — rather
 * than `""` or `undefined` — makes the "no tenant scoping in effect" case a
 * conscious, greppable value instead of an accidental default.
 */
export const SINGLE_TENANT_SCOPE = "__single_tenant__";

/**
 * Deterministic SHA-256 cache key over the effective request. Identical inputs
 * always produce the same key; any change in model, params, messages, or
 * tenant scope yields a different key.
 */
export function computeResponseCacheKey(input: CacheKeyInput): string {
  const normalized = {
    tn: input.tenantScope,
    p: input.provider,
    m: input.model,
    t: input.temperature ?? null,
    mt: input.maxTokens ?? null,
    msgs: input.messages,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

/**
 * A node is cacheable only when its output is reproducible: no tools are bound
 * (tool calls have side effects and non-deterministic results) and sampling is
 * deterministic (temperature unset or exactly 0).
 */
export function isCacheableRequest(opts: {
  hasTools: boolean;
  temperature?: number;
}): boolean {
  if (opts.hasTools) return false;
  // Only an EXPLICIT temperature of 0 is reproducible. An unset temperature is
  // NOT deterministic — providers apply a non-zero default (OpenAI ≈ 1.0), so
  // caching an "unset" request (and, worse, serving a paraphrase of it from the
  // semantic cache) would return a stale answer for a creative prompt. Require
  // temperature === 0 to treat a node as cacheable.
  return opts.temperature === 0;
}

// ---------------------------------------------------------------------------
// In-memory LRU + TTL store
// ---------------------------------------------------------------------------

interface Entry {
  value: CachedResponse;
  expiresAt: number;
}

export class InMemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // LRU bump: re-insert to mark as most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  async set(
    key: string,
    value: CachedResponse,
    ttlSeconds: number,
  ): Promise<void> {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    // Evict oldest entries beyond the bound (Map preserves insertion order).
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Redis store (shared across replicas)
// ---------------------------------------------------------------------------

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  close?: () => void;
}

const REDIS_KEY_PREFIX = "aiperator:respcache:";

/**
 * Redis-backed cache store. Uses `SET key value EX ttl` for per-entry expiry,
 * so eviction is delegated to Redis (combine with `maxmemory-policy` for bounds).
 */
export class RedisCacheStore implements CacheStore {
  constructor(private readonly client: RedisLike) {}

  async get(key: string): Promise<CachedResponse | undefined> {
    const raw = await this.client.get(REDIS_KEY_PREFIX + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as CachedResponse;
    } catch {
      return undefined;
    }
  }

  async set(
    key: string,
    value: CachedResponse,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(
      REDIS_KEY_PREFIX + key,
      JSON.stringify(value),
      "EX",
      ttlSeconds,
    );
  }

  async close(): Promise<void> {
    this.client.close?.();
  }
}

/**
 * Builds a Redis cache store from a connection URL using Bun's native
 * RedisClient. Returns undefined when unavailable so the caller falls back to
 * the in-memory store.
 */
export function createRedisCacheStore(
  redisUrl: string,
  logger?: Logger,
): CacheStore | undefined {
  const client = createRedisClient<RedisLike>(
    redisUrl,
    "Response cache",
    logger,
  );
  return client ? new RedisCacheStore(client) : undefined;
}

// ---------------------------------------------------------------------------
// StoreFactory-backed adapter (Requirement 1.3)
// ---------------------------------------------------------------------------

/**
 * Adapts a generic {@link GenericStore} (from the central StoreFactory) into
 * the response-cache {@link CacheStore} contract. This eliminates duplicated
 * Redis/in-memory store logic — the backing selection is centralised in
 * `bootstrap/persistence.ts`.
 */
export class StoreBackedCacheStore implements CacheStore {
  constructor(private readonly store: GenericStore<string, CachedResponse>) {}

  async get(key: string): Promise<CachedResponse | undefined> {
    return this.store.get(key);
  }

  async set(
    key: string,
    value: CachedResponse,
    ttlSeconds: number,
  ): Promise<void> {
    await this.store.set(key, value, { ttlMs: ttlSeconds * 1000 });
  }
}

// ---------------------------------------------------------------------------
// ResponseCache facade
// ---------------------------------------------------------------------------

export interface ResponseCache {
  enabled: boolean;
  get(input: CacheKeyInput): Promise<CachedResponse | undefined>;
  set(input: CacheKeyInput, value: CachedResponse): Promise<void>;
  isCacheable(opts: { hasTools: boolean; temperature?: number }): boolean;
}

class ResponseCacheImpl implements ResponseCache {
  readonly enabled = true;
  constructor(
    private readonly store: CacheStore,
    private readonly ttlSeconds: number,
    private readonly logger?: Logger,
  ) {}

  async get(input: CacheKeyInput): Promise<CachedResponse | undefined> {
    try {
      return await this.store.get(computeResponseCacheKey(input));
    } catch (err) {
      this.logger?.warn("Response cache get failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async set(input: CacheKeyInput, value: CachedResponse): Promise<void> {
    if (value.text.length === 0) return; // never cache empty output
    try {
      await this.store.set(
        computeResponseCacheKey(input),
        value,
        this.ttlSeconds,
      );
    } catch (err) {
      this.logger?.warn("Response cache set failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  isCacheable(opts: { hasTools: boolean; temperature?: number }): boolean {
    return isCacheableRequest(opts);
  }
}

export interface ResponseCacheOptions {
  enabled?: boolean;
  ttlSeconds?: number;
  maxEntries?: number;
  redisUrl?: string;
  /** Central store from StoreFactory. When provided, takes precedence over ad-hoc Redis. */
  genericStore?: GenericStore<string, CachedResponse>;
}

/**
 * Builds a {@link ResponseCache}, or undefined when disabled. Prefers a
 * StoreFactory-backed store when `genericStore` is provided (centralised
 * backing selection per Req 1.3), else falls back to a direct Redis store
 * or in-memory LRU.
 */
export function createResponseCache(
  options: ResponseCacheOptions,
  logger?: Logger,
): ResponseCache | undefined {
  if (options.enabled !== true) return undefined;
  const ttl = options.ttlSeconds ?? 300;

  let store: CacheStore;
  if (options.genericStore !== undefined) {
    store = new StoreBackedCacheStore(options.genericStore);
    logger?.info("Response cache enabled (StoreFactory-backed)", {
      ttlSeconds: ttl,
    });
  } else {
    const redisStore =
      options.redisUrl !== undefined
        ? createRedisCacheStore(options.redisUrl, logger)
        : undefined;
    store = redisStore ?? new InMemoryCacheStore(options.maxEntries ?? 1000);
    logger?.info("Response cache enabled", {
      backend: redisStore !== undefined ? "redis" : "in-memory",
      ttlSeconds: ttl,
    });
  }
  return new ResponseCacheImpl(store, ttl, logger);
}
