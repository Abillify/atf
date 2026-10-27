// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import type { EvalReport } from "./eval-runner.js";

export interface EvalRunRecord {
  id: string;
  name: string;
  source: "ci" | "manual";
  kind?: string;
  datasetId?: string;
  datasetVersion?: string;
  collection?: string;
  parameters?: Record<string, unknown>;
  retrievalReport?: Record<string, unknown>;
  report: EvalReport;
  recordedAt: string;
}

export interface EvalRunHistory {
  record(input: Omit<EvalRunRecord, "id" | "recordedAt">): Promise<EvalRunRecord>;
  listRecent(limit?: number): Promise<EvalRunRecord[]>;
  latestFor(name: string): Promise<EvalRunRecord | undefined>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export class InMemoryEvalRunHistory implements EvalRunHistory {
  private readonly records: EvalRunRecord[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  async record(input: Omit<EvalRunRecord, "id" | "recordedAt">): Promise<EvalRunRecord> {
    const record = {
      ...input,
      id: crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
    };
    this.records.unshift(record);
    if (this.records.length > this.maxEntries) this.records.length = this.maxEntries;
    return record;
  }

  async listRecent(limit?: number): Promise<EvalRunRecord[]> {
    return this.records.slice(0, clampLimit(limit));
  }

  async latestFor(name: string): Promise<EvalRunRecord | undefined> {
    return this.records.find((record) => record.name === name);
  }
}

interface EvalRunRow {
  id: string;
  name: string;
  source: string;
  kind: string | null;
  dataset_id: string | null;
  dataset_version: string | null;
  collection: string | null;
  parameters: unknown;
  retrieval_report: unknown;
  report: unknown;
  recorded_at: string | Date;
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function rowToRecord(row: EvalRunRow): EvalRunRecord {
  return {
    id: row.id,
    name: row.name,
    source: row.source === "ci" ? "ci" : "manual",
    ...(row.kind !== null ? { kind: row.kind } : {}),
    ...(row.dataset_id !== null ? { datasetId: row.dataset_id } : {}),
    ...(row.dataset_version !== null ? { datasetVersion: row.dataset_version } : {}),
    ...(row.collection !== null ? { collection: row.collection } : {}),
    ...(parseObject(row.parameters) !== undefined ? { parameters: parseObject(row.parameters) } : {}),
    ...(parseObject(row.retrieval_report) !== undefined ? { retrievalReport: parseObject(row.retrieval_report) } : {}),
    report: (typeof row.report === "string" ? JSON.parse(row.report) : row.report) as EvalReport,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
  };
}

/** Optional durable adapter with an in-memory mirror for best-effort fallback. */
export class PostgresEvalRunHistory implements EvalRunHistory {
  private readonly mirror = new InMemoryEvalRunHistory();

  constructor(
    private readonly database: Database,
    private readonly logger?: Logger,
  ) {}

  async record(input: Omit<EvalRunRecord, "id" | "recordedAt">): Promise<EvalRunRecord> {
    const record = await this.mirror.record(input);
    try {
      await this.database.query(
        `INSERT INTO eval_runs
           (id, name, source, kind, dataset_id, dataset_version, collection,
            parameters, retrieval_report, recorded_at, report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10, $11::text::jsonb)`,
        [record.id, record.name, record.source, record.kind ?? "evaluation",
         record.datasetId ?? null, record.datasetVersion ?? null, record.collection ?? null,
         record.parameters === undefined ? null : JSON.stringify(record.parameters),
         record.retrievalReport === undefined ? null : JSON.stringify(record.retrievalReport),
         record.recordedAt, JSON.stringify(record.report)],
      );
    } catch (error) {
      this.logger?.warn("Failed to persist eval run; serving from in-memory mirror", {
        name: record.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return record;
  }

  async listRecent(limit?: number): Promise<EvalRunRecord[]> {
    const count = clampLimit(limit);
    try {
      const rows = await this.database.withOperator((database) =>
        database.query<EvalRunRow>(
          `SELECT id, name, source, kind, dataset_id, dataset_version, collection,
                  parameters, retrieval_report, recorded_at, report FROM eval_runs
           ORDER BY recorded_at DESC LIMIT $1`,
          [count],
        ),
      );
      const byId = new Map<string, EvalRunRecord>();
      for (const record of rows.map(rowToRecord)) byId.set(record.id, record);
      for (const record of await this.mirror.listRecent(count)) byId.set(record.id, record);
      return [...byId.values()]
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
        .slice(0, count);
    } catch (error) {
      this.logger?.warn("Eval run history query failed; serving in-memory mirror", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.mirror.listRecent(limit);
    }
  }

  async latestFor(name: string): Promise<EvalRunRecord | undefined> {
    try {
      const rows = await this.database.withOperator((database) =>
        database.query<EvalRunRow>(
          `SELECT id, name, source, kind, dataset_id, dataset_version, collection,
                  parameters, retrieval_report, recorded_at, report FROM eval_runs
           WHERE name = $1 ORDER BY recorded_at DESC LIMIT 1`,
          [name],
        ),
      );
      const databaseRecord = rows[0] === undefined ? undefined : rowToRecord(rows[0]);
      const mirrorRecord = await this.mirror.latestFor(name);
      if (databaseRecord === undefined) return mirrorRecord;
      if (mirrorRecord === undefined) return databaseRecord;
      return mirrorRecord.recordedAt > databaseRecord.recordedAt ? mirrorRecord : databaseRecord;
    } catch (error) {
      this.logger?.warn("Eval run history latestFor query failed; serving in-memory mirror", {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.mirror.latestFor(name);
    }
  }
}

export function createEvalRunHistory(
  database?: Database,
  logger?: Logger,
): EvalRunHistory {
  return database === undefined
    ? new InMemoryEvalRunHistory()
    : new PostgresEvalRunHistory(database, logger);
}
