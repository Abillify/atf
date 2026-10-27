// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * JSONB columns written through Bun's SQL client.
 *
 * Bun binds a JavaScript string parameter cast as `$n::jsonb` as a JSON
 * *string scalar*: `JSON.stringify(obj)` bound to `$1::jsonb` stores
 * `"{\"a\":1}"`, not `{"a":1}`. SQL operators (`->>`, `@>`, `?`, `||`) then
 * see a string and match nothing. Write stringified values with
 * `$n::text::jsonb`, which parses the text on the server; an object parameter
 * (not stringified) may keep `$n::jsonb`. `scripts/check-jsonb-casts.ts`
 * enforces this for the Runtime.
 *
 * Rows written before that rule still hold string scalars. {@link jsonColumn}
 * reads both shapes.
 */

/**
 * The value of a JSONB column: objects and arrays pass through; a string that
 * holds a JSON object or array (a row written as a string scalar) is parsed;
 * `null`/`undefined` become `undefined`; any other string stays as it is.
 */
export function jsonColumn<T = unknown>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    }
    return value as T;
  }
  return value as T;
}

/**
 * SQL that rewrites string-scalar JSONB values holding an object or array into
 * the parsed value, for one column. Used by migrations; `table` and `column`
 * must be trusted identifiers.
 */
export function repairStringScalarJsonSql(table: string, column: string): string {
  return `UPDATE ${table}
     SET ${column} = (${column} #>> '{}')::jsonb
   WHERE jsonb_typeof(${column}) = 'string'
     AND left(ltrim(${column} #>> '{}'), 1) IN ('{', '[')`;
}
