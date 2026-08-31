// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant registry (`src/assistants/assistant-store.ts`)
 *
 * Owns the lifecycle of assistant entities: provisioning, lookup, listing,
 * status changes, and deletion. Two implementations behind one interface —
 * {@link InMemoryAssistantStore} for tests and no-DB deployments, and
 * {@link PostgresAssistantStore} for durable, cross-replica operation — matching
 * the pattern already used by `flow-store.ts` and `memory-store.ts`.
 *
 * The design point worth stating explicitly: **provisioning is a row plus a
 * directory.** There is no per-assistant flow file, no per-assistant config
 * entry, and no operator step. That is what "every user gets an assistant
 * without their own setup" means mechanically — individuality is state, so
 * creating the hundredth assistant costs exactly what the first one did.
 *
 * `ensureAssistant` is therefore the primary entry point and is idempotent: a
 * request that names an assistant which does not exist yet provisions it and
 * proceeds, rather than failing and requiring a separate create call.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import type { AssistantWorkspaceResolver } from "./workspace.js";
import {
  NO_TENANT,
  isValidAssistantIdentifier,
  type AssistantAutonomy,
  type AssistantRecord,
  type AssistantScope,
  type AssistantStatus,
  type AssistantSummary,
} from "./types.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Values a caller may set when provisioning. */
export interface AssistantProvisionInput {
  scope: AssistantScope;
  /** Human-facing name. Defaults to the assistant id when empty. */
  displayName?: string;
  autonomy?: AssistantAutonomy;
  /** Pin to a specific flow. Omit to use the platform default assistant flow. */
  flowId?: string;
}

/** Fields an update may change. Scope and workspace path are immutable. */
export interface AssistantUpdateInput {
  displayName?: string;
  status?: AssistantStatus;
  autonomy?: AssistantAutonomy;
  /** Pass `null` to clear the pin and fall back to the default flow. */
  flowId?: string | null;
}

/** Filters for the operator-plane listing. */
export interface OperatorListParams {
  /** Restrict to one tenant. Omitted means every tenant. */
  tenantId?: string;
  /** Restrict to one user within the tenant. */
  userId?: string;
  status?: AssistantStatus;
  limit?: number;
  offset?: number;
}

/** One page of the operator-plane listing plus the unpaged total. */
export interface OperatorListPage {
  assistants: AssistantSummary[];
  /** Total matching the filter, so the console can show "1-50 of 340". */
  total: number;
}

/** Largest page the operator plane will return in one request. */
export const OPERATOR_LIST_MAX_LIMIT = 200;
const OPERATOR_LIST_DEFAULT_LIMIT = 50;

/** Clamps caller-supplied paging onto the bounds above. */
function boundOperatorPaging(params: OperatorListParams | undefined): {
  limit: number;
  offset: number;
} {
  const rawLimit = params?.limit;
  const limit =
    rawLimit === undefined || !Number.isFinite(rawLimit) || rawLimit <= 0
      ? OPERATOR_LIST_DEFAULT_LIMIT
      : Math.min(Math.floor(rawLimit), OPERATOR_LIST_MAX_LIMIT);
  const rawOffset = params?.offset;
  const offset =
    rawOffset === undefined || !Number.isFinite(rawOffset) || rawOffset <= 0
      ? 0
      : Math.floor(rawOffset);
  return { limit, offset };
}

export interface AssistantStore {
  /**
   * Returns the assistant, provisioning it (row + workspace directory) when it
   * does not exist. Idempotent and concurrency-safe.
   */
  ensure(input: AssistantProvisionInput): Promise<AssistantRecord>;
  /** Returns the assistant, or `undefined` when not provisioned. */
  get(scope: AssistantScope): Promise<AssistantRecord | undefined>;
  /** All assistants of one user within a tenant, newest activity first. */
  listForUser(tenantId: string, userId: string): Promise<AssistantSummary[]>;
  /**
   * Assistants across users, for the OPERATOR plane.
   *
   * Separate from {@link listForUser} rather than a widened version of it: that
   * method is reached from a user's own token and must never be able to return a
   * row belonging to somebody else. Keeping the cross-user query behind its own
   * name means no caller can accidentally turn a user-scoped listing into a
   * tenant-wide one by leaving an argument out.
   *
   * Bounded by construction — the operator console pages rather than rendering
   * every assistant in an organisation at once.
   */
  listForOperator(params?: OperatorListParams): Promise<OperatorListPage>;
  /** Applies a partial update; throws when the assistant does not exist. */
  update(scope: AssistantScope, input: AssistantUpdateInput): Promise<AssistantRecord>;
  /** Stamps `last_active_at`. Best-effort — never throws into the hot path. */
  touch(scope: AssistantScope): Promise<void>;
  /**
   * Archives the assistant. State (soul, skills, memory, workspace) is retained:
   * a delete that also destroyed learned state would make an accidental click
   * unrecoverable, and the compliance plane needs the trail. Hard deletion is a
   * separate, explicit operator action (`purge`).
   */
  archive(scope: AssistantScope, reason?: string): Promise<void>;
  /**
   * Permanently removes the assistant row. Cascading state (souls, skills,
   * proposals, credentials, grants) is removed by the caller's erase path; the
   * workspace directory is the caller's responsibility because filesystem
   * deletion is not transactional with the database.
   */
  purge(scope: AssistantScope): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Default autonomy for a freshly provisioned assistant. */
const DEFAULT_AUTONOMY: AssistantAutonomy = "supervised";

/**
 * Maximum length of a display name. Bounded because it is rendered into the
 * prompt via the soul's identity default.
 */
const MAX_DISPLAY_NAME = 120;

function normalizeDisplayName(raw: string | undefined, fallback: string): string {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  return (value.length === 0 ? fallback : value).slice(0, MAX_DISPLAY_NAME);
}

function assertScope(scope: AssistantScope): void {
  if (scope.userId.trim().length === 0) {
    throw new Error("AssistantStore: userId must be non-empty.");
  }
  if (!isValidAssistantIdentifier(scope.assistantId)) {
    throw new Error(`AssistantStore: invalid assistantId ${JSON.stringify(scope.assistantId)}.`);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Process-local store. Used by tests and by deployments without Postgres.
 *
 * Note the deliberate asymmetry with Postgres: this variant still creates the
 * workspace directory, because a sandbox run against an in-memory registry must
 * behave identically. Only the registry is volatile, not the filesystem.
 */
export class InMemoryAssistantStore implements AssistantStore {
  private readonly rows = new Map<string, AssistantRecord>();
  /** Counters keyed by scope, filled by the caller for list projections. */
  private readonly counts = new Map<string, { skills: number; pending: number }>();

  constructor(
    private readonly workspaces: AssistantWorkspaceResolver,
    private readonly logger?: Logger,
  ) {}

  private key(scope: AssistantScope): string {
    return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}`;
  }

  async ensure(input: AssistantProvisionInput): Promise<AssistantRecord> {
    assertScope(input.scope);
    const existing = this.rows.get(this.key(input.scope));
    if (existing !== undefined) return existing;

    const workspacePath = await this.workspaces.ensureWorkspace(input.scope);
    const now = new Date().toISOString();
    const record: AssistantRecord = {
      scope: input.scope,
      displayName: normalizeDisplayName(input.displayName, input.scope.assistantId),
      status: "active",
      ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
      workspacePath,
      autonomy: input.autonomy ?? DEFAULT_AUTONOMY,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(this.key(input.scope), record);
    this.logger?.info("Provisioned assistant", {
      tenantId: input.scope.tenantId,
      assistantId: input.scope.assistantId,
    });
    return record;
  }

  async get(scope: AssistantScope): Promise<AssistantRecord | undefined> {
    return this.rows.get(this.key(scope));
  }

  async listForUser(tenantId: string, userId: string): Promise<AssistantSummary[]> {
    return [...this.rows.values()]
      .filter((r) => r.scope.tenantId === tenantId && r.scope.userId === userId)
      .sort((a, b) => (b.lastActiveAt ?? b.updatedAt).localeCompare(a.lastActiveAt ?? a.updatedAt))
      .map((r) => this.toSummary(r));
  }

  async listForOperator(params?: OperatorListParams): Promise<OperatorListPage> {
    const { limit, offset } = boundOperatorPaging(params);
    const matched = [...this.rows.values()]
      .filter(
        (r) =>
          (params?.tenantId === undefined || r.scope.tenantId === params.tenantId) &&
          (params?.userId === undefined || r.scope.userId === params.userId) &&
          (params?.status === undefined || r.status === params.status),
      )
      // Tenant, then user, then activity: an operator scans by organisation, so a
      // pure activity sort would interleave tenants and make a page unreadable.
      .sort(
        (a, b) =>
          a.scope.tenantId.localeCompare(b.scope.tenantId) ||
          a.scope.userId.localeCompare(b.scope.userId) ||
          (b.lastActiveAt ?? b.updatedAt).localeCompare(a.lastActiveAt ?? a.updatedAt),
      );
    return {
      assistants: matched.slice(offset, offset + limit).map((r) => this.toSummary(r)),
      total: matched.length,
    };
  }

  /** Attaches the cached counts to a record. Shared by both listings. */
  private toSummary(record: AssistantRecord): AssistantSummary {
    const counts = this.counts.get(this.key(record.scope));
    return {
      scope: record.scope,
      displayName: record.displayName,
      status: record.status,
      autonomy: record.autonomy,
      updatedAt: record.updatedAt,
      ...(record.lastActiveAt !== undefined ? { lastActiveAt: record.lastActiveAt } : {}),
      skillCount: counts?.skills ?? 0,
      pendingProposalCount: counts?.pending ?? 0,
    };
  }

  async update(scope: AssistantScope, input: AssistantUpdateInput): Promise<AssistantRecord> {
    const existing = this.rows.get(this.key(scope));
    if (existing === undefined) {
      throw new Error(`AssistantStore: assistant ${scope.assistantId} is not provisioned.`);
    }
    const next: AssistantRecord = {
      ...existing,
      ...(input.displayName !== undefined
        ? {
            displayName: normalizeDisplayName(input.displayName, scope.assistantId),
          }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (input.flowId === null) {
      delete next.flowId;
    } else if (input.flowId !== undefined) {
      next.flowId = input.flowId;
    }
    this.rows.set(this.key(scope), next);
    return next;
  }

  async touch(scope: AssistantScope): Promise<void> {
    const existing = this.rows.get(this.key(scope));
    if (existing === undefined) return;
    existing.lastActiveAt = new Date().toISOString();
  }

  async archive(scope: AssistantScope): Promise<void> {
    const existing = this.rows.get(this.key(scope));
    if (existing === undefined) return;
    existing.status = "archived";
    existing.updatedAt = new Date().toISOString();
  }

  async purge(scope: AssistantScope): Promise<void> {
    this.rows.delete(this.key(scope));
    this.counts.delete(this.key(scope));
  }

  /** Test/bootstrap seam for list-projection counters. */
  setCounts(scope: AssistantScope, counts: { skills: number; pending: number }): void {
    this.counts.set(this.key(scope), counts);
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface AssistantRow {
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  display_name: string;
  status: string;
  flow_id: string | null;
  workspace_path: string;
  autonomy: string;
  created_at: string | Date;
  updated_at: string | Date;
  last_active_at: string | Date | null;
}

/** Normalises a Postgres timestamp (Date or string) to an ISO string. */
export function toIso(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToRecord(row: AssistantRow): AssistantRecord {
  const lastActive = toIso(row.last_active_at);
  return {
    scope: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      assistantId: row.assistant_id,
    },
    displayName: row.display_name,
    status: row.status as AssistantStatus,
    ...(row.flow_id !== null ? { flowId: row.flow_id } : {}),
    workspacePath: row.workspace_path,
    autonomy: row.autonomy as AssistantAutonomy,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    ...(lastActive !== undefined ? { lastActiveAt: lastActive } : {}),
  };
}

/** Projects a joined row (record columns + count columns) onto a summary. */
function summaryFromRow(
  row: AssistantRow & {
    skill_count: string | number;
    pending_count: string | number;
  },
): AssistantSummary {
  const record = rowToRecord(row);
  return {
    scope: record.scope,
    displayName: record.displayName,
    status: record.status,
    autonomy: record.autonomy,
    updatedAt: record.updatedAt,
    ...(record.lastActiveAt !== undefined ? { lastActiveAt: record.lastActiveAt } : {}),
    skillCount: Number(row.skill_count ?? 0),
    pendingProposalCount: Number(row.pending_count ?? 0),
  };
}

/** Durable, cross-replica assistant registry. */
export class PostgresAssistantStore implements AssistantStore {
  constructor(
    private readonly db: Database,
    private readonly workspaces: AssistantWorkspaceResolver,
    private readonly logger?: Logger,
  ) {}

  /**
   * Runs `cb` with the RLS tenant context bound when the deployment enforces it.
   *
   * Assistant rows are tenant-scoped data, so they go through `withTenant` — not
   * `withOperator`. The sentinel tenant is passed through unchanged: a
   * single-tenant deployment has RLS disabled anyway, and when it is enabled the
   * sentinel is a real, consistent tenant value rather than a bypass.
   */
  private scoped<T>(tenantId: string, cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  async ensure(input: AssistantProvisionInput): Promise<AssistantRecord> {
    assertScope(input.scope);
    const { scope } = input;

    // Workspace creation happens BEFORE the insert: a row that claims a
    // workspace path which does not exist would make every later sandbox run
    // fail with a confusing mount error, whereas an orphaned directory from a
    // failed insert is harmless and reclaimed by the next attempt.
    const workspacePath = await this.workspaces.ensureWorkspace(scope);

    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<AssistantRow>(
        `INSERT INTO assistants
           (tenant_id, user_id, assistant_id, display_name, status,
            flow_id, workspace_path, autonomy)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
         ON CONFLICT (tenant_id, user_id, assistant_id) DO UPDATE
           -- A concurrent provision of the same assistant must return the
           -- existing row rather than raising: two parallel first requests from
           -- the same user are the normal case, not an error. The workspace path
           -- is refreshed because a relocated root should take effect without an
           -- operator migration.
           SET workspace_path = EXCLUDED.workspace_path,
               updated_at = now()
         RETURNING *`,
        [
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          normalizeDisplayName(input.displayName, scope.assistantId),
          input.flowId ?? null,
          workspacePath,
          input.autonomy ?? DEFAULT_AUTONOMY,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`AssistantStore: provisioning ${scope.assistantId} returned no row.`);
    }
    this.logger?.debug("Ensured assistant", {
      tenantId: scope.tenantId,
      assistantId: scope.assistantId,
    });
    return rowToRecord(row);
  }

  async get(scope: AssistantScope): Promise<AssistantRecord | undefined> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<AssistantRow>(
        `SELECT * FROM assistants
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToRecord(row);
  }

  async listForUser(tenantId: string, userId: string): Promise<AssistantSummary[]> {
    // Counts are computed in the same statement via correlated subqueries rather
    // than by N follow-up queries: a user with a dozen assistants would
    // otherwise issue 25 round trips to render one list.
    const rows = await this.scoped(tenantId, (db) =>
      db.query<AssistantRow & { skill_count: string | number; pending_count: string | number }>(
        `SELECT a.*,
                (SELECT count(*) FROM assistant_skills s
                  WHERE s.tenant_id = a.tenant_id
                    AND s.user_id = a.user_id
                    AND s.assistant_id = a.assistant_id
                    AND s.status <> 'retired') AS skill_count,
                (SELECT count(*) FROM assistant_skill_proposals p
                  WHERE p.tenant_id = a.tenant_id
                    AND p.user_id = a.user_id
                    AND p.assistant_id = a.assistant_id
                    AND p.status = 'pending') AS pending_count
           FROM assistants a
          WHERE a.tenant_id = $1 AND a.user_id = $2
          ORDER BY COALESCE(a.last_active_at, a.updated_at) DESC`,
        [tenantId, userId],
      ),
    );
    return rows.map((row) => summaryFromRow(row));
  }

  async listForOperator(params?: OperatorListParams): Promise<OperatorListPage> {
    const { limit, offset } = boundOperatorPaging(params);
    // `withOperator`, not `withTenant`: this listing spans tenants by design, and
    // the tenant filter — when given — is an explicit predicate rather than an RLS
    // binding. Reachable only from the operator plane, which authorises before it
    // calls here.
    return this.db.withOperator(async (db) => {
      const rows = await db.query<
        AssistantRow & {
          skill_count: string | number;
          pending_count: string | number;
          total_count: string | number;
        }
      >(
        // The unpaged total travels with the page as a window function so the
        // console can render "1-50 of 340" without a second round trip that could
        // disagree with the page it labels.
        `SELECT a.*,
                (SELECT count(*) FROM assistant_skills s
                  WHERE s.tenant_id = a.tenant_id
                    AND s.user_id = a.user_id
                    AND s.assistant_id = a.assistant_id
                    AND s.status <> 'retired') AS skill_count,
                (SELECT count(*) FROM assistant_skill_proposals p
                  WHERE p.tenant_id = a.tenant_id
                    AND p.user_id = a.user_id
                    AND p.assistant_id = a.assistant_id
                    AND p.status = 'pending') AS pending_count,
                count(*) OVER () AS total_count
           FROM assistants a
          WHERE ($1::text IS NULL OR a.tenant_id = $1)
            AND ($2::text IS NULL OR a.user_id = $2)
            AND ($3::text IS NULL OR a.status = $3)
          ORDER BY a.tenant_id, a.user_id,
                   COALESCE(a.last_active_at, a.updated_at) DESC
          LIMIT $4 OFFSET $5`,
        [params?.tenantId ?? null, params?.userId ?? null, params?.status ?? null, limit, offset],
      );
      return {
        assistants: rows.map((row) => summaryFromRow(row)),
        // An empty page carries no window value, and an offset past the end is a
        // legitimate request — so absent means "nothing matched from here on".
        total: Number(rows[0]?.total_count ?? 0),
      };
    });
  }

  async update(scope: AssistantScope, input: AssistantUpdateInput): Promise<AssistantRecord> {
    // COALESCE-based partial update keeps this a single statement without
    // building SQL dynamically. `flow_id` needs the extra flag parameter because
    // NULL is a meaningful value there (clear the pin) and COALESCE cannot
    // distinguish "not supplied" from "set to NULL".
    const clearFlow = input.flowId === null;
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<AssistantRow>(
        `UPDATE assistants
            SET display_name = COALESCE($4, display_name),
                status       = COALESCE($5, status),
                autonomy     = COALESCE($6, autonomy),
                flow_id      = CASE WHEN $7 THEN NULL ELSE COALESCE($8, flow_id) END,
                updated_at   = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
          RETURNING *`,
        [
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          input.displayName === undefined
            ? null
            : normalizeDisplayName(input.displayName, scope.assistantId),
          input.status ?? null,
          input.autonomy ?? null,
          clearFlow,
          clearFlow ? null : (input.flowId ?? null),
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`AssistantStore: assistant ${scope.assistantId} is not provisioned.`);
    }
    return rowToRecord(row);
  }

  async touch(scope: AssistantScope): Promise<void> {
    try {
      await this.scoped(scope.tenantId, (db) =>
        db.query(
          `UPDATE assistants SET last_active_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
          [scope.tenantId, scope.userId, scope.assistantId],
        ),
      );
    } catch (err) {
      // Activity stamping is bookkeeping. Failing the user's turn because a
      // timestamp could not be written would trade a real outcome for a metric.
      this.logger?.debug("Assistant touch failed", {
        assistantId: scope.assistantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async archive(scope: AssistantScope, reason?: string): Promise<void> {
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `UPDATE assistants SET status = 'archived', updated_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    this.logger?.info("Archived assistant", {
      assistantId: scope.assistantId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async purge(scope: AssistantScope): Promise<void> {
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `DELETE FROM assistants
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds the durable store when a database is available, else the in-memory one.
 *
 * Mirrors the existing optional-persistence pattern: the assistant subsystem
 * degrades to process-local rather than being unavailable, so a developer
 * running without Postgres still gets working assistants (they just do not
 * survive a restart).
 */
export function createAssistantStore(params: {
  db?: Database;
  workspaces: AssistantWorkspaceResolver;
  logger?: Logger;
}): AssistantStore {
  if (params.db !== undefined) {
    return new PostgresAssistantStore(params.db, params.workspaces, params.logger);
  }
  params.logger?.warn(
    "No database configured — assistants are process-local and will not survive a restart.",
  );
  return new InMemoryAssistantStore(params.workspaces, params.logger);
}

/** Re-exported for callers that construct a scope from a tenant-less identity. */
export { NO_TENANT };
