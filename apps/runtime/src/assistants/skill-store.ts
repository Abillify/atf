// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Skill persistence (`src/assistants/skill-store.ts`)
 *
 * Stores the live procedures an assistant has available. The index/render rules
 * live in `skill-index.ts`; the proposal state machine that produces skills lives
 * in `proposal-store.ts`. This module is the narrow persistence layer between
 * them.
 *
 * Notable design points:
 *
 * - **`listForPrompt` returns the index projection, not full records.** Bodies
 *   can be 20 KB each; loading them to render a one-line-per-skill index would
 *   pull megabytes into every turn to display a few hundred bytes.
 *
 * - **Retirement over deletion.** `retire` flips a status; it does not delete.
 *   A rolled-back canary, a superseded procedure and an operator veto all need
 *   the row to survive so the proposal that created it still resolves and the
 *   audit trail stays intact.
 *
 * - **`recordUse` is fire-and-forget.** The use counter feeds budget-driven index
 *   selection, which tolerates staleness completely. Failing a user's turn
 *   because a counter could not be incremented would trade an outcome for a
 *   metric.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import { toIso } from "./assistant-store.js";
import { normalizeTriggerLine, skillSortKey, type SkillIndexEntry } from "./skill-index.js";
import {
  SKILL_BODY_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
  type AssistantScope,
  type SkillOrigin,
  type SkillRecord,
  type SkillStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a write would violate a skill invariant. */
export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillValidationError";
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface SkillUpsertInput {
  scope: AssistantScope;
  name: string;
  triggerLine: string;
  body: string;
  origin: SkillOrigin;
  /**
   * Initial status. `canary` starts the skill under validation; the caller is
   * then responsible for registering the canary record.
   */
  status?: SkillStatus;
}

/** Values a skill update may change. Name and scope are the identity. */
export interface SkillPatchInput {
  triggerLine?: string;
  body?: string;
  status?: SkillStatus;
}

export interface SkillStore {
  /** Index projection for prompt rendering — excludes bodies and retired skills. */
  listForPrompt(scope: AssistantScope): Promise<SkillIndexEntry[]>;
  /** Full records including bodies. For management views and export. */
  listAll(scope: AssistantScope, options?: { includeRetired?: boolean }): Promise<SkillRecord[]>;
  /** One skill by name, or `undefined`. Bodies included. */
  getByName(scope: AssistantScope, name: string): Promise<SkillRecord | undefined>;
  /** One skill by id, or `undefined`. */
  getById(scope: AssistantScope, id: string): Promise<SkillRecord | undefined>;
  /**
   * Creates or replaces a skill by name, bumping its version.
   *
   * Upsert rather than separate create/update because the caller (the proposal
   * apply path) knows the intent but not reliably whether a concurrent apply
   * already created the row.
   */
  upsert(input: SkillUpsertInput): Promise<SkillRecord>;
  /** Partial update of an existing skill. Throws when it does not exist. */
  patch(scope: AssistantScope, name: string, patch: SkillPatchInput): Promise<SkillRecord>;
  /** Flips status to `retired`. Idempotent; never deletes. */
  retire(scope: AssistantScope, name: string, reason?: string): Promise<void>;
  /** Increments the use counter. Best-effort; never throws. */
  recordUse(scope: AssistantScope, ids: readonly string[]): Promise<void>;
  /** Count of non-retired skills. */
  count(scope: AssistantScope): Promise<number>;
  /** Removes every skill of the assistant. Erase/purge path only. */
  purge(scope: AssistantScope): Promise<void>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Skill names double as the handle the model passes to `skill_read`, so they are
 * constrained to something a model reproduces reliably: letters, digits, spaces,
 * `-` and `_`. Punctuation-heavy names invite near-miss lookups.
 */
const SKILL_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

/** Normalises and validates a skill name; throws on an unusable one. */
export function normalizeSkillName(raw: string): string {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length === 0) {
    throw new SkillValidationError("A skill name is required.");
  }
  if (value.length > SKILL_NAME_MAX_CHARS) {
    throw new SkillValidationError(`Skill name exceeds ${SKILL_NAME_MAX_CHARS} characters.`);
  }
  if (!SKILL_NAME_PATTERN.test(value)) {
    throw new SkillValidationError(
      `Skill name ${JSON.stringify(value)} may contain only letters, digits, spaces, "-" and "_", and must start with a letter or digit.`,
    );
  }
  return value;
}

/**
 * Normalises a skill body.
 *
 * Bounded at the WRITE side so the read side never has to window. A body over
 * the limit is refused rather than truncated: half a procedure that presents
 * itself as whole is worse than a rejected write the author can fix by splitting
 * the skill.
 */
export function normalizeSkillBody(raw: string): string {
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (value.length === 0) {
    throw new SkillValidationError("A skill body is required.");
  }
  if (value.length > SKILL_BODY_MAX_CHARS) {
    throw new SkillValidationError(
      `Skill body is ${value.length} characters, over the ${SKILL_BODY_MAX_CHARS} limit. ` +
        `Split it into two narrower skills rather than shortening it — a truncated procedure is followed as if it were complete.`,
    );
  }
  return value;
}

/** Content hash used to detect no-op updates without comparing full bodies. */
export function skillBodyHash(triggerLine: string, body: string): string {
  return crypto.createHash("sha256").update(`${triggerLine}\u001f${body}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/** Process-local skill store for tests and no-database deployments. */
export class InMemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, SkillRecord[]>();

  private key(scope: AssistantScope): string {
    return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}`;
  }

  private bucket(scope: AssistantScope): SkillRecord[] {
    const existing = this.skills.get(this.key(scope));
    if (existing !== undefined) return existing;
    const created: SkillRecord[] = [];
    this.skills.set(this.key(scope), created);
    return created;
  }

  async listForPrompt(scope: AssistantScope): Promise<SkillIndexEntry[]> {
    return this.bucket(scope)
      .filter((s) => s.status !== "retired")
      .map((s) => ({
        id: s.id,
        name: s.name,
        triggerLine: s.triggerLine,
        sortKey: s.sortKey,
        useCount: s.useCount,
        ...(s.status === "canary" ? { canary: true as const } : {}),
      }));
  }

  async listAll(
    scope: AssistantScope,
    options: { includeRetired?: boolean } = {},
  ): Promise<SkillRecord[]> {
    const all = this.bucket(scope);
    const filtered =
      options.includeRetired === true ? all : all.filter((s) => s.status !== "retired");
    return [...filtered].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }

  async getByName(scope: AssistantScope, name: string): Promise<SkillRecord | undefined> {
    const target = name.replace(/\s+/g, " ").trim().toLowerCase();
    return this.bucket(scope).find((s) => s.name.toLowerCase() === target);
  }

  async getById(scope: AssistantScope, id: string): Promise<SkillRecord | undefined> {
    return this.bucket(scope).find((s) => s.id === id);
  }

  async upsert(input: SkillUpsertInput): Promise<SkillRecord> {
    const name = normalizeSkillName(input.name);
    const triggerLine = normalizeTriggerLine(input.triggerLine);
    const body = normalizeSkillBody(input.body);
    const bucket = this.bucket(input.scope);
    const now = new Date().toISOString();
    const index = bucket.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) {
      const existing = bucket[index];
      if (existing === undefined) {
        throw new SkillValidationError("Skill vanished during upsert.");
      }
      const next: SkillRecord = {
        ...existing,
        triggerLine,
        body,
        bodyHash: skillBodyHash(triggerLine, body),
        version: existing.version + 1,
        status: input.status ?? existing.status,
        updatedAt: now,
      };
      bucket[index] = next;
      return next;
    }
    const record: SkillRecord = {
      id: crypto.randomUUID(),
      scope: input.scope,
      name,
      triggerLine,
      body,
      bodyHash: skillBodyHash(triggerLine, body),
      version: 1,
      sortKey: skillSortKey(name),
      status: input.status ?? "active",
      origin: input.origin,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    bucket.push(record);
    return record;
  }

  async patch(scope: AssistantScope, name: string, patch: SkillPatchInput): Promise<SkillRecord> {
    const bucket = this.bucket(scope);
    const index = bucket.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    const existing = index >= 0 ? bucket[index] : undefined;
    if (existing === undefined) {
      throw new SkillValidationError(`Skill ${JSON.stringify(name)} not found.`);
    }
    const triggerLine =
      patch.triggerLine !== undefined
        ? normalizeTriggerLine(patch.triggerLine)
        : existing.triggerLine;
    const body = patch.body !== undefined ? normalizeSkillBody(patch.body) : existing.body;
    const contentChanged = triggerLine !== existing.triggerLine || body !== existing.body;
    const next: SkillRecord = {
      ...existing,
      triggerLine,
      body,
      bodyHash: skillBodyHash(triggerLine, body),
      // A status-only change is not a new version of the procedure: bumping it
      // would make version history meaningless for anyone tracking content.
      version: contentChanged ? existing.version + 1 : existing.version,
      status: patch.status ?? existing.status,
      updatedAt: new Date().toISOString(),
    };
    bucket[index] = next;
    return next;
  }

  async retire(scope: AssistantScope, name: string): Promise<void> {
    const bucket = this.bucket(scope);
    const index = bucket.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    const existing = index >= 0 ? bucket[index] : undefined;
    if (existing === undefined) return;
    bucket[index] = {
      ...existing,
      status: "retired",
      updatedAt: new Date().toISOString(),
    };
  }

  async recordUse(scope: AssistantScope, ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids);
    const now = new Date().toISOString();
    const bucket = this.bucket(scope);
    for (const [index, skill] of bucket.entries()) {
      if (!wanted.has(skill.id)) continue;
      bucket[index] = {
        ...skill,
        useCount: skill.useCount + 1,
        lastUsedAt: now,
      };
    }
  }

  async count(scope: AssistantScope): Promise<number> {
    return this.bucket(scope).filter((s) => s.status !== "retired").length;
  }

  async purge(scope: AssistantScope): Promise<void> {
    this.skills.delete(this.key(scope));
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  name: string;
  trigger_line: string;
  body: string;
  body_hash: string;
  version: number;
  sort_key: string;
  status: string;
  origin: string;
  use_count: number;
  last_used_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToSkill(row: SkillRow): SkillRecord {
  const lastUsed = toIso(row.last_used_at);
  return {
    id: row.id,
    scope: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      assistantId: row.assistant_id,
    },
    name: row.name,
    triggerLine: row.trigger_line,
    body: row.body,
    bodyHash: row.body_hash,
    version: Number(row.version),
    sortKey: row.sort_key,
    status: row.status as SkillStatus,
    origin: row.origin as SkillOrigin,
    useCount: Number(row.use_count),
    ...(lastUsed !== undefined ? { lastUsedAt: lastUsed } : {}),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

/** Durable skill store. */
export class PostgresSkillStore implements SkillStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  private scoped<T>(tenantId: string, cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  async listForPrompt(scope: AssistantScope): Promise<SkillIndexEntry[]> {
    // Bodies are deliberately excluded: this runs on every turn, and selecting
    // 20 KB per skill to render one line each is the difference between a
    // kilobyte read and a megabyte one.
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<{
        id: string;
        name: string;
        trigger_line: string;
        sort_key: string;
        use_count: number;
        status: string;
      }>(
        `SELECT id, name, trigger_line, sort_key, use_count, status
           FROM assistant_skills
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND status <> 'retired'
          ORDER BY sort_key, id`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      triggerLine: row.trigger_line,
      sortKey: row.sort_key,
      useCount: Number(row.use_count),
      ...(row.status === "canary" ? { canary: true as const } : {}),
    }));
  }

  async listAll(
    scope: AssistantScope,
    options: { includeRetired?: boolean } = {},
  ): Promise<SkillRecord[]> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<SkillRow>(
        `SELECT * FROM assistant_skills
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND ($4 OR status <> 'retired')
          ORDER BY sort_key, id`,
        [scope.tenantId, scope.userId, scope.assistantId, options.includeRetired === true],
      ),
    );
    return rows.map(rowToSkill);
  }

  async getByName(scope: AssistantScope, name: string): Promise<SkillRecord | undefined> {
    // Matched on the normalised sort key rather than the display name: the model
    // supplies the name from the prompt index and may vary its capitalisation,
    // and a case-sensitive miss would present as "the skill does not exist".
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<SkillRow>(
        `SELECT * FROM assistant_skills
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND sort_key = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, skillSortKey(name)],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToSkill(row);
  }

  async getById(scope: AssistantScope, id: string): Promise<SkillRecord | undefined> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<SkillRow>(
        `SELECT * FROM assistant_skills
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND id = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, id],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToSkill(row);
  }

  async upsert(input: SkillUpsertInput): Promise<SkillRecord> {
    const name = normalizeSkillName(input.name);
    const triggerLine = normalizeTriggerLine(input.triggerLine);
    const body = normalizeSkillBody(input.body);
    const { scope } = input;
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<SkillRow>(
        `INSERT INTO assistant_skills
           (id, tenant_id, user_id, assistant_id, name, trigger_line, body,
            body_hash, version, sort_key, status, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11)
         ON CONFLICT (tenant_id, user_id, assistant_id, name) DO UPDATE
           SET trigger_line = EXCLUDED.trigger_line,
               body = EXCLUDED.body,
               body_hash = EXCLUDED.body_hash,
               status = EXCLUDED.status,
               -- Version tracks CONTENT. A re-apply of an identical body (a
               -- retried request, an idempotent replay) must not inflate it, or
               -- version numbers stop meaning "how often this changed".
               version = CASE
                 WHEN assistant_skills.body_hash = EXCLUDED.body_hash
                   THEN assistant_skills.version
                 ELSE assistant_skills.version + 1
               END,
               updated_at = now()
         RETURNING *`,
        [
          crypto.randomUUID(),
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          name,
          triggerLine,
          body,
          skillBodyHash(triggerLine, body),
          skillSortKey(name),
          input.status ?? "active",
          input.origin,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new SkillValidationError(`Upserting skill ${JSON.stringify(name)} returned no row.`);
    }
    return rowToSkill(row);
  }

  async patch(scope: AssistantScope, name: string, patch: SkillPatchInput): Promise<SkillRecord> {
    const existing = await this.getByName(scope, name);
    if (existing === undefined) {
      throw new SkillValidationError(`Skill ${JSON.stringify(name)} not found.`);
    }
    const triggerLine =
      patch.triggerLine !== undefined
        ? normalizeTriggerLine(patch.triggerLine)
        : existing.triggerLine;
    const body = patch.body !== undefined ? normalizeSkillBody(patch.body) : existing.body;
    const bodyHash = skillBodyHash(triggerLine, body);
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<SkillRow>(
        `UPDATE assistant_skills
            SET trigger_line = $5,
                body = $6,
                body_hash = $7,
                status = COALESCE($8, status),
                version = CASE WHEN body_hash = $7 THEN version ELSE version + 1 END,
                updated_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND id = $4
          RETURNING *`,
        [
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          existing.id,
          triggerLine,
          body,
          bodyHash,
          patch.status ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new SkillValidationError(`Skill ${JSON.stringify(name)} disappeared during update.`);
    }
    return rowToSkill(row);
  }

  async retire(scope: AssistantScope, name: string, reason?: string): Promise<void> {
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `UPDATE assistant_skills
            SET status = 'retired', updated_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND sort_key = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, skillSortKey(name)],
      ),
    );
    this.logger?.info("Retired assistant skill", {
      assistantId: scope.assistantId,
      skill: name,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async recordUse(scope: AssistantScope, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      // Single statement with `= ANY($4)` rather than one per id: a turn can use
      // several skills and this runs after every turn.
      await this.scoped(scope.tenantId, (db) =>
        db.query(
          `UPDATE assistant_skills
              SET use_count = use_count + 1, last_used_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
              AND id = ANY($4)`,
          [scope.tenantId, scope.userId, scope.assistantId, [...ids]],
        ),
      );
    } catch (err) {
      // The counter only influences which skills the index shows when the set
      // exceeds the budget. Losing an increment is invisible; failing the turn
      // is not.
      this.logger?.debug("Skill use recording failed", {
        assistantId: scope.assistantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async count(scope: AssistantScope): Promise<number> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM assistant_skills
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND status <> 'retired'`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async purge(scope: AssistantScope): Promise<void> {
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `DELETE FROM assistant_skills
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
  }
}

/** Builds the durable store when a database is available, else in-memory. */
export function createSkillStore(params: { db?: Database; logger?: Logger }): SkillStore {
  return params.db !== undefined
    ? new PostgresSkillStore(params.db, params.logger)
    : new InMemorySkillStore();
}
