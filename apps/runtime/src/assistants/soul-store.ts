// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Soul persistence (`src/assistants/soul-store.ts`)
 *
 * Stores the three-write-class soul document with an optimistic lock and an
 * append-only revision history. The document rules live in `soul-document.ts`;
 * this module owns durability, concurrency, and history.
 *
 * Why an optimistic lock and not last-write-wins: an assistant may edit its own
 * identity during a turn while its user edits directives in the UI. Both writes
 * target the same row. Last-write-wins loses one of them silently, and the loser
 * is whichever request happened to be slower — a non-deterministic data loss
 * that surfaces later as "the assistant forgot what I told it". A refused write
 * with a re-read instruction is recoverable; a lost write is not.
 *
 * Why full snapshots in history instead of diffs: the questions asked of this
 * table are "what was this assistant instructed to do on 3 March" (compliance)
 * and "put it back the way it was" (rollback). Both are one row read against a
 * snapshot and a replay against diffs. History is written rarely and read
 * rarely; storage is the cheapest of the three costs.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import {
  applySoulPatch,
  emptySoulDocument,
  normalizeSoulDocument,
  soulDocumentHash,
  type SoulDocument,
  type SoulPatch,
} from "./soul-document.js";
import { toIso } from "./assistant-store.js";
import type {
  AssistantScope,
  SoulActorType,
  SoulRecord,
  SoulRevisionRecord,
  SoulWriteClass,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a mutation's `expectedRevisionHash` does not match the stored one.
 *
 * Carries the current hash so the caller can immediately re-read and retry
 * without a second round trip, and so a tool result can tell the model exactly
 * what to do next instead of leaving it to guess.
 */
export class SoulRevisionConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    readonly currentRevisionHash: string,
  ) {
    super(
      `Soul was modified concurrently (now at revision ${currentRevision}). ` +
        `Re-read the soul and re-apply your change against the current revision.`,
    );
    this.name = "SoulRevisionConflictError";
  }
}

/** Raised when an actor attempts to write a class it does not own. */
export class SoulWriteClassError extends Error {
  constructor(
    readonly actorType: SoulActorType,
    readonly attempted: SoulWriteClass[],
  ) {
    super(
      `Actor "${actorType}" may not modify: ${attempted.join(", ")}. ` +
        `identity is agent-owned, directives are user-owned, constraints are operator-owned.`,
    );
    this.name = "SoulWriteClassError";
  }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface SoulMutationInput {
  scope: AssistantScope;
  patch: SoulPatch;
  actorType: SoulActorType;
  actorId?: string;
  /**
   * The revision hash the caller read before composing the patch. Omitted only
   * by provisioning (which creates the first revision). Supplying it is what
   * makes the write safe against a concurrent editor.
   */
  expectedRevisionHash?: string;
  /** Free-text justification recorded in history. */
  reason?: string;
}

export interface SoulMutationResult {
  record: SoulRecord;
  /** False when the patch normalised to a no-op; no revision was created. */
  changed: boolean;
  /**
   * Classes named by the patch that this actor does not own. Reported rather
   * than thrown when at least one owned class was also present, so a partially
   * valid patch still applies and the actor learns what was dropped.
   */
  ignoredClasses: SoulWriteClass[];
}

export interface SoulStore {
  /** Reads the soul, creating an empty one when the assistant has none yet. */
  get(scope: AssistantScope): Promise<SoulRecord>;
  /** Applies a patch under the actor's write class and optimistic lock. */
  mutate(input: SoulMutationInput): Promise<SoulMutationResult>;
  /** Revision history, newest first. */
  history(scope: AssistantScope, limit?: number): Promise<SoulRevisionRecord[]>;
  /**
   * Restores a past revision as a NEW revision.
   *
   * Deliberately not a destructive rewind: the act of rolling back is itself an
   * auditable event, and rewinding by deleting revisions would erase the record
   * of what was rolled back and by whom.
   */
  restore(params: {
    scope: AssistantScope;
    revision: number;
    actorType: SoulActorType;
    actorId?: string;
    expectedRevisionHash?: string;
  }): Promise<SoulMutationResult>;
  /** Removes soul and history. Used by the erase/purge path only. */
  purge(scope: AssistantScope): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared mutation core
// ---------------------------------------------------------------------------

/** Default history page size. */
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;

function boundLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_HISTORY_LIMIT);
}

/**
 * Computes the next document and validates the mutation, independent of storage.
 *
 * Shared by both implementations so the in-memory store cannot diverge from the
 * Postgres one on the rules that matter (lock check, write-class containment,
 * no-op detection). Throws for a rejected mutation; returns the new document for
 * an accepted one.
 */
function prepareMutation(params: { current: SoulRecord; input: SoulMutationInput }): {
  next: SoulDocument;
  changed: boolean;
  ignoredClasses: SoulWriteClass[];
} {
  const { current, input } = params;

  if (
    input.expectedRevisionHash !== undefined &&
    input.expectedRevisionHash !== current.revisionHash
  ) {
    throw new SoulRevisionConflictError(current.revision, current.revisionHash);
  }

  const base: SoulDocument = {
    identity: current.identity,
    directives: current.directives,
    constraints: current.constraints,
  };
  const applied = applySoulPatch({
    base,
    patch: input.patch,
    actorType: input.actorType,
  });

  // Every named class was refused → the mutation has no legitimate effect at
  // all, so it is an error rather than a silent no-op. A partially valid patch
  // proceeds and reports the dropped classes.
  const namedClasses =
    (input.patch.identity !== undefined ? 1 : 0) +
    (input.patch.directives !== undefined ? 1 : 0) +
    (input.patch.constraints !== undefined ? 1 : 0);
  if (namedClasses > 0 && applied.ignoredClasses.length === namedClasses) {
    throw new SoulWriteClassError(input.actorType, applied.ignoredClasses);
  }

  return applied;
}

/** Determines which class a revision entry should be attributed to. */
function revisionWriteClass(actorType: SoulActorType, patch: SoulPatch): SoulWriteClass {
  if (actorType === "agent") return "identity";
  if (actorType === "user") return "directives";
  if (actorType === "operator") return "constraints";
  // `system` only writes during provisioning/restore, where the whole document
  // is set. Attribute to the most privileged class present so the history entry
  // does not understate what changed.
  if (patch.constraints !== undefined) return "constraints";
  if (patch.directives !== undefined) return "directives";
  return "identity";
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/** Process-local soul store for tests and no-database deployments. */
export class InMemorySoulStore implements SoulStore {
  private readonly souls = new Map<string, SoulRecord>();
  private readonly revisions = new Map<string, SoulRevisionRecord[]>();

  private key(scope: AssistantScope): string {
    return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}`;
  }

  async get(scope: AssistantScope): Promise<SoulRecord> {
    const existing = this.souls.get(this.key(scope));
    if (existing !== undefined) return existing;
    const doc = emptySoulDocument();
    return {
      scope,
      ...doc,
      revision: 0,
      revisionHash: soulDocumentHash(doc),
      updatedAt: new Date(0).toISOString(),
    };
  }

  async mutate(input: SoulMutationInput): Promise<SoulMutationResult> {
    const current = await this.get(input.scope);
    const applied = prepareMutation({ current, input });
    if (!applied.changed) {
      return {
        record: current,
        changed: false,
        ignoredClasses: applied.ignoredClasses,
      };
    }
    const revision = current.revision + 1;
    const now = new Date().toISOString();
    const record: SoulRecord = {
      scope: input.scope,
      ...applied.next,
      revision,
      revisionHash: soulDocumentHash(applied.next),
      updatedAt: now,
    };
    this.souls.set(this.key(input.scope), record);
    const history = this.revisions.get(this.key(input.scope)) ?? [];
    history.push({
      scope: input.scope,
      revision,
      revisionHash: record.revisionHash,
      writeClass: revisionWriteClass(input.actorType, input.patch),
      actorType: input.actorType,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...applied.next,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      createdAt: now,
    });
    this.revisions.set(this.key(input.scope), history);
    return { record, changed: true, ignoredClasses: applied.ignoredClasses };
  }

  async history(scope: AssistantScope, limit?: number): Promise<SoulRevisionRecord[]> {
    const all = this.revisions.get(this.key(scope)) ?? [];
    return [...all].reverse().slice(0, boundLimit(limit));
  }

  async restore(params: {
    scope: AssistantScope;
    revision: number;
    actorType: SoulActorType;
    actorId?: string;
    expectedRevisionHash?: string;
  }): Promise<SoulMutationResult> {
    const all = this.revisions.get(this.key(params.scope)) ?? [];
    const target = all.find((r) => r.revision === params.revision);
    if (target === undefined) {
      throw new Error(`Soul revision ${params.revision} does not exist for this assistant.`);
    }
    return this.mutate({
      scope: params.scope,
      // Restore bypasses write-class containment by design: it re-applies a
      // document that was already validated when it was first written, and it is
      // only reachable from the operator plane.
      actorType: "system",
      ...(params.actorId !== undefined ? { actorId: params.actorId } : {}),
      ...(params.expectedRevisionHash !== undefined
        ? { expectedRevisionHash: params.expectedRevisionHash }
        : {}),
      reason: `Restored revision ${params.revision}`,
      patch: {
        identity: target.identity,
        directives: target.directives,
        constraints: target.constraints,
      },
    });
  }

  async purge(scope: AssistantScope): Promise<void> {
    this.souls.delete(this.key(scope));
    this.revisions.delete(this.key(scope));
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface SoulRow {
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  identity: unknown;
  directives: unknown;
  constraints: unknown;
  revision: number;
  revision_hash: string;
  updated_at: string | Date;
}

interface SoulRevisionRow extends SoulRow {
  write_class: string;
  actor_type: string;
  actor_id: string | null;
  reason: string | null;
  created_at: string | Date;
}

/**
 * JSONB arrives as an object from Bun's driver but as a string from some
 * pool configurations. Parse defensively rather than assuming, because the
 * failure mode is a soul that silently renders as empty.
 */
function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function rowToSoul(row: SoulRow): SoulRecord {
  const doc = normalizeSoulDocument({
    identity: parseJsonColumn(row.identity),
    directives: parseJsonColumn(row.directives),
    constraints: parseJsonColumn(row.constraints),
  });
  return {
    scope: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      assistantId: row.assistant_id,
    },
    ...doc,
    revision: Number(row.revision),
    // The stored hash is NOT recomputed from the normalised document on purpose.
    // It is the optimistic-lock token a concurrent writer compares against, so
    // it must be exactly the value that was written. Recomputing it here would
    // make the lock silently self-heal whenever normalisation changed a value —
    // which is the one case where a refusal is genuinely required.
    revisionHash: row.revision_hash,
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

/** Durable soul store with transactional revision history. */
export class PostgresSoulStore implements SoulStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  private scoped<T>(tenantId: string, cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  async get(scope: AssistantScope): Promise<SoulRecord> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<SoulRow>(
        `SELECT * FROM assistant_souls
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    const row = rows[0];
    if (row !== undefined) return rowToSoul(row);
    // No row yet. Return the empty document at revision 0 rather than creating
    // one: reading a soul is on the hot path of every turn, and a read that
    // writes would turn a replica-safe SELECT into a contended INSERT.
    const doc = emptySoulDocument();
    return {
      scope,
      ...doc,
      revision: 0,
      revisionHash: soulDocumentHash(doc),
      updatedAt: new Date(0).toISOString(),
    };
  }

  async mutate(input: SoulMutationInput): Promise<SoulMutationResult> {
    const { scope } = input;
    return this.scoped(scope.tenantId, async (db) => {
      // Read-modify-write inside the tenant transaction. `withTenant` already
      // opens one when RLS is enabled; when it is not, the compare-and-set in
      // the UPDATE's WHERE clause is what actually prevents the lost update, so
      // correctness does not depend on the transaction being present.
      const currentRows = await db.query<SoulRow>(
        `SELECT * FROM assistant_souls
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      );
      const currentRow = currentRows[0];
      const current = currentRow !== undefined ? rowToSoul(currentRow) : await this.get(scope);

      const applied = prepareMutation({ current, input });
      if (!applied.changed) {
        return {
          record: current,
          changed: false,
          ignoredClasses: applied.ignoredClasses,
        };
      }

      const revision = current.revision + 1;
      const revisionHash = soulDocumentHash(applied.next);
      const identityJson = JSON.stringify(applied.next.identity);
      const directivesJson = JSON.stringify(applied.next.directives);
      const constraintsJson = JSON.stringify(applied.next.constraints);

      const written =
        currentRow === undefined
          ? await db.query<SoulRow>(
              `INSERT INTO assistant_souls
                 (tenant_id, user_id, assistant_id, identity, directives,
                  constraints, revision, revision_hash, updated_at)
               VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, now())
               -- A concurrent first write inserted the row between our SELECT
               -- and here. The predicate makes this a compare-and-set: it
               -- matches only if the row is still at the revision we read, so
               -- the loser updates nothing and gets a conflict below.
               ON CONFLICT (tenant_id, user_id, assistant_id) DO UPDATE
                 SET identity = EXCLUDED.identity,
                     directives = EXCLUDED.directives,
                     constraints = EXCLUDED.constraints,
                     revision = EXCLUDED.revision,
                     revision_hash = EXCLUDED.revision_hash,
                     updated_at = now()
                 WHERE assistant_souls.revision = $9
               RETURNING *`,
              [
                scope.tenantId,
                scope.userId,
                scope.assistantId,
                identityJson,
                directivesJson,
                constraintsJson,
                revision,
                revisionHash,
                current.revision,
              ],
            )
          : await db.query<SoulRow>(
              `UPDATE assistant_souls
                  SET identity = $4::jsonb,
                      directives = $5::jsonb,
                      constraints = $6::jsonb,
                      revision = $7,
                      revision_hash = $8,
                      updated_at = now()
                WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
                  -- Compare-and-set on the revision we read. Without this a
                  -- writer that lost the race would overwrite the winner.
                  AND revision = $9
                RETURNING *`,
              [
                scope.tenantId,
                scope.userId,
                scope.assistantId,
                identityJson,
                directivesJson,
                constraintsJson,
                revision,
                revisionHash,
                current.revision,
              ],
            );

      const writtenRow = written[0];
      if (writtenRow === undefined) {
        // Zero rows affected means the compare-and-set failed: someone else
        // advanced the revision. Re-read so the error carries the real current
        // state rather than the stale one we started from.
        const latest = await this.get(scope);
        throw new SoulRevisionConflictError(latest.revision, latest.revisionHash);
      }

      await db.query(
        `INSERT INTO assistant_soul_revisions
           (tenant_id, user_id, assistant_id, revision, revision_hash,
            write_class, actor_type, actor_id, identity, directives,
            constraints, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
         -- Idempotent under retry: the (scope, revision) unique constraint means
         -- a replayed insert is a no-op rather than a duplicate history entry.
         ON CONFLICT (tenant_id, user_id, assistant_id, revision) DO NOTHING`,
        [
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          revision,
          revisionHash,
          revisionWriteClass(input.actorType, input.patch),
          input.actorType,
          input.actorId ?? null,
          identityJson,
          directivesJson,
          constraintsJson,
          input.reason ?? null,
        ],
      );

      this.logger?.debug("Soul mutated", {
        assistantId: scope.assistantId,
        revision,
        actorType: input.actorType,
      });
      return {
        record: rowToSoul(writtenRow),
        changed: true,
        ignoredClasses: applied.ignoredClasses,
      };
    });
  }

  async history(scope: AssistantScope, limit?: number): Promise<SoulRevisionRecord[]> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<SoulRevisionRow>(
        `SELECT * FROM assistant_soul_revisions
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
          ORDER BY revision DESC
          LIMIT $4`,
        [scope.tenantId, scope.userId, scope.assistantId, boundLimit(limit)],
      ),
    );
    return rows.map((row) => {
      const doc = normalizeSoulDocument({
        identity: parseJsonColumn(row.identity),
        directives: parseJsonColumn(row.directives),
        constraints: parseJsonColumn(row.constraints),
      });
      return {
        scope: {
          tenantId: row.tenant_id,
          userId: row.user_id,
          assistantId: row.assistant_id,
        },
        revision: Number(row.revision),
        revisionHash: row.revision_hash,
        writeClass: row.write_class as SoulWriteClass,
        actorType: row.actor_type as SoulActorType,
        ...(row.actor_id !== null ? { actorId: row.actor_id } : {}),
        ...doc,
        ...(row.reason !== null ? { reason: row.reason } : {}),
        createdAt: toIso(row.created_at) ?? new Date().toISOString(),
      };
    });
  }

  async restore(params: {
    scope: AssistantScope;
    revision: number;
    actorType: SoulActorType;
    actorId?: string;
    expectedRevisionHash?: string;
  }): Promise<SoulMutationResult> {
    const rows = await this.scoped(params.scope.tenantId, (db) =>
      db.query<SoulRevisionRow>(
        `SELECT * FROM assistant_soul_revisions
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND revision = $4`,
        [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.revision],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Soul revision ${params.revision} does not exist for this assistant.`);
    }
    const doc = normalizeSoulDocument({
      identity: parseJsonColumn(row.identity),
      directives: parseJsonColumn(row.directives),
      constraints: parseJsonColumn(row.constraints),
    });
    return this.mutate({
      scope: params.scope,
      actorType: "system",
      ...(params.actorId !== undefined ? { actorId: params.actorId } : {}),
      ...(params.expectedRevisionHash !== undefined
        ? { expectedRevisionHash: params.expectedRevisionHash }
        : {}),
      reason: `Restored revision ${params.revision}`,
      patch: {
        identity: doc.identity,
        directives: doc.directives,
        constraints: doc.constraints,
      },
    });
  }

  async purge(scope: AssistantScope): Promise<void> {
    await this.scoped(scope.tenantId, async (db) => {
      await db.query(
        `DELETE FROM assistant_soul_revisions
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      );
      await db.query(
        `DELETE FROM assistant_souls
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      );
    });
  }
}

/** Builds the durable store when a database is available, else in-memory. */
export function createSoulStore(params: { db?: Database; logger?: Logger }): SoulStore {
  return params.db !== undefined
    ? new PostgresSoulStore(params.db, params.logger)
    : new InMemorySoulStore();
}
