// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Inter-assistant messaging persistence (`src/assistants/messaging-store.ts`)
 *
 * Stores grants and the message queue. The rules live in `messaging-policy.ts`;
 * this module owns durability and the two queries the policy needs to make its
 * decision (recent send count, pending inbox count).
 *
 * ## Scoping note
 *
 * A grant and a message reference TWO scopes, so neither can be read under a single
 * tenant context when the two sides are in different tenants. Cross-tenant reads go
 * through `withOperator`, matching how the platform already handles its
 * intentionally tenant-agnostic paths (execution history, cost, audit).
 *
 * That is a deliberate, narrow exception and it is safe because the queries are
 * fully keyed by both scopes: a caller can only read rows whose sender AND receiver
 * it names, and the policy layer has already established that it may.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import { toIso } from "./assistant-store.js";
import { MESSAGE_RATE_WINDOW_MS, isGrantActive } from "./messaging-policy.js";
import type {
  AssistantGrant,
  AssistantMessage,
  AssistantMessageStatus,
  AssistantScope,
  GrantScope,
} from "./types.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface GrantCreateInput {
  from: AssistantScope;
  to: AssistantScope;
  scope: GrantScope;
  /** Receiver's user id. Validated by the policy before this is called. */
  grantedBy: string;
  note?: string;
  expiresAt?: string;
}

export interface MessageEnqueueInput {
  grantId: string;
  from: AssistantScope;
  to: AssistantScope;
  subject: string;
  body: string;
  correlationId?: string;
}

export interface MessagingStore {
  createGrant(input: GrantCreateInput): Promise<AssistantGrant>;
  /** The grant for one directed pair, or `undefined`. */
  findGrant(from: AssistantScope, to: AssistantScope): Promise<AssistantGrant | undefined>;
  /** Grants where this assistant is the receiver — what it has accepted. */
  listIncomingGrants(to: AssistantScope): Promise<AssistantGrant[]>;
  /** Grants where this assistant is the sender — where it may write. */
  listOutgoingGrants(from: AssistantScope): Promise<AssistantGrant[]>;
  revokeGrant(grantId: string): Promise<void>;
  enqueue(input: MessageEnqueueInput): Promise<AssistantMessage>;
  /** Undelivered messages for a receiver, oldest first. */
  listInbox(to: AssistantScope, limit?: number): Promise<AssistantMessage[]>;
  /** Marks messages delivered so they are not re-injected next turn. */
  markDelivered(messageIds: readonly string[]): Promise<void>;
  markFailed(messageId: string, error: string): Promise<void>;
  /** Undelivered count, for the inbox-full check. */
  countPendingInbox(to: AssistantScope): Promise<number>;
  /** Sends from one assistant to one other inside the rate window. */
  countRecentSends(from: AssistantScope, to: AssistantScope, now: number): Promise<number>;
  /** Removes grants and messages touching this assistant, in either direction. */
  purge(scope: AssistantScope): Promise<void>;
}

const DEFAULT_INBOX_LIMIT = 20;
const MAX_INBOX_LIMIT = 100;

function boundLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_INBOX_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_INBOX_LIMIT);
}

function scopeKeyOf(scope: AssistantScope): string {
  return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}`;
}

function pairKey(from: AssistantScope, to: AssistantScope): string {
  return `${scopeKeyOf(from)}\u001e${scopeKeyOf(to)}`;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/** Process-local messaging store for tests and no-database deployments. */
export class InMemoryMessagingStore implements MessagingStore {
  private readonly grants = new Map<string, AssistantGrant>();
  private readonly messages = new Map<string, AssistantMessage>();

  async createGrant(input: GrantCreateInput): Promise<AssistantGrant> {
    const existing = await this.findGrant(input.from, input.to);
    const grant: AssistantGrant = {
      // Re-granting reuses the id so message rows that reference it stay valid.
      // A new id would orphan the history of the previous channel.
      id: existing?.id ?? crypto.randomUUID(),
      from: input.from,
      to: input.to,
      scope: input.scope,
      grantedBy: input.grantedBy,
      ...(input.note !== undefined ? { note: input.note } : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  async findGrant(from: AssistantScope, to: AssistantScope): Promise<AssistantGrant | undefined> {
    const key = pairKey(from, to);
    return [...this.grants.values()].find((grant) => pairKey(grant.from, grant.to) === key);
  }

  async listIncomingGrants(to: AssistantScope): Promise<AssistantGrant[]> {
    const key = scopeKeyOf(to);
    return [...this.grants.values()].filter((grant) => scopeKeyOf(grant.to) === key);
  }

  async listOutgoingGrants(from: AssistantScope): Promise<AssistantGrant[]> {
    const key = scopeKeyOf(from);
    return [...this.grants.values()].filter((grant) => scopeKeyOf(grant.from) === key);
  }

  async revokeGrant(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (grant === undefined) return;
    this.grants.set(grantId, {
      ...grant,
      revokedAt: new Date().toISOString(),
    });
  }

  async enqueue(input: MessageEnqueueInput): Promise<AssistantMessage> {
    const message: AssistantMessage = {
      id: crypto.randomUUID(),
      grantId: input.grantId,
      from: input.from,
      to: input.to,
      subject: input.subject,
      body: input.body,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.messages.set(message.id, message);
    return message;
  }

  async listInbox(to: AssistantScope, limit?: number): Promise<AssistantMessage[]> {
    const key = scopeKeyOf(to);
    return [...this.messages.values()]
      .filter((message) => scopeKeyOf(message.to) === key && message.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, boundLimit(limit));
  }

  async markDelivered(messageIds: readonly string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const id of messageIds) {
      const message = this.messages.get(id);
      if (message === undefined || message.status !== "pending") continue;
      this.messages.set(id, {
        ...message,
        status: "delivered",
        deliveredAt: now,
      });
    }
  }

  async markFailed(messageId: string, error: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (message === undefined) return;
    this.messages.set(messageId, {
      ...message,
      status: "failed",
      deliveryError: error,
    });
  }

  async countPendingInbox(to: AssistantScope): Promise<number> {
    return (await this.listInbox(to, MAX_INBOX_LIMIT)).length;
  }

  async countRecentSends(from: AssistantScope, to: AssistantScope, now: number): Promise<number> {
    const key = pairKey(from, to);
    const windowStart = now - MESSAGE_RATE_WINDOW_MS;
    return [...this.messages.values()].filter(
      (message) =>
        pairKey(message.from, message.to) === key && Date.parse(message.createdAt) >= windowStart,
    ).length;
  }

  async purge(scope: AssistantScope): Promise<void> {
    const key = scopeKeyOf(scope);
    for (const [id, grant] of [...this.grants.entries()]) {
      if (scopeKeyOf(grant.from) === key || scopeKeyOf(grant.to) === key) {
        this.grants.delete(id);
      }
    }
    for (const [id, message] of [...this.messages.entries()]) {
      if (scopeKeyOf(message.from) === key || scopeKeyOf(message.to) === key) {
        this.messages.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface GrantRow {
  id: string;
  from_tenant_id: string;
  from_user_id: string;
  from_assistant_id: string;
  to_tenant_id: string;
  to_user_id: string;
  to_assistant_id: string;
  scope: string;
  granted_by: string;
  note: string | null;
  created_at: string | Date;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
}

interface MessageRow {
  id: string;
  grant_id: string;
  from_tenant_id: string;
  from_user_id: string;
  from_assistant_id: string;
  to_tenant_id: string;
  to_user_id: string;
  to_assistant_id: string;
  subject: string;
  body: string;
  correlation_id: string | null;
  status: string;
  delivered_at: string | Date | null;
  delivery_error: string | null;
  created_at: string | Date;
}

function rowToGrant(row: GrantRow): AssistantGrant {
  const expiresAt = toIso(row.expires_at);
  const revokedAt = toIso(row.revoked_at);
  return {
    id: row.id,
    from: {
      tenantId: row.from_tenant_id,
      userId: row.from_user_id,
      assistantId: row.from_assistant_id,
    },
    to: {
      tenantId: row.to_tenant_id,
      userId: row.to_user_id,
      assistantId: row.to_assistant_id,
    },
    scope: row.scope as GrantScope,
    grantedBy: row.granted_by,
    ...(row.note !== null ? { note: row.note } : {}),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(revokedAt !== undefined ? { revokedAt } : {}),
  };
}

function rowToMessage(row: MessageRow): AssistantMessage {
  const deliveredAt = toIso(row.delivered_at);
  return {
    id: row.id,
    grantId: row.grant_id,
    from: {
      tenantId: row.from_tenant_id,
      userId: row.from_user_id,
      assistantId: row.from_assistant_id,
    },
    to: {
      tenantId: row.to_tenant_id,
      userId: row.to_user_id,
      assistantId: row.to_assistant_id,
    },
    subject: row.subject,
    body: row.body,
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    status: row.status as AssistantMessageStatus,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(row.delivery_error !== null ? { deliveryError: row.delivery_error } : {}),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

/** Durable messaging store. */
export class PostgresMessagingStore implements MessagingStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  /**
   * Grants and messages name two scopes that may be in different tenants, so a
   * single tenant GUC cannot cover both. These queries are fully keyed by BOTH
   * scopes, so a caller can only reach rows whose sender and receiver it already
   * named — and the policy layer has established it may.
   */
  private cross<T>(cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withOperator(cb);
  }

  async createGrant(input: GrantCreateInput): Promise<AssistantGrant> {
    const rows = await this.cross((db) =>
      db.query<GrantRow>(
        `INSERT INTO assistant_grants
           (id, from_tenant_id, from_user_id, from_assistant_id,
            to_tenant_id, to_user_id, to_assistant_id,
            scope, granted_by, note, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (from_tenant_id, from_user_id, from_assistant_id,
                      to_tenant_id, to_user_id, to_assistant_id) DO UPDATE
           SET scope = EXCLUDED.scope,
               granted_by = EXCLUDED.granted_by,
               note = EXCLUDED.note,
               expires_at = EXCLUDED.expires_at,
               -- Re-granting clears a previous revocation: the user has just
               -- consented again, and leaving revoked_at set would make the new
               -- grant dead on arrival. The id is preserved by the conflict
               -- target, so existing message rows keep resolving.
               revoked_at = NULL
         RETURNING *`,
        [
          crypto.randomUUID(),
          input.from.tenantId,
          input.from.userId,
          input.from.assistantId,
          input.to.tenantId,
          input.to.userId,
          input.to.assistantId,
          input.scope,
          input.grantedBy,
          input.note ?? null,
          input.expiresAt ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Creating an assistant grant returned no row.");
    }
    this.logger?.info("Assistant message channel granted", {
      fromAssistant: input.from.assistantId,
      toAssistant: input.to.assistantId,
      scope: input.scope,
    });
    return rowToGrant(row);
  }

  async findGrant(from: AssistantScope, to: AssistantScope): Promise<AssistantGrant | undefined> {
    const rows = await this.cross((db) =>
      db.query<GrantRow>(
        `SELECT * FROM assistant_grants
          WHERE from_tenant_id = $1 AND from_user_id = $2 AND from_assistant_id = $3
            AND to_tenant_id = $4 AND to_user_id = $5 AND to_assistant_id = $6`,
        [from.tenantId, from.userId, from.assistantId, to.tenantId, to.userId, to.assistantId],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToGrant(row);
  }

  async listIncomingGrants(to: AssistantScope): Promise<AssistantGrant[]> {
    const rows = await this.cross((db) =>
      db.query<GrantRow>(
        `SELECT * FROM assistant_grants
          WHERE to_tenant_id = $1 AND to_user_id = $2 AND to_assistant_id = $3
          ORDER BY created_at DESC`,
        [to.tenantId, to.userId, to.assistantId],
      ),
    );
    return rows.map(rowToGrant);
  }

  async listOutgoingGrants(from: AssistantScope): Promise<AssistantGrant[]> {
    const rows = await this.cross((db) =>
      db.query<GrantRow>(
        `SELECT * FROM assistant_grants
          WHERE from_tenant_id = $1 AND from_user_id = $2 AND from_assistant_id = $3
          ORDER BY created_at DESC`,
        [from.tenantId, from.userId, from.assistantId],
      ),
    );
    return rows.map(rowToGrant);
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.cross((db) =>
      db.query(`UPDATE assistant_grants SET revoked_at = now() WHERE id = $1`, [grantId]),
    );
    this.logger?.info("Assistant message channel revoked", { grantId });
  }

  async enqueue(input: MessageEnqueueInput): Promise<AssistantMessage> {
    const rows = await this.cross((db) =>
      db.query<MessageRow>(
        `INSERT INTO assistant_messages
           (id, grant_id, from_tenant_id, from_user_id, from_assistant_id,
            to_tenant_id, to_user_id, to_assistant_id,
            subject, body, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          crypto.randomUUID(),
          input.grantId,
          input.from.tenantId,
          input.from.userId,
          input.from.assistantId,
          input.to.tenantId,
          input.to.userId,
          input.to.assistantId,
          input.subject,
          input.body,
          input.correlationId ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Enqueueing an assistant message returned no row.");
    }
    return rowToMessage(row);
  }

  async listInbox(to: AssistantScope, limit?: number): Promise<AssistantMessage[]> {
    const rows = await this.cross((db) =>
      db.query<MessageRow>(
        `SELECT * FROM assistant_messages
          WHERE to_tenant_id = $1 AND to_user_id = $2 AND to_assistant_id = $3
            AND status = 'pending'
          ORDER BY created_at
          LIMIT $4`,
        [to.tenantId, to.userId, to.assistantId, boundLimit(limit)],
      ),
    );
    return rows.map(rowToMessage);
  }

  async markDelivered(messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.cross((db) =>
      db.query(
        `UPDATE assistant_messages
            SET status = 'delivered', delivered_at = now()
          WHERE id = ANY($1) AND status = 'pending'`,
        [[...messageIds]],
      ),
    );
  }

  async markFailed(messageId: string, error: string): Promise<void> {
    await this.cross((db) =>
      db.query(
        `UPDATE assistant_messages
            SET status = 'failed', delivery_error = $2
          WHERE id = $1`,
        [messageId, error.slice(0, 1_000)],
      ),
    );
  }

  async countPendingInbox(to: AssistantScope): Promise<number> {
    const rows = await this.cross((db) =>
      db.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM assistant_messages
          WHERE to_tenant_id = $1 AND to_user_id = $2 AND to_assistant_id = $3
            AND status = 'pending'`,
        [to.tenantId, to.userId, to.assistantId],
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async countRecentSends(from: AssistantScope, to: AssistantScope, now: number): Promise<number> {
    const windowStart = new Date(now - MESSAGE_RATE_WINDOW_MS).toISOString();
    const rows = await this.cross((db) =>
      db.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM assistant_messages
          WHERE from_tenant_id = $1 AND from_user_id = $2 AND from_assistant_id = $3
            AND to_tenant_id = $4 AND to_user_id = $5 AND to_assistant_id = $6
            AND created_at >= $7`,
        [
          from.tenantId,
          from.userId,
          from.assistantId,
          to.tenantId,
          to.userId,
          to.assistantId,
          windowStart,
        ],
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async purge(scope: AssistantScope): Promise<void> {
    await this.cross(async (db) => {
      // Messages first: they reference grants with ON DELETE CASCADE, so deleting
      // grants would take them anyway — but doing it explicitly means the two
      // directions are handled symmetrically and nothing depends on cascade order.
      await db.query(
        `DELETE FROM assistant_messages
          WHERE (from_tenant_id = $1 AND from_user_id = $2 AND from_assistant_id = $3)
             OR (to_tenant_id = $1 AND to_user_id = $2 AND to_assistant_id = $3)`,
        [scope.tenantId, scope.userId, scope.assistantId],
      );
      await db.query(
        `DELETE FROM assistant_grants
          WHERE (from_tenant_id = $1 AND from_user_id = $2 AND from_assistant_id = $3)
             OR (to_tenant_id = $1 AND to_user_id = $2 AND to_assistant_id = $3)`,
        [scope.tenantId, scope.userId, scope.assistantId],
      );
    });
  }
}

/** Builds the durable store when a database is available, else in-memory. */
export function createMessagingStore(params: { db?: Database; logger?: Logger }): MessagingStore {
  return params.db !== undefined
    ? new PostgresMessagingStore(params.db, params.logger)
    : new InMemoryMessagingStore();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Result of an assistant's attempt to message a peer. */
export type SendOutcome = { sent: true; messageId: string } | { sent: false; detail: string };

/**
 * Joins the messaging policy with the store.
 *
 * Thin: the policy decides, the store persists, this sequences. Assistant liveness
 * is supplied by the caller rather than looked up here, so the service does not
 * need the assistant registry and stays independently testable.
 */
export class AssistantMessenger {
  constructor(
    private readonly store: MessagingStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Enqueues a message if the grant permits it.
   *
   * Returns an outcome rather than throwing for a refusal: a refusal surfaced as a
   * tool error reads to the model as "the tool is broken", and models retry broken
   * tools.
   */
  async send(params: {
    from: AssistantScope;
    to: AssistantScope;
    subject: string;
    body: string;
    correlationId?: string;
    senderActive: boolean;
    receiverActive: boolean;
  }): Promise<SendOutcome> {
    const { decideMessageSend } = await import("./messaging-policy.js");
    const now = this.now();
    const grant = await this.store.findGrant(params.from, params.to);
    const decision = decideMessageSend({
      from: params.from,
      to: params.to,
      subject: params.subject,
      body: params.body,
      ...(grant !== undefined ? { grant } : {}),
      senderActive: params.senderActive,
      receiverActive: params.receiverActive,
      recentSendCount: await this.store.countRecentSends(params.from, params.to, now),
      pendingInboxCount: await this.store.countPendingInbox(params.to),
      now,
    });
    if (!decision.allow) {
      return { sent: false, detail: decision.detail };
    }
    const message = await this.store.enqueue({
      grantId: decision.grantId,
      from: params.from,
      to: params.to,
      subject: decision.subject,
      body: decision.body,
      ...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
    });
    return { sent: true, messageId: message.id };
  }

  /**
   * Reads the inbox for injection into a turn's prompt.
   *
   * Filters out messages whose grant is no longer active. A revoked channel must
   * not keep delivering: the receiver's user withdrew consent, and a message
   * already in the queue is still foreign content entering their assistant's
   * context.
   */
  async collectInbox(to: AssistantScope, limit?: number): Promise<AssistantMessage[]> {
    const messages = await this.store.listInbox(to, limit);
    if (messages.length === 0) return [];
    const now = this.now();
    const grants = await this.store.listIncomingGrants(to);
    const activeGrantIds = new Set(
      grants.filter((grant) => isGrantActive(grant, now)).map((g) => g.id),
    );
    return messages.filter((message) => activeGrantIds.has(message.grantId));
  }
}
