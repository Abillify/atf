// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Central SQL-identifier whitelist (`src/db/sql-identifier.ts`)
 *
 * Requirement 7.10: every identifier that is interpolated into a SQL
 * statement at runtime (table names, column names in dynamically built
 * `SET`/`ORDER BY` clauses, index names, …) must pass through this single
 * validation point instead of ad-hoc per-call-site regexes.
 *
 * Parameterised VALUES always stay as `$n` placeholders — this module is only
 * about the parts of a statement that cannot be parameterised. The accepted
 * shape is a plain lowercase Postgres identifier: it must start with a letter
 * or underscore, continue with letters, digits or underscores, and fit within
 * Postgres' 63-byte identifier limit. Anything else (quotes, semicolons,
 * whitespace, dashes, Unicode, leading digits, over-long names) is rejected,
 * which makes every call site injection-safe by construction.
 *
 * No `any` at module boundaries.
 */

/** Postgres folds/truncates identifiers beyond 63 bytes — reject them outright. */
const MAX_IDENTIFIER_LENGTH = 63;

/** Lowercase unquoted Postgres identifier shape: `[_a-z][_a-z0-9]*`. */
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Returns `true` when `name` is a safe unquoted SQL identifier, i.e. it can be
 * interpolated into a statement without quoting or escaping.
 */
export function isSafeSqlIdentifier(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_RE.test(name)
  );
}

/**
 * Validates `name` against the identifier whitelist and returns it unchanged,
 * so it can be used inline in template literals:
 * `SELECT … FROM ${safeSqlIdentifier(table)}`.
 *
 * @param name  The identifier to validate (table, column, index, …).
 * @param context Optional human-readable hint included in the error message
 *   (e.g. `"vector store table name"`) to make misconfiguration obvious.
 * @throws Error when `name` is not a safe identifier — callers should treat
 *   this as a programming/configuration error, never as user input to retry.
 */
export function safeSqlIdentifier(name: string, context?: string): string {
  if (!isSafeSqlIdentifier(name)) {
    const where = context !== undefined ? ` (${context})` : "";
    throw new Error(
      `Unsafe SQL identifier rejected${where}: ${JSON.stringify(name)}`,
    );
  }
  return name;
}
