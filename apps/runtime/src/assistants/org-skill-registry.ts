// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Org Skill Registry (`src/assistants/org-skill-registry.ts`)
 *
 * A learned skill (`skill-store.ts`) is private to one `(tenant, user,
 * assistant)` scope by construction — nothing anywhere lets a second
 * assistant read it. That is correct for a procedure that has not yet
 * proven itself, but it means every assistant in an organisation
 * independently re-learns the same techniques from scratch, at the same
 * risk (a fresh proposal, a fresh scan, a fresh canary), with no way for one
 * assistant's hard-won procedure to help another's user.
 *
 * This module is the curated, tenant-wide catalog that closes that gap
 * **without** weakening any existing boundary:
 *
 *   - **Publishing is the source assistant's OWN user's decision**,
 *     mirrored from `PUT /v1/assistants/:id/skills` (a user-authored skill
 *     going live directly) — publishing a LEARNED procedure the user has
 *     already reviewed (it must be `active`, not `canary`) into the catalog
 *     is the same order of decision, just with a wider destination.
 *   - **Installing is the DESTINATION assistant's own consent path.**
 *     {@link installOrgSkill} does not write a live skill directly — it
 *     creates an ordinary `pending` proposal in the destination scope via
 *     the EXISTING `ProposalStore.create()`, which re-scans the content
 *     (the origin's scan ran against a DIFFERENT assistant's constraints
 *     and autonomy; nothing about that scan is a claim about safety in a
 *     new scope) and goes through that assistant's own apply/canary
 *     pipeline exactly like a self-learned proposal would. This is a
 *     deliberate consequence of the existing "an operator never applies a
 *     user's proposal" boundary in `assistants-admin.ts`: the registry must
 *     not become a side door around it, so installing a catalog entry is
 *     represented as data arriving for the user's OWN pipeline to decide on,
 *     never as an operator or the registry pushing a live change.
 *   - **A catalog entry is a SNAPSHOT, not a live reference.** `SkillRecord`
 *     is keyed by a single scope and versioned per-scope; there is no "many
 *     assistants read one skill row" indirection in the platform, and
 *     introducing one would mean a rollback of the ORIGIN skill silently
 *     affecting every assistant that installed from it — not what "install
 *     a proven technique" should mean. Publishing copies content into
 *     `org_skills`; installing copies it again into a proposal.
 *
 * Cross-TENANT sharing is out of scope for this iteration
 * (`OrgSkillVisibility` has exactly one value, `"tenant"`) — see the ADR for
 * why a cross-tenant tier is a separate, later, operator-gated decision.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import { toIso } from "./assistant-store.js";
import { scanProposal } from "./proposal-scanner.js";
import type { ProposalStore } from "./proposal-store.js";
import { normalizeTriggerLine } from "./skill-index.js";
import { normalizeSkillBody, normalizeSkillName, skillBodyHash } from "./skill-store.js";
import type {
  AssistantScope,
  OrgSkillRecord,
  OrgSkillListPage,
  OrgSkillStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a publish is refused because the content fails the safety scan. */
export class OrgSkillScanBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgSkillScanBlockedError";
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface OrgSkillPublishInput {
  tenantId: string;
  sourceScope: AssistantScope;
  /** Must be the source assistant's OWN user — see the module doc comment. */
  publishedBy: string;
  name: string;
  triggerLine: string;
  body: string;
  summary?: string;
  evidence?: string;
}

export interface OrgSkillListParams {
  tenantId: string;
  status?: OrgSkillStatus;
  /** Case-insensitive substring match against the name. */
  query?: string;
  limit?: number;
  offset?: number;
}

export interface OrgSkillStore {
  /**
   * Publishes a skill snapshot to the tenant catalog. Re-scans the content
   * (independent of whatever scan the origin skill/proposal already passed
   * — see the module doc comment) and refuses with
   * {@link OrgSkillScanBlockedError} on a critical finding.
   */
  publish(input: OrgSkillPublishInput): Promise<OrgSkillRecord>;
  /** Browsable catalog for a tenant. Defaults to `status: "published"` only. */
  list(params: OrgSkillListParams): Promise<OrgSkillListPage>;
  get(tenantId: string, id: string): Promise<OrgSkillRecord | undefined>;
  /** Flips status to `deprecated`. Idempotent; never deletes (see the type doc). */
  deprecate(tenantId: string, id: string): Promise<void>;
  /** Best-effort increment; never throws. */
  recordInstall(tenantId: string, id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared publish logic (re-scan gate, shared by both implementations)
// ---------------------------------------------------------------------------

function prepareForPublish(input: OrgSkillPublishInput): {
  name: string;
  triggerLine: string;
  body: string;
  bodyHash: string;
} {
  const name = normalizeSkillName(input.name);
  const triggerLine = normalizeTriggerLine(input.triggerLine);
  const body = normalizeSkillBody(input.body);
  // Independent re-scan: the origin skill may have been scanned once, at
  // proposal-create time, against ONE assistant's transcript-derived risk.
  // Publishing to a tenant-wide catalog is a materially wider blast radius
  // (every assistant in the tenant can now pull this content into ITS
  // prompt), so the gate is re-applied here rather than trusted from
  // history. `warn`-level findings do not block (same tolerance as the
  // proposal scanner) — only a `critical` finding does.
  const scan = scanProposal({ triggerLine, body });
  if (scan.state === "quarantined") {
    throw new OrgSkillScanBlockedError(
      "This skill cannot be published: the safety scan found a critical issue " +
        `(${scan.findings.filter((f) => f.severity === "critical").map((f) => f.rule).join(", ")}). ` +
        "Publishing to the org-wide catalog was refused before any other assistant could see it.",
    );
  }
  return { name, triggerLine, body, bodyHash: skillBodyHash(triggerLine, body) };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/** Process-local catalog store for tests and no-database deployments. */
export class InMemoryOrgSkillStore implements OrgSkillStore {
  private readonly rows = new Map<string, OrgSkillRecord>();

  async publish(input: OrgSkillPublishInput): Promise<OrgSkillRecord> {
    const prepared = prepareForPublish(input);
    const now = new Date().toISOString();
    const record: OrgSkillRecord = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      name: prepared.name,
      triggerLine: prepared.triggerLine,
      body: prepared.body,
      bodyHash: prepared.bodyHash,
      visibility: "tenant",
      status: "published",
      sourceScope: input.sourceScope,
      publishedBy: input.publishedBy,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      installCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async list(params: OrgSkillListParams): Promise<OrgSkillListPage> {
    const status = params.status ?? "published";
    const query = params.query?.trim().toLowerCase();
    const matched = [...this.rows.values()]
      .filter((r) => r.tenantId === params.tenantId && r.status === status)
      .filter((r) => query === undefined || query === "" || r.name.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    return { total: matched.length, skills: matched.slice(offset, offset + limit) };
  }

  async get(tenantId: string, id: string): Promise<OrgSkillRecord | undefined> {
    const row = this.rows.get(id);
    return row !== undefined && row.tenantId === tenantId ? row : undefined;
  }

  async deprecate(tenantId: string, id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined || row.tenantId !== tenantId) return;
    this.rows.set(id, { ...row, status: "deprecated", updatedAt: new Date().toISOString() });
  }

  async recordInstall(tenantId: string, id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined || row.tenantId !== tenantId) return;
    this.rows.set(id, { ...row, installCount: row.installCount + 1 });
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface OrgSkillRow {
  id: string;
  tenant_id: string;
  name: string;
  trigger_line: string;
  body: string;
  body_hash: string;
  visibility: string;
  status: string;
  source_user_id: string;
  source_assistant_id: string;
  published_by: string;
  summary: string | null;
  evidence: string | null;
  install_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToOrgSkill(row: OrgSkillRow): OrgSkillRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    triggerLine: row.trigger_line,
    body: row.body,
    bodyHash: row.body_hash,
    visibility: row.visibility as OrgSkillRecord["visibility"],
    status: row.status as OrgSkillStatus,
    sourceScope: {
      tenantId: row.tenant_id,
      userId: row.source_user_id,
      assistantId: row.source_assistant_id,
    },
    publishedBy: row.published_by,
    ...(row.summary !== null ? { summary: row.summary } : {}),
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
    installCount: Number(row.install_count),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

/** Durable catalog store. */
export class PostgresOrgSkillStore implements OrgSkillStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  private scoped<T>(tenantId: string, cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  async publish(input: OrgSkillPublishInput): Promise<OrgSkillRecord> {
    const prepared = prepareForPublish(input);
    const rows = await this.scoped(input.tenantId, (db) =>
      db.query<OrgSkillRow>(
        `INSERT INTO org_skills
           (id, tenant_id, name, trigger_line, body, body_hash, visibility,
            status, source_user_id, source_assistant_id, published_by,
            summary, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, 'tenant', 'published', $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          crypto.randomUUID(),
          input.tenantId,
          prepared.name,
          prepared.triggerLine,
          prepared.body,
          prepared.bodyHash,
          input.sourceScope.userId,
          input.sourceScope.assistantId,
          input.publishedBy,
          input.summary ?? null,
          input.evidence ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Publishing an org skill returned no row.");
    }
    this.logger?.info("Skill published to org registry", {
      tenantId: input.tenantId,
      name: prepared.name,
      sourceAssistantId: input.sourceScope.assistantId,
    });
    return rowToOrgSkill(row);
  }

  async list(params: OrgSkillListParams): Promise<OrgSkillListPage> {
    const status = params.status ?? "published";
    const query = params.query?.trim();
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const rows = await this.scoped(params.tenantId, (db) =>
      db.query<OrgSkillRow & { total_count: string | number }>(
        `SELECT *, count(*) OVER () AS total_count
           FROM org_skills
          WHERE tenant_id = $1 AND status = $2
            AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
          ORDER BY updated_at DESC
          LIMIT $4 OFFSET $5`,
        [params.tenantId, status, query !== undefined && query.length > 0 ? query : null, limit, offset],
      ),
    );
    const total = rows[0] !== undefined ? Number(rows[0].total_count) : 0;
    return { total, skills: rows.map(rowToOrgSkill) };
  }

  async get(tenantId: string, id: string): Promise<OrgSkillRecord | undefined> {
    const rows = await this.scoped(tenantId, (db) =>
      db.query<OrgSkillRow>(`SELECT * FROM org_skills WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        id,
      ]),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToOrgSkill(row);
  }

  async deprecate(tenantId: string, id: string): Promise<void> {
    await this.scoped(tenantId, (db) =>
      db.query(
        `UPDATE org_skills SET status = 'deprecated', updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      ),
    );
    this.logger?.info("Org skill deprecated", { tenantId, id });
  }

  async recordInstall(tenantId: string, id: string): Promise<void> {
    try {
      await this.scoped(tenantId, (db) =>
        db.query(
          `UPDATE org_skills SET install_count = install_count + 1
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id],
        ),
      );
    } catch (err) {
      // The counter is display-only (how popular is this entry) — never worth
      // failing an install over.
      this.logger?.debug("Org skill install count update failed", {
        tenantId,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Builds the durable store when a database is available, else in-memory. */
export function createOrgSkillStore(params: { db?: Database; logger?: Logger }): OrgSkillStore {
  return params.db !== undefined
    ? new PostgresOrgSkillStore(params.db, params.logger)
    : new InMemoryOrgSkillStore();
}

// ---------------------------------------------------------------------------
// Install — bridges a catalog entry into the DESTINATION's own proposal pipeline
// ---------------------------------------------------------------------------

/** Raised when the catalog entry named for install is not installable. */
export class OrgSkillNotInstallableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "OrgSkillNotInstallableError";
  }
}

/**
 * Installs a catalog entry into an assistant by creating an ordinary
 * `pending` proposal in the DESTINATION scope.
 *
 * Deliberately does NOT write a live skill directly, for the reason the
 * module doc comment states at length: installing must be indistinguishable
 * from the destination assistant learning it itself, so it goes through the
 * exact same scan-gate → pending → user-decides (or autonomy-gated
 * auto-apply-as-canary, handled by the ordinary proposal/canary machinery —
 * this function only creates the proposal, same as `learning-pass.ts` does)
 * pipeline. `kind` is derived from whether the destination already has a
 * skill of that name, exactly like a self-learned proposal would.
 */
export async function installOrgSkill(params: {
  entry: OrgSkillRecord;
  destinationScope: AssistantScope;
  proposals: ProposalStore;
  existingSkillNames: ReadonlySet<string>;
}): Promise<{ proposalId: string }> {
  const { entry } = params;
  if (entry.status !== "published") {
    throw new OrgSkillNotInstallableError(
      `This catalog entry is "${entry.status}", not "published", and cannot be installed.`,
    );
  }
  const kind = params.existingSkillNames.has(entry.name.toLowerCase()) ? "update" : "create";
  const proposal = await params.proposals.create({
    scope: params.destinationScope,
    kind,
    targetSkill: entry.name,
    title: entry.summary ?? entry.name,
    triggerLine: entry.triggerLine,
    body: entry.body,
    ...(entry.summary !== undefined ? { goal: entry.summary } : {}),
    evidence:
      `Installed from the org skill registry (entry ${entry.id}, published by ` +
      `${params.destinationScope.tenantId === entry.sourceScope.tenantId ? entry.sourceScope.assistantId : "another tenant"}).` +
      (entry.evidence !== undefined ? ` Origin evidence: ${entry.evidence}` : ""),
    createdBy: "org-registry",
    // NOT autonomousCapture: a human (the installing user) explicitly chose
    // this entry from the catalog — it is closer to a person authoring a
    // skill than to an autonomous learning pass, and `autonomousCapture`
    // specifically gates whether autonomy permits auto-apply of something
    // NO human looked at. Here a human looked at the catalog listing.
    autonomousCapture: false,
    actorType: "user",
    actorId: params.destinationScope.userId,
  });
  return { proposalId: proposal.id };
}
