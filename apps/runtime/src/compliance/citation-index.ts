// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Answer citation index (`src/compliance/citation-index.ts`)
 *
 * Records, per execution, which retrieved chunks the final answer actually
 * cited (`answer_citations`). Opt-in via `CITATION_INDEX_ENABLED=true` plus a
 * configured `DATABASE_URL`; the engine calls
 * {@link CitationIndexStore.recordExecution} asynchronously AFTER the answer
 * has been delivered, so a write failure can only ever log a warning — it must
 * never delay or fail the response.
 *
 * One row per registered source that carries both a `chunk_id` and a
 * `document_id` (the pair the search-side citation check resolves); sources
 * without a `chunk_id` are skipped. `cited` is true when the marker `[n]` of
 * that source occurs in the final answer — the same marker semantics the
 * sources check uses ({@link citedIndices}), fenced code excluded.
 *
 * The table is covered by retention (age purge on `created_at`) and erasure
 * (subject delete on `user_id` within the tenant) through
 * `answerCitationsRetentionTarget` in `observability/retention-db-targets.ts`.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import type { Citation } from "../types/openai.js";
import { citedIndices } from "../graph/answer-sources-check.js";

/** One `answer_citations` row for an execution's registered source. */
export interface CitationIndexRow {
  tenantId: string;
  userId?: string | null;
  executionId: string;
  flowId: string;
  flowVersion?: string | null;
  /** The cited document (`citation.document_id`) — the search-side base ref. */
  baseRef: string;
  chunkId: string;
  revision?: string | null;
  citationIndex: number;
  cited: boolean;
}

/** Durable sink for the per-execution citation index. */
export interface CitationIndexStore {
  /** Insert all rows of one execution in a single batch statement. */
  recordExecution(rows: readonly CitationIndexRow[]): Promise<void>;
}

/** The execution-level context the rows are stamped with. */
export interface CitationIndexContext {
  tenantId: string;
  userId?: string | null;
  executionId: string;
  flowId: string;
  flowVersion?: string | null;
}

/**
 * Map registry entries to index rows: only entries whose citation carries a
 * `document_id` AND a `chunk_id` are recorded (the pair the citation check
 * needs); `cited` marks the entries whose `[index]` marker occurs in the
 * final answer.
 */
export function buildCitationIndexRows(
  context: CitationIndexContext,
  entries: ReadonlyArray<{ index: number; citation: Citation }>,
  finalResponse: string,
): CitationIndexRow[] {
  const markers = citedIndices(finalResponse);
  const rows: CitationIndexRow[] = [];
  for (const { index, citation } of entries) {
    const { document_id: documentId, chunk_id: chunkId } = citation;
    if (documentId === undefined || documentId === "") continue;
    if (chunkId === undefined || chunkId === "") continue;
    rows.push({
      tenantId: context.tenantId,
      userId: context.userId ?? null,
      executionId: context.executionId,
      flowId: context.flowId,
      flowVersion: context.flowVersion ?? null,
      baseRef: documentId,
      chunkId,
      revision: citation.version ?? null,
      citationIndex: index,
      cited: markers.has(index),
    });
  }
  return rows;
}

/**
 * Postgres-backed store: one batch `INSERT … VALUES (…), (…)` per execution,
 * inside the tenant RLS context when tenant scoping is configured (same
 * pattern as the other tenant-scoped stores).
 */
export class PostgresCitationIndexStore implements CitationIndexStore {
  constructor(private readonly db: Database) {}

  private scoped<T>(
    tenantId: string,
    callback: (db: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.withTenant !== undefined
      ? this.db.withTenant(tenantId, callback)
      : callback(this.db);
  }

  async recordExecution(
    rows: readonly CitationIndexRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const tenantId = rows[0]?.tenantId ?? "";
    const values: unknown[] = [];
    const tuples = rows.map((row, i) => {
      const b = i * 10;
      values.push(
        row.tenantId,
        row.userId ?? null,
        row.executionId,
        row.flowId,
        row.flowVersion ?? null,
        row.baseRef,
        row.chunkId,
        row.revision ?? null,
        row.citationIndex,
        row.cited,
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`;
    });
    await this.scoped(tenantId, (db) =>
      db.query(
        `INSERT INTO answer_citations
           (tenant_id, user_id, execution_id, flow_id, flow_version,
            base_ref, chunk_id, revision, citation_index, cited)
         VALUES ${tuples.join(", ")}`,
        values,
      ),
    );
  }
}

/**
 * Process-local store used by tests and as the shape reference; keeps every
 * batch so assertions can inspect what would have been written.
 */
export class InMemoryCitationIndexStore implements CitationIndexStore {
  readonly recorded: CitationIndexRow[] = [];
  /** When set, {@link recordExecution} rejects with it — for failure tests. */
  failWith: Error | undefined;

  async recordExecution(
    rows: readonly CitationIndexRow[],
  ): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.recorded.push(...rows);
  }
}
