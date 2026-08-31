// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent long-term memory (`src/graph/memory-store.ts`)
 *
 * Stateless threads forget everything between conversations; checkpointing
 * remembers *one* thread. Long-term memory remembers durable facts about a
 * **user/tenant across all their conversations** — preferences, prior answers,
 * recurring context — and recalls the relevant ones (semantic search) on each
 * new turn so the assistant can personalise without the client re-sending
 * history.
 *
 * Built on the {@link VectorStore} + {@link Embedder} from the RAG layer, but
 * fully isolated: memories live in their own collection-per-scope (and, when
 * Postgres-backed, their own `agent_memories` table), so they never mix with
 * RAG knowledge-base documents.
 *
 * Scope = (tenant, user). The user identity falls back from authenticated email
 * → conversation id → an explicit `user_id` request param; when none is present
 * the request is anonymous and memory is skipped (never written to a shared
 * bucket). All operations are best-effort and never throw into the hot path.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { VectorStore } from "./vector-store.js";
import type { Embedder } from "./semantic-cache.js";
import type { RequestContext } from "../types/monitoring.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface MemoryScope {
  /** Tenant/client the user belongs to (optional). */
  tenantId?: string;
  /** Stable user identity within the tenant. */
  userId: string;
  /**
   * Assistant identity within the user (optional).
   *
   * Present only for assistant-backed runs. A user may own several assistants
   * that must NOT share a memory bucket: two assistants with one memory are one
   * assistant with two personas, and facts learned in a work context leak into a
   * private one.
   *
   * Absent for every pre-existing path (the `memory` node on a plain flow), and
   * {@link memoryCollection} keeps the historical three-part key in that case,
   * so existing memories stay addressable byte-for-byte. This is a widening of
   * the scope, not a migration of it.
   */
  assistantId?: string;
}

/**
 * Derives a {@link MemoryScope} from the request context, or undefined when the
 * request carries no usable identity (anonymous → no memory). Pure.
 *
 * The identity fallback chain (`userEmail` → explicit `user_id` →
 * `conversation_id`) is retained for the plain `memory` node: for opportunistic
 * personalisation, degrading to a conversation-scoped bucket is better than no
 * memory at all.
 *
 * Assistant-backed runs resolve their strict scope in `assistant-context`, which
 * writes the validated `assistant_id` into the shared request context. When that
 * value is present, this function carries it into the memory key so recall and
 * post-turn auto-capture use the same `(tenant,user,assistant)` bucket. The
 * authenticated stable `userId` wins over email and client-supplied fallbacks.
 */
export function resolveMemoryScope(
  ctx: RequestContext,
): MemoryScope | undefined {
  const conv =
    typeof ctx.requestParams?.conversation_id === "string"
      ? (ctx.requestParams.conversation_id as string)
      : undefined;
  const explicit =
    typeof ctx.requestParams?.user_id === "string"
      ? (ctx.requestParams.user_id as string)
      : undefined;
  const assistantId =
    typeof ctx.requestParams?.assistant_id === "string"
      ? ctx.requestParams.assistant_id.trim()
      : undefined;
  const userId = ctx.userId ?? ctx.userEmail ?? explicit ?? conv;
  if (userId === undefined || userId.trim().length === 0) return undefined;
  return {
    userId: userId.trim(),
    ...(ctx.clientId !== undefined ? { tenantId: ctx.clientId } : {}),
    ...(assistantId !== undefined && assistantId.length > 0
      ? { assistantId }
      : {}),
  };
}

/**
 * Projects a resolved assistant scope onto a {@link MemoryScope}.
 *
 * Kept here rather than in the assistants module so the memory-key convention
 * has exactly one owner: the sentinel handling (`"_"` → absent tenant) must
 * agree with {@link memoryCollection}, and splitting that across two modules is
 * how the two representations drift.
 */
export function assistantMemoryScope(scope: {
  tenantId: string;
  userId: string;
  assistantId: string;
}): MemoryScope {
  return {
    userId: scope.userId,
    assistantId: scope.assistantId,
    // "_" is the assistants module's single-tenant sentinel; MemoryScope
    // expresses the same thing by omitting the field.
    ...(scope.tenantId !== "_" ? { tenantId: scope.tenantId } : {}),
  };
}

/**
 * Reserved, collision-resistant collection key for a scope.
 *
 * The separator MUST NOT be a NUL byte (`\u0000`): the collection key is stored
 * and queried as a Postgres `text` column (`WHERE collection = $1`), and
 * Postgres rejects any text value containing `0x00` with
 * `invalid byte sequence for encoding "UTF8": 0x00`, which silently disabled
 * memory on the pgvector backend. `\u001f` (ASCII Unit Separator) keeps the
 * same "never appears in an email / id / tenant" guarantee while staying valid
 * UTF-8 that Postgres accepts.
 */
export function memoryCollection(scope: MemoryScope): string {
  const base = `mem\u001f${scope.tenantId ?? "_"}\u001f${scope.userId}`;
  // A scope without an assistant keeps the historical three-part key, so
  // memories written before assistants existed remain addressable. Appending a
  // sentinel segment unconditionally would have re-keyed every existing bucket
  // and silently emptied it.
  return scope.assistantId === undefined
    ? base
    : `${base}\u001f${scope.assistantId}`;
}

/** Inverse of {@link memoryCollection} — undefined when `collection` isn't a memory collection. */
export function decodeMemoryCollection(
  collection: string,
): MemoryScope | undefined {
  const parts = collection.split("\u001f");
  // 3 parts = pre-assistant (user-scoped) bucket, 4 = assistant-scoped.
  if (parts.length < 3 || parts.length > 4 || parts[0] !== "mem") {
    return undefined;
  }
  const [, tenantPart, userId, assistantPart] = parts;
  if (userId === undefined || userId.length === 0) return undefined;
  // A 4-part key with an empty assistant segment is malformed, not "no
  // assistant": accepting it would map two distinct keys to one scope and make
  // the encode/decode round trip lossy.
  if (parts.length === 4 && (assistantPart ?? "").length === 0) {
    return undefined;
  }
  return {
    userId,
    ...(tenantPart !== undefined && tenantPart !== "_"
      ? { tenantId: tenantPart }
      : {}),
    ...(assistantPart !== undefined && assistantPart.length > 0
      ? { assistantId: assistantPart }
      : {}),
  };
}

/** URL-safe opaque scope id for the admin "sessions" API (base64url of tenant/user). */
export function encodeScopeId(scope: MemoryScope): string {
  const base = `${scope.tenantId ?? "_"}\u001f${scope.userId}`;
  // Mirrors memoryCollection: an assistant-less scope encodes exactly as before,
  // so previously issued opaque scope ids keep resolving.
  const raw =
    scope.assistantId === undefined
      ? base
      : `${base}\u001f${scope.assistantId}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** Inverse of {@link encodeScopeId}. Returns undefined on malformed input. */
export function decodeScopeId(id: string): MemoryScope | undefined {
  try {
    const raw = Buffer.from(id, "base64url").toString("utf8");
    const parts = raw.split("\u001f");
    if (parts.length < 2 || parts.length > 3) return undefined;
    const [tenantPart, userId, assistantPart] = parts;
    if (userId === undefined || userId.length === 0) return undefined;
    if (parts.length === 3 && (assistantPart ?? "").length === 0) {
      return undefined;
    }
    return {
      userId,
      ...(tenantPart !== undefined && tenantPart !== "_"
        ? { tenantId: tenantPart }
        : {}),
      ...(assistantPart !== undefined && assistantPart.length > 0
        ? { assistantId: assistantPart }
        : {}),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RecalledMemory {
  id: string;
  text: string;
  /** Cosine similarity to the query, [0,1]. */
  score: number;
  kind?: string;
  createdAt?: string;
}

export interface RememberOptions {
  /** Free-form category, e.g. "preference", "fact", "turn". Default "fact". */
  kind?: string;
  /** Stable id to upsert under (dedupes); a uuid is generated when omitted. */
  id?: string;
  /** Extra metadata stored alongside the memory. */
  metadata?: Record<string, unknown>;
}

/** One memory scope with its entry count — for an admin session-listing view. */
export interface MemoryScopeSummary {
  /** Opaque id encoding the scope, usable as a route param. */
  id: string;
  scope: MemoryScope;
  entryCount: number;
}

/** A stored memory entry (no similarity score — not a recall result). */
export interface MemoryEntry {
  id: string;
  text: string;
  kind?: string;
  createdAt?: string;
}

export interface MemoryStore {
  remember(
    scope: MemoryScope,
    text: string,
    opts?: RememberOptions,
  ): Promise<string | undefined>;
  recall(
    scope: MemoryScope,
    query: string,
    topK: number,
    minScore?: number,
  ): Promise<RecalledMemory[]>;
  forget(scope: MemoryScope, ids: string[]): Promise<number>;
  clear(scope: MemoryScope): Promise<number>;
  count(scope: MemoryScope): Promise<number>;
  /** Lists all known memory scopes ("sessions") with their entry count — for an admin UI. */
  listScopes(limit?: number): Promise<MemoryScopeSummary[]>;
  /** Lists stored entries for a scope (no query/ranking) — for an admin UI. */
  listEntries(scope: MemoryScope, limit?: number): Promise<MemoryEntry[]>;
}

/** Max characters stored per memory (bounds index size / embedding cost). */
const MAX_MEMORY_CHARS = 2000;

class MemoryStoreImpl implements MemoryStore {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly logger?: Logger,
  ) {}

  async remember(
    scope: MemoryScope,
    text: string,
    opts: RememberOptions = {},
  ): Promise<string | undefined> {
    const trimmed = text.trim().slice(0, MAX_MEMORY_CHARS);
    if (trimmed.length === 0) return undefined;
    const id = opts.id ?? crypto.randomUUID();
    try {
      const embedding = await this.embedder.embed(trimmed);
      await this.store.upsert(memoryCollection(scope), [
        {
          id,
          text: trimmed,
          embedding,
          metadata: {
            kind: opts.kind ?? "fact",
            createdAt: new Date().toISOString(),
            ...(opts.metadata ?? {}),
          },
        },
      ]);
      return id;
    } catch (err) {
      this.logger?.warn("Memory remember failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async recall(
    scope: MemoryScope,
    query: string,
    topK: number,
    minScore?: number,
  ): Promise<RecalledMemory[]> {
    if (query.trim().length === 0) return [];
    try {
      const vector = await this.embedder.embed(query);
      const chunks = await this.store.query(
        memoryCollection(scope),
        vector,
        Math.max(1, topK),
        minScore,
      );
      return chunks.map((c) => {
        const md = c.metadata ?? {};
        return {
          id: c.id,
          text: c.text,
          score: c.score,
          ...(typeof md.kind === "string"
            ? { kind: md.kind as string }
            : {}),
          ...(typeof md.createdAt === "string"
            ? { createdAt: md.createdAt as string }
            : {}),
        };
      });
    } catch (err) {
      this.logger?.warn("Memory recall failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async forget(scope: MemoryScope, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.store.deleteDocuments(memoryCollection(scope), ids);
  }

  async clear(scope: MemoryScope): Promise<number> {
    return this.store.deleteCollection(memoryCollection(scope));
  }

  async count(scope: MemoryScope): Promise<number> {
    return this.store.count(memoryCollection(scope));
  }

  async listScopes(limit = 100): Promise<MemoryScopeSummary[]> {
    const collections = await this.store.listCollections();
    const memoryCollections = collections
      .map((c) => ({ collection: c, scope: decodeMemoryCollection(c) }))
      .filter(
        (
          x,
        ): x is { collection: string; scope: MemoryScope } =>
          x.scope !== undefined,
      )
      .slice(0, Math.max(1, limit));

    const withCounts = await Promise.all(
      memoryCollections.map(async ({ collection, scope }) => ({
        id: encodeScopeId(scope),
        scope,
        entryCount: await this.store.count(collection),
      })),
    );
    return withCounts;
  }

  async listEntries(scope: MemoryScope, limit = 100): Promise<MemoryEntry[]> {
    const docs = await this.store.listDocuments(
      memoryCollection(scope),
      limit,
    );
    return docs.map((d) => {
      const md = d.metadata ?? {};
      return {
        id: d.id,
        text: d.text,
        ...(typeof md.kind === "string" ? { kind: md.kind as string } : {}),
        ...(typeof md.createdAt === "string"
          ? { createdAt: md.createdAt as string }
          : {}),
      };
    });
  }
}

export interface MemoryStoreOptions {
  enabled?: boolean;
}

/**
 * Builds a {@link MemoryStore}, or undefined when disabled / no embedder. The
 * vector store + embedder are injected so this is fully unit-testable.
 */
export function createMemoryStore(
  options: MemoryStoreOptions,
  store: VectorStore | undefined,
  embedder: Embedder | undefined,
  logger?: Logger,
): MemoryStore | undefined {
  if (options.enabled !== true) return undefined;
  if (store === undefined || embedder === undefined) {
    logger?.warn(
      "Long-term memory enabled but no vector store / embedding model available (set EMBEDDING_MODEL); disabling",
    );
    return undefined;
  }
  logger?.info("Agent long-term memory enabled");
  return new MemoryStoreImpl(store, embedder, logger);
}
