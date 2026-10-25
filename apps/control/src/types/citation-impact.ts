// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Wire types for `GET /monitoring/citation-impact` (the citation impact
 * report). Mirrored here deliberately: the Control app never imports from the
 * runtime package, so the snake_case wire format is restated as local types.
 */

/** Lifecycle of a cited chunk relative to the answer that cited it. */
export type CitationChunkStatus =
  | "current"
  | "carried"
  | "changed"
  | "removed"
  | "unknown";

/** A cited chunk inside an affected execution, with its current status. */
export interface CitationImpactChunk {
  base_ref: string;
  chunk_id: string;
  status: "changed" | "removed";
  current_revision?: string;
}

/** One execution whose answers cite at least one changed or removed chunk. */
export interface CitationImpactAffected {
  execution_id: string;
  flow_id: string;
  flow_version: string | null;
  created_at: string;
  chunks: CitationImpactChunk[];
}

/** Detached Ed25519 signature over the report body, when the runtime signs. */
export interface CitationImpactSignature {
  alg: "EdDSA";
  kid: string;
  value: string;
}

/** Response of `GET /monitoring/citation-impact`. */
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
