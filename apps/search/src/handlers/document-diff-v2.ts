// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/document-diff-v2.ts
 *
 * `document_diff` (traceability): compares one document's units between two
 * points in time.
 *
 *   GET /v2/documents/{base_ref}/diff?collection=&from=&to=
 *
 * The units at each instant are loaded in one navigation read per instant
 * (every unit of the document, with the temporal `valid_at` visibility rule
 * and the caller's access scope), then diffed by `diffDocumentUnits`:
 * alignment by `section_id`, then `unit_id`, then the ordinal-based pair key,
 * then reading order. A document above the navigation unit cap is reported
 * with `truncated: true`.
 */

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import { readHeader } from "../header-utils.js";
import { parseRfc3339DateTime } from "../rfc3339.js";
import { aggregateTrustLabels, trustLabels } from "../content-trust.js";
import type { PostgresClient } from "../postgres-client.js";
import type { NavUnitRow } from "../pg-types.js";
import {
  diffDocumentUnits,
  headExcerpt,
  contentHash,
  type DiffableUnit,
} from "../traceability.js";

/** A unit in the diff output — trimmed to the fields the diff is about. */
export interface DocumentDiffUnit {
  unit_id: string | null;
  unit_type: string | null;
  section_id: string | null;
  page_start: number | null;
  page_end: number | null;
  excerpt: string;
  content_hash: string;
}

/** A changed unit: same alignment key, differing content hash. */
export interface DocumentDiffChanged {
  key: string;
  before_excerpt: string;
  after_excerpt: string;
}

/** The `document_diff` payload (MCP tool and REST route share it). */
export interface DocumentDiffPayload {
  base_ref: string;
  from: string;
  to: string;
  added: DocumentDiffUnit[];
  removed: DocumentDiffUnit[];
  changed: DocumentDiffChanged[];
  unchanged_count: number;
  /**
   * True when either instant holds more units than one read loads (the
   * navigation unit cap); the diff then covers only the first units in
   * reading order and must not be read as complete.
   */
  truncated: boolean;
}

function toDiffUnit(u: DiffableUnit): DocumentDiffUnit {
  return {
    unit_id: u.unit_id,
    unit_type: u.unit_type,
    section_id: u.section_id,
    page_start: u.page_start,
    page_end: u.page_end,
    excerpt: headExcerpt(u.content),
    content_hash: contentHash(u.content),
  };
}

/**
 * Load one document's units as visible at `validAt` in a single navigation
 * read (all units of the document, reading order, temporal `valid_at` rule
 * and the caller's access scope). At most the navigation unit cap is loaded;
 * `truncated` reports a larger document, whose diff is then incomplete.
 * Throws when the query fails; a partial unit set would produce a misleading
 * diff.
 */
export async function loadDocumentUnitsAt(
  postgresClient: PostgresClient,
  collection: string,
  scope: AccessScope,
  baseRef: string,
  validAt: string,
): Promise<{ units: NavUnitRow[]; truncated: boolean }> {
  const res = await postgresClient.getDocumentUnits(collection, scope, baseRef, {
    validAt,
  });
  if (!res.ok) {
    throw new Error(`Document units load failed: ${res.error.message}`);
  }
  return res.result;
}

/**
 * Build the `document_diff` payload: load the units at both instants and diff
 * them. `from`/`to` are canonical RFC 3339 instants (already validated by the
 * caller).
 */
export async function buildDocumentDiff(
  postgresClient: PostgresClient,
  collection: string,
  scope: AccessScope,
  baseRef: string,
  from: string,
  to: string,
): Promise<DocumentDiffPayload> {
  const fromUnits = await loadDocumentUnitsAt(postgresClient, collection, scope, baseRef, from);
  const toUnits = await loadDocumentUnitsAt(postgresClient, collection, scope, baseRef, to);
  const diff = diffDocumentUnits(fromUnits.units, toUnits.units);
  return {
    base_ref: baseRef,
    from,
    to,
    truncated: fromUnits.truncated || toUnits.truncated,
    added: diff.added.map(toDiffUnit),
    removed: diff.removed.map(toDiffUnit),
    changed: diff.changed.map((c) => ({
      key: c.key,
      before_excerpt: headExcerpt(c.before.content),
      after_excerpt: headExcerpt(c.after.content),
    })),
    unchanged_count: diff.unchanged_count,
  };
}

/**
 * GET /v2/documents/:ref/diff?collection=&from=&to=
 *
 * Same auth / scope / tenant / collection chain as the other v2 document
 * routes. `from` and `to` are required RFC 3339 instants; excerpts carry the
 * content-trust labels like the other read endpoints.
 */
export function createDocumentDiffHandler(
  postgresClient: PostgresClient,
  logger: Logger,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const accessScope = (res.locals as { accessScope?: AccessScope }).accessScope;
      if (!accessScope?.tenantId) {
        res.status(403).json({ error: "Tenant context is required" });
        return;
      }
      const collection =
        (res.locals as { resolvedCollection?: string }).resolvedCollection ??
        readHeader(req, "x-collection") ??
        "documents";

      // Same decoding as the other v2 document routes; a malformed escape
      // (e.g. a literal "%") is a client error, not a 500.
      let baseRef: string;
      try {
        baseRef = decodeURIComponent((req.params as { ref?: string }).ref ?? "").trim();
      } catch {
        res.status(400).json({ error: "base_ref is not a valid URI component", code: "INVALID_BASE_REF" });
        return;
      }
      if (baseRef === "") {
        res.status(400).json({ error: "base_ref is required", code: "INVALID_BASE_REF" });
        return;
      }
      let from: string | undefined;
      let to: string | undefined;
      try {
        from = parseRfc3339DateTime(req.query.from);
        to = parseRfc3339DateTime(req.query.to);
      } catch {
        res.status(400).json({
          error: "from and to must be RFC 3339 date-times with an explicit timezone",
          code: "INVALID_TIME_RANGE",
        });
        return;
      }
      if (from === undefined || to === undefined) {
        res.status(400).json({
          error: "from and to query parameters are required (RFC 3339 date-time)",
          code: "INVALID_TIME_RANGE",
        });
        return;
      }

      const payload = await buildDocumentDiff(
        postgresClient,
        collection,
        accessScope,
        baseRef,
        from,
        to,
      );
      const risks = [
        ...payload.added.map((u) => trustLabels(u.excerpt).injection_risk),
        ...payload.removed.map((u) => trustLabels(u.excerpt).injection_risk),
        ...payload.changed.flatMap((c) => [
          trustLabels(c.before_excerpt).injection_risk,
          trustLabels(c.after_excerpt).injection_risk,
        ]),
      ];
      logger.debug(
        { baseRef, collection, from, to, added: payload.added.length, removed: payload.removed.length, changed: payload.changed.length },
        "document_diff served",
      );
      res.json({ ...payload, ...aggregateTrustLabels(risks) });
    } catch (error) {
      next(error);
    }
  };
}
