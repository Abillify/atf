// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { resolveContextPath, type AuthContext } from "../auth/context.ts";

/**
 * Bind tokens use two namespaces and are ALWAYS bound as positional parameters
 * (never string-interpolated), so callers cannot inject SQL:
 *
 *   :param.<path>  -> value from the MCP tool call arguments
 *   :ctx.<path>    -> value from the auth context
 *                     (:ctx.username, :ctx.claims.email, :ctx.headers.x-tenant-id)
 *
 * The leading `param.`/`ctx.` requirement also means Postgres `::type` casts are
 * left untouched.
 */
function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Convert a JavaScript array to a PostgreSQL array literal string, e.g.
 * `["a", "b"]` → `{a,b}`, `["has space", "quo\"te"]` → `{"has space","quo\"te"}`.
 * NULL / undefined elements are rendered as unquoted NULL.
 */
function formatPgArray(arr: unknown[]): string {
  const elements = arr.map((el) => {
    if (el === null || el === undefined) return "NULL";
    const s = String(el);
    // Quote if the value is empty or contains characters that would be
    // ambiguous inside a PostgreSQL array literal.
    if (s === "" || /[,{}\s"\\]/.test(s)) {
      return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return s;
  });
  return "{" + elements.join(",") + "}";
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  // Arrays must be rendered as PostgreSQL array literals, not JSON.
  // JSON format (e.g. '["26945"]') is rejected by the ::text[] cast.
  if (Array.isArray(value)) return formatPgArray(value);
  // Knex binds plain objects oddly across dialects; serialize as JSON.
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

export interface CompiledQuery {
  sql: string;
  bindings: unknown[];
}

const TOKEN_START = /:(?:param|ctx)\./y; // sticky, used for lookahead at a position
const TOKEN_BODY = /:((?:param|ctx)\.[A-Za-z0-9_.\-]+)/y;

/**
 * Replace `:param.*` / `:ctx.*` tokens with `?` placeholders and collect the
 * resolved values, preserving order. The scanner skips SQL line comments
 * (`-- ...`), block comments (`/* ... *​/`) and single-quoted string literals,
 * so bind tokens that merely appear in comments or string constants are left
 * untouched. The result is safe to hand to knex.raw().
 * 
 * When the same token appears multiple times, each occurrence gets its own
 * binding with the same value (standard SQL bind behavior).
 */
export function compileQuery(
  template: string,
  params: Record<string, unknown>,
  ctx: AuthContext,
): CompiledQuery {
  const bindings: unknown[] = [];
  let out = "";
  let i = 0;
  const n = template.length;

  while (i < n) {
    const ch = template[i]!;
    const next = template[i + 1];

    // Line comment: -- ... to end of line
    if (ch === "-" && next === "-") {
      const end = template.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      // Strip `?` from comments: Knex counts every `?` in the raw SQL string as
      // a binding placeholder, including those inside comments.
      out += template.slice(i, stop).replace(/\?/g, "");
      i = stop;
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      const end = template.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      // Strip `?` from comments: same reason as above.
      out += template.slice(i, stop).replace(/\?/g, "");
      i = stop;
      continue;
    }

    // Single-quoted string literal (handles '' escaping).
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (template[j] === "'") {
          if (template[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += template.slice(i, j);
      i = j;
      continue;
    }

    // Bind token: :param.<path> or :ctx.<path>
    if (ch === ":") {
      TOKEN_START.lastIndex = i;
      if (TOKEN_START.test(template)) {
        TOKEN_BODY.lastIndex = i;
        const m = TOKEN_BODY.exec(template);
        if (m) {
          const token = m[1]!;
          const dot = token.indexOf(".");
          const namespace = token.slice(0, dot);
          const path = token.slice(dot + 1);
          const value = namespace === "param" ? getPath(params, path) : resolveContextPath(ctx, path);
          bindings.push(normalizeValue(value));
          out += "?";
          i = TOKEN_BODY.lastIndex;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return { sql: out, bindings };
}
