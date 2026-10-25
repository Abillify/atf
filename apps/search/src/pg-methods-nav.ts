// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * postgres-client methods: PostgresClient navigation/read methods: unit expansion, document groups, threads, outlines, sections, pages, context, figures, tables, single units and identifier occurrences.
 *
 * Extracted verbatim from postgres-client.ts (Requirement 13.6).
 * Shared factory state arrives via PgFactoryCtx; bodies are
 * unchanged.
 */

import type { AccessScope } from "./access-scope.js";
import { collectionTableName } from "./collection-ddl.js";
import { groupMemberReferences, resolveDocumentGroups, type DocumentGroup } from "./document-identity.js";
import type { ExpandMode } from "./expansion.js";
import { resolveFigureKinds } from "./figure-kinds.js";
import { SqlParams, buildAccessSql, buildTemporalFilterSql } from "./query-builder.js";
import { DOCUMENT_ORDER_SQL, NAV_MAX_UNITS, NAV_ROW_SELECT, SOURCE_HEAD_BYTES, SOURCE_HEAD_MAX_BATCHES, clampInt, escapeLikeLiteral, figureCaption, navExcerpt, navRow, normalizePathPrefix, normalizeReference, sourceSha256FromPayloadHead, stripLinks } from "./pg-helpers.js";
import type { NavRowShape } from "./pg-helpers.js";
import type { CitationChunkRow, CurrentRevisionRow, ExpandUnitCoords, ExpandUnitRow, FigureUnitInfo, IdentifierOccurrence, NavReadOptions, NavUnitRow, OutlineEntry, PostgresResponse } from "./pg-types.js";

import type { PgFactoryCtx } from "./pg-factory-ctx.js";

export function createNavMethods(ctx: PgFactoryCtx) {
  const {
    withClient,
  } = ctx;

  return {
    async expandUnit(
      collection: string,
      scope: AccessScope,
      mode: ExpandMode,
      coords: ExpandUnitCoords,
      options?: { includeAllVersions?: boolean; validAt?: string },
    ): Promise<PostgresResponse<ExpandUnitRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const baseRef = coords.baseRef?.trim();
      if (!baseRef) return { ok: true, result: [] };

      // Build the mode-specific target predicate. Every mode is additionally
      // scoped to the hit's document (base_ref) so expansion never crosses into
      // another document, and runs under the SAME temporal/revision-visibility
      // (buildTemporalFilterSql, with the collection so the current-revision
      // pointer is honoured) and tenant/ACL (buildAccessSql) predicates as the
      // search query. That is what keeps expansion from surfacing a unit the
      // searcher could not retrieve directly, or one from a non-current revision.
      const p = new SqlParams();
      const temporalFilter = buildTemporalFilterSql(
        p,
        table,
        options?.includeAllVersions ?? false,
        options?.validAt,
        "",
        collection,
      );
      const accessSql = buildAccessSql(p, scope);

      if (mode === "document") {
        const tenantId = scope.tenantId;
        return withClient(async (client) => {
          // The documents to read: the hit's thread in chronological order, or
          // just the hit's document.
          const groups = await resolveDocumentGroups(client, {
            tenantId,
            collection,
            references: [baseRef],
          });
          const group = groups.get(baseRef);
          const members =
            group?.kind === "email_thread"
              ? await groupMemberReferences(client, {
                  tenantId,
                  collection,
                  groupId: group.id,
                })
              : [];
          const refs = members.length > 0 ? members : [baseRef];
          const refsPh = p.add(refs);
          const res = await client.query<{
            unit_id: string | null;
            content: string | null;
            page_start: number | null;
            page_end: number | null;
          }>(
            `SELECT unit_id, content, page_start, page_end
               FROM "${table}"
              WHERE base_ref = ANY(${refsPh}::text[])
                AND (unit_type IS NULL OR unit_type NOT IN ('section', 'page', 'document'))${temporalFilter}${accessSql}
              ORDER BY array_position(${refsPh}::text[], base_ref),
                       page_start ASC NULLS FIRST, page_end ASC NULLS FIRST, id ASC`,
            p.values,
          );
          return res.rows.map((row) => ({
            unit_id: row.unit_id,
            content: row.content ?? "",
            page_start: row.page_start,
            page_end: row.page_end,
          }));
        });
      }

      const baseRefPh = p.add(baseRef);

      let targetSql: string;
      if (mode === "neighbors") {
        // The hit plus whichever of its prev/next reading-order siblings exist.
        // With no sibling ids there is nothing to expand to; return the hit's
        // own row set (which dedupes to empty in the assembler), i.e. [].
        const ids = [
          coords.unitId,
          coords.prevUnitId,
          coords.nextUnitId,
        ].filter((id): id is string => typeof id === "string" && id.length > 0);
        if (ids.length === 0) return { ok: true, result: [] };
        const idsPh = p.add(ids);
        targetSql = `unit_id = ANY(${idsPh}::text[])`;
      } else if (mode === "section") {
        const sectionId = coords.sectionId?.trim();
        if (!sectionId) return { ok: true, result: [] };
        const secPh = p.add(sectionId);
        targetSql = `section_id = ${secPh}`;
      } else {
        // page: every unit overlapping the hit's page range in this document.
        const start = coords.pageStart;
        const end = coords.pageEnd ?? coords.pageStart;
        if (start == null || end == null) return { ok: true, result: [] };
        const startPh = p.add(start);
        const endPh = p.add(end);
        // Overlap test: unit.page_start <= hit.page_end AND unit.page_end >= hit.page_start.
        targetSql = `page_start IS NOT NULL AND page_end IS NOT NULL AND page_start <= ${endPh} AND page_end >= ${startPh}`;
      }

      const sql = `
        SELECT unit_id, content, page_start, page_end
        FROM "${table}"
        WHERE base_ref = ${baseRefPh}
          AND (${targetSql})${temporalFilter}${accessSql}
        ORDER BY ${DOCUMENT_ORDER_SQL}
      `;

      return withClient(async (client) => {
        const res = await client.query<{
          unit_id: string | null;
          content: string | null;
          page_start: number | null;
          page_end: number | null;
        }>(sql, p.values);
        return res.rows.map((row) => ({
          unit_id: row.unit_id,
          content: row.content ?? "",
          page_start: row.page_start,
          page_end: row.page_end,
        }));
      });
    },

    async resolveDocumentGroups(
      collection: string,
      scope: AccessScope,
      references: string[],
    ): Promise<PostgresResponse<Map<string, DocumentGroup>>> {
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const tenantId = scope.tenantId;
      return withClient((client) =>
        resolveDocumentGroups(client, { tenantId, collection, references }),
      );
    },

    async listThreadMembers(
      collection: string,
      scope: AccessScope,
      threadId: string,
    ): Promise<PostgresResponse<string[]>> {
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const tenantId = scope.tenantId;
      return withClient((client) =>
        groupMemberReferences(client, {
          tenantId,
          collection,
          groupId: threadId,
        }),
      );
    },

    async lookupFigureUnits(
      collection: string,
      scope: AccessScope,
      baseRef: string,
      figureIds: string[],
      options?: { includeAllVersions?: boolean; validAt?: string },
    ): Promise<PostgresResponse<FigureUnitInfo[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const ref = baseRef?.trim();
      const ids = [
        ...new Set(
          figureIds.filter((id) => typeof id === "string" && id.length > 0),
        ),
      ];
      if (!ref || ids.length === 0) return { ok: true, result: [] };

      // Same document + tenant/ACL + temporal/revision-visibility gates as a
      // search, so a referenced figure can never leak a figure the searcher
      // could not have retrieved directly. Match on the `figure_id` mirrored
      // into metadata (the batch worker writes it there for figure units); the
      // metadata GIN index and the base_ref index back the lookup.
      const p = new SqlParams();
      const temporalFilter = buildTemporalFilterSql(
        p,
        table,
        options?.includeAllVersions ?? false,
        options?.validAt,
        "",
        collection,
      );
      const accessSql = buildAccessSql(p, scope);
      const baseRefPh = p.add(ref);
      const idsPh = p.add(ids);
      const sql = `
        SELECT
          content,
          page_start,
          figure_kind,
          metadata->>'figure_id' AS figure_id,
          metadata->>'asset_id'  AS asset_id,
          metadata->'bbox'       AS bbox
        FROM "${table}"
        WHERE base_ref = ${baseRefPh}
          AND metadata->>'figure_id' = ANY(${idsPh}::text[])${temporalFilter}${accessSql}
        ORDER BY page_start ASC NULLS FIRST, id ASC
      `;
      return withClient(async (client) => {
        const res = await client.query<{
          content: string | null;
          page_start: number | null;
          figure_kind: string | null;
          figure_id: string | null;
          asset_id: string | null;
          bbox: unknown;
        }>(sql, p.values);
        // One row per figure id; the ORDER BY makes the first row deterministic
        // if a figure is somehow indexed twice.
        const byFigure = new Map<string, FigureUnitInfo>();
        for (const row of res.rows) {
          if (!row.figure_id || byFigure.has(row.figure_id)) continue;
          const bbox =
            Array.isArray(row.bbox) &&
            row.bbox.length === 4 &&
            row.bbox.every((n) => typeof n === "number")
              ? (row.bbox as [number, number, number, number])
              : null;
          byFigure.set(row.figure_id, {
            figure_id: row.figure_id,
            asset_id: row.asset_id ?? null,
            figure_kind: row.figure_kind ?? null,
            caption: figureCaption(row.content),
            page: row.page_start ?? null,
            bbox,
          });
        }
        return [...byFigure.values()];
      });
    },

    // ── v2 navigation reads ──────────────────────────────────────
    // These mirror expandUnit/lookupFigureUnits: every read is gated by the
    // SAME buildTemporalFilterSql (current-revision pointer) + buildAccessSql
    // (tenant/ACL) predicates as search, and scoped to one document by base_ref
    // or document_id (or, for find_identifier, joined to a visible unit), so a
    // navigation call can never surface a unit the caller could not retrieve.

    async getOutline(
      collection: string,
      scope: AccessScope,
      reference: string,
      options?: NavReadOptions & {
        depth?: number;
        limit?: number;
        offset?: number;
      },
    ): Promise<PostgresResponse<{ entries: OutlineEntry[]; total: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const ref = normalizeReference(reference);
      const depth =
        options?.depth != null && options.depth > 0 ? options.depth : null;
      const limit = clampInt(options?.limit, 200, 1, 2000);
      const offset = clampInt(options?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        const depthClause =
          depth !== null
            ? ` AND COALESCE(array_length(section_path, 1), 0) <= ${p.add(depth)}`
            : "";
        const where = `base_ref = ${refPh} AND unit_type = 'section'${depthClause}${temporalFilter}${accessSql}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM "${table}" WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const offsetPh = p.add(offset);
        const res = await client.query<{
          unit_id: string | null;
          section_id: string | null;
          section_path: string[] | null;
          page_start: number | null;
          page_end: number | null;
        }>(
          `SELECT unit_id, section_id, section_path, page_start, page_end
             FROM "${table}"
            WHERE ${where}
            ORDER BY page_start ASC NULLS FIRST, section_path ASC NULLS FIRST, id ASC
            LIMIT ${limitPh} OFFSET ${offsetPh}`,
          p.values,
        );
        const entries: OutlineEntry[] = res.rows.map((row) => {
          const path = Array.isArray(row.section_path) ? row.section_path : [];
          return {
            unit_id: row.unit_id ?? "",
            section_id: row.section_id,
            section_path: path,
            depth: path.length,
            heading: path.at(-1) ?? row.section_id ?? "",
            // Section units carry a sentinel page range; expose null instead of 0.
            page_start:
              row.page_start && row.page_start > 0 ? row.page_start : null,
            page_end: row.page_end && row.page_end > 0 ? row.page_end : null,
          };
        });
        return { entries, total };
      });
    },

    async getSectionUnits(
      collection: string,
      scope: AccessScope,
      reference: string,
      selector: { sectionId?: string; sectionPath?: string[] },
      options?: NavReadOptions,
    ): Promise<PostgresResponse<NavUnitRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const ref = normalizeReference(reference);
      const sectionId = selector.sectionId?.trim();
      const sectionPath = selector.sectionPath?.filter(
        (s) => typeof s === "string" && s.length > 0,
      );
      if (!sectionId && (!sectionPath || sectionPath.length === 0)) {
        return { ok: true, result: [] };
      }
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        // Prefer the explicit section id; else match a section-path PREFIX so a
        // caller can pass "4 Wareneingang" and get every unit under it.
        let targetSql: string;
        if (sectionId) {
          targetSql = `section_id = ${p.add(sectionId)}`;
        } else {
          const pathPh = p.add(sectionPath as string[]);
          targetSql = `section_path IS NOT NULL AND section_path[1:${(sectionPath as string[]).length}] = ${pathPh}::text[]`;
        }
        const res = await client.query<NavRowShape>(
          `${NAV_ROW_SELECT}
             FROM "${table}"
            WHERE base_ref = ${refPh} AND (${targetSql})${temporalFilter}${accessSql}
            ORDER BY ${DOCUMENT_ORDER_SQL}
            LIMIT ${NAV_MAX_UNITS}`,
          p.values,
        );
        return res.rows.map(navRow);
      });
    },

    async getDocumentUnits(
      collection: string,
      scope: AccessScope,
      reference: string,
      options?: NavReadOptions & { limit?: number },
    ): Promise<PostgresResponse<{ units: NavUnitRow[]; truncated: boolean }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const ref = normalizeReference(reference);
      const limit = clampInt(options?.limit, NAV_MAX_UNITS, 1, NAV_MAX_UNITS);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        // One read of every visible unit of the document; one row past the
        // limit tells the caller the set is incomplete.
        const res = await client.query<NavRowShape>(
          `${NAV_ROW_SELECT}
             FROM "${table}"
            WHERE base_ref = ${refPh}${temporalFilter}${accessSql}
            ORDER BY ${DOCUMENT_ORDER_SQL}
            LIMIT ${p.add(limit + 1)}`,
          p.values,
        );
        const truncated = res.rows.length > limit;
        return {
          units: res.rows.slice(0, limit).map(navRow),
          truncated,
        };
      });
    },

    async getPageUnits(
      collection: string,
      scope: AccessScope,
      reference: string,
      from: number,
      to: number,
      options?: NavReadOptions,
    ): Promise<PostgresResponse<NavUnitRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const start = Math.max(1, Math.min(from, to));
      const end = Math.max(from, to);
      const ref = normalizeReference(reference);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        const startPh = p.add(start);
        const endPh = p.add(end);
        // Overlap test, and exclude the section-unit sentinel (page 0). page/
        // chunk/table/figure units carry real page ranges.
        const res = await client.query<NavRowShape>(
          `${NAV_ROW_SELECT}
             FROM "${table}"
            WHERE base_ref = ${refPh}
              AND page_start IS NOT NULL AND page_end IS NOT NULL
              AND page_start > 0 AND page_end > 0
              AND page_start <= ${endPh} AND page_end >= ${startPh}${temporalFilter}${accessSql}
            ORDER BY ${DOCUMENT_ORDER_SQL}
            LIMIT ${NAV_MAX_UNITS}`,
          p.values,
        );
        return res.rows.map(navRow);
      });
    },

    async getContextUnits(
      collection: string,
      scope: AccessScope,
      unitId: string,
      before: number,
      after: number,
      options?: NavReadOptions,
    ): Promise<
      PostgresResponse<{
        before: NavUnitRow[];
        unit: NavUnitRow | null;
        after: NavUnitRow[];
      }>
    > {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const target = unitId?.trim();
      if (!target)
        return { ok: true, result: { before: [], unit: null, after: [] } };
      const beforeN = clampInt(before, 1, 0, 50);
      const afterN = clampInt(after, 1, 0, 50);
      return withClient(async (client) => {
        // Resolve the target under the visibility gates, and walk its prev/next
        // graph within the same document. Each hop re-checks visibility, so a
        // neighbour the caller cannot see terminates the walk (never leaks).
        const load = async (
          id: string,
        ): Promise<
          | (NavUnitRow & {
              prev_unit_id: string | null;
              next_unit_id: string | null;
            })
          | null
        > => {
          const p = new SqlParams();
          const temporalFilter = buildTemporalFilterSql(
            p,
            table,
            options?.includeAllVersions ?? false,
            options?.validAt,
            "",
            collection,
          );
          const accessSql = buildAccessSql(p, scope);
          const idPh = p.add(id);
          const res = await client.query<
            NavRowShape & {
              prev_unit_id: string | null;
              next_unit_id: string | null;
            }
          >(
            `${NAV_ROW_SELECT}, prev_unit_id, next_unit_id
               FROM "${table}"
              WHERE unit_id = ${idPh}${temporalFilter}${accessSql}
              LIMIT 1`,
            p.values,
          );
          const row = res.rows[0];
          if (!row) return null;
          return {
            ...navRow(row),
            prev_unit_id: row.prev_unit_id,
            next_unit_id: row.next_unit_id,
          };
        };
        const center = await load(target);
        if (!center) return { before: [], unit: null, after: [] };
        const beforeRows: NavUnitRow[] = [];
        let cursor: string | null = center.prev_unit_id;
        for (let i = 0; i < beforeN && cursor; i++) {
          const row = await load(cursor);
          if (!row) break;
          beforeRows.push(stripLinks(row));
          cursor = row.prev_unit_id;
        }
        beforeRows.reverse();
        const afterRows: NavUnitRow[] = [];
        cursor = center.next_unit_id;
        for (let i = 0; i < afterN && cursor; i++) {
          const row = await load(cursor);
          if (!row) break;
          afterRows.push(stripLinks(row));
          cursor = row.next_unit_id;
        }
        return {
          before: beforeRows,
          unit: stripLinks(center),
          after: afterRows,
        };
      });
    },

    async listFigureUnits(
      collection: string,
      scope: AccessScope,
      reference: string,
      options?: NavReadOptions & {
        fromPage?: number;
        toPage?: number;
        kind?: string;
        limit?: number;
        offset?: number;
      },
    ): Promise<PostgresResponse<{ figures: FigureUnitInfo[]; total: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const ref = normalizeReference(reference);
      const limit = clampInt(options?.limit, 50, 1, 500);
      const offset = clampInt(options?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        let rangeSql = "";
        if (options?.fromPage != null && options?.toPage != null) {
          const from = Math.max(1, Math.min(options.fromPage, options.toPage));
          const to = Math.max(options.fromPage, options.toPage);
          rangeSql = ` AND page_start IS NOT NULL AND page_start >= ${p.add(from)} AND page_start <= ${p.add(to)}`;
        }
        // An alias (`process`, `drawing`, …) covers the stored kinds it names.
        const kindValue = options?.kind?.trim() ?? "";
        const kindSql =
          kindValue !== ""
            ? ` AND figure_kind = ANY(${p.add([...new Set([kindValue, ...(resolveFigureKinds(kindValue) ?? [])])])}::text[])`
            : "";
        const where = `base_ref = ${refPh} AND unit_type = 'figure'${rangeSql}${kindSql}${temporalFilter}${accessSql}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM "${table}" WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const offsetPh = p.add(offset);
        const res = await client.query<{
          content: string | null;
          page_start: number | null;
          figure_kind: string | null;
          figure_id: string | null;
          asset_id: string | null;
          bbox: unknown;
        }>(
          `SELECT content, page_start, figure_kind,
                  metadata->>'figure_id' AS figure_id,
                  metadata->>'asset_id'  AS asset_id,
                  metadata->'bbox'       AS bbox
             FROM "${table}"
            WHERE ${where}
            ORDER BY page_start ASC NULLS FIRST, id ASC
            LIMIT ${limitPh} OFFSET ${offsetPh}`,
          p.values,
        );
        const figures: FigureUnitInfo[] = res.rows
          .filter((row) => row.figure_id)
          .map((row) => {
            const bbox =
              Array.isArray(row.bbox) &&
              row.bbox.length === 4 &&
              row.bbox.every((n) => typeof n === "number")
                ? (row.bbox as [number, number, number, number])
                : null;
            return {
              figure_id: row.figure_id as string,
              asset_id: row.asset_id ?? null,
              figure_kind: row.figure_kind ?? null,
              caption: figureCaption(row.content),
              page: row.page_start ?? null,
              bbox,
            };
          });
        return { figures, total };
      });
    },

    async getTableUnits(
      collection: string,
      scope: AccessScope,
      tableId: string,
      options?: NavReadOptions & { limit?: number },
    ): Promise<PostgresResponse<{ units: NavUnitRow[]; total: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const id = tableId?.trim();
      if (!id) return { ok: true, result: { units: [], total: 0 } };
      const limit = clampInt(options?.limit, 200, 1, 2000);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const idPh = p.add(id);
        const where = `table_id = ${idPh}${temporalFilter}${accessSql}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM "${table}" WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const res = await client.query<NavRowShape>(
          `${NAV_ROW_SELECT}
             FROM "${table}"
            WHERE ${where}
            ORDER BY ${DOCUMENT_ORDER_SQL}
            LIMIT ${limitPh}`,
          p.values,
        );
        return { units: res.rows.map(navRow), total };
      });
    },

    async getUnitById(
      collection: string,
      scope: AccessScope,
      unitId: string,
      options?: NavReadOptions,
    ): Promise<PostgresResponse<NavUnitRow | null>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const id = unitId?.trim();
      if (!id) return { ok: true, result: null };
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const idPh = p.add(id);
        const res = await client.query<
          NavRowShape & { base_ref: string; figure_refs: string[] | null }
        >(
          `${NAV_ROW_SELECT}, base_ref, figure_refs
             FROM "${table}"
            WHERE unit_id = ${idPh}${temporalFilter}${accessSql}
            LIMIT 1`,
          p.values,
        );
        const row = res.rows[0];
        if (!row) return null;
        const unit = navRow(row);
        // Surface figure_refs (figure ids the unit references) on the metadata
        // mirror so follow_ref can resolve them via lookupFigureUnits.
        if (Array.isArray(row.figure_refs) && row.figure_refs.length > 0) {
          unit.metadata = {
            ...unit.metadata,
            base_ref: row.base_ref,
            figure_refs: row.figure_refs,
          };
        } else {
          unit.metadata = { ...unit.metadata, base_ref: row.base_ref };
        }
        return unit;
      });
    },

    async lookupRevisionSourceSha256(
      collection: string,
      tenantId: string,
      revisionId: string,
    ): Promise<PostgresResponse<string | null>> {
      const tenant = tenantId.trim();
      if (tenant === "" || revisionId.trim() === "")
        return { ok: true, result: null };
      return withClient(async (client) => {
        // Only the HEAD of each staged payload is read: `document.begin` is the
        // first record of the NDJSON stream, so a bounded prefix is enough and a
        // multi-MB page batch is never pulled into memory. The join to
        // vs_revisions pins the batch to a revision that still exists for this
        // tenant + collection.
        const res = await client.query<{ head: Buffer | null }>(
          `SELECT substring(b.payload FROM 1 FOR $4) AS head
             FROM vs_ingest_batches b
             JOIN vs_revisions r
               ON r.tenant_id = b.tenant_id
              AND r.collection = b.collection
              AND r.revision_id = b.revision_id
            WHERE b.tenant_id = $1 AND b.collection = $2 AND b.revision_id = $3
              AND b.payload IS NOT NULL
            ORDER BY b.seq ASC
            LIMIT $5`,
          [
            tenant,
            collection,
            revisionId,
            SOURCE_HEAD_BYTES,
            SOURCE_HEAD_MAX_BATCHES,
          ],
        );
        for (const row of res.rows) {
          const sha = sourceSha256FromPayloadHead(row.head);
          if (sha !== null) return sha;
        }
        return null;
      });
    },

    async findIdentifierOccurrences(
      collection: string,
      scope: AccessScope,
      valueNorm: string,
      options?: NavReadOptions & {
        limit?: number;
        offset?: number;
        pathPrefix?: string;
      },
    ): Promise<
      PostgresResponse<{ occurrences: IdentifierOccurrence[]; total: number }>
    > {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const norm = valueNorm?.trim();
      if (!norm) return { ok: true, result: { occurrences: [], total: 0 } };
      const limit = clampInt(options?.limit, 50, 1, 500);
      const offset = clampInt(options?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return withClient(async (client) => {
        // Join vs_identifiers to the collection table on unit_id, gated by the
        // per-unit visibility predicates so an occurrence surfaces only when its
        // unit is visible to the caller in the current revision.
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "d",
          collection,
        );
        const access = buildAccessSql(p, scope, "d");
        const tenantPh = p.add(scope.tenantId);
        const collPh = p.add(collection);
        const normPh = p.add(norm);
        // A folder scope (a project) keeps occurrences from other folders out.
        const prefix = normalizePathPrefix(options?.pathPrefix);
        const prefixSql =
          prefix === ""
            ? ""
            : ` AND d.base_ref LIKE ${p.add(escapeLikeLiteral(prefix) + "/%")} ESCAPE '\\'`;
        const where =
          `i.tenant_id = ${tenantPh} AND i.collection = ${collPh} AND i.value_norm = ${normPh}` +
          ` AND d.tenant_id = i.tenant_id AND d.unit_id = i.unit_id${prefixSql}${temporalFilter}${access}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n
             FROM vs_identifiers i JOIN "${table}" d ON d.unit_id = i.unit_id
            WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const offsetPh = p.add(offset);
        const res = await client.query<{
          value_norm: string;
          unit_id: string;
          page: number | null;
          kind: string | null;
          reference: string;
          base_ref: string;
          section_path: string[] | null;
          content: string | null;
        }>(
          `SELECT i.value_norm, i.unit_id, i.page, i.kind,
                  d.reference, d.base_ref, d.section_path, d.content
             FROM vs_identifiers i JOIN "${table}" d ON d.unit_id = i.unit_id
            WHERE ${where}
            ORDER BY d.base_ref ASC, i.page ASC, d.id ASC
            LIMIT ${limitPh} OFFSET ${offsetPh}`,
          p.values,
        );
        const occurrences: IdentifierOccurrence[] = res.rows.map((row) => ({
          value_norm: row.value_norm,
          unit_id: row.unit_id,
          page: row.page ?? null,
          kind: row.kind ?? null,
          reference: row.reference,
          base_ref: row.base_ref,
          section_path: Array.isArray(row.section_path) ? row.section_path : [],
          excerpt: navExcerpt(row.content),
        }));
        return { occurrences, total };
      });
    },

    /**
     * Load cited chunks by id for `POST /v2/citations/check` in ONE query.
     *
     * A citation id is the v1 `chunk_id` (stored in the `chunk` jsonb) or the
     * v2 `unit_id` a search hit carried as evidence, so the id predicate
     * matches either column. There is deliberately NO temporal filter: a cited
     * chunk may live in a superseded revision and must still resolve so the
     * caller can classify it (`current` / `carried` / `changed`); a chunk the
     * caller's ACL hides — or that never existed — simply does not come back
     * and is reported `unknown`. The ACL clause is the same as search's.
     */
    async getChunksByIds(
      collection: string,
      scope: AccessScope,
      chunkIds: string[],
    ): Promise<PostgresResponse<CitationChunkRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      if (chunkIds.length === 0) return { ok: true, result: [] };
      return withClient(async (client) => {
        const p = new SqlParams();
        const accessSql = buildAccessSql(p, scope);
        const idsPh = p.add(chunkIds);
        const res = await client.query<{
          id: string | null;
          base_ref: string;
          revision_id: string | null;
          content: string | null;
          valid_from: Date | string | null;
          created: Date | string;
        }>(
          `SELECT COALESCE(chunk->>'chunk_id', unit_id) AS id,
                  base_ref, revision_id, content, valid_from, created
             FROM "${table}"
            WHERE (chunk->>'chunk_id' = ANY(${idsPh}::text[])
                   OR unit_id = ANY(${idsPh}::text[]))${accessSql}`,
          p.values,
        );
        const rows: CitationChunkRow[] = [];
        for (const row of res.rows) {
          if (row.id === null || row.content === null) continue;
          rows.push({
            id: row.id,
            base_ref: row.base_ref,
            revision_id: row.revision_id ?? null,
            content: row.content,
            valid_from:
              row.valid_from === null ? null : new Date(row.valid_from).toISOString(),
            created: new Date(row.created).toISOString(),
          });
        }
        return rows;
      });
    },

    /**
     * The revision of each document visible at `validAt` (the same temporal
     * rule as `document_diff`), for a set of base refs, in ONE query. A base
     * ref with no visible row is absent from the result — the caller reads
     * that as `removed`. All units of one document's visible version share a
     * `revision_id`, so the first row per base ref is representative; a legacy
     * (unversioned) document yields a null revision.
     */
    async getCurrentRevisionsAt(
      collection: string,
      scope: AccessScope,
      baseRefs: string[],
      validAt: string,
    ): Promise<PostgresResponse<CurrentRevisionRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      if (baseRefs.length === 0) return { ok: true, result: [] };
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          false,
          validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refsPh = p.add(baseRefs);
        const res = await client.query<{
          base_ref: string;
          revision_id: string | null;
        }>(
          `SELECT base_ref, revision_id
             FROM "${table}"
            WHERE base_ref = ANY(${refsPh}::text[])${temporalFilter}${accessSql}`,
          p.values,
        );
        const byRef = new Map<string, CurrentRevisionRow>();
        for (const row of res.rows) {
          if (byRef.has(row.base_ref)) continue;
          byRef.set(row.base_ref, {
            base_ref: row.base_ref,
            revision_id: row.revision_id ?? null,
          });
        }
        return [...byRef.values()];
      });
    },

    /**
     * The content of every unit of one document's revision visible at
     * `validAt`, for the citations-check content-hash comparison. Bounded by
     * the navigation unit cap. One query per document, never per chunk.
     */
    async getCurrentRevisionContents(
      collection: string,
      scope: AccessScope,
      baseRef: string,
      validAt: string,
    ): Promise<PostgresResponse<string[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const ref = normalizeReference(baseRef);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          false,
          validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        const res = await client.query<{ content: string | null }>(
          `SELECT content
             FROM "${table}"
            WHERE base_ref = ${refPh}${temporalFilter}${accessSql}
            LIMIT ${p.add(NAV_MAX_UNITS)}`,
          p.values,
        );
        return res.rows.map((row) => row.content ?? "");
      });
    },
  };
}
