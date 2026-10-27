// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { AssistantScope } from "./types.js";
import type { TranscriptAppendInput, TranscriptEntry, TranscriptStore } from "./transcript-store.js";
import { jsonColumn } from "../db/json-column.js";

export type AssistantToolStatus =
  | "planned"
  | "awaiting_approval"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * Settled states. A journal row in one of these has no outstanding side effect,
 * so a reused tool call id may safely start a fresh attempt on it. `unknown`
 * is deliberately excluded: it means we cannot tell whether the side effect
 * happened, which only a manual reconcile may resolve.
 */
const REARMABLE_TOOL_STATUS: ReadonlySet<AssistantToolStatus> = new Set<AssistantToolStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export interface AssistantSessionSummary {
  conversationId: string;
  parentConversationId?: string;
  forkedFromSequence?: number;
  title?: string;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface AssistantSessionSnapshot {
  id: string;
  conversationId: string;
  sequence: number;
  kind: "summary" | "checkpoint";
  content: string;
  sourceFromSequence?: number;
  sourceToSequence?: number;
  createdAt: string;
}

/**
 * Raised when a journal row is no longer in a state that permits the requested
 * transition. Callers may tolerate this for bookkeeping that happens *after* an
 * external side effect (the outcome is already real), but must never tolerate it
 * for the durable intent written *before* a side effect.
 */
export class ToolJournalConflictError extends Error {
  constructor(readonly status: AssistantToolStatus) {
    super("Tool journal transition rejected because the current state changed.");
    this.name = "ToolJournalConflictError";
  }
}

export interface AssistantToolJournalEntry {
  conversationId: string;
  toolCallId: string;
  operationId: string;
  sequence: number;
  executionId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: AssistantToolStatus;
  attempts: number;
  leaseExpiresAt?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantToolJournal {
  beforeTool(params: {
    scope: AssistantScope;
    conversationId: string;
    executionId: string;
    toolCallId: string;
    tool: string;
    args: Record<string, unknown>;
    operationId?: string;
    leaseMs?: number;
  }): Promise<undefined | { operationId: string }>;
  startTool?(params: {
    scope: AssistantScope;
    conversationId: string;
    toolCallId: string;
    workerId: string;
    leaseMs?: number;
  }): Promise<boolean>;
  markAwaitingApproval?(params: {
    scope: AssistantScope;
    conversationId: string;
    toolCallId: string;
    approvalId?: string;
  }): Promise<void>;
  /** Returns an approved journal entry to pending so its worker can acquire a fresh lease. */
  resumeApprovedTool?(params: {
    scope: AssistantScope;
    conversationId: string;
    toolCallId: string;
  }): Promise<boolean>;
  claimTool?(params: {
    scope: AssistantScope;
    conversationId: string;
    toolCallId: string;
    workerId: string;
    leaseMs?: number;
  }): Promise<boolean>;
  completeTool(params: {
    scope: AssistantScope;
    conversationId: string;
    toolCallId: string;
    succeeded: boolean;
    result?: unknown;
    error?: unknown;
  }): Promise<void>;
  cancelTool?(params: {
    scope: AssistantScope;
    conversationId: string;
    toolCallId: string;
    reason: string;
  }): Promise<void>;
  recoverExpired?(scope: AssistantScope, limit?: number): Promise<AssistantToolJournalEntry[]>;
  listRecoverable?(scope: AssistantScope, limit?: number): Promise<AssistantToolJournalEntry[]>;
  reconcileUnknown?(params: {
    scope: AssistantScope;
    conversationId: string;
    toolCallId: string;
    status: "completed" | "failed" | "cancelled";
    result?: unknown;
    reason?: string;
  }): Promise<AssistantToolJournalEntry | undefined>;
}

export interface AssistantSessionStore extends TranscriptStore, AssistantToolJournal {
  listSessions(scope: AssistantScope, options?: { includeDeleted?: boolean; limit?: number }): Promise<AssistantSessionSummary[]>;
  forkSession(params: {
    scope: AssistantScope;
    sourceConversationId: string;
    conversationId: string;
    sequence?: number;
    title?: string;
  }): Promise<AssistantSessionSummary>;
  softDeleteSession(scope: AssistantScope, conversationId: string): Promise<boolean>;
  restoreSession(scope: AssistantScope, conversationId: string): Promise<boolean>;
  createSnapshot(params: {
    scope: AssistantScope;
    conversationId: string;
    sequence: number;
    kind: "summary" | "checkpoint";
    content: string;
    sourceFromSequence?: number;
    sourceToSequence?: number;
  }): Promise<AssistantSessionSnapshot>;
  listSnapshots(scope: AssistantScope, conversationId: string): Promise<AssistantSessionSnapshot[]>;
}

export class PostgresAssistantSessionStore implements AssistantSessionStore {
  constructor(private readonly db: Database) {}

  async append(scope: AssistantScope, entry: TranscriptAppendInput): Promise<TranscriptEntry> {
    // The event and its projection intent are committed on the same DB connection.
    // Workspace I/O is deliberately deferred: a local disk failure must never roll
    // back the authoritative transcript.
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    let sequence = 0;
    await this.inTenant(scope, async (db) => {
      sequence = await this.nextSequence(db, scope, entry.conversationId);
      await db.query(
        `INSERT INTO assistant_session_events
           (id, tenant_id, user_id, assistant_id, conversation_id, sequence, execution_id, role, name, content, event_kind, created_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, $9, $10, 'transcript', $11::timestamptz)`,
        [id, scope.tenantId, scope.userId, scope.assistantId, entry.conversationId, sequence,
          entry.executionId, entry.role, entry.name ?? null, entry.content, createdAt],
      );
      const persisted: TranscriptEntry = { version: 1, id, executionId: entry.executionId,
        conversationId: entry.conversationId, role: entry.role, content: entry.content, sequence,
        ...(entry.name !== undefined ? { name: entry.name } : {}), createdAt };
      await db.query(
        `INSERT INTO assistant_mirror_outbox
           (id, tenant_id, user_id, assistant_id, conversation_id, event_id, payload)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::text::jsonb)
         ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        [crypto.randomUUID(), scope.tenantId, scope.userId, scope.assistantId, entry.conversationId, id,
          JSON.stringify(persisted)],
      );
    });
    return { version: 1, id, executionId: entry.executionId, conversationId: entry.conversationId,
      role: entry.role, content: entry.content, sequence,
      ...(entry.name !== undefined ? { name: entry.name } : {}), createdAt };
  }

  async read(scope: AssistantScope, conversationId: string, limit = 80): Promise<TranscriptEntry[]> {
    const boundedLimit = Math.min(Math.max(limit, 0), 1_000);
    if (boundedLimit === 0) return [];
    const visited = new Set<string>();
    const segments: TranscriptEntry[][] = [];
    let currentConversationId: string | undefined = conversationId;
    let maximumSequence: number | undefined;
    let remaining = boundedLimit;
    const maxDepth = 32;

    for (let depth = 0; currentConversationId !== undefined && remaining > 0; depth += 1) {
      if (depth >= maxDepth) throw new Error("Assistant session lineage exceeds the maximum depth.");
      if (visited.has(currentConversationId)) throw new Error("Assistant session lineage contains a cycle.");
      visited.add(currentConversationId);

      const [session] = await this.inTenant(scope, (db) => db.query<SessionRow>(
        `SELECT conversation_id, parent_conversation_id, forked_from_sequence, title, last_sequence, created_at, updated_at, deleted_at
           FROM assistant_sessions
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, currentConversationId],
      ));
      if (session === undefined) break;
      const rows = await this.inTenant(scope, (db) => db.query<SessionEventRow>(
        `SELECT id, execution_id, conversation_id, sequence, role, name, content, created_at
           FROM assistant_session_events
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4
            AND ($5::bigint IS NULL OR sequence <= $5)
          ORDER BY sequence DESC LIMIT $6`,
        [scope.tenantId, scope.userId, scope.assistantId, currentConversationId, maximumSequence ?? null, remaining],
      ));
      const segment = rows.reverse().map((row) => this.toEntry(currentConversationId as string, row));
      segments.unshift(segment);
      remaining -= segment.length;
      currentConversationId = session.parent_conversation_id ?? undefined;
      maximumSequence = session.forked_from_sequence === null ? undefined : Number(session.forked_from_sequence);
    }
    return segments.flat().slice(-boundedLimit);
  }

  /** Search is intentionally delegated to Vectorsearch. This fallback preserves the TranscriptStore contract. */
  async search(scope: AssistantScope, query: string, limit = 20): Promise<TranscriptEntry[]> {
    const needle = query.trim();
    if (needle === "") return [];
    const rows = await this.inTenant(scope, (db) => db.query<SessionEventRow>(
      `SELECT id, execution_id, conversation_id, sequence, role, name, content, created_at
         FROM assistant_session_events
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
          AND search_document @@ websearch_to_tsquery('simple', $4)
        ORDER BY created_at DESC LIMIT $5`,
      [scope.tenantId, scope.userId, scope.assistantId, needle, limit],
    ));
    return rows.map((row) => this.toEntry(row.conversation_id, row));
  }

  async listSessions(scope: AssistantScope, options: { includeDeleted?: boolean; limit?: number } = {}): Promise<AssistantSessionSummary[]> {
    const rows = await this.inTenant(scope, (db) => db.query<SessionRow>(
      `SELECT conversation_id, parent_conversation_id, forked_from_sequence, title, last_sequence, created_at, updated_at, deleted_at
         FROM assistant_sessions
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
          AND ($4::boolean OR deleted_at IS NULL)
        ORDER BY updated_at DESC LIMIT $5`,
      [scope.tenantId, scope.userId, scope.assistantId, options.includeDeleted === true, Math.min(Math.max(options.limit ?? 50, 1), 200)],
    ));
    return rows.map(this.toSessionSummary);
  }

  async forkSession(params: Parameters<AssistantSessionStore["forkSession"]>[0]): Promise<AssistantSessionSummary> {
    if (params.sourceConversationId === params.conversationId) throw new Error("A session cannot fork from itself.");
    const source = await this.inTenant(params.scope, (db) => db.query<SessionRow>(
      `SELECT conversation_id, last_sequence FROM assistant_sessions
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND deleted_at IS NULL`,
      [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.sourceConversationId],
    ));
    const sourceRow = source[0];
    if (sourceRow === undefined) throw new Error("Source session not found.");
    const forkSequence = Math.min(Math.max(params.sequence ?? Number(sourceRow.last_sequence), 0), Number(sourceRow.last_sequence));
    const rows = await this.inTenant(params.scope, (db) => db.query<SessionRow>(
      `INSERT INTO assistant_sessions
         (tenant_id, user_id, assistant_id, conversation_id, parent_conversation_id, forked_from_sequence, title, last_sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
       ON CONFLICT (tenant_id, user_id, assistant_id, conversation_id) DO NOTHING
       RETURNING conversation_id, parent_conversation_id, forked_from_sequence, title, last_sequence, created_at, updated_at, deleted_at`,
      [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId,
        params.sourceConversationId, forkSequence, params.title ?? null],
    ));
    const row = rows[0];
    if (row === undefined) throw new Error("Target session already exists.");
    return this.toSessionSummary(row);
  }

  async softDeleteSession(scope: AssistantScope, conversationId: string): Promise<boolean> {
    return this.setDeleted(scope, conversationId, true);
  }

  async restoreSession(scope: AssistantScope, conversationId: string): Promise<boolean> {
    return this.setDeleted(scope, conversationId, false);
  }

  async createSnapshot(params: Parameters<AssistantSessionStore["createSnapshot"]>[0]): Promise<AssistantSessionSnapshot> {
    const id = crypto.randomUUID();
    const fingerprint = crypto.createHash("sha256").update(params.content).digest("hex");
    const rows = await this.inTenant(params.scope, (db) => db.query<SnapshotRow>(
      `WITH inserted AS (
         INSERT INTO assistant_session_snapshots
           (id, tenant_id, user_id, assistant_id, conversation_id, sequence, kind, content,
            source_from_sequence, source_to_sequence, content_fingerprint)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, user_id, assistant_id, conversation_id, sequence, kind, content_fingerprint)
         DO NOTHING
         RETURNING id, conversation_id, sequence, kind, content, source_from_sequence, source_to_sequence, created_at
       ), existing AS (
         SELECT id, conversation_id, sequence, kind, content, source_from_sequence, source_to_sequence, created_at
           FROM assistant_session_snapshots
          WHERE tenant_id = $2 AND user_id = $3 AND assistant_id = $4 AND conversation_id = $5
            AND sequence = $6 AND kind = $7 AND content_fingerprint = $11
          ORDER BY created_at DESC LIMIT 1
       )
       SELECT * FROM inserted UNION ALL SELECT * FROM existing LIMIT 1`,
      [id, params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId,
        params.sequence, params.kind, params.content, params.sourceFromSequence ?? null,
        params.sourceToSequence ?? null, fingerprint],
    ));
    const row = rows[0];
    if (row === undefined) throw new Error("Could not create session snapshot.");
    return this.toSnapshot(row);
  }

  async listSnapshots(scope: AssistantScope, conversationId: string): Promise<AssistantSessionSnapshot[]> {
    const rows = await this.inTenant(scope, (db) => db.query<SnapshotRow>(
      `SELECT id, conversation_id, sequence, kind, content, source_from_sequence, source_to_sequence, created_at
         FROM assistant_session_snapshots
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4
        ORDER BY sequence DESC, created_at DESC`,
      [scope.tenantId, scope.userId, scope.assistantId, conversationId],
    ));
    return rows.map((row) => this.toSnapshot(row));
  }

  async beforeTool(params: Parameters<AssistantToolJournal["beforeTool"]>[0]): Promise<{ operationId: string }> {
    const operationId = params.operationId ?? crypto.randomUUID();
    await this.inTenant(params.scope, async (db) => {
      const existing = await db.query<{ operation_id: string; status: AssistantToolStatus }>(
        `SELECT operation_id, status FROM assistant_tool_journal
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND tool_call_id = $5`,
        [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId, params.toolCallId],
      );
      // An in-flight or unresolved row keeps at-most-once semantics: the caller
      // fails closed when it cannot acquire the lease. A settled row means the
      // call id was reused (providers do not guarantee globally unique tool call
      // ids), so re-arm it as a new attempt instead of wedging the conversation.
      const previous = existing[0];
      if (previous !== undefined && !REARMABLE_TOOL_STATUS.has(previous.status)) return;
      const leaseMs = Math.min(Math.max(params.leaseMs ?? 60_000, 1_000), 15 * 60_000);
      if (previous !== undefined) {
        await db.query(
          `UPDATE assistant_tool_journal
              SET operation_id = $6, execution_id = $7::uuid, tool_name = $8, args = $9::text::jsonb, status = 'pending',
                  attempts = attempts + 1, result = NULL, error = NULL, approval_id = NULL, completed_at = NULL,
                  lease_owner = NULL, lease_expires_at = now() + ($10::bigint * interval '1 millisecond'), updated_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND tool_call_id = $5
              AND status IN ('completed', 'failed', 'cancelled')`,
          [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId, params.toolCallId,
            operationId, params.executionId, params.tool, JSON.stringify(params.args), leaseMs],
        );
        return;
      }
      const sequence = await this.nextSequence(db, params.scope, params.conversationId);
      await db.query(
        `INSERT INTO assistant_tool_journal
           (tenant_id, user_id, assistant_id, conversation_id, tool_call_id, operation_id, sequence, execution_id,
            tool_name, args, status, attempts, lease_expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10::text::jsonb, 'pending', 1,
                 now() + ($11::bigint * interval '1 millisecond'), now())`,
        [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId, params.toolCallId,
          operationId, sequence, params.executionId, params.tool, JSON.stringify(params.args), leaseMs],
      );
    });
    return { operationId };
  }

  async startTool(params: Parameters<NonNullable<AssistantToolJournal["startTool"]>>[0]): Promise<boolean> {
    const leaseMs = Math.min(Math.max(params.leaseMs ?? 60_000, 1_000), 15 * 60_000);
    const rows = await this.inTenant(params.scope, (db) => db.query<{ tool_call_id: string }>(
      `UPDATE assistant_tool_journal
          SET status = 'running', lease_owner = $6, lease_expires_at = now() + ($7::bigint * interval '1 millisecond'), updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND tool_call_id = $5
          AND status = 'pending'
        RETURNING tool_call_id`,
      [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId, params.toolCallId,
        params.workerId, leaseMs],
    ));
    return rows.length === 1;
  }

  async markAwaitingApproval(params: Parameters<NonNullable<AssistantToolJournal["markAwaitingApproval"]>>[0]): Promise<void> {
    await this.updateToolStatus(params.scope, params.conversationId, params.toolCallId, "awaiting_approval", {
      approvalId: params.approvalId,
    });
  }

  async resumeApprovedTool(params: Parameters<NonNullable<AssistantToolJournal["resumeApprovedTool"]>>[0]): Promise<boolean> {
    const rows = await this.inTenant(params.scope, (db) => db.query<{ tool_call_id: string }>(
      `UPDATE assistant_tool_journal
          SET status = 'pending', updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND tool_call_id = $5
          AND status = 'awaiting_approval'
        RETURNING tool_call_id`,
      [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId, params.toolCallId],
    ));
    return rows.length === 1;
  }

  async claimTool(params: Parameters<NonNullable<AssistantToolJournal["claimTool"]>>[0]): Promise<boolean> {
    const leaseMs = Math.min(Math.max(params.leaseMs ?? 60_000, 1_000), 15 * 60_000);
    const rows = await this.inTenant(params.scope, (db) => db.query<{ tool_call_id: string }>(
      `UPDATE assistant_tool_journal
          SET status = 'running', lease_owner = $6, lease_expires_at = now() + ($7::bigint * interval '1 millisecond'),
              attempts = attempts + 1, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND tool_call_id = $5
          AND status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= now())
        RETURNING tool_call_id`,
      [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId, params.toolCallId,
        params.workerId, leaseMs],
    ));
    return rows.length === 1;
  }

  async completeTool(params: Parameters<AssistantToolJournal["completeTool"]>[0]): Promise<void> {
    await this.updateToolStatus(params.scope, params.conversationId, params.toolCallId, params.succeeded ? "completed" : "failed", {
      result: params.result,
      error: params.error === undefined ? undefined : String(params.error),
    });
  }

  async cancelTool(params: Parameters<NonNullable<AssistantToolJournal["cancelTool"]>>[0]): Promise<void> {
    await this.updateToolStatus(params.scope, params.conversationId, params.toolCallId, "cancelled", { error: params.reason });
  }

  async recoverExpired(scope: AssistantScope, limit = 50): Promise<AssistantToolJournalEntry[]> {
    const rows = await this.inTenant(scope, (db) => db.query<ToolRow>(
      `UPDATE assistant_tool_journal
          SET status = 'unknown', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE (tenant_id, user_id, assistant_id, conversation_id, tool_call_id) IN (
          SELECT tenant_id, user_id, assistant_id, conversation_id, tool_call_id
            FROM assistant_tool_journal
           WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
             AND status IN ('pending', 'running') AND lease_expires_at <= now()
           ORDER BY lease_expires_at ASC LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING conversation_id, tool_call_id, operation_id, sequence, execution_id, tool_name, args, status, attempts,
                  lease_expires_at, result, error, created_at, updated_at`,
      [scope.tenantId, scope.userId, scope.assistantId, Math.min(Math.max(limit, 1), 200)],
    ));
    return rows.map((row) => this.toToolEntry(row));
  }

  async listRecoverable(scope: AssistantScope, limit = 50): Promise<AssistantToolJournalEntry[]> {
    const rows = await this.inTenant(scope, (db) => db.query<ToolRow>(
      `SELECT conversation_id, tool_call_id, operation_id, sequence, execution_id, tool_name, args, status, attempts,
              lease_expires_at, result, error, created_at, updated_at
         FROM assistant_tool_journal
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
          AND status IN ('unknown', 'pending', 'running')
        ORDER BY updated_at ASC LIMIT $4`,
      [scope.tenantId, scope.userId, scope.assistantId, Math.min(Math.max(limit, 1), 200)],
    ));
    return rows.map((row) => this.toToolEntry(row));
  }

  async reconcileUnknown(params: Parameters<NonNullable<AssistantToolJournal["reconcileUnknown"]>>[0]): Promise<AssistantToolJournalEntry | undefined> {
    const rows = await this.inTenant(params.scope, (db) => db.query<ToolRow>(
      `UPDATE assistant_tool_journal
          SET status = $6, result = CASE WHEN $7::text::jsonb IS NULL THEN result ELSE $7::text::jsonb END,
              error = CASE WHEN $8::text IS NULL THEN error ELSE $8::text END,
              lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND tool_call_id = $5
          AND status = 'unknown'
        RETURNING conversation_id, tool_call_id, operation_id, sequence, execution_id, tool_name, args, status, attempts,
                  lease_expires_at, result, error, created_at, updated_at`,
      [params.scope.tenantId, params.scope.userId, params.scope.assistantId, params.conversationId, params.toolCallId,
        params.status, params.result === undefined ? null : JSON.stringify(params.result), params.reason ?? null],
    ));
    const row = rows[0];
    return row === undefined ? undefined : this.toToolEntry(row);
  }

  private async setDeleted(scope: AssistantScope, conversationId: string, deleted: boolean): Promise<boolean> {
    const rows = await this.inTenant(scope, (db) => db.query<{ conversation_id: string }>(
      `UPDATE assistant_sessions SET deleted_at = ${deleted ? "now()" : "NULL"}, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4
        RETURNING conversation_id`,
      [scope.tenantId, scope.userId, scope.assistantId, conversationId],
    ));
    return rows.length === 1;
  }

  private async updateToolStatus(scope: AssistantScope, conversationId: string, toolCallId: string, status: AssistantToolStatus, data: { result?: unknown; error?: string; approvalId?: string }): Promise<void> {
    // `pending` is accepted for terminal transitions because `startTool` is an
    // optional part of the journal contract: a journal without leases moves
    // straight from the durable intent to its outcome. `awaiting_approval` may
    // fail directly when the approval continuation itself throws.
    const allowedFrom: AssistantToolStatus[] = status === "awaiting_approval"
      ? ["running"]
      : status === "cancelled"
        ? ["pending", "running", "awaiting_approval"]
        : status === "completed"
          ? ["running", "pending"]
          : status === "failed"
            ? ["running", "pending", "awaiting_approval"]
            : [];
    if (allowedFrom.length === 0) throw new Error(`Unsupported tool journal transition to ${status}.`);
    const rows = await this.inTenant(scope, (db) => db.query<{ tool_call_id: string }>(
      `UPDATE assistant_tool_journal
          SET status = $6, result = COALESCE($7::text::jsonb, result), error = COALESCE($8, error), approval_id = COALESCE($9, approval_id),
              lease_owner = NULL, lease_expires_at = NULL, completed_at = CASE WHEN $6 IN ('completed', 'failed', 'cancelled') THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND conversation_id = $4 AND tool_call_id = $5
          AND status IN (
            SELECT jsonb_array_elements_text(
              CASE jsonb_typeof($10::text::jsonb)
                WHEN 'array' THEN $10::text::jsonb
                ELSE jsonb_build_array($10::text::jsonb)
              END
            )
          )
        RETURNING tool_call_id`,
      [scope.tenantId, scope.userId, scope.assistantId, conversationId, toolCallId, status,
        data.result === undefined ? null : JSON.stringify(data.result), data.error ?? null, data.approvalId ?? null, JSON.stringify(allowedFrom)],
    ));
    if (rows.length !== 1) throw new ToolJournalConflictError(status);
  }

  private async nextSequence(db: Database, scope: AssistantScope, conversationId: string): Promise<number> {
    const rows = await db.query<{ last_sequence: number | string }>(
      `INSERT INTO assistant_sessions (tenant_id, user_id, assistant_id, conversation_id, last_sequence)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (tenant_id, user_id, assistant_id, conversation_id)
       DO UPDATE SET last_sequence = assistant_sessions.last_sequence + 1, updated_at = now()
       RETURNING last_sequence`,
      [scope.tenantId, scope.userId, scope.assistantId, conversationId],
    );
    return Number(rows[0]?.last_sequence ?? 1);
  }

  private inTenant<T>(scope: AssistantScope, fn: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(scope.tenantId, fn) : fn(this.db);
  }

  private toEntry(conversationId: string, row: SessionEventRow): TranscriptEntry {
    return { version: 1, id: row.id, executionId: row.execution_id, conversationId, role: row.role as TranscriptEntry["role"],
      content: row.content, sequence: Number(row.sequence), ...(row.name !== null ? { name: row.name } : {}), createdAt: this.iso(row.created_at) };
  }

  private toSessionSummary = (row: SessionRow): AssistantSessionSummary => ({
    conversationId: row.conversation_id, ...(row.parent_conversation_id !== null ? { parentConversationId: row.parent_conversation_id } : {}),
    ...(row.forked_from_sequence !== null ? { forkedFromSequence: Number(row.forked_from_sequence) } : {}),
    ...(row.title !== null ? { title: row.title } : {}), lastSequence: Number(row.last_sequence), createdAt: this.iso(row.created_at),
    updatedAt: this.iso(row.updated_at), ...(row.deleted_at !== null ? { deletedAt: this.iso(row.deleted_at) } : {}),
  });

  private toSnapshot(row: SnapshotRow): AssistantSessionSnapshot {
    return { id: row.id, conversationId: row.conversation_id, sequence: Number(row.sequence), kind: row.kind,
      content: row.content, ...(row.source_from_sequence !== null ? { sourceFromSequence: Number(row.source_from_sequence) } : {}),
      ...(row.source_to_sequence !== null ? { sourceToSequence: Number(row.source_to_sequence) } : {}), createdAt: this.iso(row.created_at) };
  }

  private toToolEntry(row: ToolRow): AssistantToolJournalEntry {
    return { conversationId: row.conversation_id, toolCallId: row.tool_call_id, operationId: row.operation_id,
      sequence: Number(row.sequence), executionId: row.execution_id, toolName: row.tool_name,
      args: jsonColumn<Record<string, unknown>>(row.args) ?? {}, status: row.status as AssistantToolStatus, attempts: Number(row.attempts),
      ...(row.lease_expires_at !== null ? { leaseExpiresAt: this.iso(row.lease_expires_at) } : {}),
      ...(row.result !== null ? { result: jsonColumn(row.result) } : {}), ...(row.error !== null ? { error: row.error } : {}),
      createdAt: this.iso(row.created_at), updatedAt: this.iso(row.updated_at) };
  }

  private iso(value: string | Date): string { return new Date(value).toISOString(); }
}

interface SessionEventRow { id: string; execution_id: string; conversation_id: string; sequence: number | string; role: string; name: string | null; content: string; created_at: string | Date; }
interface SessionRow { conversation_id: string; parent_conversation_id: string | null; forked_from_sequence: number | string | null; title: string | null; last_sequence: number | string; created_at: string | Date; updated_at: string | Date; deleted_at: string | Date | null; }
interface SnapshotRow { id: string; conversation_id: string; sequence: number | string; kind: "summary" | "checkpoint"; content: string; source_from_sequence: number | string | null; source_to_sequence: number | string | null; created_at: string | Date; }
interface ToolRow { conversation_id: string; tool_call_id: string; operation_id: string; sequence: number | string; execution_id: string; tool_name: string; args: unknown; status: string; attempts: number | string; lease_expires_at: string | Date | null; result: unknown | null; error: string | null; created_at: string | Date; updated_at: string | Date; }

/** Uses Postgres as the source of truth; its outbox is the only workspace projection path. */
export class MirroredTranscriptStore implements TranscriptStore {
  constructor(private readonly primary: TranscriptStore, _replica: TranscriptStore) {
    void _replica;
  }
  async append(scope: AssistantScope, entry: TranscriptAppendInput): Promise<TranscriptEntry> {
    return this.primary.append(scope, entry);
  }
  async read(scope: AssistantScope, conversationId: string, limit?: number): Promise<TranscriptEntry[]> { return this.primary.read(scope, conversationId, limit); }
  async search(scope: AssistantScope, query: string, limit?: number): Promise<TranscriptEntry[]> { return this.primary.search(scope, query, limit); }
}
