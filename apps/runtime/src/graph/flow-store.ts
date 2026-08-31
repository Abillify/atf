// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Online flow store (`src/graph/flow-store.ts`)
 *
 * Backs the graphical editor's "Stage 3" — flows as editable entities with a
 * draft/publish lifecycle and version history, so the whole system can be set
 * up online (no files needed). It coexists with file-based flows via the
 * composite registry: published flows here overlay anything from `FLOWS_DIR`.
 *
 * Lifecycle:
 *   saveDraft  → upsert the working copy (does not affect live traffic)
 *   publish    → validated draft becomes the live `published` definition,
 *                version is bumped and the prior state appended to history
 *   rollback   → re-publish a past version
 *
 * Two implementations behind one interface: {@link InMemoryFlowStore} (tests /
 * no-DB) and {@link PostgresFlowStore} (durable, cross-replica). Validation is
 * the caller's concern (the route runs {@link validateFlow} before publish), so
 * the store stays a thin, fully-testable persistence layer.
 *
 * No `any` at module boundaries.
 */

import type { FlowDefinition } from "../types/flow.js";
import type { Database } from "../db/database.js";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface FlowRecord {
  id: string;
  name: string;
  draft: FlowDefinition | null;
  published: FlowDefinition | null;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface FlowSummary {
  id: string;
  name: string;
  hasDraft: boolean;
  hasPublished: boolean;
  /** True when the draft differs from the published definition. */
  draftDirty: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface FlowVersionRecord {
  flowId: string;
  version: number;
  definition: FlowDefinition;
  publishedAt: string;
  publishedBy: string | null;
}

export class FlowStoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "no_draft" | "no_version",
  ) {
    super(message);
    this.name = "FlowStoreError";
  }
}

export interface FlowStore {
  listAll(): Promise<FlowSummary[]>;
  get(id: string): Promise<FlowRecord | undefined>;
  /** Upserts the working draft. `name` defaults to the definition's name. */
  saveDraft(
    id: string,
    definition: FlowDefinition,
    by?: string,
  ): Promise<FlowRecord>;
  /** Promotes the current draft to published. Throws when there is no draft. */
  publish(id: string, by?: string): Promise<FlowRecord>;
  /** Removes the flow entirely. Returns false when it did not exist. */
  delete(id: string): Promise<boolean>;
  /** All currently-published definitions (consumed by the composite registry). */
  listPublished(): Promise<FlowDefinition[]>;
  listVersions(id: string): Promise<FlowVersionRecord[]>;
  /** Re-publishes a past version (as a new version). */
  rollback(id: string, version: number, by?: string): Promise<FlowRecord>;
}

function summarize(r: FlowRecord): FlowSummary {
  return {
    id: r.id,
    name: r.name,
    hasDraft: r.draft !== null,
    hasPublished: r.published !== null,
    draftDirty:
      r.draft !== null &&
      JSON.stringify(r.draft) !== JSON.stringify(r.published),
    version: r.version,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryFlowStore implements FlowStore {
  private readonly flows = new Map<string, FlowRecord>();
  private readonly versions = new Map<string, FlowVersionRecord[]>();

  async listAll(): Promise<FlowSummary[]> {
    return [...this.flows.values()].map(summarize);
  }

  async get(id: string): Promise<FlowRecord | undefined> {
    const r = this.flows.get(id);
    return r ? { ...r } : undefined;
  }

  async saveDraft(
    id: string,
    definition: FlowDefinition,
    by?: string,
  ): Promise<FlowRecord> {
    const existing = this.flows.get(id);
    const rec: FlowRecord = {
      id,
      name: definition.name,
      draft: definition,
      published: existing?.published ?? null,
      version: existing?.version ?? 0,
      updatedAt: new Date().toISOString(),
      updatedBy: by ?? null,
    };
    this.flows.set(id, rec);
    return { ...rec };
  }

  async publish(id: string, by?: string): Promise<FlowRecord> {
    const existing = this.flows.get(id);
    if (existing === undefined)
      throw new FlowStoreError(`Flow "${id}" not found`, "not_found");
    if (existing.draft === null)
      throw new FlowStoreError(
        `Flow "${id}" has no draft to publish`,
        "no_draft",
      );
    const version = existing.version + 1;
    const rec: FlowRecord = {
      ...existing,
      name: existing.draft.name,
      published: existing.draft,
      version,
      updatedAt: new Date().toISOString(),
      updatedBy: by ?? null,
    };
    this.flows.set(id, rec);
    const history = this.versions.get(id) ?? [];
    history.push({
      flowId: id,
      version,
      definition: existing.draft,
      publishedAt: rec.updatedAt,
      publishedBy: by ?? null,
    });
    this.versions.set(id, history);
    return { ...rec };
  }

  async delete(id: string): Promise<boolean> {
    this.versions.delete(id);
    return this.flows.delete(id);
  }

  async listPublished(): Promise<FlowDefinition[]> {
    const out: FlowDefinition[] = [];
    for (const r of this.flows.values())
      if (r.published !== null) out.push(r.published);
    return out;
  }

  async listVersions(id: string): Promise<FlowVersionRecord[]> {
    return [...(this.versions.get(id) ?? [])].sort(
      (a, b) => b.version - a.version,
    );
  }

  async rollback(
    id: string,
    version: number,
    by?: string,
  ): Promise<FlowRecord> {
    const existing = this.flows.get(id);
    if (existing === undefined)
      throw new FlowStoreError(`Flow "${id}" not found`, "not_found");
    const target = (this.versions.get(id) ?? []).find(
      (v) => v.version === version,
    );
    if (target === undefined)
      throw new FlowStoreError(
        `Flow "${id}" has no version ${version}`,
        "no_version",
      );
    const newVersion = existing.version + 1;
    const rec: FlowRecord = {
      ...existing,
      name: target.definition.name,
      draft: target.definition,
      published: target.definition,
      version: newVersion,
      updatedAt: new Date().toISOString(),
      updatedBy: by ?? null,
    };
    this.flows.set(id, rec);
    const history = this.versions.get(id) ?? [];
    history.push({
      flowId: id,
      version: newVersion,
      definition: target.definition,
      publishedAt: rec.updatedAt,
      publishedBy: by ?? null,
    });
    this.versions.set(id, history);
    return { ...rec };
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface FlowRow {
  id: string;
  name: string;
  draft: unknown;
  published: unknown;
  version: number | string;
  updated_at: string | Date;
  updated_by: string | null;
}

interface VersionRow {
  flow_id: string;
  version: number | string;
  definition: unknown;
  published_at: string | Date;
  published_by: string | null;
}

function parseDef(v: unknown): FlowDefinition | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as FlowDefinition;
    } catch {
      return null;
    }
  }
  return v as FlowDefinition;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

function rowToRecord(r: FlowRow): FlowRecord {
  return {
    id: r.id,
    name: r.name,
    draft: parseDef(r.draft),
    published: parseDef(r.published),
    version: Number(r.version),
    updatedAt: toIso(r.updated_at),
    updatedBy: r.updated_by,
  };
}

export class PostgresFlowStore implements FlowStore {
  constructor(private readonly db: Database) {}

  async listAll(): Promise<FlowSummary[]> {
    const rows = await this.db.query<FlowRow>(
      `SELECT id, name, draft, published, version, updated_at, updated_by
         FROM flows ORDER BY updated_at DESC`,
    );
    return rows.map((r) => summarize(rowToRecord(r)));
  }

  async get(id: string): Promise<FlowRecord | undefined> {
    const rows = await this.db.query<FlowRow>(
      `SELECT id, name, draft, published, version, updated_at, updated_by
         FROM flows WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async saveDraft(
    id: string,
    definition: FlowDefinition,
    by?: string,
  ): Promise<FlowRecord> {
    await this.db.query(
      `INSERT INTO flows (id, name, draft, updated_by)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, draft = EXCLUDED.draft,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, definition.name, JSON.stringify(definition), by ?? null],
    );
    const rec = await this.get(id);
    if (rec === undefined)
      throw new FlowStoreError(
        `Flow "${id}" not found after save`,
        "not_found",
      );
    return rec;
  }

  async publish(id: string, by?: string): Promise<FlowRecord> {
    const existing = await this.get(id);
    if (existing === undefined)
      throw new FlowStoreError(`Flow "${id}" not found`, "not_found");
    if (existing.draft === null)
      throw new FlowStoreError(
        `Flow "${id}" has no draft to publish`,
        "no_draft",
      );
    const version = existing.version + 1;
    await this.db.query(
      `UPDATE flows
          SET published = draft, name = $2, version = $3,
              updated_by = $4, updated_at = now()
        WHERE id = $1`,
      [id, existing.draft.name, version, by ?? null],
    );
    await this.db.query(
      `INSERT INTO flow_versions (flow_id, version, definition, published_by)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (flow_id, version) DO NOTHING`,
      [id, version, JSON.stringify(existing.draft), by ?? null],
    );
    const rec = await this.get(id);
    if (rec === undefined) {
      // Unreachable: the UPDATE above just wrote this row.
      throw new Error(`Failed to read back published flow "${id}".`);
    }
    return rec;
  }

  async delete(id: string): Promise<boolean> {
    await this.db.query(`DELETE FROM flow_versions WHERE flow_id = $1`, [id]);
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM flows WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  async listPublished(): Promise<FlowDefinition[]> {
    const rows = await this.db.query<{ published: unknown }>(
      `SELECT published FROM flows WHERE published IS NOT NULL`,
    );
    return rows
      .map((r) => parseDef(r.published))
      .filter((d): d is FlowDefinition => d !== null);
  }

  async listVersions(id: string): Promise<FlowVersionRecord[]> {
    const rows = await this.db.query<VersionRow>(
      `SELECT flow_id, version, definition, published_at, published_by
         FROM flow_versions WHERE flow_id = $1 ORDER BY version DESC`,
      [id],
    );
    return rows.map((r) => ({
      flowId: r.flow_id,
      version: Number(r.version),
      definition: parseDef(r.definition) as FlowDefinition,
      publishedAt: toIso(r.published_at),
      publishedBy: r.published_by,
    }));
  }

  async rollback(
    id: string,
    version: number,
    by?: string,
  ): Promise<FlowRecord> {
    const existing = await this.get(id);
    if (existing === undefined)
      throw new FlowStoreError(`Flow "${id}" not found`, "not_found");
    const versions = await this.listVersions(id);
    const target = versions.find((v) => v.version === version);
    if (target === undefined)
      throw new FlowStoreError(
        `Flow "${id}" has no version ${version}`,
        "no_version",
      );
    const newVersion = existing.version + 1;
    await this.db.query(
      `UPDATE flows
          SET published = $2, draft = $2, name = $3, version = $4,
              updated_by = $5, updated_at = now()
        WHERE id = $1`,
      [
        id,
        JSON.stringify(target.definition),
        target.definition.name,
        newVersion,
        by ?? null,
      ],
    );
    await this.db.query(
      `INSERT INTO flow_versions (flow_id, version, definition, published_by)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (flow_id, version) DO NOTHING`,
      [id, newVersion, JSON.stringify(target.definition), by ?? null],
    );
    const rec = await this.get(id);
    if (rec === undefined) {
      // Unreachable: the UPDATE above just wrote this row.
      throw new Error(`Failed to read back rolled-back flow "${id}".`);
    }
    return rec;
  }
}
