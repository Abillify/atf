// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Semantic response cache (`src/graph/semantic-cache.ts`)
 *
 * The exact-match {@link ResponseCache} only reuses a result when the request
 * is byte-identical. This cache goes one step further: it embeds the last user
 * message and reuses a prior response when an existing entry is *semantically*
 * similar above a cosine threshold. So paraphrases ("capital of France?" vs.
 * "what is France's capital") collapse onto a single provider call — the single
 * biggest cost/latency lever for FAQ-style and agent-retry traffic.
 *
 * Correctness is preserved by construction:
 *   - Only DETERMINISTIC nodes are cacheable (no tools, temperature 0/unset),
 *     exactly like the exact-match cache.
 *   - Entries are partitioned by a {@link namespace} (tenant/user/context/
 *     provider/model/params), so a hit needs the same tenant AND user plus a
 *     byte-identical context and can never cross models or sampling settings.
 *     Only the last user message is matched on similarity.
 *
 * The embedding backend is injected via the {@link Embedder} contract, so the
 * similarity/threshold/eviction logic is fully unit-testable without any
 * network calls. A real {@link AiSdkEmbedder} wraps the Vercel AI SDK.
 *
 * The store is an in-memory, per-replica bounded vector index (linear cosine
 * scan within a namespace). This is intentional: a shared cross-replica vector
 * index needs a real vector DB and is out of scope; the per-replica index still
 * removes the dominant cost of repeated/similar prompts on each instance.
 *
 * No `any` at module boundaries.
 */

import { embed } from "ai";
import crypto from "node:crypto";
import type { EmbeddingModel } from "ai";
import type { Logger } from "../observability/logger.js";
import type { CachedResponse } from "./response-cache.js";
import { isCacheableRequest, SINGLE_TENANT_SCOPE } from "./response-cache.js";

export { SINGLE_TENANT_SCOPE };
import type { VectorStore } from "./vector-store.js";

/**
 * User isolation scope for deployments without per-user identity. Mirrors
 * {@link SINGLE_TENANT_SCOPE}: a sentinel, never an omission, so an entry is
 * always bound to a concrete user scope.
 */
export const SINGLE_USER_SCOPE = "__single_user__";

// ---------------------------------------------------------------------------
// Embedder contract
// ---------------------------------------------------------------------------

/** Produces a dense vector for a text. Injected so the cache is testable. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** Real embedder backed by a Vercel AI SDK embedding model. */
export class AiSdkEmbedder implements Embedder {
  constructor(private readonly model: EmbeddingModel) {}

  async embed(text: string): Promise<number[]> {
    const { embedding } = await embed({ model: this.model, value: text });
    return embedding;
  }
}

function validateEmbeddingVector(
  vector: number[],
  expectedDimension?: number,
): number[] {
  if (vector.length === 0) {
    throw new Error("Embedding provider returned an empty vector");
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding provider returned a non-finite vector");
  }
  if (
    expectedDimension !== undefined &&
    vector.length !== expectedDimension
  ) {
    throw new Error(
      `Embedding dimension ${vector.length} does not match expected dimension ${expectedDimension}`,
    );
  }
  return vector;
}

/** Primary-first embedder with strict output validation and exception fallback. */
export class FallbackEmbedder implements Embedder {
  constructor(
    private readonly primary: Embedder,
    private readonly fallback: Embedder,
    private readonly logger: Logger,
    private readonly expectedDimension?: number,
  ) {}

  async embed(text: string): Promise<number[]> {
    let primaryError: unknown;
    try {
      return validateEmbeddingVector(
        await this.primary.embed(text),
        this.expectedDimension,
      );
    } catch (err) {
      primaryError = err;
      this.logger.warn("Primary embedding provider failed; using fallback", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      return validateEmbeddingVector(
        await this.fallback.embed(text),
        this.expectedDimension,
      );
    } catch (fallbackError) {
      const primaryMessage =
        primaryError instanceof Error
          ? primaryError.message
          : String(primaryError);
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `Fallback embedding failed after primary failure (${primaryMessage}): ${fallbackMessage}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity (pure)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity of two equal-length vectors in [-1, 1]. Returns 0 for
 * mismatched lengths or a zero-magnitude vector (no meaningful direction).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [i, x] of a.entries()) {
    const y = b[i];
    if (y === undefined) continue; // unreachable: a.length === b.length checked above
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------------------------------------------------------------------------
// In-memory vector index (bounded, TTL, per-namespace)
// ---------------------------------------------------------------------------

interface VectorEntry {
  vector: number[];
  value: CachedResponse;
  expiresAt: number;
  /** Recency marker for LRU eviction. */
  touched: number;
}

/**
 * A bounded vector store keyed by namespace. Each namespace holds its own list
 * of (vector, response) entries; lookups scan only the matching namespace.
 */
export class InMemoryVectorStore {
  private readonly byNamespace = new Map<string, Map<string, VectorEntry>>();
  private seq = 0;

  /**
   * Notified whenever an entry leaves the store on its own — an expired entry
   * met during a search, or an entry dropped by the size cap. An owner that
   * keeps its own per-entry bookkeeping uses this to stay in sync, so that
   * bookkeeping cannot outlive the entries it describes.
   */
  onRemoval?: (namespace: string, key: string) => void;

  constructor(private readonly maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** Returns the best match (>= threshold) in a namespace, or undefined. */
  search(
    namespace: string,
    vector: number[],
    threshold: number,
  ): CachedResponse | undefined {
    const bucket = this.byNamespace.get(namespace);
    if (bucket === undefined) return undefined;

    const now = Date.now();
    let best: VectorEntry | undefined;
    let bestSim = -Infinity;
    for (const [key, entry] of bucket) {
      if (now > entry.expiresAt) {
        bucket.delete(key);
        this.onRemoval?.(namespace, key);
        continue;
      }
      const sim = cosineSimilarity(vector, entry.vector);
      if (sim > bestSim) {
        bestSim = sim;
        best = entry;
      }
    }
    if (best !== undefined && bestSim >= threshold) {
      best.touched = ++this.seq; // LRU bump
      return best.value;
    }
    return undefined;
  }

  /** Inserts an entry, evicting the globally least-recently-used when over bound. */
  insert(
    namespace: string,
    key: string,
    vector: number[],
    value: CachedResponse,
    ttlSeconds: number,
  ): void {
    let bucket = this.byNamespace.get(namespace);
    if (bucket === undefined) {
      bucket = new Map<string, VectorEntry>();
      this.byNamespace.set(namespace, bucket);
    }
    bucket.set(key, {
      vector,
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
      touched: ++this.seq,
    });
    this.evictIfNeeded();
  }

  /** Total entries across all namespaces. */
  size(): number {
    let n = 0;
    for (const bucket of this.byNamespace.values()) n += bucket.size;
    return n;
  }

  private evictIfNeeded(): void {
    while (this.size() > this.maxEntries) {
      let lruNs: string | undefined;
      let lruKey: string | undefined;
      let lruTouched = Infinity;
      for (const [ns, bucket] of this.byNamespace) {
        for (const [key, entry] of bucket) {
          if (entry.touched < lruTouched) {
            lruTouched = entry.touched;
            lruNs = ns;
            lruKey = key;
          }
        }
      }
      if (lruNs === undefined || lruKey === undefined) break;
      const bucket = this.byNamespace.get(lruNs);
      bucket?.delete(lruKey);
      this.onRemoval?.(lruNs, lruKey);
      if (bucket !== undefined && bucket.size === 0)
        this.byNamespace.delete(lruNs);
    }
  }

  /**
   * Deletes the listed keys of one namespace and returns how many were really
   * there. Namespaces left empty are dropped.
   */
  deleteKeys(namespace: string, keys: Iterable<string>): number {
    const bucket = this.byNamespace.get(namespace);
    if (bucket === undefined) return 0;
    let removed = 0;
    for (const key of keys) if (bucket.delete(key)) removed++;
    if (bucket.size === 0) this.byNamespace.delete(namespace);
    return removed;
  }
}

// ---------------------------------------------------------------------------
// SemanticCache facade
// ---------------------------------------------------------------------------

export interface SemanticCacheKeyInput {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * The text to embed and match on: the last user message only. Everything else
   * (system prompt, injected context, earlier turns) travels in
   * {@link contextHash} instead — embedding the whole prompt let a long shared
   * system prompt dominate the vector and produce hits between different
   * questions.
   */
  text: string;
  /**
   * Tenant/client isolation scope — REQUIRED. Mixed into the namespace so a
   * near-duplicate-question hit can never cross tenants. A semantic cache is
   * MORE exposed to cross-tenant leakage than the exact-match cache (it matches
   * on similarity, not identity), so this is not optional here. Use
   * {@link SINGLE_TENANT_SCOPE} for deployments without multi-tenancy.
   */
  tenantScope: string;
  /** User isolation scope inside the tenant — REQUIRED. Use SINGLE_USER_SCOPE when no user is known. */
  userScope: string;
  /** SHA-256 (hex) over everything except the last user message: system prompt, injected context, earlier turns. Hits require an identical value. */
  contextHash: string;
}

export interface SemanticCache {
  enabled: boolean;
  get(input: SemanticCacheKeyInput): Promise<CachedResponse | undefined>;
  set(input: SemanticCacheKeyInput, value: CachedResponse): Promise<void>;
  isCacheable(opts: { hasTools: boolean; temperature?: number }): boolean;
  /**
   * Deletes every entry stored for one user of one tenant and returns the
   * number of entries removed. Scopes match exactly what `get`/`set` used: the
   * same `tenantScope` and `userScope`, across all models, contexts and cached
   * questions of that user. Entries that already expired do not count.
   */
  eraseUser(tenantScope: string, userScope: string): Promise<number>;
  /**
   * False when the backing store cannot delete entries, so {@link eraseUser}
   * cannot honour an erasure request. Omitted (treated as supported) otherwise.
   */
  readonly erasureSupported?: boolean;
  /**
   * Deletes entries that cannot be attributed to a user because they were
   * written before user scoping was stored with them, and returns how many were
   * removed. Absent when the cache keeps no such entries.
   */
  eraseUnattributed?(): Promise<number>;
}

/**
 * Namespace partitions entries so a hit can never cross tenant, user, context,
 * model, or sampling params. `tenantScope` and `userScope` are listed first and
 * are never optional — see {@link SemanticCacheKeyInput.tenantScope}.
 * `contextHash` binds an entry to the exact prompt around the last user
 * message, so a hit cannot reuse an answer generated from another system
 * prompt, another injected context or another conversation history.
 */
function namespaceOf(input: SemanticCacheKeyInput): string {
  return JSON.stringify({
    tn: input.tenantScope,
    us: input.userScope,
    ch: input.contextHash,
    p: input.provider,
    m: input.model,
    t: input.temperature ?? null,
    mt: input.maxTokens ?? null,
  });
}

/** Collection prefix of every entry written by {@link VectorStoreSemanticCache}. */
const VECTOR_COLLECTION_PREFIX = "semcache:";

/** Separator that cannot appear in a namespace or entry key. */
const SCOPE_SEP = "\u0000";

/** Index key of one user inside one tenant. */
function userIndexKey(tenantScope: string, userScope: string): string {
  return `${tenantScope}${SCOPE_SEP}${userScope}`;
}

/** Index member identifying one stored entry. */
function entryIndexKey(namespace: string, key: string): string {
  return `${namespace}${SCOPE_SEP}${key}`;
}

class SemanticCacheImpl implements SemanticCache {
  readonly enabled = true;
  private keySeq = 0;

  /**
   * `tenantScope|userScope` -> the entries written for that user, so an
   * erasure can find them again: namespaces also contain the context hash, the
   * model and the sampling params, which an erasure request does not know.
   */
  private readonly byUser = new Map<string, Set<string>>();

  constructor(
    private readonly embedder: Embedder,
    private readonly store: InMemoryVectorStore,
    private readonly threshold: number,
    private readonly ttlSeconds: number,
    private readonly logger?: Logger,
  ) {
    // Entries also leave on their own (TTL, size cap); drop them from the
    // erasure index too so it cannot grow past the cache itself.
    store.onRemoval = (namespace, key) => {
      this.forget(entryIndexKey(namespace, key));
    };
  }

  /** Removes one entry from every user bucket of the erasure index. */
  private forget(entryKey: string): void {
    for (const [userKey, entries] of this.byUser) {
      if (entries.delete(entryKey) && entries.size === 0) {
        this.byUser.delete(userKey);
      }
    }
  }

  async get(input: SemanticCacheKeyInput): Promise<CachedResponse | undefined> {
    if (input.text.trim().length === 0) return undefined;
    try {
      const vector = await this.embedder.embed(input.text);
      return this.store.search(namespaceOf(input), vector, this.threshold);
    } catch (err) {
      this.logger?.warn("Semantic cache get failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async set(
    input: SemanticCacheKeyInput,
    value: CachedResponse,
  ): Promise<void> {
    if (value.text.length === 0 || input.text.trim().length === 0) return;
    try {
      const vector = await this.embedder.embed(input.text);
      const namespace = namespaceOf(input);
      const key = `e${++this.keySeq}`;
      this.store.insert(namespace, key, vector, value, this.ttlSeconds);
      const userKey = userIndexKey(input.tenantScope, input.userScope);
      let entries = this.byUser.get(userKey);
      if (entries === undefined) {
        entries = new Set<string>();
        this.byUser.set(userKey, entries);
      }
      entries.add(entryIndexKey(namespace, key));
    } catch (err) {
      this.logger?.warn("Semantic cache set failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async eraseUser(tenantScope: string, userScope: string): Promise<number> {
    const entries = this.byUser.get(userIndexKey(tenantScope, userScope));
    if (entries === undefined || entries.size === 0) return 0;
    const byNamespace = new Map<string, string[]>();
    for (const entryKey of entries) {
      const sep = entryKey.indexOf(SCOPE_SEP);
      const namespace = entryKey.slice(0, sep);
      const key = entryKey.slice(sep + SCOPE_SEP.length);
      const keys = byNamespace.get(namespace);
      if (keys === undefined) byNamespace.set(namespace, [key]);
      else keys.push(key);
    }
    this.byUser.delete(userIndexKey(tenantScope, userScope));
    let removed = 0;
    for (const [namespace, keys] of byNamespace) {
      removed += this.store.deleteKeys(namespace, keys);
    }
    this.logger?.debug("Semantic cache erased entries for a user", {
      tenantScope,
      userScope,
      erased: removed,
    });
    return removed;
  }

  isCacheable(opts: { hasTools: boolean; temperature?: number }): boolean {
    return isCacheableRequest(opts);
  }
}

export interface SemanticCacheOptions {
  enabled?: boolean;
  threshold?: number;
  maxEntries?: number;
  ttlSeconds?: number;
}

/**
 * Builds a {@link SemanticCache}, or undefined when disabled / no embedder is
 * available. The embedder is injected (real or fake) so this never reaches out
 * to a provider on its own.
 */
export function createSemanticCache(
  options: SemanticCacheOptions,
  embedder: Embedder | undefined,
  logger?: Logger,
): SemanticCache | undefined {
  if (options.enabled !== true) return undefined;
  if (embedder === undefined) {
    logger?.warn(
      "Semantic cache enabled but no embedding model configured (set EMBEDDING_MODEL); disabling",
    );
    return undefined;
  }
  const store = new InMemoryVectorStore(options.maxEntries ?? 500);
  logger?.info("Semantic cache enabled", {
    threshold: options.threshold ?? 0.92,
    ttlSeconds: options.ttlSeconds ?? 300,
    maxEntries: options.maxEntries ?? 500,
  });
  return new SemanticCacheImpl(
    embedder,
    store,
    options.threshold ?? 0.92,
    options.ttlSeconds ?? 300,
    logger,
  );
}

// ---------------------------------------------------------------------------
// Cluster-wide semantic cache (VectorStore-backed, e.g. pgvector)
// ---------------------------------------------------------------------------

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

function isCachedResponse(v: unknown): v is CachedResponse {
  if (v === null || typeof v !== "object") return false;
  const r = v as { text?: unknown; usage?: unknown };
  if (typeof r.text !== "string") return false;
  const u = r.usage as { promptTokens?: unknown } | undefined;
  return u !== undefined && typeof u === "object";
}

/**
 * Semantic cache backed by a shared {@link VectorStore} (pgvector when a
 * database is configured). Unlike the per-replica {@link InMemoryVectorStore}
 * variant, entries persist and are visible to ALL replicas, so a hit on one
 * instance saves the provider call on every instance — the cross-replica
 * cost/latency lever for FAQ-style and agent-retry traffic.
 *
 * Each namespace (provider/model/sampling params) maps to its own isolated
 * vector collection so a hit can never cross models. Entries carry an
 * `expiresAt`; expired hits are skipped at read time (the store also bounds
 * size), so correctness and the TTL contract are preserved.
 */
class VectorStoreSemanticCache implements SemanticCache {
  readonly enabled = true;

  /** Last purge time per collection (ms) — throttles the opportunistic sweep. */
  private readonly lastPurgeAt = new Map<string, number>();

  /**
   * `tenantScope|userScope` -> the documents written for that user
   * (`collection|id`). The collection name is a hash over the whole namespace,
   * which also contains the context hash, model and sampling params, so an
   * erasure request cannot derive it from the user alone.
   */
  private readonly byUser = new Map<string, Set<string>>();

  /**
   * False when the injected store cannot delete by metadata, which makes
   * per-user erasure impossible: the per-process index below only knows what
   * this replica wrote since it started.
   */
  readonly erasureSupported: boolean;

  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly threshold: number,
    private readonly ttlSeconds: number,
    private readonly clock: Clock = Date.now,
    private readonly logger?: Logger,
    /** Over-fetch a few candidates so an expired top hit can fall through. */
    private readonly probeK = 5,
    /**
     * Upper bound on live entries per namespace collection. Expired entries are
     * swept and, past this bound, the oldest live entries are evicted too — so
     * the shared pgvector index cannot grow without limit (previously expired
     * entries were only skipped at read time and never deleted). Default 5000.
     */
    private readonly maxEntries = 5000,
    /** Minimum interval between opportunistic purges of one collection (ms). */
    private readonly purgeIntervalMs = 60_000,
  ) {
    // The database is the source of truth for who an entry belongs to; a store
    // that cannot delete by metadata cannot honour an erasure request. The
    // method is optional on the interface and injected or partial stores may
    // not provide it, so the capability is checked rather than assumed.
    this.erasureSupported = typeof store.deleteByMetadata === "function";
  }

  /** Removes one document from every user bucket of the erasure index. */
  private forget(entryKey: string): void {
    for (const [userKey, entries] of this.byUser) {
      if (entries.delete(entryKey) && entries.size === 0) {
        this.byUser.delete(userKey);
      }
    }
  }

  /**
   * Opportunistic, throttled purge of a namespace collection: deletes entries
   * whose `expiresAt` has passed and, if still over {@link maxEntries}, evicts
   * the oldest live entries. Runs at most once per {@link purgeIntervalMs} per
   * collection, off the hot path (fire-and-forget from `set`). Best-effort —
   * any store error is swallowed.
   */
  private async maybePurge(collection: string): Promise<void> {
    const now = this.clock();
    const last = this.lastPurgeAt.get(collection) ?? 0;
    if (now - last < this.purgeIntervalMs) return;
    this.lastPurgeAt.set(collection, now);
    try {
      const docs = await this.store.listDocuments(collection, this.maxEntries * 4);
      const expiredIds: string[] = [];
      const live: Array<{ id: string; expiresAt: number }> = [];
      for (const d of docs) {
        const exp =
          typeof d.metadata?.expiresAt === "number"
            ? (d.metadata.expiresAt as number)
            : Infinity;
        if (now > exp) expiredIds.push(d.id);
        else live.push({ id: d.id, expiresAt: exp });
      }
      if (live.length > this.maxEntries) {
        live.sort((a, b) => a.expiresAt - b.expiresAt);
        for (const d of live.slice(0, live.length - this.maxEntries)) {
          expiredIds.push(d.id);
        }
      }
      if (expiredIds.length > 0) {
        await this.store.deleteDocuments(collection, expiredIds);
        for (const id of expiredIds) {
          this.forget(entryIndexKey(collection, id));
        }
        this.logger?.debug("Semantic cache (vector) purged entries", {
          collection,
          removed: expiredIds.length,
        });
      }
    } catch (err) {
      this.logger?.debug("Semantic cache (vector) purge failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private collection(input: SemanticCacheKeyInput): string {
    const ns = namespaceOf(input);
    return `${VECTOR_COLLECTION_PREFIX}${crypto.createHash("sha256").update(ns).digest("hex").slice(0, 32)}`;
  }

  async get(input: SemanticCacheKeyInput): Promise<CachedResponse | undefined> {
    if (input.text.trim().length === 0) return undefined;
    try {
      const vector = await this.embedder.embed(input.text);
      const hits = await this.store.query(
        this.collection(input),
        vector,
        this.probeK,
        this.threshold,
      );
      const now = this.clock();
      for (const hit of hits) {
        const md = hit.metadata ?? {};
        const expiresAt =
          typeof md.expiresAt === "number"
            ? (md.expiresAt as number)
            : Infinity;
        if (now > expiresAt) continue;
        if (isCachedResponse(md.response)) return md.response;
      }
      return undefined;
    } catch (err) {
      this.logger?.warn("Semantic cache (vector) get failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async set(
    input: SemanticCacheKeyInput,
    value: CachedResponse,
  ): Promise<void> {
    if (value.text.length === 0 || input.text.trim().length === 0) return;
    try {
      const vector = await this.embedder.embed(input.text);
      // Deterministic id by (namespace, text) so re-setting the same prompt
      // updates in place rather than accumulating duplicates.
      const id = crypto
        .createHash("sha256")
        .update(`${namespaceOf(input)}\u0000${input.text}`)
        .digest("hex");
      const collection = this.collection(input);
      await this.store.upsert(collection, [
        {
          id,
          text: input.text,
          embedding: vector,
          metadata: {
            response: value,
            expiresAt: this.clock() + this.ttlSeconds * 1000,
            // Stored with the entry so an erasure finds it from any replica and
            // after a restart, not only through this process's index.
            tenantScope: input.tenantScope,
            userScope: input.userScope,
          },
        },
      ]);
      const userKey = userIndexKey(input.tenantScope, input.userScope);
      let entries = this.byUser.get(userKey);
      if (entries === undefined) {
        entries = new Set<string>();
        this.byUser.set(userKey, entries);
      }
      entries.add(entryIndexKey(collection, id));
      // Fire-and-forget: sweep expired/overflow entries so the shared index
      // stays bounded. Throttled per collection; never blocks the request.
      void this.maybePurge(collection);
    } catch (err) {
      this.logger?.warn("Semantic cache (vector) set failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async eraseUser(tenantScope: string, userScope: string): Promise<number> {
    const deleteByMetadata = this.store.deleteByMetadata?.bind(this.store);
    if (this.erasureSupported !== true || deleteByMetadata === undefined) {
      return 0;
    }
    let erased = 0;
    try {
      erased = await deleteByMetadata(VECTOR_COLLECTION_PREFIX, {
        tenantScope,
        userScope,
      });
    } catch (err) {
      this.logger?.warn("Semantic cache (vector) erase failed", {
        tenantScope,
        userScope,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    // The store decided what was deleted; only tidy the local index.
    this.byUser.delete(userIndexKey(tenantScope, userScope));
    this.logger?.debug("Semantic cache (vector) erased entries for a user", {
      tenantScope,
      userScope,
      erased,
    });
    return erased;
  }

  async eraseUnattributed(): Promise<number> {
    const deleteWithout = this.store.deleteWithoutMetadataKey?.bind(this.store);
    if (deleteWithout === undefined) return 0;
    // Entries written before user scoping cannot be attributed; they are dropped on the first erasure (the cache refills).
    const removed = await deleteWithout(VECTOR_COLLECTION_PREFIX, "userScope");
    if (removed > 0) {
      this.logger?.info("Semantic cache (vector) dropped unattributed entries", {
        removed,
      });
    }
    return removed;
  }

  isCacheable(opts: { hasTools: boolean; temperature?: number }): boolean {
    return isCacheableRequest(opts);
  }
}

/**
 * Builds a cluster-wide {@link SemanticCache} backed by a shared
 * {@link VectorStore}. Returns undefined when disabled or no embedder/store is
 * available, so the caller can fall back to the per-replica in-memory cache.
 */
export function createVectorStoreSemanticCache(
  options: SemanticCacheOptions,
  embedder: Embedder | undefined,
  store: VectorStore | undefined,
  logger?: Logger,
  clock: Clock = Date.now,
): SemanticCache | undefined {
  if (options.enabled !== true) return undefined;
  if (embedder === undefined || store === undefined) return undefined;
  logger?.info("Semantic cache enabled (cluster-wide, vector-store backed)", {
    threshold: options.threshold ?? 0.92,
    ttlSeconds: options.ttlSeconds ?? 300,
  });
  return new VectorStoreSemanticCache(
    embedder,
    store,
    options.threshold ?? 0.92,
    options.ttlSeconds ?? 300,
    clock,
    logger,
    5,
    options.maxEntries ?? 5000,
  );
}
