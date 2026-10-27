// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Citation impact analysis (`src/compliance/citation-impact.ts`)
 *
 * Answers the question "which past answers cited passages that a newer
 * document revision changed or removed?". The answer-citation rows written by
 * `citation-index.ts` are grouped into distinct `(base_ref, chunk_id)` pairs
 * and checked against the Search service (`POST /v2/citations/check`, in
 * blocks of at most {@link CITATION_CHECK_MAX_ITEMS} pairs per request). An
 * execution is *affected* when at least one of its cited pairs came back
 * `changed` or `removed`.
 *
 * The resulting report can be signed with the Ed25519 evidence key: the
 * signature covers the canonical JSON form (`@atf/canonical-json`) of the
 * report WITHOUT its `signature` field — the exact envelope mode of the flow
 * release receipt (`eval/flow-release.ts`), so `atf-verify --citation-impact`
 * verifies it the same offline way.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import { canonicalizeForBundleHash } from "../observability/evidence-bundle.js";
import {
  type Ed25519EvidenceKey,
  signEvidenceBytes,
} from "../observability/evidence-key.js";

/** The six statuses the Search citation check reports per pair. */
export type CitationChunkStatus =
  | "current"
  | "carried"
  | "changed"
  | "removed"
  | "unknown"
  | "unverified";

/** A `(base_ref, chunk_id)` pair as requested from the citation check. */
export interface CitationCheckItem {
  base_ref: string;
  chunk_id: string;
}

/** One result entry of `POST /v2/citations/check`. */
export interface CitationCheckResult {
  base_ref: string;
  chunk_id: string;
  status: CitationChunkStatus;
  current_revision?: string;
}

/** Response body of `POST /v2/citations/check`. */
export interface CitationCheckResponse {
  checked_at: string;
  results: CitationCheckResult[];
}

/** The maximum number of pairs the Search endpoint accepts per request. */
export const CITATION_CHECK_MAX_ITEMS = 500;

/** A cited `(base_ref, chunk_id)` pair with the executions citing it. */
export interface CitationPairGroup {
  baseRef: string;
  chunkId: string;
  /** Executions citing this pair, in insertion order, deduplicated. */
  executions: CitationImpactExecutionRef[];
}

/** The execution identity attached to a cited pair. */
export interface CitationImpactExecutionRef {
  executionId: string;
  flowId: string;
  flowVersion?: string | null;
  createdAt: string;
}

/**
 * Group citation rows into distinct `(base_ref, chunk_id)` pairs, preserving
 * first-seen order, with the citing executions deduplicated per pair.
 */
export function groupRowsByPair(
  rows: ReadonlyArray<
    CitationImpactExecutionRef & { baseRef: string; chunkId: string }
  >,
): CitationPairGroup[] {
  const groups = new Map<string, CitationPairGroup>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.baseRef}\u0000${row.chunkId}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { baseRef: row.baseRef, chunkId: row.chunkId, executions: [] };
      groups.set(key, group);
    }
    const dedupeKey = `${key}\u0000${row.executionId}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      group.executions.push({
        executionId: row.executionId,
        flowId: row.flowId,
        flowVersion: row.flowVersion ?? null,
        createdAt: row.createdAt,
      });
    }
  }
  return [...groups.values()];
}

/** Split items into request blocks of at most `maxItems` (default 500). */
export function chunkCheckItems(
  items: readonly CitationCheckItem[],
  maxItems: number = CITATION_CHECK_MAX_ITEMS,
): CitationCheckItem[][] {
  if (maxItems < 1) return [items.slice()];
  const blocks: CitationCheckItem[][] = [];
  for (let i = 0; i < items.length; i += maxItems) {
    blocks.push(items.slice(i, i + maxItems));
  }
  return blocks;
}

/** One affected execution in the report. */
export interface CitationImpactAffected {
  execution_id: string;
  flow_id: string;
  flow_version: string | null;
  created_at: string;
  chunks: CitationImpactChunk[];
}

/** One changed/removed chunk of an affected execution. */
export interface CitationImpactChunk {
  base_ref: string;
  chunk_id: string;
  status: "changed" | "removed";
  current_revision?: string;
}

/** Ed25519 signature envelope, same shape as the release receipt. */
export interface CitationImpactSignature {
  alg: "EdDSA";
  kid: string;
  value: string;
}

/** The signed citation impact report (wire form, snake_case). */
export interface CitationImpactReport {
  generated_at: string;
  since: string;
  /** The tenant the report is scoped to; `null` for an all-tenant report. */
  tenant_id: string | null;
  summary: {
    executions_checked: number;
    executions_affected: number;
    chunks: Record<CitationChunkStatus, number>;
  };
  affected: CitationImpactAffected[];
  signature?: CitationImpactSignature;
}

const CHECK_RESULT_STATUSES: readonly CitationChunkStatus[] = [
  "current",
  "carried",
  "changed",
  "removed",
  "unknown",
  "unverified",
];

function isCitationChunkStatus(value: unknown): value is CitationChunkStatus {
  return (
    typeof value === "string" &&
    (CHECK_RESULT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Lenient parse of a citation-check response body. Unknown statuses degrade
 * to `unknown` rather than failing the whole report; a structurally invalid
 * body throws so the caller can surface the upstream failure.
 */
export function parseCitationCheckResponse(body: unknown): CitationCheckResponse {
  const top = body as
    | { checked_at?: unknown; results?: unknown }
    | null
    | undefined;
  if (
    top === null ||
    typeof top !== "object" ||
    !Array.isArray(top.results)
  ) {
    throw new Error("citation check response has no results array");
  }
  const results: CitationCheckResult[] = top.results.map((raw) => {
    const r = raw as Record<string, unknown>;
    const status = isCitationChunkStatus(r["status"]) ? r["status"] : "unknown";
    return {
      base_ref: typeof r["base_ref"] === "string" ? r["base_ref"] : "",
      chunk_id: typeof r["chunk_id"] === "string" ? r["chunk_id"] : "",
      status,
      ...(typeof r["current_revision"] === "string"
        ? { current_revision: r["current_revision"] }
        : {}),
    };
  });
  return {
    checked_at: typeof top.checked_at === "string" ? top.checked_at : "",
    results,
  };
}

/**
 * Aggregate grouped pairs and their check results into the report body
 * (unsigned). `results` are matched to groups by `(base_ref, chunk_id)`;
 * pairs without a result count as `unknown`. The chunk counters count
 * DISTINCT pairs; `executions_checked` counts distinct executions overall.
 */
export function buildCitationImpactReport(
  groups: readonly CitationPairGroup[],
  results: readonly CitationCheckResult[],
  options: { generatedAt: string; since: string; tenantId: string | null },
): CitationImpactReport {
  const resultByPair = new Map<string, CitationCheckResult>();
  for (const result of results) {
    resultByPair.set(`${result.base_ref}\u0000${result.chunk_id}`, result);
  }

  const chunks: Record<CitationChunkStatus, number> = {
    current: 0,
    carried: 0,
    changed: 0,
    removed: 0,
    unknown: 0,
    unverified: 0,
  };
  const executionsChecked = new Set<string>();
  const affectedByExecution = new Map<string, CitationImpactAffected>();

  for (const group of groups) {
    const result = resultByPair.get(
      `${group.baseRef}\u0000${group.chunkId}`,
    );
    const status = result?.status ?? "unknown";
    chunks[status] += 1;
    for (const execution of group.executions) {
      executionsChecked.add(execution.executionId);
      if (status !== "changed" && status !== "removed") continue;
      let affected = affectedByExecution.get(execution.executionId);
      if (affected === undefined) {
        affected = {
          execution_id: execution.executionId,
          flow_id: execution.flowId,
          flow_version: execution.flowVersion ?? null,
          created_at: execution.createdAt,
          chunks: [],
        };
        affectedByExecution.set(execution.executionId, affected);
      }
      affected.chunks.push({
        base_ref: group.baseRef,
        chunk_id: group.chunkId,
        status,
        ...(result?.current_revision !== undefined
          ? { current_revision: result.current_revision }
          : {}),
      });
    }
  }

  return {
    generated_at: options.generatedAt,
    since: options.since,
    tenant_id: options.tenantId,
    summary: {
      executions_checked: executionsChecked.size,
      executions_affected: affectedByExecution.size,
      chunks,
    },
    affected: [...affectedByExecution.values()],
  };
}

/**
 * The bytes the signature covers: the canonical JSON form of the report
 * WITHOUT its `signature` field (`@atf/canonical-json`, same mode as the
 * flow release receipt).
 */
export function citationImpactSigningBytes(
  report: CitationImpactReport,
): string {
  const { signature: _signature, ...unsigned } = report;
  return canonicalizeForBundleHash(unsigned);
}

/** Attach an Ed25519 signature envelope over the canonical signing bytes. */
export function signCitationImpact(
  report: Omit<CitationImpactReport, "signature">,
  key: Ed25519EvidenceKey,
): CitationImpactReport {
  return {
    ...report,
    signature: {
      alg: "EdDSA",
      kid: key.kid,
      value: signEvidenceBytes(key, citationImpactSigningBytes(report)),
    },
  };
}

/**
 * Row shape returned by {@link PostgresCitationImpactSource} — one cited row
 * joined with its execution's earliest citation time.
 */
interface CitationImpactDbRow {
  base_ref: string;
  chunk_id: string;
  execution_id: string;
  flow_id: string;
  flow_version: string | null;
  created_at: string;
}

function toExecutionRow(row: CitationImpactDbRow): CitationImpactExecutionRef & {
  baseRef: string;
  chunkId: string;
} {
  return {
    baseRef: row.base_ref,
    chunkId: row.chunk_id,
    executionId: row.execution_id,
    flowId: row.flow_id,
    flowVersion: row.flow_version,
    createdAt: row.created_at,
  };
}

/**
 * Reads cited pairs from `answer_citations`. The operator plane is
 * cross-tenant by design, so reads run on the BYPASSRLS operator pool
 * (`withOperator` — a pass-through when RLS is not configured); a tenant
 * filter is applied explicitly via `tenantId` instead.
 */
export class PostgresCitationImpactSource {
  constructor(private readonly db: Database) {}

  /**
   * Distinct cited `(base_ref, chunk_id)` pairs since `since`, capped to the
   * `limit` most recent executions. Returns the pairs with the executions
   * citing them (within the same capped execution set).
   */
  async citedPairs(options: {
    since: string;
    limit: number;
    tenantId?: string;
    baseRef?: string;
  }): Promise<CitationPairGroup[]> {
    const filters: string[] = [
      "c.cited = true",
      "c.created_at >= $2::timestamptz",
    ];
    const params: unknown[] = [options.limit, options.since];
    if (options.tenantId !== undefined) {
      params.push(options.tenantId);
      filters.push(`c.tenant_id = $${params.length}`);
    }
    if (options.baseRef !== undefined) {
      params.push(options.baseRef);
      filters.push(`c.base_ref = $${params.length}`);
    }
    // The most recent `limit` executions carrying cited chunks; the outer
    // query then collects every cited pair of exactly those executions.
    const sql = `
      WITH recent AS (
        SELECT execution_id
          FROM answer_citations c
         WHERE ${filters.join(" AND ")}
         GROUP BY execution_id
         ORDER BY max(created_at) DESC
         LIMIT $1
      )
      SELECT c.base_ref, c.chunk_id, c.execution_id, c.flow_id,
             c.flow_version, min(c.created_at)::text AS created_at
        FROM answer_citations c
        JOIN recent r ON r.execution_id = c.execution_id
       WHERE ${filters.join(" AND ")}
       GROUP BY c.base_ref, c.chunk_id, c.execution_id, c.flow_id,
                c.flow_version
       ORDER BY c.base_ref, c.chunk_id, min(c.created_at)
    `;
    const rows = await this.db.withOperator((op) =>
      op.query<CitationImpactDbRow>(sql, params),
    );
    return groupRowsByPair(rows.map(toExecutionRow));
  }
}
