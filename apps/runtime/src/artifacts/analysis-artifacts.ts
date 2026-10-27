// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { canonicalJsonLocale } from "@atf/canonical-json";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";

export const ANALYSIS_ARTIFACT_TYPES = [
  "chronology",
  "contradiction_matrix",
  "decision_register",
  "requirements_matrix",
  "entity_register",
  "open_items",
  "coverage_report",
] as const;
export type AnalysisArtifactType = (typeof ANALYSIS_ARTIFACT_TYPES)[number];
export type AnalysisArtifactStatus = "draft" | "validated" | "superseded";

export interface EvidenceReference {
  document?: string;
  ref?: string;
  citation_id?: string;
  chunk_id?: string;
  page?: string | number;
  section?: string;
  char_start?: number;
  char_end?: number;
  version?: string;
}

const evidenceReferenceSchema = z
  .object({
    document: z.string().min(1).max(2_000).optional(),
    ref: z.string().min(1).max(2_000).optional(),
    citation_id: z.string().min(1).max(500).optional(),
    chunk_id: z.string().min(1).max(500).optional(),
    page: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]).optional(),
    section: z.string().min(1).max(1_000).optional(),
    char_start: z.number().int().nonnegative().optional(),
    char_end: z.number().int().nonnegative().optional(),
    version: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.document === undefined && value.ref === undefined) {
      ctx.addIssue({ code: "custom", message: "Evidence requires document or ref." });
    }
    if (
      value.char_start !== undefined &&
      value.char_end !== undefined &&
      value.char_end < value.char_start
    ) {
      ctx.addIssue({ code: "custom", message: "Evidence char_end must be >= char_start." });
    }
  });

const evidenceListSchema = z.array(evidenceReferenceSchema).min(1).max(500);

function typedEntrySchema(recognizedFields: readonly string[]) {
  return z
    .object({ evidence: evidenceListSchema.optional() })
    .loose()
    .refine(
      (value) =>
        value.evidence !== undefined ||
        recognizedFields.some((field) => {
          const candidate = value[field];
          return (
            (typeof candidate === "string" && candidate.trim() !== "") ||
            (typeof candidate === "number" && Number.isFinite(candidate)) ||
            (typeof candidate === "boolean") ||
            (Array.isArray(candidate) && candidate.length > 0) ||
            (candidate !== null && typeof candidate === "object")
          );
        }),
      `Entry requires evidence or one of: ${recognizedFields.join(", ")}.`,
    );
}

const chronologyEntrySchema = typedEntrySchema([
  "date", "time", "timestamp", "period", "when", "event", "description", "summary", "title",
]);
const contradictionEntrySchema = typedEntrySchema([
  "claim", "statement", "left", "right", "a", "b", "issue", "contradiction", "description",
]);
const decisionEntrySchema = typedEntrySchema([
  "decision", "title", "description", "outcome", "rationale", "status",
]);
const requirementEntrySchema = typedEntrySchema([
  "requirement", "id", "title", "description", "criterion", "status",
]);
const entityEntrySchema = typedEntrySchema([
  "name", "label", "entity", "id", "type", "description",
]);
const openItemEntrySchema = typedEntrySchema([
  "item", "title", "question", "description", "status", "owner",
]);
const coverageEntrySchema = typedEntrySchema([
  "item", "requirement", "topic", "status", "coverage", "gap", "description",
]);

const payloadSchemas: Record<AnalysisArtifactType, z.ZodType<Record<string, unknown>>> = {
  chronology: z.object({ events: z.array(chronologyEntrySchema).min(1).max(10_000) }).loose(),
  contradiction_matrix: z.object({ contradictions: z.array(contradictionEntrySchema).min(1).max(10_000) }).loose(),
  decision_register: z.object({ decisions: z.array(decisionEntrySchema).min(1).max(10_000) }).loose(),
  requirements_matrix: z.object({ requirements: z.array(requirementEntrySchema).min(1).max(10_000) }).loose(),
  entity_register: z.object({ entities: z.array(entityEntrySchema).min(1).max(10_000) }).loose(),
  open_items: z.object({ items: z.array(openItemEntrySchema).min(1).max(10_000) }).loose(),
  coverage_report: z
    .object({
      items: z.array(coverageEntrySchema).min(1).max(10_000).optional(),
      covered: z.array(coverageEntrySchema).min(1).max(10_000).optional(),
      gaps: z.array(coverageEntrySchema).min(1).max(10_000).optional(),
      evidence: evidenceListSchema.optional(),
    })
    .loose()
    .refine(
      (value) =>
        value.items !== undefined ||
        value.covered !== undefined ||
        value.gaps !== undefined ||
        value.evidence !== undefined,
      "Coverage report requires items, covered, gaps, or evidence.",
    ),
};

export class AnalysisArtifactValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid analysis artifact payload: ${issues.join("; ")}`);
    this.name = "AnalysisArtifactValidationError";
  }
}

export function validateAnalysisArtifactPayload(
  type: AnalysisArtifactType,
  schemaVersion: number,
  payload: unknown,
): Record<string, unknown> {
  if (schemaVersion !== 1) {
    throw new AnalysisArtifactValidationError([
      `Unsupported schema_version ${schemaVersion} for ${type}; supported: 1.`,
    ]);
  }
  const result = payloadSchemas[type].safeParse(payload);
  if (!result.success) {
    throw new AnalysisArtifactValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`),
    );
  }
  return result.data;
}

export interface AnalysisArtifactScope {
  tenantId: string;
  userId?: string;
}

export interface AnalysisArtifactRecord {
  id: string;
  tenantId: string;
  userId?: string;
  assistantId?: string;
  conversationId?: string;
  projectId?: string;
  caseId?: string;
  type: AnalysisArtifactType;
  schemaVersion: number;
  title: string;
  payload: Record<string, unknown>;
  status: AnalysisArtifactStatus;
  revision: number;
  supersedesId?: string;
  sourceExecutionId?: string;
  sourceFlowId?: string;
  datasetId?: string;
  createdBy: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisArtifactCreateInput {
  scope: AnalysisArtifactScope;
  assistantId?: string;
  conversationId?: string;
  projectId?: string;
  caseId?: string;
  type: AnalysisArtifactType;
  schemaVersion: number;
  title: string;
  payload: unknown;
  status?: Exclude<AnalysisArtifactStatus, "superseded">;
  sourceExecutionId?: string;
  sourceFlowId?: string;
  datasetId?: string;
  createdBy: string;
}

export interface AnalysisArtifactListFilter {
  type?: AnalysisArtifactType;
  status?: AnalysisArtifactStatus;
  assistantId?: string;
  conversationId?: string;
  projectId?: string;
  caseId?: string;
  sourceExecutionId?: string;
  sourceFlowId?: string;
  datasetId?: string;
  latest?: boolean;
  limit?: number;
}

export interface AnalysisArtifactStore {
  create(record: AnalysisArtifactRecord): Promise<AnalysisArtifactRecord>;
  list(scope: AnalysisArtifactScope, filter?: AnalysisArtifactListFilter): Promise<AnalysisArtifactRecord[]>;
  get(scope: AnalysisArtifactScope, id: string): Promise<AnalysisArtifactRecord | undefined>;
  createRevision(current: AnalysisArtifactRecord, next: AnalysisArtifactRecord): Promise<AnalysisArtifactRecord>;
}

function contentHash(input: {
  type: AnalysisArtifactType;
  schemaVersion: number;
  title: string;
  payload: Record<string, unknown>;
}): string {
  return createHash("sha256").update(canonicalJsonLocale(input)).digest("hex");
}

export class AnalysisArtifactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisArtifactConflictError";
  }
}

export class AnalysisArtifactService {
  constructor(private readonly store: AnalysisArtifactStore) {}

  async create(input: AnalysisArtifactCreateInput): Promise<AnalysisArtifactRecord> {
    const payload = validateAnalysisArtifactPayload(input.type, input.schemaVersion, input.payload);
    const now = new Date().toISOString();
    const base = {
      type: input.type,
      schemaVersion: input.schemaVersion,
      title: input.title.trim(),
      payload,
    };
    return this.store.create({
      id: crypto.randomUUID(),
      tenantId: input.scope.tenantId,
      ...(input.scope.userId !== undefined ? { userId: input.scope.userId } : {}),
      ...(input.assistantId !== undefined ? { assistantId: input.assistantId } : {}),
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
      ...base,
      status: input.status ?? "draft",
      revision: 1,
      ...(input.sourceExecutionId !== undefined ? { sourceExecutionId: input.sourceExecutionId } : {}),
      ...(input.sourceFlowId !== undefined ? { sourceFlowId: input.sourceFlowId } : {}),
      ...(input.datasetId !== undefined ? { datasetId: input.datasetId } : {}),
      createdBy: input.createdBy,
      contentHash: contentHash(base),
      createdAt: now,
      updatedAt: now,
    });
  }

  list(scope: AnalysisArtifactScope, filter?: AnalysisArtifactListFilter) {
    return this.store.list(scope, filter);
  }

  get(scope: AnalysisArtifactScope, id: string) {
    return this.store.get(scope, id);
  }

  async createRevision(params: {
    scope: AnalysisArtifactScope;
    id: string;
    schemaVersion?: number;
    title?: string;
    payload?: unknown;
    status?: Exclude<AnalysisArtifactStatus, "superseded">;
    createdBy: string;
  }): Promise<AnalysisArtifactRecord | undefined> {
    const current = await this.store.get(params.scope, params.id);
    if (current === undefined) return undefined;
    if (current.status === "superseded") {
      throw new AnalysisArtifactConflictError("A superseded artifact cannot be revised; revise its latest successor.");
    }
    const schemaVersion = params.schemaVersion ?? current.schemaVersion;
    const payload = validateAnalysisArtifactPayload(
      current.type,
      schemaVersion,
      params.payload ?? current.payload,
    );
    const now = new Date().toISOString();
    const base = {
      type: current.type,
      schemaVersion,
      title: (params.title ?? current.title).trim(),
      payload,
    };
    const next: AnalysisArtifactRecord = {
      ...current,
      id: crypto.randomUUID(),
      ...base,
      status: params.status ?? "draft",
      revision: current.revision + 1,
      supersedesId: current.id,
      createdBy: params.createdBy,
      contentHash: contentHash(base),
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createRevision(current, next);
  }
}

function canRead(scope: AnalysisArtifactScope, record: AnalysisArtifactRecord): boolean {
  return (
    record.tenantId === scope.tenantId &&
    (record.userId === undefined || record.userId === scope.userId)
  );
}

function matchesFilter(record: AnalysisArtifactRecord, filter: AnalysisArtifactListFilter): boolean {
  return (
    (filter.type === undefined || record.type === filter.type) &&
    (filter.status === undefined || record.status === filter.status) &&
    (filter.assistantId === undefined || record.assistantId === filter.assistantId) &&
    (filter.conversationId === undefined || record.conversationId === filter.conversationId) &&
    (filter.projectId === undefined || record.projectId === filter.projectId) &&
    (filter.caseId === undefined || record.caseId === filter.caseId) &&
    (filter.sourceExecutionId === undefined || record.sourceExecutionId === filter.sourceExecutionId) &&
    (filter.sourceFlowId === undefined || record.sourceFlowId === filter.sourceFlowId) &&
    (filter.datasetId === undefined || record.datasetId === filter.datasetId)
  );
}

export class InMemoryAnalysisArtifactStore implements AnalysisArtifactStore {
  private readonly records = new Map<string, AnalysisArtifactRecord>();

  async create(record: AnalysisArtifactRecord): Promise<AnalysisArtifactRecord> {
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async list(scope: AnalysisArtifactScope, filter: AnalysisArtifactListFilter = {}): Promise<AnalysisArtifactRecord[]> {
    const supersededIds = new Set(
      [...this.records.values()].flatMap((record) => record.supersedesId === undefined ? [] : [record.supersedesId]),
    );
    return [...this.records.values()]
      .filter((record) => canRead(scope, record))
      .filter((record) => matchesFilter(record, filter))
      .filter((record) => filter.latest !== true || !supersededIds.has(record.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(500, filter.limit ?? 50)))
      .map((record) => structuredClone(record));
  }

  async get(scope: AnalysisArtifactScope, id: string): Promise<AnalysisArtifactRecord | undefined> {
    const record = this.records.get(id);
    return record !== undefined && canRead(scope, record) ? structuredClone(record) : undefined;
  }

  async createRevision(current: AnalysisArtifactRecord, next: AnalysisArtifactRecord): Promise<AnalysisArtifactRecord> {
    const stored = this.records.get(current.id);
    if (stored === undefined || stored.status === "superseded") {
      throw new AnalysisArtifactConflictError("Artifact was revised concurrently.");
    }
    this.records.set(current.id, { ...stored, status: "superseded", updatedAt: next.createdAt });
    this.records.set(next.id, structuredClone(next));
    return structuredClone(next);
  }
}

interface ArtifactRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  assistant_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  case_id: string | null;
  type: AnalysisArtifactType;
  schema_version: number;
  title: string;
  payload: unknown;
  status: AnalysisArtifactStatus;
  revision: number;
  supersedes_id: string | null;
  source_execution_id: string | null;
  source_flow_id: string | null;
  dataset_id: string | null;
  created_by: string;
  content_hash: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToRecord(row: ArtifactRow): AnalysisArtifactRecord {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as Record<string, unknown> : row.payload as Record<string, unknown>;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.user_id !== null ? { userId: row.user_id } : {}),
    ...(row.assistant_id !== null ? { assistantId: row.assistant_id } : {}),
    ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.case_id !== null ? { caseId: row.case_id } : {}),
    type: row.type,
    schemaVersion: Number(row.schema_version),
    title: row.title,
    payload,
    status: row.status,
    revision: Number(row.revision),
    ...(row.supersedes_id !== null ? { supersedesId: row.supersedes_id } : {}),
    ...(row.source_execution_id !== null ? { sourceExecutionId: row.source_execution_id } : {}),
    ...(row.source_flow_id !== null ? { sourceFlowId: row.source_flow_id } : {}),
    ...(row.dataset_id !== null ? { datasetId: row.dataset_id } : {}),
    createdBy: row.created_by,
    contentHash: row.content_hash,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresAnalysisArtifactStore implements AnalysisArtifactStore {
  constructor(private readonly db: Database, private readonly logger?: Logger) {}

  private scoped<T>(tenantId: string, callback: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, callback) : callback(this.db);
  }

  private accessClause(scope: AnalysisArtifactScope, offset = 1): { sql: string; params: unknown[] } {
    return scope.userId === undefined
      ? { sql: `tenant_id = $${offset} AND user_id IS NULL`, params: [scope.tenantId] }
      : {
          sql: `tenant_id = $${offset} AND (user_id IS NULL OR user_id = $${offset + 1})`,
          params: [scope.tenantId, scope.userId],
        };
  }

  async create(record: AnalysisArtifactRecord): Promise<AnalysisArtifactRecord> {
    const rows = await this.scoped(record.tenantId, (db) => db.query<ArtifactRow>(
      `INSERT INTO analysis_artifacts
       (id, tenant_id, user_id, assistant_id, conversation_id, project_id, case_id,
        type, schema_version, title, payload, status, revision, supersedes_id,
        source_execution_id, source_flow_id, dataset_id, created_by, content_hash,
        created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [record.id, record.tenantId, record.userId ?? null, record.assistantId ?? null,
       record.conversationId ?? null, record.projectId ?? null, record.caseId ?? null,
       record.type, record.schemaVersion, record.title, JSON.stringify(record.payload), record.status,
       record.revision, record.supersedesId ?? null, record.sourceExecutionId ?? null,
       record.sourceFlowId ?? null, record.datasetId ?? null, record.createdBy, record.contentHash,
       record.createdAt, record.updatedAt],
    ));
    return rowToRecord(rows[0] ?? record as unknown as ArtifactRow);
  }

  async list(scope: AnalysisArtifactScope, filter: AnalysisArtifactListFilter = {}): Promise<AnalysisArtifactRecord[]> {
    const access = this.accessClause(scope);
    const params = [...access.params];
    const clauses = [access.sql];
    const add = (column: string, value: unknown) => {
      if (value !== undefined) {
        params.push(value);
        clauses.push(`${column} = $${params.length}`);
      }
    };
    add("type", filter.type); add("status", filter.status); add("assistant_id", filter.assistantId);
    add("conversation_id", filter.conversationId); add("project_id", filter.projectId); add("case_id", filter.caseId);
    add("source_execution_id", filter.sourceExecutionId); add("source_flow_id", filter.sourceFlowId); add("dataset_id", filter.datasetId);
    if (filter.latest === true) {
      clauses.push("NOT EXISTS (SELECT 1 FROM analysis_artifacts successor WHERE successor.tenant_id = analysis_artifacts.tenant_id AND successor.supersedes_id = analysis_artifacts.id)");
    }
    params.push(Math.max(1, Math.min(500, filter.limit ?? 50)));
    const rows = await this.scoped(scope.tenantId, (db) => db.query<ArtifactRow>(
      `SELECT * FROM analysis_artifacts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    ));
    return rows.map(rowToRecord);
  }

  async get(scope: AnalysisArtifactScope, id: string): Promise<AnalysisArtifactRecord | undefined> {
    const access = this.accessClause(scope);
    const params = [...access.params, id];
    const rows = await this.scoped(scope.tenantId, (db) => db.query<ArtifactRow>(
      `SELECT * FROM analysis_artifacts WHERE ${access.sql} AND id = $${params.length}`,
      params,
    ));
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async createRevision(current: AnalysisArtifactRecord, next: AnalysisArtifactRecord): Promise<AnalysisArtifactRecord> {
    return this.scoped(current.tenantId, async (db) => {
      const rows = await db.query<ArtifactRow>(
        `WITH superseded AS (
           UPDATE analysis_artifacts
              SET status='superseded', updated_at=$21
            WHERE tenant_id=$2 AND id=$14 AND status <> 'superseded' AND content_hash=$22
            RETURNING id
         )
         INSERT INTO analysis_artifacts
           (id, tenant_id, user_id, assistant_id, conversation_id, project_id, case_id,
            type, schema_version, title, payload, status, revision, supersedes_id,
            source_execution_id, source_flow_id, dataset_id, created_by, content_hash, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
           FROM superseded
         RETURNING *`,
        [next.id, next.tenantId, next.userId ?? null, next.assistantId ?? null,
         next.conversationId ?? null, next.projectId ?? null, next.caseId ?? null,
         next.type, next.schemaVersion, next.title, JSON.stringify(next.payload), next.status,
         next.revision, next.supersedesId ?? null, next.sourceExecutionId ?? null,
         next.sourceFlowId ?? null, next.datasetId ?? null, next.createdBy, next.contentHash,
         next.createdAt, next.updatedAt, current.contentHash],
      );
      const row = rows[0];
      if (row === undefined) throw new AnalysisArtifactConflictError("Artifact was revised concurrently.");
      this.logger?.debug("Analysis artifact revision created", { id: next.id, revision: next.revision });
      return rowToRecord(row);
    });
  }
}
