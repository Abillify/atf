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
 *   saveDraft  → upsert a working copy (does not affect live traffic)
 *   publish    → validated draft becomes the live `published` definition,
 *                version is bumped and the prior state appended to history
 *   rollback   → re-publish a past version
 *
 * Drafts are NAMED and a flow can hold several at once: every flow always has
 * the implicit working draft {@link DEFAULT_DRAFT_ID} (the `flows.draft`
 * column, which predates named drafts and stays the compatibility path), plus
 * any number of additional drafts addressed by `draftId`. `publish` takes the
 * draft to promote, so an experiment can go live without touching the others.
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

/** The implicit working draft every flow has (the `flows.draft` column). */
export const DEFAULT_DRAFT_ID = "default";

/** Draft ids are URL-path-safe labels chosen by the editor. */
export const DRAFT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isValidDraftId(draftId: string): boolean {
  return DRAFT_ID_RE.test(draftId);
}

export interface DraftInfo {
  draftId: string;
  /** Display label (free-form; defaults to the draft id). */
  label: string;
  definition: FlowDefinition;
  updatedAt: string;
  updatedBy: string | null;
}

export interface FlowRecord {
  id: string;
  name: string;
  /** The default working draft — `drafts[DEFAULT_DRAFT_ID]`, kept for compatibility. */
  draft: FlowDefinition | null;
  published: FlowDefinition | null;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  /** All named drafts, including the default one when it exists. */
  drafts: DraftInfo[];
}

export interface FlowSummary {
  id: string;
  name: string;
  hasDraft: boolean;
  hasPublished: boolean;
  /** True when the default draft differs from the published definition. */
  draftDirty: boolean;
  /** Number of drafts held (default included); 0 when none. */
  draftCount: number;
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
    readonly code: "not_found" | "no_draft" | "no_version" | "bad_draft_id",
  ) {
    super(message);
    this.name = "FlowStoreError";
  }
}

export interface FlowStore {
  listAll(): Promise<FlowSummary[]>;
  get(id: string): Promise<FlowRecord | undefined>;
  /**
   * Upserts a named draft (default: {@link DEFAULT_DRAFT_ID}). `name` defaults
   * to the definition's name. Does not affect live traffic.
   */
  saveDraft(
    id: string,
    definition: FlowDefinition,
    by?: string,
    opts?: { draftId?: string; label?: string },
  ): Promise<FlowRecord>;
  /**
   * Promotes a draft (default: {@link DEFAULT_DRAFT_ID}) to published.
   * Throws when that draft does not exist.
   */
  publish(
    id: string,
    by?: string,
    opts?: { draftId?: string },
  ): Promise<FlowRecord>;
  /** Removes one named draft. Returns false when it did not exist. */
  deleteDraft(id: string, draftId: string): Promise<boolean>;
  /** Removes the flow entirely. Returns false when it did not exist. */
  delete(id: string): Promise<boolean>;
  /** All currently-published definitions (consumed by the composite registry). */
  listPublished(): Promise<FlowDefinition[]>;
  listVersions(id: string): Promise<FlowVersionRecord[]>;
  /** Re-publishes a past version (as a new version). */
  rollback(id: string, version: number, by?: string): Promise<FlowRecord>;
}

function summarize(
  r: FlowRecord,
  draftCountOverride?: number,
): FlowSummary {
  return {
    id: r.id,
    name: r.name,
    hasDraft: r.draft !== null,
    hasPublished: r.published !== null,
    draftDirty:
      r.draft !== null &&
      JSON.stringify(r.draft) !== JSON.stringify(r.published),
    draftCount: draftCountOverride ?? r.drafts.length,
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
  private readonly drafts = new Map<string, Map<string, DraftInfo>>();
  private readonly versions = new Map<string, FlowVersionRecord[]>();

  private draftsFor(id: string): Map<string, DraftInfo> {
    let m = this.drafts.get(id);
    if (m === undefined) {
      m = new Map<string, DraftInfo>();
      this.drafts.set(id, m);
    }
    return m;
  }

  /** The default draft plus all named ones, default first. */
  private draftList(id: string): DraftInfo[] {
    const m = this.drafts.get(id);
    if (m === undefined) return [];
    return [...m.values()].sort((a, b) =>
      a.draftId === DEFAULT_DRAFT_ID
        ? -1
        : b.draftId === DEFAULT_DRAFT_ID
          ? 1
          : a.draftId.localeCompare(b.draftId),
    );
  }

  async listAll(): Promise<FlowSummary[]> {
    return [...this.flows.values()].map((r) =>
      summarize({ ...r, drafts: this.draftList(r.id) }),
    );
  }

  async get(id: string): Promise<FlowRecord | undefined> {
    const r = this.flows.get(id);
    return r ? { ...r, drafts: this.draftList(id) } : undefined;
  }

  async saveDraft(
    id: string,
    definition: FlowDefinition,
    by?: string,
    opts?: { draftId?: string; label?: string },
  ): Promise<FlowRecord> {
    const draftId = opts?.draftId ?? DEFAULT_DRAFT_ID;
    if (!isValidDraftId(draftId))
      throw new FlowStoreError(
        `Invalid draft id "${draftId}" (lowercase letters, digits, '-', '_').`,
        "bad_draft_id",
      );
    const existing = this.flows.get(id);
    const now = new Date().toISOString();
    const info: DraftInfo = {
      draftId,
      label: opts?.label?.trim() !== "" ? (opts?.label as string) : draftId,
      definition,
      updatedAt: now,
      updatedBy: by ?? null,
    };
    this.draftsFor(id).set(draftId, info);
    const rec: FlowRecord = {
      id,
      name: definition.name,
      // The default draft is also mirrored on the record (`flows.draft`).
      draft:
        draftId === DEFAULT_DRAFT_ID
          ? definition
          : (existing?.draft ??
            this.drafts.get(id)?.get(DEFAULT_DRAFT_ID)?.definition ??
            null),
      published: existing?.published ?? null,
      version: existing?.version ?? 0,
      updatedAt: now,
      updatedBy: by ?? null,
      drafts: this.draftList(id),
    };
    this.flows.set(id, rec);
    return { ...rec, drafts: this.draftList(id) };
  }

  async publish(
    id: string,
    by?: string,
    opts?: { draftId?: string },
  ): Promise<FlowRecord> {
    const draftId = opts?.draftId ?? DEFAULT_DRAFT_ID;
    const existing = this.flows.get(id);
    if (existing === undefined)
      throw new FlowStoreError(`Flow "${id}" not found`, "not_found");
    const source =
      draftId === DEFAULT_DRAFT_ID
        ? (existing.draft ?? this.drafts.get(id)?.get(DEFAULT_DRAFT_ID)?.definition)
        : this.drafts.get(id)?.get(draftId)?.definition;
    if (source === null || source === undefined)
      throw new FlowStoreError(
        draftId === DEFAULT_DRAFT_ID
          ? `Flow "${id}" has no draft to publish`
          : `Flow "${id}" has no draft "${draftId}" to publish`,
        "no_draft",
      );
    const version = existing.version + 1;
    const rec: FlowRecord = {
      ...existing,
      name: source.name,
      published: source,
      version,
      updatedAt: new Date().toISOString(),
      updatedBy: by ?? null,
      drafts: this.draftList(id),
    };
    this.flows.set(id, rec);
    const history = this.versions.get(id) ?? [];
    history.push({
      flowId: id,
      version,
      definition: source,
      publishedAt: rec.updatedAt,
      publishedBy: by ?? null,
    });
    this.versions.set(id, history);
    return { ...rec, drafts: this.draftList(id) };
  }

  async deleteDraft(id: string, draftId: string): Promise<boolean> {
    const m = this.drafts.get(id);
    if (m === undefined || !m.delete(draftId)) return false;
    const existing = this.flows.get(id);
    if (existing !== undefined) {
      this.flows.set(id, {
        ...existing,
        draft:
          draftId === DEFAULT_DRAFT_ID
            ? null
            : existing.draft,
        drafts: this.draftList(id),
      });
    }
    if (m.size === 0) this.drafts.delete(id);
    return true;
  }

  async delete(id: string): Promise<boolean> {
    this.versions.delete(id);
    this.drafts.delete(id);
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
    // A rollback also resets the default draft to the rolled-back definition.
    const rollbackNow = new Date().toISOString();
    this.draftsFor(id).set(DEFAULT_DRAFT_ID, {
      draftId: DEFAULT_DRAFT_ID,
      label: DEFAULT_DRAFT_ID,
      definition: target.definition,
      updatedAt: rollbackNow,
      updatedBy: by ?? null,
    });
    const rec: FlowRecord = {
      ...existing,
      name: target.definition.name,
      draft: target.definition,
      published: target.definition,
      version: newVersion,
      updatedAt: rollbackNow,
      updatedBy: by ?? null,
      drafts: this.draftList(id),
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
    return { ...rec, drafts: this.draftList(id) };
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

interface DraftRow {
  flow_id: string;
  draft_id: string;
  label: string;
  definition: unknown;
  updated_at: string | Date;
  updated_by: string | null;
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

function rowToRecord(r: FlowRow, drafts: DraftInfo[] = []): FlowRecord {
  const defaultDraft =
    drafts.find((d) => d.draftId === DEFAULT_DRAFT_ID)?.definition ??
    parseDef(r.draft);
  return {
    id: r.id,
    name: r.name,
    draft: defaultDraft,
    published: parseDef(r.published),
    version: Number(r.version),
    updatedAt: toIso(r.updated_at),
    updatedBy: r.updated_by,
    drafts,
  };
}

function rowToDraftInfo(r: DraftRow): DraftInfo {
  return {
    draftId: r.draft_id,
    label: r.label,
    definition: parseDef(r.definition) as FlowDefinition,
    updatedAt: toIso(r.updated_at),
    updatedBy: r.updated_by,
  };
}

/** Default draft first, then named drafts alphabetically. */
function sortDrafts(list: DraftInfo[]): DraftInfo[] {
  return [...list].sort((a, b) =>
    a.draftId === DEFAULT_DRAFT_ID
      ? -1
      : b.draftId === DEFAULT_DRAFT_ID
        ? 1
        : a.draftId.localeCompare(b.draftId),
  );
}

export class PostgresFlowStore implements FlowStore {
  constructor(private readonly db: Database) {}

  private async draftsFor(id: string): Promise<DraftInfo[]> {
    const rows = await this.db.query<DraftRow>(
      `SELECT flow_id, draft_id, label, definition, updated_at, updated_by
         FROM flow_drafts WHERE flow_id = $1`,
      [id],
    );
    return sortDrafts(rows.map(rowToDraftInfo));
  }

  async listAll(): Promise<FlowSummary[]> {
    const rows = await this.db.query<FlowRow>(
      `SELECT id, name, draft, published, version, updated_at, updated_by
         FROM flows ORDER BY updated_at DESC`,
    );
    // One round-trip for every flow's draft ids, so the counts include drafts
    // stored only in `flow_drafts` (and the legacy `flows.draft` column).
    const draftRows = await this.db.query<{ flow_id: string; draft_id: string }>(
      `SELECT flow_id, draft_id FROM flow_drafts`,
    );
    const idsByFlow = new Map<string, Set<string>>();
    for (const r of draftRows) {
      let set = idsByFlow.get(r.flow_id);
      if (set === undefined) {
        set = new Set<string>();
        idsByFlow.set(r.flow_id, set);
      }
      set.add(r.draft_id);
    }
    return rows.map((r) => {
      const ids = idsByFlow.get(r.id) ?? new Set<string>();
      const draftCount =
        ids.size +
        (parseDef(r.draft) !== null && !ids.has(DEFAULT_DRAFT_ID) ? 1 : 0);
      return summarize(rowToRecord(r), draftCount);
    });
  }

  async get(id: string): Promise<FlowRecord | undefined> {
    const rows = await this.db.query<FlowRow>(
      `SELECT id, name, draft, published, version, updated_at, updated_by
         FROM flows WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const drafts = await this.draftsFor(id);
    // Rows written before the flow_drafts table: surface flows.draft as the
    // default draft so the editor always sees it.
    if (
      !drafts.some((d) => d.draftId === DEFAULT_DRAFT_ID) &&
      parseDef(row.draft) !== null
    ) {
      drafts.unshift({
        draftId: DEFAULT_DRAFT_ID,
        label: DEFAULT_DRAFT_ID,
        definition: parseDef(row.draft) as FlowDefinition,
        updatedAt: toIso(row.updated_at),
        updatedBy: row.updated_by,
      });
    }
    return rowToRecord(row, drafts);
  }

  async saveDraft(
    id: string,
    definition: FlowDefinition,
    by?: string,
    opts?: { draftId?: string; label?: string },
  ): Promise<FlowRecord> {
    const draftId = opts?.draftId ?? DEFAULT_DRAFT_ID;
    if (!isValidDraftId(draftId))
      throw new FlowStoreError(
        `Invalid draft id "${draftId}" (lowercase letters, digits, '-', '_').`,
        "bad_draft_id",
      );
    const label =
      opts?.label !== undefined && opts.label.trim() !== ""
        ? opts.label.trim()
        : draftId;
    if (draftId === DEFAULT_DRAFT_ID) {
      // The default draft stays mirrored in `flows.draft` (compat path).
      await this.db.query(
        `INSERT INTO flows (id, name, draft, updated_by)
           VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, draft = EXCLUDED.draft,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, definition.name, JSON.stringify(definition), by ?? null],
      );
    } else {
      // Named drafts need the flow row to exist; create it without touching
      // `draft`/`published` so live traffic and the default draft stay put.
      await this.db.query(
        `INSERT INTO flows (id, name, updated_by)
           VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [id, definition.name, by ?? null],
      );
    }
    await this.db.query(
      `INSERT INTO flow_drafts (flow_id, draft_id, label, definition, updated_by)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (flow_id, draft_id) DO UPDATE
         SET label = EXCLUDED.label, definition = EXCLUDED.definition,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, draftId, label, JSON.stringify(definition), by ?? null],
    );
    const rec = await this.get(id);
    if (rec === undefined)
      throw new FlowStoreError(
        `Flow "${id}" not found after save`,
        "not_found",
      );
    return rec;
  }

  async publish(
    id: string,
    by?: string,
    opts?: { draftId?: string },
  ): Promise<FlowRecord> {
    const draftId = opts?.draftId ?? DEFAULT_DRAFT_ID;
    const existing = await this.get(id);
    if (existing === undefined)
      throw new FlowStoreError(`Flow "${id}" not found`, "not_found");
    const source =
      existing.drafts.find((d) => d.draftId === draftId)?.definition ??
      (draftId === DEFAULT_DRAFT_ID ? existing.draft : null);
    if (source === null || source === undefined)
      throw new FlowStoreError(
        draftId === DEFAULT_DRAFT_ID
          ? `Flow "${id}" has no draft to publish`
          : `Flow "${id}" has no draft "${draftId}" to publish`,
        "no_draft",
      );
    const version = existing.version + 1;
    await this.db.query(
      `UPDATE flows
          SET published = $2, name = $3, version = $4,
              updated_by = $5, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(source), source.name, version, by ?? null],
    );
    await this.db.query(
      `INSERT INTO flow_versions (flow_id, version, definition, published_by)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (flow_id, version) DO NOTHING`,
      [id, version, JSON.stringify(source), by ?? null],
    );
    const rec = await this.get(id);
    if (rec === undefined) {
      // Unreachable: the UPDATE above just wrote this row.
      throw new Error(`Failed to read back published flow "${id}".`);
    }
    return rec;
  }

  async deleteDraft(id: string, draftId: string): Promise<boolean> {
    const rows = await this.db.query<{ flow_id: string }>(
      `DELETE FROM flow_drafts WHERE flow_id = $1 AND draft_id = $2 RETURNING flow_id`,
      [id, draftId],
    );
    let removed = rows.length > 0;
    if (draftId === DEFAULT_DRAFT_ID) {
      const cleared = await this.db.query<{ id: string }>(
        `UPDATE flows SET draft = NULL, updated_at = now()
          WHERE id = $1 AND draft IS NOT NULL RETURNING id`,
        [id],
      );
      removed = removed || cleared.length > 0;
    }
    return removed;
  }

  async delete(id: string): Promise<boolean> {
    await this.db.query(`DELETE FROM flow_versions WHERE flow_id = $1`, [id]);
    await this.db.query(`DELETE FROM flow_drafts WHERE flow_id = $1`, [id]);
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
    // A rollback resets the default draft to the rolled-back definition too.
    await this.db.query(
      `INSERT INTO flow_drafts (flow_id, draft_id, label, definition, updated_by)
         VALUES ($1, $2, $2, $3, $4)
       ON CONFLICT (flow_id, draft_id) DO UPDATE
         SET definition = EXCLUDED.definition,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, DEFAULT_DRAFT_ID, JSON.stringify(target.definition), by ?? null],
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
