// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp-nav.ts
 *
 * The v2 document-navigation MCP tools (task 3.9, Requirements 15.1/15.3/15.4).
 * Kept in a sibling module so `handlers/mcp.ts` stays maintainable; the tools
 * are registered onto the same {@link McpServer} via {@link registerNavigationTools},
 * so they inherit the one registration boundary in mcp.ts (identical Fabric
 * scope, authorization and idempotency semantics) — they are ADDITIVE and never
 * touch the existing tools.
 *
 * The tools:
 *   - `get_outline(ref, depth)`      — table of contents (section ids + pages),
 * depth-limited AND paginated;
 *   - `get_section(ref, …, max_chars)` — a section as Markdown v2, size-bounded;
 *   - `get_pages(ref, from, to, …)`   — a page range as Markdown v2 / summary;
 *   - `get_context(unit_id, before, after)` — reading-order neighbours;
 *   - `list_figures(ref, pages?, kind?)`     — figures of a range, paginated;
 *   - `get_asset(asset_id, variant, region?)`— image as MCP image content, with an
 *                                       optional server-side region zoom via the
 *                                       render-cache; FAILS CLOSED on a metadata
 *                                       mismatch (15.4);
 *   - `get_table(table_id, rows?)`    — a logical table reassembled across pages;
 *   - `find_identifier(value)`        — exact occurrences across the collection,
 *                                       paginated;
 *   - `follow_ref(unit_id)`           — resolve a unit's referenced figures.
 *
 * Every read runs through the SAME tenant/ACL + temporal/revision-visibility
 * gates as search (the PostgresClient navigation methods enforce them), so a
 * navigation call can never surface a unit or asset the caller could not have
 * retrieved directly, nor one from a non-current revision (15 constraints).
 */

import { documentBodyText } from "../postgres-client.js";
import { FIGURE_KINDS, resolveFigureKinds, unknownFigureKindMessage } from "../figure-kinds.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import type {
  IdentifierOccurrence,
  NavUnitRow,
  PostgresClient,
} from "../postgres-client.js";
import type { AssetStore, AssetScope, AssetMeta } from "../asset-store.js";
import type { AssetVariant } from "../asset-variants.js";
import { ASSET_VARIANTS } from "../asset-variants.js";
import type { RenderCache, RegionBox } from "../render-cache.js";
import { normalizeIdentifier } from "../identifier.js";
import { expectedReferenceMatches } from "../expected-reference.js";
import { responseTrustLabels } from "../content-trust.js";

/** MIME types an image tool is allowed to stream back as MCP image content. */
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * The wiring the navigation tools need from the MCP handler. `authorize`,
 * `accessScopeForMcp` and `emitQueryActivity` are the exact helpers the other
 * MCP tools use, passed in so the two modules share one implementation.
 */
export interface NavigationToolContext {
  server: McpServer;
  postgresClient: PostgresClient;
  logger: Logger;
  defaultCollection: string;
  /** Resolve + authorize a collection for the acting principal (mcp.ts). */
  authorize: (collection: string) => Promise<{ scope: AccessScope; acl: unknown }>;
  /** The acting MCP principal's access scope (mcp.ts). */
  accessScopeForMcp: () => AccessScope;
  /** Emit a read-only "query" activity event (mcp.ts). */
  emitQueryActivity: (params: {
    tool: string;
    summary: string;
    status: "ok" | "error";
    startTime: number;
    detail: Record<string, unknown>;
  }) => void;
  /** The v2 AssetStore, for `get_asset` variant reads + metadata. */
  assetStore?: AssetStore | null;
  /** The render-cache, for `get_asset` region zoom. Null when Extract is not configured. */
  renderCache?: RenderCache | null;
}

/** JSON-encode a text response payload the way the other MCP tools do. */
function json(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** A shaped navigation unit for the response (drops the internal metadata mirror). */
function shapeUnit(u: NavUnitRow): Record<string, unknown> {
  return {
    unit_id: u.unit_id,
    unit_type: u.unit_type,
    section_id: u.section_id,
    section_path: u.section_path,
    pages:
      u.page_start != null
        ? { from: u.page_start, to: u.page_end ?? u.page_start }
        : null,
    ...(u.figure_kind ? { figure_kind: u.figure_kind } : {}),
    ...(u.table_id ? { table_id: u.table_id } : {}),
    content: u.content,
  };
}

/**
 * Join a set of units into a single Markdown v2 string, bounded by `maxChars`.
 * Unit `content` is already Markdown v2 (the batch unit builder rendered it at
 * ingest via the contract's renderer), so a section/page view is the ordered
 * concatenation of its units' content — no re-render, no extra model call.
 * Returns the text plus whether it was truncated and the total char count.
 */
function joinMarkdown(
  units: NavUnitRow[],
  maxChars: number,
): { markdown: string; truncated: boolean; total_chars: number } {
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  let total = 0;
  for (const u of units) {
    const piece = u.content.trim();
    if (piece === "") continue;
    total += piece.length + (parts.length > 0 ? 2 : 0);
    if (used + piece.length > maxChars && parts.length > 0) {
      truncated = true;
      continue;
    }
    parts.push(piece);
    used += piece.length + 2;
    if (used >= maxChars) {
      // Everything after this would overflow; note it if more units remain.
      truncated = truncated || units.indexOf(u) < units.length - 1;
    }
  }
  return { markdown: parts.join("\n\n"), truncated, total_chars: total };
}

/**
 * Split navigation units into the document's own text and Extract's summaries.
 * A section/page read is the original: its `section`/`page`/`document` summary
 * units are returned apart, labelled, never merged into the Markdown; a table
 * unit contributes its grid once, a figure its marked transcription
 * (documentBodyText).
 */
function splitBody(units: NavUnitRow[]): {
  body: NavUnitRow[];
  summaries: Array<{ unit_type: string; page_start: number | null; page_end: number | null; section_path: string[]; summary: string }>;
} {
  const body: NavUnitRow[] = [];
  const summaries: Array<{ unit_type: string; page_start: number | null; page_end: number | null; section_path: string[]; summary: string }> = [];
  for (const u of units) {
    if (u.unit_type === "section" || u.unit_type === "page" || u.unit_type === "document") {
      summaries.push({ unit_type: u.unit_type, page_start: u.page_start, page_end: u.page_end, section_path: u.section_path, summary: u.content });
    } else {
      body.push({ ...u, content: documentBodyText(u) });
    }
  }
  return { body, summaries };
}

/** `valid_at` for the navigation reads: the version valid at that instant. */
const validAtSchema = z
  .string()
  .datetime({ offset: true })
  .optional()
  .describe(
    "RFC 3339 instant with timezone: read the document version valid at that time (as search's valid_at). Default: the current version.",
  );

export function registerNavigationTools(ctx: NavigationToolContext): void {
  const {
    server,
    postgresClient,
    logger,
    defaultCollection,
    authorize,
    accessScopeForMcp,
    emitQueryActivity,
    assetStore = null,
    renderCache = null,
  } = ctx;

  // ── get_outline ────────────────────────────────────────────────────────────
  server.tool(
    "get_outline",
    "Return a document's table of contents: its sections with heading path, section id and page range. Depth-limited (depth) and paginated (limit/offset) so a huge document's outline never overflows the context — check 'truncated'/'total'. Start research here, then drill in with get_section / get_pages.",
    {
      reference: z
        .string()
        .min(1)
        .describe("Document reference/path (base_ref from a search hit or list_documents)"),
      collection: z
        .string()
        .optional()
        .describe(`Collection to read from (default: "${defaultCollection}")`),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Maximum heading depth to include (1 = top-level sections only). Default: all depths"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum outline entries to return (default: 200)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of outline entries to skip (pagination, default: 0)"),
      valid_at: validAtSchema,
    },
    async ({ reference, collection, depth, limit, offset, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getOutline(col, accessScopeForMcp(), reference, {
        ...(valid_at !== undefined ? { validAt: valid_at } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({ tool: "get_outline", summary: `${reference} in ${col} — failed`, status: "error", startTime, detail: { collection: col, reference, error: result.error.message } });
        return { content: [{ type: "text", text: `Outline failed: ${result.error.message}` }], isError: true };
      }
      const { entries, total } = result.result;
      const truncated = (offset ?? 0) + entries.length < total;
      emitQueryActivity({ tool: "get_outline", summary: `${entries.length} of ${total} section${total === 1 ? "" : "s"} in ${reference}`, status: "ok", startTime, detail: { collection: col, reference, count: entries.length, total, truncated } });
      return json({ reference, entries, count: entries.length, total, truncated });
    },
  );

  // ── get_section ──────────────────────────────────────────────────────────────
  server.tool(
    "get_section",
    "Return one section of a document as Markdown v2 (in reading order), selected by section_id (from get_outline) or by a section_path prefix. Bounded by max_chars — check 'truncated' and narrow the selector or read the pages directly if it is set.",
    {
      reference: z.string().min(1).describe("Document reference/path (base_ref)"),
      collection: z.string().optional().describe(`Collection to read from (default: "${defaultCollection}")`),
      section_id: z.string().min(1).optional().describe("Section id from get_outline (preferred)"),
      section_path: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Section path prefix, e.g. ["4 Antragseingang", "4.2 Anmeldung"]. Used when section_id is not given.'),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(500_000)
        .optional()
        .describe("Maximum Markdown length to return (default: 40000). Guards the context; sets 'truncated' when exceeded."),
      valid_at: validAtSchema,
    },
    async ({ reference, collection, section_id, section_path, max_chars, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      if (!section_id && (!section_path || section_path.length === 0)) {
        return { content: [{ type: "text", text: "Provide section_id or section_path." }], isError: true };
      }
      await authorize(col);
      const result = await postgresClient.getSectionUnits(
        col,
        accessScopeForMcp(),
        reference,
        { ...(section_id ? { sectionId: section_id } : {}), ...(section_path ? { sectionPath: section_path } : {}) },
        valid_at !== undefined ? { validAt: valid_at } : undefined,
      );
      if (!result.ok) {
        emitQueryActivity({ tool: "get_section", summary: `${reference} in ${col} — failed`, status: "error", startTime, detail: { collection: col, reference, error: result.error.message } });
        return { content: [{ type: "text", text: `Section read failed: ${result.error.message}` }], isError: true };
      }
      const cap = max_chars ?? 40_000;
      const { body, summaries } = splitBody(result.result);
      const { markdown, truncated, total_chars } = joinMarkdown(body, cap);
      emitQueryActivity({ tool: "get_section", summary: `${result.result.length} unit${result.result.length === 1 ? "" : "s"} of ${section_id ?? section_path?.join(" › ")} in ${reference}${truncated ? " (truncated)" : ""}`, status: "ok", startTime, detail: { collection: col, reference, section_id, units: result.result.length, truncated } });
      return json({
        reference,
        section_id: section_id ?? null,
        section_path: section_path ?? null,
        markdown,
        units: body.length,
        truncated,
        total_chars,
        ...(summaries.length > 0 ? { summaries } : {}),
        ...responseTrustLabels([markdown, ...summaries.map((s) => s.summary)]),
      });
    },
  );

  // ── get_pages ──────────────────────────────────────────────────────────────
  server.tool(
    "get_pages",
    "Return a page range of a document as Markdown v2 or a compact summary. Bounded by max_chars — check 'truncated'. Use after get_outline / a search hit to read the exact pages an answer needs.",
    {
      reference: z.string().min(1).describe("Document reference/path (base_ref)"),
      collection: z.string().optional().describe(`Collection to read from (default: "${defaultCollection}")`),
      from: z.number().int().min(1).describe("First page (1-based, inclusive)"),
      to: z.number().int().min(1).describe("Last page (1-based, inclusive)"),
      format: z
        .enum(["markdown", "summary"])
        .optional()
        .describe("markdown = full Markdown v2 of the pages; summary = one line per unit. Default: markdown"),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(500_000)
        .optional()
        .describe("Maximum length to return (default: 40000). Sets 'truncated' when exceeded."),
      valid_at: validAtSchema,
    },
    async ({ reference, collection, from, to, format, max_chars, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getPageUnits(
        col,
        accessScopeForMcp(),
        reference,
        from,
        to,
        valid_at !== undefined ? { validAt: valid_at } : undefined,
      );
      if (!result.ok) {
        emitQueryActivity({ tool: "get_pages", summary: `${reference} ${from}-${to} in ${col} — failed`, status: "error", startTime, detail: { collection: col, reference, from, to, error: result.error.message } });
        return { content: [{ type: "text", text: `Pages read failed: ${result.error.message}` }], isError: true };
      }
      const cap = max_chars ?? 40_000;
      const units = result.result;
      if (format === "summary") {
        const lines = units.map((u) => {
          const first = u.content.split(/\r?\n/, 1)[0]?.trim() ?? "";
          const page = u.page_start != null ? `p${u.page_start}${u.page_end && u.page_end !== u.page_start ? `-${u.page_end}` : ""}` : "?";
          return `- [${page}] ${u.unit_type ?? "unit"}: ${first.length > 160 ? `${first.slice(0, 160)}…` : first}`;
        });
        const joined = joinMarkdown(units.map((u, i) => ({ ...u, content: lines[i] ?? "" })), cap);
        emitQueryActivity({ tool: "get_pages", summary: `${units.length} unit summary of ${reference} ${from}-${to}`, status: "ok", startTime, detail: { collection: col, reference, from, to, units: units.length, format: "summary" } });
        return json({
          reference,
          from,
          to,
          format: "summary",
          summary: joined.markdown,
          units: units.length,
          truncated: joined.truncated,
          ...responseTrustLabels([joined.markdown]),
        });
      }
      const { body, summaries } = splitBody(units);
      const { markdown, truncated, total_chars } = joinMarkdown(body, cap);
      emitQueryActivity({ tool: "get_pages", summary: `${body.length} unit${body.length === 1 ? "" : "s"} of ${reference} ${from}-${to}${truncated ? " (truncated)" : ""}`, status: "ok", startTime, detail: { collection: col, reference, from, to, units: body.length, truncated } });
      return json({
        reference,
        from,
        to,
        format: "markdown",
        markdown,
        units: body.length,
        truncated,
        total_chars,
        ...(summaries.length > 0 ? { summaries } : {}),
        ...responseTrustLabels([markdown, ...summaries.map((s) => s.summary)]),
      });
    },
  );

  // ── get_context ────────────────────────────────────────────────────────────
  server.tool(
    "get_context",
    "Return the reading-order neighbours of a unit: the unit itself plus up to 'before' preceding and 'after' following units, walked through the document's unit graph. Use to widen the window around a search hit without re-searching.",
    {
      unit_id: z.string().min(1).describe("The unit id (from a search hit's evidence or another navigation tool)"),
      collection: z.string().optional().describe(`Collection to read from (default: "${defaultCollection}")`),
      before: z.number().int().min(0).max(50).optional().describe("Number of preceding units to include (default: 2)"),
      after: z.number().int().min(0).max(50).optional().describe("Number of following units to include (default: 2)"),
    },
    async ({ unit_id, collection, before, after }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getContextUnits(col, accessScopeForMcp(), unit_id, before ?? 2, after ?? 2);
      if (!result.ok) {
        emitQueryActivity({ tool: "get_context", summary: `${unit_id} in ${col} — failed`, status: "error", startTime, detail: { collection: col, unit_id, error: result.error.message } });
        return { content: [{ type: "text", text: `Context read failed: ${result.error.message}` }], isError: true };
      }
      const { before: b, unit, after: a } = result.result;
      if (unit === null) {
        emitQueryActivity({ tool: "get_context", summary: `${unit_id} in ${col} — not found`, status: "error", startTime, detail: { collection: col, unit_id, reason: "not_found" } });
        return { content: [{ type: "text", text: `No visible unit "${unit_id}" in collection "${col}".` }], isError: true };
      }
      emitQueryActivity({ tool: "get_context", summary: `${b.length}+1+${a.length} units around ${unit_id}`, status: "ok", startTime, detail: { collection: col, unit_id, before: b.length, after: a.length } });
      return json({
        unit_id,
        before: b.map(shapeUnit),
        unit: shapeUnit(unit),
        after: a.map(shapeUnit),
        ...responseTrustLabels([...b, unit, ...a].map((u) => u.content)),
      });
    },
  );

  // ── list_figures ─────────────────────────────────────────────────────────────
  server.tool(
    "list_figures",
    `List the figures of a document, optionally restricted to a page range and/or a figure kind (${FIGURE_KINDS.join(", ")}; aliases such as process = bpmn + flowchart, drawing = technical_drawing, data = chart, mask = ui_mask). Paginated (limit/offset) — check 'truncated'/'total'. Each figure carries its asset_id (fetch the image with get_asset), kind, caption, page and bbox.`,
    {
      reference: z.string().min(1).describe("Document reference/path (base_ref)"),
      collection: z.string().optional().describe(`Collection to read from (default: "${defaultCollection}")`),
      from_page: z.number().int().min(1).optional().describe("First page of the range (inclusive). Requires to_page."),
      to_page: z.number().int().min(1).optional().describe("Last page of the range (inclusive). Requires from_page."),
      kind: z
        .string()
        .min(1)
        .optional()
        .describe(`Restrict to a figure kind: ${FIGURE_KINDS.join(" | ")}. Aliases: process (bpmn + flowchart), drawing (technical_drawing), data (chart), mask (ui_mask), table (table_image).`),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum figures to return (default: 50)"),
      offset: z.number().int().min(0).optional().describe("Number of figures to skip (pagination, default: 0)"),
      valid_at: validAtSchema,
    },
    async ({ reference, collection, from_page, to_page, kind, limit, offset, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      if (kind !== undefined && resolveFigureKinds(kind) === null) {
        return { content: [{ type: "text", text: unknownFigureKindMessage(kind) }], isError: true };
      }
      const result = await postgresClient.listFigureUnits(col, accessScopeForMcp(), reference, {
        ...(valid_at !== undefined ? { validAt: valid_at } : {}),
        ...(from_page !== undefined && to_page !== undefined ? { fromPage: from_page, toPage: to_page } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({ tool: "list_figures", summary: `${reference} in ${col} — failed`, status: "error", startTime, detail: { collection: col, reference, error: result.error.message } });
        return { content: [{ type: "text", text: `List figures failed: ${result.error.message}` }], isError: true };
      }
      const { figures, total } = result.result;
      const truncated = (offset ?? 0) + figures.length < total;
      emitQueryActivity({ tool: "list_figures", summary: `${figures.length} of ${total} figure${total === 1 ? "" : "s"} in ${reference}${truncated ? " (truncated)" : ""}`, status: "ok", startTime, detail: { collection: col, reference, count: figures.length, total, truncated, kind } });
      return json({ reference, figures, count: figures.length, total, truncated });
    },
  );

  // ── get_table ──────────────────────────────────────────────────────────────
  server.tool(
    "get_table",
    "Return a logical table reassembled from its row-group units, even across page boundaries, by table_id (from a search hit or list). Bounded by 'rows' (row-group count) — check 'truncated'/'total'.",
    {
      table_id: z.string().min(1).describe("Table id (from a table search hit's evidence)"),
      collection: z.string().optional().describe(`Collection to read from (default: "${defaultCollection}")`),
      rows: z.number().int().min(1).max(2000).optional().describe("Maximum row-group units to return (default: 200)"),
      valid_at: validAtSchema,
    },
    async ({ table_id, collection, rows, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getTableUnits(col, accessScopeForMcp(), table_id, {
        ...(valid_at !== undefined ? { validAt: valid_at } : {}),
        ...(rows !== undefined ? { limit: rows } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({ tool: "get_table", summary: `${table_id} in ${col} — failed`, status: "error", startTime, detail: { collection: col, table_id, error: result.error.message } });
        return { content: [{ type: "text", text: `Table read failed: ${result.error.message}` }], isError: true };
      }
      const { units, total } = result.result;
      const truncated = units.length < total;
      const markdown = units.map((u) => u.content.trim()).filter((t) => t !== "").join("\n\n");
      const pages = units.reduce<{ from: number | null; to: number | null }>(
        (acc, u) => ({
          from: acc.from == null ? u.page_start : Math.min(acc.from, u.page_start ?? acc.from),
          to: acc.to == null ? u.page_end ?? u.page_start : Math.max(acc.to, u.page_end ?? u.page_start ?? acc.to),
        }),
        { from: null, to: null },
      );
      emitQueryActivity({ tool: "get_table", summary: `${units.length} of ${total} row-group${total === 1 ? "" : "s"} for ${table_id}${truncated ? " (truncated)" : ""}`, status: "ok", startTime, detail: { collection: col, table_id, units: units.length, total, truncated } });
      return json({
        table_id,
        markdown,
        pages: pages.from != null ? pages : null,
        row_groups: units.length,
        total,
        truncated,
        ...responseTrustLabels([markdown]),
      });
    },
  );

  // ── find_identifier ──────────────────────────────────────────────────────────
  server.tool(
    "find_identifier",
    "Find EXACT occurrences of an identifier (article/transaction/drawing/standard/requirement code, e.g. \"WE-01/A\") across the whole collection. Matching is normalization-insensitive (case, spaces, dots, hyphens, slashes). Paginated (limit/offset) — check 'truncated'/'total'. Each hit carries its unit_id, page, section path and a short excerpt.",
    {
      value: z.string().min(1).describe("The identifier to find, as written (e.g. \"WE-01/A\", \"DIN EN 1090-2\")"),
      collection: z.string().optional().describe(`Collection to search (default: "${defaultCollection}")`),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum occurrences to return (default: 50)"),
      offset: z.number().int().min(0).optional().describe("Number of occurrences to skip (pagination, default: 0)"),
      path_prefix: z
        .string()
        .optional()
        .describe('Only occurrences in documents beneath this folder path (e.g. a project folder from find_folders), e.g. "/Kunde A".'),
      valid_at: validAtSchema,
    },
    async ({ value, collection, limit, offset, path_prefix, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const valueNorm = normalizeIdentifier(value);
      if (valueNorm === "") {
        return { content: [{ type: "text", text: "The identifier normalized to an empty value." }], isError: true };
      }
      const result = await postgresClient.findIdentifierOccurrences(col, accessScopeForMcp(), valueNorm, {
        ...(path_prefix !== undefined && path_prefix.trim() !== "" ? { pathPrefix: path_prefix } : {}),
        ...(valid_at !== undefined ? { validAt: valid_at } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({ tool: "find_identifier", summary: `${value} in ${col} — failed`, status: "error", startTime, detail: { collection: col, value_norm: valueNorm, error: result.error.message } });
        return { content: [{ type: "text", text: `Find identifier failed: ${result.error.message}` }], isError: true };
      }
      const { occurrences, total } = result.result;
      const truncated = (offset ?? 0) + occurrences.length < total;
      emitQueryActivity({ tool: "find_identifier", summary: `${occurrences.length} of ${total} occurrence${total === 1 ? "" : "s"} of ${valueNorm}${truncated ? " (truncated)" : ""}`, status: "ok", startTime, detail: { collection: col, value_norm: valueNorm, count: occurrences.length, total, truncated } });
      return json({ value, value_norm: valueNorm, occurrences: occurrences.map(shapeOccurrence), count: occurrences.length, total, truncated });
    },
  );

  // ── follow_ref ───────────────────────────────────────────────────────────────
  server.tool(
    "follow_ref",
    "Resolve a unit's cross-references: given a unit_id, return the unit and the figures it references (its figure_refs) with their asset_id/kind/caption/page, so a \"see figure …\" pointer can be followed to the image (fetch it with get_asset).",
    {
      unit_id: z.string().min(1).describe("The unit id whose references to resolve"),
      collection: z.string().optional().describe(`Collection to read from (default: "${defaultCollection}")`),
    },
    async ({ unit_id, collection }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      const scope = (await authorize(col)).scope;
      const unitResult = await postgresClient.getUnitById(col, accessScopeForMcp(), unit_id);
      if (!unitResult.ok) {
        emitQueryActivity({ tool: "follow_ref", summary: `${unit_id} in ${col} — failed`, status: "error", startTime, detail: { collection: col, unit_id, error: unitResult.error.message } });
        return { content: [{ type: "text", text: `Follow ref failed: ${unitResult.error.message}` }], isError: true };
      }
      const unit = unitResult.result;
      if (unit === null) {
        emitQueryActivity({ tool: "follow_ref", summary: `${unit_id} in ${col} — not found`, status: "error", startTime, detail: { collection: col, unit_id, reason: "not_found" } });
        return { content: [{ type: "text", text: `No visible unit "${unit_id}" in collection "${col}".` }], isError: true };
      }
      const baseRef = typeof unit.metadata.base_ref === "string" ? unit.metadata.base_ref : "";
      const figureRefs = Array.isArray(unit.metadata.figure_refs)
        ? (unit.metadata.figure_refs as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      let figures: unknown[] = [];
      if (baseRef !== "" && figureRefs.length > 0) {
        const figResult = await postgresClient.lookupFigureUnits(col, scope, baseRef, figureRefs);
        if (figResult.ok) figures = figResult.result;
        else logger.warn({ error: figResult.error, unit_id }, "[MCP] follow_ref figure lookup failed");
      }
      emitQueryActivity({ tool: "follow_ref", summary: `${figures.length} referenced figure${figures.length === 1 ? "" : "s"} from ${unit_id}`, status: "ok", startTime, detail: { collection: col, unit_id, referenced: figures.length } });
      return json({
        unit: shapeUnit(unit),
        references: { figures },
        ...responseTrustLabels([unit.content]),
      });
    },
  );

  // ── get_asset ────────────────────────────────────────────────────────────────
  server.tool(
    "get_asset",
    "Fetch an authorized image asset as MCP image content. Pass the asset_id (from a search hit, list_figures or follow_ref). `variant` picks a size (thumb | preview | full). `region` (a normalized [x0,y0,x1,y1] bbox in 0..1) requests a server-side ZOOM crop rendered at higher resolution. Optional expected_document_reference / expected_figure_id FAIL CLOSED when they do not match the asset's metadata — never returning an image for a mismatched reference.",
    {
      asset_id: z.string().min(1).describe("Asset id from a search hit / list_figures / follow_ref"),
      collection: z.string().optional().describe(`Collection to read from (default: "${defaultCollection}")`),
      variant: z
        .enum(["thumb", "preview", "full"])
        .optional()
        .describe("Image size to return (default: preview). Ignored when a region zoom is requested."),
      region: z
        .array(z.number())
        .length(4)
        .optional()
        .describe("Normalized crop box [x0,y0,x1,y1] in 0..1 for a server-side zoom (rendered via Extract and cached)."),
      source_sha256: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .optional()
        .describe(
          "Optional expected document source sha256. The render source is ALWAYS resolved server-side from the asset's revision; when given, this value is only compared against it and a mismatch FAILS CLOSED.",
        ),
      target_pixels: z
        .number()
        .int()
        .min(64)
        .max(8192)
        .optional()
        .describe("Desired long-edge pixel count for a region zoom (Extract clamps it to its ceiling)."),
      expected_document_reference: z.string().min(1).optional().describe("Fail closed unless the asset belongs to this document reference"),
      expected_figure_id: z.string().min(1).optional().describe("Fail closed unless the asset is this figure id"),
    },
    async ({
      asset_id,
      collection,
      variant,
      region,
      source_sha256,
      target_pixels,
      expected_document_reference,
      expected_figure_id,
    }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const scope = accessScopeForMcp();
      const assetScope: AssetScope = {
        tenantId: scope.tenantId ?? "",
        collection: col,
      };

      const fail = (
        reason:
          | "unavailable"
          | "not_found"
          | "metadata_mismatch"
          | "unsupported_mime"
          | "region_unavailable"
          | "render_failed"
          | "source_unresolved"
          | "source_mismatch",
      ) => {
        emitQueryActivity({
          tool: "get_asset",
          summary: `${asset_id}${col !== "documents" ? ` in ${col}` : ""} — unavailable`,
          status: "error",
          startTime,
          detail: { collection: col, assetId: asset_id, reason },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `No authorized image asset found for "${asset_id}" in collection "${col}".`,
            },
          ],
          isError: true,
        };
      };

      if (assetStore === null) return fail("unavailable");

      // Read the asset's metadata FIRST and fail closed on any expected-field
      // mismatch BEFORE any bytes are read or any render is triggered (15.4).
      const metaResult = await assetStore.getMeta(assetScope, asset_id, scope);
      if (!metaResult.ok) return fail("unavailable");
      const meta: AssetMeta | null = metaResult.result;
      if (meta === null) return fail("not_found");
      // The expected reference may carry a `#unit:<sha>` fragment copied from
      // a search hit (v2 units store suffixed references); compare on the
      // document-reference base so faithful hit copies are not denied while a
      // genuinely different document still fails closed.
      if (
        (expected_document_reference !== undefined &&
          !expectedReferenceMatches(
            meta.documentReference,
            expected_document_reference,
          )) ||
        (expected_figure_id !== undefined &&
          meta.figureId !== expected_figure_id)
      ) {
        return fail("metadata_mismatch");
      }

      // ── Region zoom: render (or serve cached) a bbox crop via the render-cache.
      if (region !== undefined) {
        if (renderCache === null) return fail("region_unavailable");
        if (meta.page == null) return fail("region_unavailable");
        const box = region as unknown as RegionBox;
        if (
          !box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
          box[0] >= box[2] ||
          box[1] >= box[3]
        ) {
          return {
            content: [
              {
                type: "text",
                text: "region must be a normalized [x0,y0,x1,y1] with x0<x2 and y0<y2 in 0..1.",
              },
            ],
            isError: true,
          };
        }
        // Bind the render source to the ACL-checked asset (Req 14.4/14.5): the
        // sha256 comes from the asset's OWN revision (its staged
        // document.begin.source.sha256), never from the caller. Without this a
        // caller could pair an asset it may read with ANY source digest it
        // knows and have Extract render a document it cannot access. A legacy
        // asset (no revision) or a revision without a staged source fails
        // closed; a caller-supplied value is only an expectation to compare.
        if (meta.revisionId === null || meta.revisionId === "")
          return fail("source_unresolved");
        const sourceResult = await postgresClient.lookupRevisionSourceSha256(
          col,
          assetScope.tenantId,
          meta.revisionId,
        );
        if (!sourceResult.ok) {
          logger.warn(
            { error: sourceResult.error, asset_id },
            "[MCP] get_asset source lookup failed",
          );
          return fail("source_unresolved");
        }
        const serverSha = sourceResult.result;
        if (serverSha === null) return fail("source_unresolved");
        if (
          source_sha256 !== undefined &&
          source_sha256.toLowerCase() !== serverSha
        ) {
          return fail("source_mismatch");
        }
        const rendered = await renderCache.getOrRender(
          {
            assetScope,
            baseAssetId: asset_id,
            documentReference: meta.documentReference,
            revisionId: meta.revisionId,
          },
          {
            sourceSha256: serverSha,
            page: meta.page,
            bbox: box,
            ...(target_pixels !== undefined
              ? { targetPixels: target_pixels }
              : {}),
          },
          scope,
        );
        if (!rendered.ok) {
          logger.warn(
            { error: rendered.error, asset_id },
            "[MCP] get_asset region zoom failed",
          );
          return fail(
            rendered.error.status === 404 ? "not_found" : "render_failed",
          );
        }
        if (!IMAGE_MIME_TYPES.has(rendered.result.mimeType))
          return fail("unsupported_mime");
        emitQueryActivity({
          tool: "get_asset",
          summary: `${asset_id} region zoom${col !== "documents" ? ` in ${col}` : ""}`,
          status: "ok",
          startTime,
          detail: {
            collection: col,
            assetId: rendered.result.assetId,
            region: box,
            page: meta.page,
            rendered: rendered.result.rendered,
            bytes: rendered.result.data.length,
          },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                asset_id: rendered.result.assetId,
                base_asset_id: asset_id,
                document_reference: meta.documentReference,
                region: box,
                page: meta.page,
                mime_type: rendered.result.mimeType,
                rendered: rendered.result.rendered,
              }),
            },
            {
              type: "image" as const,
              data: rendered.result.data.toString("base64"),
              mimeType: rendered.result.mimeType,
            },
          ],
        };
      }

      // ── Variant path: read the requested size from the AssetStore (ACL-enforced).
      const wanted: AssetVariant =
        (variant as AssetVariant | undefined) ?? "preview";
      if (!ASSET_VARIANTS.includes(wanted)) return fail("not_found");
      const bytes = await assetStore.get(assetScope, asset_id, wanted, scope);
      if (!bytes.ok) return fail("unavailable");
      if (bytes.result === null) return fail("not_found");
      if (!IMAGE_MIME_TYPES.has(bytes.result.mimeType))
        return fail("unsupported_mime");
      emitQueryActivity({
        tool: "get_asset",
        summary: `${asset_id} (${wanted})${col !== "documents" ? ` in ${col}` : ""}`,
        status: "ok",
        startTime,
        detail: {
          collection: col,
          assetId: bytes.result.assetId,
          variant: wanted,
          documentReference: meta.documentReference,
          figureId: meta.figureId,
          mimeType: bytes.result.mimeType,
          bytes: bytes.result.data.length,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              asset_id: bytes.result.assetId,
              variant: bytes.result.variant,
              document_reference: meta.documentReference,
              figure_id: meta.figureId,
              kind: meta.kind,
              page: meta.page,
              mime_type: bytes.result.mimeType,
              ...(bytes.result.checksum
                ? { checksum: bytes.result.checksum }
                : {}),
            }),
          },
          {
            type: "image" as const,
            data: bytes.result.data.toString("base64"),
            mimeType: bytes.result.mimeType,
          },
        ],
      };
    },
  );
}

/** Shape an identifier occurrence for the response. */
function shapeOccurrence(o: IdentifierOccurrence): Record<string, unknown> {
  return {
    unit_id: o.unit_id,
    reference: o.reference,
    base_ref: o.base_ref,
    page: o.page,
    kind: o.kind,
    section_path: o.section_path,
    excerpt: o.excerpt,
  };
}
