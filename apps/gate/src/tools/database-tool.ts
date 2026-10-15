// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Knex } from "knex";
import { createHash, randomBytes } from "node:crypto";
import type { AuthContext } from "../auth/context.ts";
import { orderByDirection, type DatabaseTool, type RedactRule } from "../config/schema.ts";
import { compileQuery } from "../db/bindings.ts";
import {
  evaluateConditions,
  privilegedConditionNames,
} from "../db/conditions.ts";
import {
  hasTopLevelSqlKeywords,
  TOP_LEVEL_AUTO_LIMIT_KEYWORDS,
} from "../db/sql-tokens.ts";
import { renderSqlTemplate } from "../db/template.ts";
import { digestForLog, logger } from "../logger.ts";
import { withSpan } from "../observability/tracing.ts";
import {
  argsFingerprint,
  mintPaginationCursor,
  verifyPaginationCursor,
} from "./pagination-cursor.ts";
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

    const conditions = this.conditionMaps(ctx);
    const renderedSql = renderSqlTemplate(this.cfg.query ?? "", conditions.sql);
    const { sql: compiledSql, bindings: compiledBindings } = compileQuery(
      renderedSql,
      args ?? {},
      ctx,
    );

    const paginationEnabled = this.cfg.pagination?.enabled && this.cfg.access !== "write";
    const pagination = this.cfg.pagination;
    const pageSize = paginationEnabled
      ? parsePageSize(
          args?.pageSize,
          this.cfg.pagination?.pageSize ?? 100,
          this.cfg.pagination?.maxPageSize ?? 1000,
        )
      : this.cfg.rowLimit;
    // Req 6.6: the cursor is HMAC-signed and bound to this tool, the caller's
    // principal, and a fingerprint of the query arguments (the pagination
    // knobs `cursor`/`pageSize` themselves are excluded so pages may vary
    // them). A cursor from another tool, principal, or argument set is
    // rejected as invalid.
    const cursorFingerprint = paginationEnabled
      ? argsFingerprint(withoutPaginationArgs(args ?? {}))
      : "";
    const cursor = paginationEnabled
      ? this.readCursor(args?.cursor, cursorFingerprint, ctx)
      : { offset: 0 };
    const effectiveLimit = pageSize;

    // Push the row cap into the database so we never materialise more rows than
    // needed. We fetch effectiveLimit+1 to detect truncation/more-pages without
    // an extra COUNT. Write tools are never wrapped: a LIMIT subquery around an
    // INSERT/UPDATE/DELETE (... RETURNING) statement is invalid SQL.
    const window: PageWindow = paginationEnabled
      ? {
          offset: cursor.offset,
          orderBySql: pagination?.orderBy?.join(", "),
          keysetColumns: cursor.keysetValues ? pagination?.keyset : undefined,
          keysetValues: cursor.keysetValues,
          keysetDirections: pagination?.keyset?.map((col) =>
            orderByDirection(pagination.orderBy, col),
          ),
        }
      : {};
    const { sql, bindings } =
      (this.cfg.autoLimit || paginationEnabled) && this.cfg.access !== "write"
        ? applyAutoLimit(
            compiledSql,
            compiledBindings,
            effectiveLimit,
            this.runtime.db.clientName(this.cfg.database),
            window,
          )
        : { sql: compiledSql, bindings: compiledBindings };

    logger.debug("db query", {
      tool,
      database: this.cfg.database,
      placeholders: (sql.match(/\?/g) ?? []).length,
      // Binding values may contain identity/PII data: log only their count and
      // a digest so two log lines for the same query can still be correlated.
      bindingCount: compiledBindings.length,
      bindingsDigest: digestForLog(JSON.stringify(compiledBindings)),
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
    const redacted = applyRedaction(limited, this.cfg.redact, conditions.redact);
    const nextCursor =
      paginationEnabled && truncated
        ? this.mintCursor(cursorFingerprint, ctx, cursor.offset + effectiveLimit, limited)
        : undefined;

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

  /**
   * Req 6.7 (ADR-0002): When business authorization is disabled
   * (`authorizationEnabled=false`), privileged Conditions — those whose rules
   * read the caller's `scopes` context (`containsAny`/`containsAll`) — MUST
   * evaluate to `false`, never `true`: with authorization off there is no
   * verified scope set, and `true` would open every `{{if:privileged}}` SQL
   * branch (act-for-other-person, unmasked data, admin writes) to every
   * caller. All other conditions are evaluated normally, and the maps always
   * contain every declared condition name so template rendering never throws.
   *
   * Two maps, because fail-closed differs by use site:
   * - `sql` (templates): privileged → `false` (privileged branch hidden).
   * - `redact` (Redaction-Guards, `when`): a disabled guard would leak
   *   unmasked data, so any condition that is not verifiably true keeps its
   *   Redaction active (`applyRedaction` masks unless `conditions[when]` is
   *   exactly `true`).
   */
  private conditionMaps(ctx: AuthContext): {
    sql: Record<string, boolean>;
    redact: Record<string, boolean>;
  } {
    const evaluated = evaluateConditions(this.cfg.conditions, ctx);
    if (this.runtime.authorizationEnabled !== false) {
      return { sql: evaluated, redact: evaluated };
    }
    const privileged = privilegedConditionNames(this.cfg.conditions);
    const sql: Record<string, boolean> = {};
    const redact: Record<string, boolean> = {};
    for (const name of Object.keys(this.cfg.conditions)) {
      // Privileged: fail closed for SQL branches ...
      sql[name] = privileged.has(name) ? false : evaluated[name] === true;
      // ... and for Redaction every guard stays active (fail closed): without
      // verified identity, over-redacting is safe, skipping Redaction is not.
      redact[name] = true;
    }
    return { sql, redact };
  }

  /**
   * Verify an incoming cursor (Req 6.6). Missing/empty means the first page.
   * In keyset mode the payload carries the last row's keyset values; in
   * offset mode it carries the numeric offset.
   */
  private readCursor(
    raw: unknown,
    fingerprint: string,
    ctx: AuthContext,
  ): { offset: number; keysetValues?: unknown[] } {
    if (raw === undefined || raw === null || raw === "") return { offset: 0 };
    const secret = this.runtime.paginationCursorSecret ?? fallbackCursorSecret();
    const payload = verifyPaginationCursor(
      raw,
      this.cfg.name,
      fingerprint,
      ctx.subject,
      secret,
    );
    if (payload.k) {
      if (typeof payload.o !== "string") throw new Error("Invalid pagination cursor");
      let values: unknown;
      try {
        values = JSON.parse(payload.o);
      } catch {
        throw new Error("Invalid pagination cursor");
      }
      if (!Array.isArray(values) || values.length !== payload.k.length) {
        throw new Error("Invalid pagination cursor");
      }
      return { offset: 0, keysetValues: values };
    }
    if (typeof payload.o !== "number" || !Number.isSafeInteger(payload.o) || payload.o < 0) {
      throw new Error("Invalid pagination cursor");
    }
    return { offset: payload.o };
  }

  /** Mint the signed cursor for the next page (offset or keyset mode). */
  private mintCursor(
    fingerprint: string,
    ctx: AuthContext,
    nextOffset: number,
    lastPageRows: unknown[],
  ): string {
    const secret = this.runtime.paginationCursorSecret ?? fallbackCursorSecret();
    const keyset = this.cfg.pagination?.keyset;
    if (keyset && keyset.length > 0) {
      const last = lastPageRows[lastPageRows.length - 1] as Record<string, unknown> | undefined;
      const values = keyset.map((col) => (last ? last[col] : undefined));
      return mintPaginationCursor(
        { o: JSON.stringify(values), fp: fingerprint, sub: ctx.subject, k: keyset },
        this.cfg.name,
        secret,
      );
    }
    return mintPaginationCursor(
      { o: nextOffset, fp: fingerprint, sub: ctx.subject },
      this.cfg.name,
      secret,
    );
  }

  /** Dry-run: compile the SQL + bindings without touching the database. */
  async explain(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> {
    const conditions = this.conditionMaps(ctx);
    const renderedSql = renderSqlTemplate(this.cfg.query ?? "", conditions.sql);
    const { sql, bindings } = compileQuery(renderedSql, args ?? {}, ctx);
    const wouldAutoLimit = this.cfg.autoLimit && this.cfg.access !== "write";
    const text = JSON.stringify(
      {
        database: this.cfg.database,
        sql,
        bindings,
        conditions: conditions.sql,
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

/**
 * Process-wide fallback cursor secret used when `server.pagination.secret` is
 * not configured. Random per process, so cursors survive neither a restart nor
 * a second instance behind a load balancer — the configuration docs require a
 * stable secret for production (Req 6.6).
 */
let processCursorSecret: string | undefined;
function fallbackCursorSecret(): string {
  processCursorSecret ??= randomBytes(32).toString("base64url");
  return processCursorSecret;
}

/** The caller-facing pagination knobs that may change between pages. */
const PAGINATION_ARG_KEYS = new Set(["cursor", "pageSize"]);
function withoutPaginationArgs(args: Record<string, unknown>): Record<string, unknown> {
  let stripped = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (PAGINATION_ARG_KEYS.has(k)) {
      stripped = true;
      continue;
    }
    out[k] = v;
  }
  return stripped ? out : args;
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

/** Extra paging window applied on top of the row cap (pagination only). */
interface PageWindow {
  /** Offset mode: rows to skip. */
  offset?: number;
  /** Validated `ORDER BY` list from `pagination.orderBy` (Req 6.6). */
  orderBySql?: string;
  /** Keyset mode: the key columns (validated identifiers, from config). */
  keysetColumns?: readonly string[];
  /** Keyset mode: the previous page's last-row values, bound as parameters. */
  keysetValues?: unknown[];
  /** Keyset mode: sort direction per keyset column (from `orderBy`). */
  keysetDirections?: readonly ("ASC" | "DESC")[];
}

/**
 * Wrap the compiled SQL in a dialect-appropriate LIMIT (+ optional OFFSET,
 * ORDER BY and keyset predicate) subquery so at most limit+1 rows are
 * transferred from the database. The extra +1 lets the executor detect
 * truncation/more-pages without a separate COUNT query.
 *
 * The limit/offset are server-controlled, schema-validated non-negative
 * integers (never caller input directly - the caller's cursor is verified and
 * parsed to a plain number first), so they are inlined as literals. The
 * `orderBy` list comes from config and is validated to plain column
 * references; keyset values are bound as parameters. This keeps the caller's
 * bind parameters — and their order — completely unchanged (wrapper
 * parameters are appended after the inner query's).
 */
function applyAutoLimit(
  sql: string,
  bindings: unknown[],
  rowLimit: number,
  client: string | undefined,
  window: PageWindow = {},
): { sql: string; bindings: unknown[] } {
  // Already has an outer LIMIT/TOP — let it pass through unchanged. Strip both
  // line and block comments first so a LIMIT mentioned only in a comment does
  // not suppress the cap (and a real LIMIT inside a comment is not missed).
  if (hasTopLevelSqlKeywords(sql, TOP_LEVEL_AUTO_LIMIT_KEYWORDS)) {
    return { sql, bindings };
  }
  // Guard: ensure clean integer literals regardless of upstream coercion.
  const cap = Math.max(1, Math.floor(rowLimit) + 1);
  const off = Math.max(0, Math.floor(window.offset ?? 0));
  const orderBy = window.orderBySql;
  const seek =
    window.keysetColumns &&
    window.keysetColumns.length > 0 &&
    window.keysetValues
      ? keysetPredicate(
          window.keysetColumns,
          window.keysetValues,
          window.keysetDirections,
        )
      : undefined;
  const keyset = seek?.sql;
  const keysetBindings = seek ? seek.bindings : [];
  switch ((client ?? "").toLowerCase()) {
    case "mssql":
    case "tedious": {
      const order = orderBy
        ? ` ORDER BY ${orderBy}`
        : off > 0
          ? " ORDER BY (SELECT NULL)"
          : "";
      if (keyset)
        return {
          sql: `SELECT TOP (${cap}) * FROM (${sql}) AS _mcpgate_q WHERE ${keyset}${order}`,
          bindings: [...bindings, ...keysetBindings],
        };
      return off > 0
        ? {
            sql: `SELECT * FROM (${sql}) AS _mcpgate_q${order} OFFSET ${off} ROWS FETCH NEXT ${cap} ROWS ONLY`,
            bindings,
          }
        : orderBy
          ? {
              sql: `SELECT TOP (${cap}) * FROM (${sql}) AS _mcpgate_q${order}`,
              bindings,
            }
          : {
              sql: `SELECT TOP (${cap}) * FROM (${sql}) AS _mcpgate_q`,
              bindings,
            };
    }
    case "oracledb":
    case "oracle": {
      if (keyset)
        return {
          sql: `SELECT * FROM (SELECT * FROM (${sql}) WHERE ${keyset}${orderBy ? ` ORDER BY ${orderBy}` : ""}) WHERE ROWNUM <= ${cap}`,
          bindings: [...bindings, ...keysetBindings],
        };
      if (off > 0)
        return {
          sql: `SELECT * FROM (${sql})${orderBy ? ` ORDER BY ${orderBy}` : ""} OFFSET ${off} ROWS FETCH NEXT ${cap} ROWS ONLY`,
          bindings,
        };
      if (orderBy)
        return {
          sql: `SELECT * FROM (SELECT * FROM (${sql}) ORDER BY ${orderBy}) WHERE ROWNUM <= ${cap}`,
          bindings,
        };
      return { sql: `SELECT * FROM (${sql}) WHERE ROWNUM <= ${cap}`, bindings };
    }
    default: {
      // pg, mysql2, sqlite3, better-sqlite3, …
      return {
        sql: `SELECT * FROM (${sql}) AS _mcpgate_q${keyset ? ` WHERE ${keyset}` : ""}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ${cap}${off > 0 ? ` OFFSET ${off}` : ""}`,
        bindings: [...bindings, ...keysetBindings],
      };
    }
  }
}

/**
 * Dialect-portable keyset ("seek") predicate for the ordered columns
 * `[a, b, …]`, expanding `(a,b,…) > (:v1,:v2,…)` to its lexicographic form
 * `(a > :v1) OR (a = :v1 AND b > :v2) OR …`, which every supported dialect
 * understands. A `DESC` column seeks with `<` instead of `>` so the predicate
 * follows the configured sort order. Every `?` the predicate emits gets its
 * own binding, in placeholder order (column i repeats `v1 … v(i-1)` for the
 * equality terms, then `vi`). Keyset columns should be NOT NULL; NULL values
 * compare unknown and exclude the row.
 */
function keysetPredicate(
  columns: readonly string[],
  values: readonly unknown[],
  directions: readonly ("ASC" | "DESC")[] = [],
): { sql: string; bindings: unknown[] } {
  const parts: string[] = [];
  const bindings: unknown[] = [];
  for (let i = 0; i < columns.length; i++) {
    const conds: string[] = [];
    for (let j = 0; j < i; j++) {
      conds.push(`${columns[j]} = ?`);
      bindings.push(values[j]);
    }
    conds.push(`${columns[i]} ${directions[i] === "DESC" ? "<" : ">"} ?`);
    bindings.push(values[i]);
    parts.push(`(${conds.join(" AND ")})`);
  }
  return { sql: `(${parts.join(" OR ")})`, bindings };
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
