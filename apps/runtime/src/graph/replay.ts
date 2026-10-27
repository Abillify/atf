// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Time-travel replay (`src/graph/replay.ts`)
 *
 * Captures a snapshot of every completed run (input messages + final answer +
 * flow id) so any past execution can be *re-run* later — optionally with an
 * edited prompt or against a different flow version — and the new answer diffed
 * against the original. This is the debugging/LLMOps lever: open a past run,
 * tweak it, replay, and see exactly what changed.
 *
 * Two pieces:
 *   - {@link ReplayStore}: persists snapshots. In-memory (bounded ring) by
 *     default; Postgres-backed for durability across restarts/replicas.
 *   - {@link ReplayService}: loads a snapshot, re-runs it through an injected
 *     {@link ReplayExecutor} (the live graph engine in production, a fake in
 *     tests), and returns a structured diff.
 *
 * The executor is injected (same shape as the eval harness's FlowExecutor) so
 * the service is transport-agnostic and fully unit-testable. The text-diff
 * metric ({@link textSimilarity}) is pure. No `any` at module boundaries.
 */

import type { ChatMessage } from "../types/openai.js";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

const DEFAULT_TENANT_ID = "default";

export interface ExecutionSnapshot {
  executionId: string;
  flowId: string;
  messages: ChatMessage[];
  metadata?: Record<string, unknown>;
  responseText: string;
  createdAt: string;
  /** Tenant the run belonged to (for right-to-be-forgotten). Optional. */
  tenantId?: string;
  /** User identity the run belonged to (for right-to-be-forgotten). Optional. */
  userId?: string;
}

export interface ReplayListFilter {
  /** Exact flow id. Studio canvas test runs are stored as `<flowId>@studio-<nonce>` and don't match. */
  flowId?: string;
}

export interface ReplayStore {
  save(snapshot: ExecutionSnapshot): Promise<void>;
  get(executionId: string): Promise<ExecutionSnapshot | undefined>;
  /**
   * Returns the most recent snapshots (newest first), bounded by `limit`. Used
   * by the auto-eval dataset generator to mine production traffic. Optional
   * `limit` defaults to 500. With `filter.flowId` only that flow's snapshots
   * count toward `limit` — filter here, not after a global `list`, or busy
   * flows crowd a quiet flow out of the window.
   */
  list(limit?: number, filter?: ReplayListFilter): Promise<ExecutionSnapshot[]>;
  /**
   * Retention: deletes snapshots created strictly before the ISO cutoff.
   * Returns the number removed.
   */
  purgeOlderThan(cutoffIso: string): Promise<number>;
  /**
   * Right-to-be-forgotten: deletes snapshots attributable to the subject
   * (tenant, optionally narrowed to a user). Returns the number removed.
   */
  eraseSubject(subject: {
    tenantId?: string;
    userId?: string;
  }): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory store (bounded ring)
// ---------------------------------------------------------------------------

export class InMemoryReplayStore implements ReplayStore {
  private readonly byId = new Map<string, ExecutionSnapshot>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 1000) {}

  async save(snapshot: ExecutionSnapshot): Promise<void> {
    if (!this.byId.has(snapshot.executionId))
      this.order.push(snapshot.executionId);
    this.byId.set(snapshot.executionId, snapshot);
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.byId.delete(oldest);
    }
  }

  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    return this.byId.get(executionId);
  }

  async list(limit = 500, filter: ReplayListFilter = {}): Promise<ExecutionSnapshot[]> {
    // `order` is oldest → newest; walk it backwards for newest first.
    const out: ExecutionSnapshot[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const id = this.order[i];
      const s = id === undefined ? undefined : this.byId.get(id);
      if (s === undefined) continue;
      if (filter.flowId !== undefined && s.flowId !== filter.flowId) continue;
      out.push(s);
    }
    return out;
  }

  async purgeOlderThan(cutoffIso: string): Promise<number> {
    let removed = 0;
    for (const [id, snap] of this.byId) {
      if (snap.createdAt < cutoffIso) {
        this.byId.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.rebuildOrder();
    return removed;
  }

  async eraseSubject(subject: {
    tenantId?: string;
    userId?: string;
  }): Promise<number> {
    let removed = 0;
    for (const [id, snap] of this.byId) {
      if (matchesSubject(snap, subject)) {
        this.byId.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.rebuildOrder();
    return removed;
  }

  private rebuildOrder(): void {
    const kept = this.order.filter((id) => this.byId.has(id));
    this.order.length = 0;
    this.order.push(...kept);
  }
}

// ---------------------------------------------------------------------------
// Postgres store (durable)
// ---------------------------------------------------------------------------

interface SnapshotRow {
  execution_id: string;
  flow_id: string;
  messages: unknown;
  metadata: unknown;
  response_text: string;
  created_at: string | Date;
}

export class PostgresReplayStore implements ReplayStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  /** Runs writes under a tenant context, including anonymous default-tenant runs. */
  private scoped<T>(
    tenantId: string | undefined,
    cb: (db: Database) => Promise<T>,
  ): Promise<T> {
    if (this.db.withTenant) {
      return this.db.withTenant(tenantId ?? DEFAULT_TENANT_ID, cb);
    }
    return cb(this.db);
  }

  async save(snapshot: ExecutionSnapshot): Promise<void> {
    try {
      // Persist subject identity into metadata so right-to-be-forgotten can
      // match without a schema migration (keys align with matchesSubject).
      const meta: Record<string, unknown> = { ...(snapshot.metadata ?? {}) };
      if (snapshot.tenantId !== undefined && meta.tenant === undefined) {
        meta.tenant = snapshot.tenantId;
      }
      if (snapshot.userId !== undefined && meta.user_id === undefined) {
        meta.user_id = snapshot.userId;
      }
      const hasMeta = Object.keys(meta).length > 0;
      await this.scoped(snapshot.tenantId, (db) =>
        // jsonb-cast-ok: `metadata` ($4) is bound as an object, not a JSON string.
        db.query(
          `INSERT INTO execution_snapshots
             (execution_id, flow_id, messages, metadata, response_text, tenant_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           ON CONFLICT (execution_id) DO UPDATE
             SET response_text = EXCLUDED.response_text`,
          [
            snapshot.executionId,
            snapshot.flowId,
            JSON.stringify(snapshot.messages),
            hasMeta ? meta : null,
            snapshot.responseText,
            snapshot.tenantId ?? DEFAULT_TENANT_ID,
          ],
        ),
      );
    } catch (err) {
      this.logger?.warn("Failed to persist execution snapshot", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    // Operator-plane read (replay/eval context): uses BYPASSRLS pool when
    // available so it can access snapshots across all tenants.
    const rows = await this.db.withOperator((db) =>
      db.query<SnapshotRow>(
        `SELECT execution_id, flow_id, messages, metadata, response_text, created_at
           FROM execution_snapshots WHERE execution_id = $1`,
        [executionId],
      ),
    );
    const r = rows[0];
    if (r === undefined) return undefined;
    return {
      executionId: r.execution_id,
      flowId: r.flow_id,
      messages: parseJson<ChatMessage[]>(r.messages) ?? [],
      ...(r.metadata != null
        ? { metadata: parseJson<Record<string, unknown>>(r.metadata) ?? {} }
        : {}),
      responseText: r.response_text,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at,
    };
  }

  async list(limit = 500, filter: ReplayListFilter = {}): Promise<ExecutionSnapshot[]> {
    // Operator-plane read (eval dataset, optimizer): uses BYPASSRLS pool when
    // available so it can access snapshots across all tenants.
    const rows = await this.db.withOperator((db) =>
      filter.flowId !== undefined
        ? db.query<SnapshotRow>(
            `SELECT execution_id, flow_id, messages, metadata, response_text, created_at
               FROM execution_snapshots
              WHERE flow_id = $2
              ORDER BY created_at DESC
              LIMIT $1`,
            [Math.max(1, limit), filter.flowId],
          )
        : db.query<SnapshotRow>(
            `SELECT execution_id, flow_id, messages, metadata, response_text, created_at
               FROM execution_snapshots
              ORDER BY created_at DESC
              LIMIT $1`,
            [Math.max(1, limit)],
          ),
    );
    return rows.map((r) => ({
      executionId: r.execution_id,
      flowId: r.flow_id,
      messages: parseJson<ChatMessage[]>(r.messages) ?? [],
      ...(r.metadata != null
        ? { metadata: parseJson<Record<string, unknown>>(r.metadata) ?? {} }
        : {}),
      responseText: r.response_text,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at,
    }));
  }

  async purgeOlderThan(cutoffIso: string): Promise<number> {
    // Retention purge spans all tenants — operator-plane, requires BYPASSRLS.
    const rows = await this.db.withOperator((db) =>
      db.query<{ execution_id: string }>(
        `DELETE FROM execution_snapshots WHERE created_at < $1 RETURNING execution_id`,
        [cutoffIso],
      ),
    );
    return rows.length;
  }

  async eraseSubject(subject: {
    tenantId?: string;
    userId?: string;
  }): Promise<number> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (subject.tenantId !== undefined) {
      params.push(subject.tenantId);
      // Match on the dedicated column OR the legacy metadata field for
      // snapshots written before the tenant_id column was added.
      clauses.push(
        `(tenant_id = $${params.length} OR metadata->>'tenant' = $${params.length})`,
      );
    }
    if (subject.userId !== undefined) {
      params.push(subject.userId);
      const p = `$${params.length}`;
      clauses.push(
        `(metadata->>'user_id' = ${p} OR metadata->>'conversation_id' = ${p})`,
      );
    }
    if (clauses.length === 0) return 0;
    // Operator-plane action: must bypass RLS to erase across tenants.
    const rows = await this.db.withOperator((db) =>
      db.query<{ execution_id: string }>(
        `DELETE FROM execution_snapshots WHERE ${clauses.join(" AND ")} RETURNING execution_id`,
        params,
      ),
    );
    return rows.length;
  }
}

function parseJson<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }
  return v as T;
}

/**
 * True when a snapshot belongs to the erasure subject. A subject with only a
 * tenant matches every snapshot of that tenant; adding a user narrows it. The
 * snapshot's identity falls back to its metadata when the dedicated fields are
 * absent (older captures).
 */
function matchesSubject(
  snap: ExecutionSnapshot,
  subject: { tenantId?: string; userId?: string },
): boolean {
  const md = snap.metadata ?? {};
  const snapTenant =
    snap.tenantId ??
    (typeof md.tenant === "string" ? (md.tenant as string) : undefined);
  const snapUser =
    snap.userId ??
    (typeof md.user_id === "string"
      ? (md.user_id as string)
      : typeof md.conversation_id === "string"
        ? (md.conversation_id as string)
        : undefined);
  if (subject.tenantId !== undefined && snapTenant !== subject.tenantId)
    return false;
  if (subject.userId !== undefined && snapUser !== subject.userId) return false;
  // At least one constraint must have positively matched (guarded by caller's
  // isValidSubject — an all-undefined subject never reaches here).
  if (subject.tenantId !== undefined && snapTenant === subject.tenantId)
    return true;
  if (subject.userId !== undefined && snapUser === subject.userId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Text similarity (pure)
// ---------------------------------------------------------------------------

function wordSet(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(matches);
}

/** Jaccard similarity of the word sets of two texts, in [0,1]. Pure. */
export function textSimilarity(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : Math.round((inter / union) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Replay service
// ---------------------------------------------------------------------------

/** Injected execution backend (in-process graph engine, or a fake in tests). */
export type ReplayExecutor = (
  flowId: string,
  messages: ChatMessage[],
  metadata?: Record<string, unknown>,
) => Promise<{ text: string }>;

export interface ReplayOverrides {
  /** Re-run against a different flow id (e.g. a new version / canary candidate). */
  flowId?: string;
  /** Replace the input messages (edit-and-replay). */
  messages?: ChatMessage[];
  /** Extra/override metadata for the replay run. */
  metadata?: Record<string, unknown>;
}

export interface ReplayResult {
  executionId: string;
  originalFlowId: string;
  replayedFlowId: string;
  originalResponse: string;
  replayedResponse: string;
  /** Word-set Jaccard similarity between the two answers, [0,1]. */
  similarity: number;
  /** True when the replayed answer differs from the original. */
  changed: boolean;
}

export class ReplayNotFoundError extends Error {
  constructor(executionId: string) {
    super(`No snapshot found for execution "${executionId}"`);
    this.name = "ReplayNotFoundError";
  }
}

export interface ReplayService {
  capture(snapshot: ExecutionSnapshot): Promise<void>;
  replay(
    executionId: string,
    overrides?: ReplayOverrides,
  ): Promise<ReplayResult>;
}

class ReplayServiceImpl implements ReplayService {
  constructor(
    private readonly store: ReplayStore,
    private readonly executor: ReplayExecutor,
    private readonly logger?: Logger,
  ) {}

  async capture(snapshot: ExecutionSnapshot): Promise<void> {
    await this.store.save(snapshot);
  }

  async replay(
    executionId: string,
    overrides: ReplayOverrides = {},
  ): Promise<ReplayResult> {
    const snapshot = await this.store.get(executionId);
    if (snapshot === undefined) throw new ReplayNotFoundError(executionId);

    const flowId = overrides.flowId ?? snapshot.flowId;
    const messages = overrides.messages ?? snapshot.messages;
    const snapshotMetadata = { ...(snapshot.metadata ?? {}) };
    const capturedVerifiedContext = snapshotMetadata.__verifiedContext;
    delete snapshotMetadata.__token;
    delete snapshotMetadata.__verifiedContext;
    const overrideMetadata = { ...(overrides.metadata ?? {}) };
    delete overrideMetadata.__verifiedContext;
    const metadata = {
      ...snapshotMetadata,
      ...overrideMetadata,
      // Authorization identity is accepted only from the captured, signed
      // production envelope. Replay callers cannot inject this reserved key.
      ...(capturedVerifiedContext !== undefined
        ? { __verifiedContext: capturedVerifiedContext }
        : {}),
    };

    this.logger?.info("Replaying execution", {
      executionId,
      originalFlow: snapshot.flowId,
      replayFlow: flowId,
      editedMessages: overrides.messages !== undefined,
    });

    const { text } = await this.executor(flowId, messages, metadata);
    const similarity = textSimilarity(snapshot.responseText, text);
    return {
      executionId,
      originalFlowId: snapshot.flowId,
      replayedFlowId: flowId,
      originalResponse: snapshot.responseText,
      replayedResponse: text,
      similarity,
      changed: similarity < 1 || text.trim() !== snapshot.responseText.trim(),
    };
  }
}

export function createReplayService(
  store: ReplayStore,
  executor: ReplayExecutor,
  logger?: Logger,
): ReplayService {
  return new ReplayServiceImpl(store, executor, logger);
}
