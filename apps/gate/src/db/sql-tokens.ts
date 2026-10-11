// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Depth-aware top-level SQL keyword scanner shared by the row-cap wrapper
 * (`autoLimit` pass-through) and the pagination load-time validation (Req 6.5).
 * Comments, string literals, quoted identifiers and nested parenthesized
 * subqueries are skipped, so only keywords effective on the outermost query
 * count.
 */
export function hasTopLevelSqlKeywords(
  sql: string,
  keywords: readonly string[],
): boolean {
  const wanted = new Set(keywords.map((k) => k.toUpperCase()));
  let depth = 0;
  let i = 0;
  const word = (start: number): string => {
    let end = start;
    while (end < sql.length && /[A-Za-z0-9_$]/.test(sql.charAt(end))) end++;
    return sql.slice(start, end).toUpperCase();
  };
  while (i < sql.length) {
    const ch = sql.charAt(i);
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
      if (wanted.has(token)) return true;
      i += token.length; continue;
    }
    i++;
  }
  return false;
}

/** Keywords that already cap or page the outermost query (Req 6.5). */
export const TOP_LEVEL_ROW_LIMIT_KEYWORDS: readonly string[] = [
  "LIMIT",
  "TOP",
  "OFFSET",
  "FETCH",
];

/** Keywords the autoLimit wrapper treats as an existing cap (unchanged semantics). */
export const TOP_LEVEL_AUTO_LIMIT_KEYWORDS: readonly string[] = ["LIMIT", "TOP"];
