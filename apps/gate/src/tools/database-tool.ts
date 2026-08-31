// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Knex } from "knex";
import { createHash } from "node:crypto";
import type { AuthContext } from "../auth/context.ts";
import type { DatabaseTool, RedactRule } from "../config/schema.ts";
import { compileQuery } from "../db/bindings.ts";
import { evaluateConditions } from "../db/conditions.ts";
import { renderSqlTemplate } from "../db/template.ts";
import { logger } from "../logger.ts";
import { withSpan } from "../observability/tracing.ts";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolRuntime } from "./types.ts";

export const DEFAULT_DATABASE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    rowCount: { type: "integer", description: "Number of rows in `rows`." },
    truncated: { type: "boolean", description: "True when more rows exist than were returned." },
    rows: { type: "array", items: { type: "object" }, description: "Result rows." },
    nextCursor: {
      type: "string",
      description: "Opaque cursor for the next page, when pagination is enabled.",
    },
    page: {
      type: "object",
      description: "Pagination metadata, when pagination is enabled.",
      properties: {
        pageSize: { type: "integer" },
        returned: { type: "integer" },
        hasMore: { type: "boolean" },
        nextCursor: { type: "string" },
      },
      required: ["pageSize", "returned", "hasMore"],
    },
  },
  required: ["rowCount", "truncated", "rows"],
};

/** Build the advertised database contract without constructing an executor. */
export function databaseToolDefinition(cfg: DatabaseTool): ToolDefinition {
  const inputSchema = { ...(cfg.inputSchema as Record<string, unknown>) };
  if (cfg.pagination?.enabled) {
    const properties = { ...(inputSchema.properties as Record<string, unknown> | undefined) };
    if (!("cursor" in properties)) {
      properties.cursor = {
        type: "string",
        description:
          "Opaque pagination cursor from a previous call's nextCursor. Omit for the first page.",
      };
    }
    if (!("pageSize" in properties)) {
      properties.pageSize = {
        type: "integer",
        minimum: 1,
        maximum: cfg.pagination.maxPageSize,
        default: cfg.pagination.pageSize,
        description: "Number of rows to return on this page.",
      };
    }
    inputSchema.properties = properties;
  }
  return {
    name: cfg.name,
    description: cfg.description,
    inputSchema,
    outputSchema:
      (cfg.outputSchema as Record<string, unknown> | undefined) ??
      DEFAULT_DATABASE_OUTPUT_SCHEMA,
  };
}

/**
 * Executes a configured database tool:
 *   1. evaluate named conditions against the auth context
 *   2. resolve `{{if:...}}` template fragments (author-controlled SQL)
 *   3. compile `:param.*` / `:ctx.*` bind tokens to positional parameters
 *   4. optionally wrap in a LIMIT/OFFSET subquery (autoLimit or pagination)
 *   5. run through the universal Knex layer, redact configured fields and
 *      return rows as JSON (+ structuredContent)
 */
export class DatabaseToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;

  constructor(
    private readonly cfg: DatabaseTool,
    private readonly runtime: ToolRuntime,
  ) {
    this.definition = databaseToolDefinition(cfg);
  }

  async execute(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> {
    const tool = this.cfg.name;
    const db = this.runtime.db.get(this.cfg.database);

    const conditions = this.runtime.authorizationEnabled === false
      ? Object.fromEntries(Object.keys(this.cfg.conditions).map((name) => [name, true]))
      : evaluateConditions(this.cfg.conditions, ctx);
    const renderedSql = renderSqlTemplate(this.cfg.query ?? "", conditions);
    const { sql: compiledSql, bindings: compiledBindings } = compileQuery(
      renderedSql,
      args ?? {},
      ctx,
    );

    const paginationEnabled = this.cfg.pagination?.enabled && this.cfg.access !== "write";
    const pageSize = paginationEnabled
      ? parsePageSize(
          args?.pageSize,
          this.cfg.pagination?.pageSize ?? 100,
          this.cfg.pagination?.maxPageSize ?? 1000,
        )
      : this.cfg.rowLimit;
    const offset = paginationEnabled ? parseCursor(args?.cursor) : 0;
    const effectiveLimit = pageSize;

    // Push the row cap into the database so we never materialise more rows than
    // needed. We fetch effectiveLimit+1 to detect truncation/more-pages without
    // an extra COUNT. Write tools are never wrapped: a LIMIT subquery around an
    // INSERT/UPDATE/DELETE (... RETURNING) statement is invalid SQL.
    const { sql, bindings } =
      (this.cfg.autoLimit || paginationEnabled) && this.cfg.access !== "write"
        ? applyAutoLimit(
            compiledSql,
            compiledBindings,
            effectiveLimit,
            this.runtime.db.clientName(this.cfg.database),
            paginationEnabled ? offset : 0,
          )
        : { sql: compiledSql, bindings: compiledBindings };

    logger.debug("db query", {
      tool,
      database: this.cfg.database,
      placeholders: (sql.match(/\?/g) ?? []).length,
      // Bindings are logged at debug only — they may contain identity/PII data.
      bindings: compiledBindings,
    });

    const tDb = Date.now();
    const raw = await withSpan(
      `db.query ${tool}`,
      { "mcpgate.tool": tool, "db.system": this.runtime.db.clientName(this.cfg.database) ?? "unknown" },
      async () => db.raw(sql, bindings as Knex.RawBinding[]),
    );
    const dbMs = Date.now() - tDb;
    logger.debug("db query done", { tool, ms: dbMs });

    // Knex returns dialect-specific shapes; normalise to a row array.
    const rows = extractRows(raw);
    const limited = rows.slice(0, effectiveLimit);
    const truncated = rows.length > effectiveLimit;
    const redacted = applyRedaction(limited, this.cfg.redact, conditions);
    const nextCursor = paginationEnabled && truncated ? String(offset + effectiveLimit) : undefined;

    // Compact JSON (no pretty-print) keeps the MCP payload small.
    const structured: Record<string, unknown> = {
      rowCount: redacted.length,
      truncated,
      rows: redacted,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(paginationEnabled
        ? {
            page: {
              pageSize,
              returned: redacted.length,
              hasMore: truncated,
              ...(nextCursor !== undefined ? { nextCursor } : {}),
            },
          }
        : {}),
    };
    const text = JSON.stringify(structured);

    logger.debug("db result", {
      tool,
      rowCount: redacted.length,
      truncated,
      bytes: Buffer.byteLength(text, "utf8"),
      dbMs,
    });

    // Per-column byte breakdown: only computed and logged at debug level so
    // there is zero overhead in production.
    if (logger.debug !== undefined && process.env.MCPGATE_LOG_LEVEL === "debug") {
      const fieldBytes: Record<string, number> = {};
      for (const row of redacted) {
        if (row && typeof row === "object") {
          for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
            try {
              fieldBytes[k] = (fieldBytes[k] ?? 0) + Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
            } catch { /* ignore */ }
          }
        }
      }
      const breakdown = Object.entries(fieldBytes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}=${(n / 1024).toFixed(1)}KiB`)
        .join(" ");
      logger.debug("db field sizes", { tool, breakdown });
    }

    return {
      content: [{ type: "text", text }],
      structuredContent: structured,
      meta: {
        database: this.cfg.database,
        rowCount: redacted.length,
        truncated,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        // sql/bindings kept in meta for the audit trail (monitor/audit.ts); the
        // live monitor surfaces (index.ts console subscriber, monitor/ui.html)
        // intentionally don't render this field.
        query: { sql: compiledSql, bindings: compiledBindings },
      },
    };
  }

  /** Dry-run: compile the SQL + bindings without touching the database. */
  async explain(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> {
    const conditions = this.runtime.authorizationEnabled === false
      ? Object.fromEntries(Object.keys(this.cfg.conditions).map((name) => [name, true]))
      : evaluateConditions(this.cfg.conditions, ctx);
    const renderedSql = renderSqlTemplate(this.cfg.query ?? "", conditions);
    const { sql, bindings } = compileQuery(renderedSql, args ?? {}, ctx);
    const wouldAutoLimit = this.cfg.autoLimit && this.cfg.access !== "write";
    const text = JSON.stringify(
      {
        database: this.cfg.database,
        sql,
        bindings,
        conditions,
        autoLimit: wouldAutoLimit,
        rowLimit: this.cfg.rowLimit,
        pagination: this.cfg.pagination,
        redact: this.cfg.redact,
      },
      null,
      2,
    );
    return {
      content: [{ type: "text", text }],
      meta: { dryRun: true, database: this.cfg.database, query: { sql, bindings } },
    };
  }
}

// ---------------------------------------------------------------------------
// Pagination cursor
// ---------------------------------------------------------------------------

/** Parse an opaque cursor (currently a decimal offset) back into a number. */
function parseCursor(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error("Invalid pagination cursor");
  }
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid pagination cursor");
  return offset;
}

function parsePageSize(raw: unknown, fallback: number, maximum: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > maximum) {
    throw new Error(`pageSize must be an integer between 1 and ${maximum}`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Field-level redaction
// ---------------------------------------------------------------------------

/**
 * Apply configured redaction rules to every returned row. Rules with a `when`
 * condition only apply when that condition evaluated true for the current
 * caller (see db/conditions.ts); rules without `when` apply unconditionally.
 * The first matching rule for a column wins.
 */
function applyRedaction(
  rows: unknown[],
  rules: RedactRule[],
  conditions: Record<string, boolean>,
): unknown[] {
  if (!rules || rules.length === 0) return rows;
  const active = rules.filter((r) => r.when === undefined || conditions[r.when] === true);
  if (active.length === 0) return rows;

  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const rule of active) {
      if (!(rule.column in out)) continue;
      switch (rule.strategy) {
        case "omit":
          delete out[rule.column];
          break;
        case "hash": {
          const value = out[rule.column];
          out[rule.column] =
            value === null || value === undefined
              ? value
              : createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
          break;
        }
        case "mask":
        default:
          out[rule.column] = rule.placeholder;
          break;
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// rowLimit SQL pushdown
// ---------------------------------------------------------------------------

/**
 * Wrap the compiled SQL in a dialect-appropriate LIMIT (+ optional OFFSET)
 * subquery so at most limit+1 rows are transferred from the database. The
 * extra +1 lets the executor detect truncation/more-pages without a separate
 * COUNT query.
 *
 * The limit/offset are server-controlled, schema-validated non-negative
 * integers (never caller input directly - the caller's cursor is parsed to a
 * plain number first), so they are inlined as literals. This keeps the
 * caller's bind parameters — and their order — completely unchanged.
 */
function applyAutoLimit(
  sql: string,
  bindings: unknown[],
  rowLimit: number,
  client: string | undefined,
  offset: number = 0,
): { sql: string; bindings: unknown[] } {
  // Already has an outer LIMIT/TOP — let it pass through unchanged. Strip both
  // line and block comments first so a LIMIT mentioned only in a comment does
  // not suppress the cap (and a real LIMIT inside a comment is not missed).
  if (hasTopLevelLimit(sql)) {
    return { sql, bindings };
  }
  // Guard: ensure clean integer literals regardless of upstream coercion.
  const cap = Math.max(1, Math.floor(rowLimit) + 1);
  const off = Math.max(0, Math.floor(offset));
  switch ((client ?? "").toLowerCase()) {
    case "mssql":
    case "tedious":
      return off > 0
        ? {
            sql: `SELECT * FROM (${sql}) AS _mcpgate_q ORDER BY (SELECT NULL) OFFSET ${off} ROWS FETCH NEXT ${cap} ROWS ONLY`,
            bindings,
          }
        : { sql: `SELECT TOP (${cap}) * FROM (${sql}) AS _mcpgate_q`, bindings };
    case "oracledb":
    case "oracle":
      return off > 0
        ? { sql: `SELECT * FROM (${sql}) OFFSET ${off} ROWS FETCH NEXT ${cap} ROWS ONLY`, bindings }
        : { sql: `SELECT * FROM (${sql}) WHERE ROWNUM <= ${cap}`, bindings };
    default:
      // pg, mysql2, sqlite3, better-sqlite3, …
      return {
        sql: `SELECT * FROM (${sql}) AS _mcpgate_q LIMIT ${cap}${off > 0 ? ` OFFSET ${off}` : ""}`,
        bindings,
      };
  }
}

/**
 * Scan executable top-level SQL tokens. Comments, string literals, quoted
 * identifiers and nested parenthesized queries cannot suppress auto-limiting.
 */
function hasTopLevelLimit(sql: string): boolean {
  let depth = 0;
  let i = 0;
  const word = (start: number): string => {
    let end = start;
    while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end++;
    return sql.slice(start, end).toUpperCase();
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") { i = sql.indexOf("\n", i + 2); if (i < 0) return false; continue; }
    if (ch === "/" && next === "*") { const end = sql.indexOf("*/", i + 2); if (end < 0) return false; i = end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch; i++;
      while (i < sql.length) { if (sql[i] === quote) { if (sql[i + 1] === quote) { i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (ch === "[") { i++; while (i < sql.length) { if (sql[i] === "]") { if (sql[i + 1] === "]") { i += 2; continue; } i++; break; } i++; } continue; }
    if (ch === "(") { depth++; i++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const token = word(i);
      if (token === "LIMIT" || token === "TOP") return true;
      i += token.length; continue;
    }
    i++;
  }
  return false;
}

/** Normalise the various Knex driver return shapes into a plain row array. */
function extractRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    // mysql2 returns [rows, fields]; pg returns { rows }. Bare array = sqlite.
    if (raw.length > 0 && Array.isArray(raw[0])) return raw[0] as unknown[];
    return raw;
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows)) {
    return (raw as { rows: unknown[] }).rows;
  }
  return raw === undefined || raw === null ? [] : [raw];
}
