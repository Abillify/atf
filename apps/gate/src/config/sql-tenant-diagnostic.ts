// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export type SqlTenantDiagnosticStatus = "safe" | "unsafe" | "unknown" | "parse-error";

export interface SqlTenantDiagnostic {
  status: SqlTenantDiagnosticStatus;
  reason: string;
}

type TokenKind = "word" | "parameter" | "symbol";
interface Token {
  kind: TokenKind;
  value: string;
  depth: number;
}

const TENANT_PARAMETER = ":ctx.tenantId";
const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[A-Za-z0-9_$]/;

function tokenizeSql(sql: string): { tokens?: Token[]; error?: string } {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;

  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value, depth });
  };

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { error: "unterminated block comment" };
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          closed = true;
          break;
        } else {
          i += 1;
        }
      }
      if (!closed) return { error: "unterminated string literal" };
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      const start = i + 1;
      i += 1;
      let value = "";
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === close && sql[i + 1] === close && close !== "]") {
          value += close;
          i += 2;
        } else if (sql[i] === close) {
          i += 1;
          closed = true;
          break;
        } else {
          value += sql[i];
          i += 1;
        }
      }
      if (!closed) return { error: `unterminated quoted identifier at ${start - 1}` };
      push("word", value);
      continue;
    }
    if (ch === "$" && /^\$[A-Za-z0-9_]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/)![0]!;
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) return { error: "unterminated dollar-quoted string" };
      i = end + tag.length;
      continue;
    }
    if (ch === ":") {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_.]/.test(sql[end]!)) end += 1;
      if (end > i + 1) {
        push("parameter", sql.slice(i, end));
        i = end;
        continue;
      }
    }
    if (WORD_START.test(ch)) {
      let end = i + 1;
      while (end < sql.length && WORD_PART.test(sql[end]!)) end += 1;
      push("word", sql.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "(") {
      push("symbol", ch);
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth < 0) return { error: "unmatched closing parenthesis" };
      push("symbol", ch);
      i += 1;
      continue;
    }
    const pair = sql.slice(i, i + 2);
    if (["<=", ">=", "!=", "<>", "==", "::"].includes(pair)) {
      push("symbol", pair);
      i += 2;
      continue;
    }
    push("symbol", ch);
    i += 1;
  }

  if (depth !== 0) return { error: "unclosed parenthesis" };
  return { tokens };
}

function upper(token: Token | undefined): string {
  return token?.kind === "word" ? token.value.toUpperCase() : "";
}

function isIdentifier(token: Token | undefined): boolean {
  if (!token || token.kind !== "word") return false;
  return !new Set([
    "AND", "OR", "NOT", "NULL", "TRUE", "FALSE", "WHERE", "ON", "SET", "VALUES",
    "SELECT", "FROM", "JOIN", "RETURNING", "LIMIT", "OFFSET", "ORDER", "GROUP", "HAVING",
  ]).has(token.value.toUpperCase());
}

function isTenantIdentifier(token: Token | undefined): boolean {
  return isIdentifier(token) &&
    token!.value.replace(/[^a-z0-9]/gi, "").toLowerCase().includes("tenant");
}

function hasEqualityBinding(tokens: Token[], parameterIndex: number): boolean {
  const parameter = tokens[parameterIndex]!;
  const candidates: Array<[Token | undefined, Token | undefined]> = [
    [tokens[parameterIndex - 1], tokens[parameterIndex - 2]],
    [tokens[parameterIndex + 1], tokens[parameterIndex + 2]],
  ];
  return candidates.some(
    ([operator, operand]) =>
      operator?.depth === parameter.depth &&
      ["=", "=="].includes(operator.value) &&
      isTenantIdentifier(operand),
  );
}

function clauseAt(tokens: Token[], index: number): string {
  const depth = tokens[index]!.depth;
  for (let i = index - 1; i >= 0; i -= 1) {
    const token = tokens[i]!;
    if (token.depth > depth) continue;
    const word = upper(token);
    if (["WHERE", "ON", "SELECT", "SET", "VALUES", "RETURNING", "FROM"].includes(word)) {
      return word;
    }
  }
  return "";
}

function diagnosePredicateStatement(tokens: Token[], statement: string): SqlTenantDiagnostic {
  const parameters = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.kind === "parameter" && token.value === TENANT_PARAMETER);
  if (parameters.length === 0) {
    return { status: "unsafe", reason: `${TENANT_PARAMETER} appears only in ignored or non-binding SQL text` };
  }
  if (tokens.some((token) => upper(token) === "OR")) {
    return { status: "unsafe", reason: "SQL disjunction cannot prove tenant filtering on every branch" };
  }
  if (tokens.some((token) => ["UNION", "INTERSECT", "EXCEPT"].includes(upper(token)))) {
    return { status: "unknown", reason: "compound SQL queries are not analyzed" };
  }
  for (const { index } of parameters) {
    const clause = clauseAt(tokens, index);
    if ((clause === "WHERE" || (statement === "SELECT" && clause === "ON")) && hasEqualityBinding(tokens, index)) {
      return { status: "safe", reason: `${TENANT_PARAMETER} is equality-bound in ${clause}` };
    }
  }
  return {
    status: "unsafe",
    reason: `${TENANT_PARAMETER} is not equality-bound in ${statement === "SELECT" ? "WHERE or JOIN ON" : "WHERE"}`,
  };
}

function splitTopLevelList(tokens: Token[]): Token[][] {
  const entries: Token[][] = [[]];
  const baseDepth = tokens[0]?.depth ?? 0;
  for (const token of tokens) {
    if (token.value === "," && token.depth === baseDepth) entries.push([]);
    else entries.at(-1)!.push(token);
  }
  return entries;
}

function diagnoseInsert(tokens: Token[]): SqlTenantDiagnostic {
  const into = tokens.findIndex((token) => upper(token) === "INTO");
  if (into === -1) return { status: "parse-error", reason: "INSERT has no INTO clause" };
  const open = tokens.findIndex((token, index) => index > into && token.value === "(");
  if (open === -1) return { status: "unknown", reason: "INSERT has no explicit target-column list" };
  const close = tokens.findIndex((token, index) => index > open && token.value === ")" && token.depth === tokens[open]!.depth);
  if (close === -1) return { status: "parse-error", reason: "INSERT target-column list is not closed" };
  const columns = splitTopLevelList(tokens.slice(open + 1, close)).map((entry) => entry.find(isIdentifier)?.value ?? "");
  const tenantIndexes = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.replace(/[^a-z0-9]/gi, "").toLowerCase().includes("tenant"))
    .map(({ index }) => index);
  if (tenantIndexes.length === 0) return { status: "unsafe", reason: "INSERT target columns contain no tenant column" };

  const values = tokens.findIndex((token, index) => index > close && upper(token) === "VALUES");
  if (values !== -1) {
    const tuples: Token[][] = [];
    let cursor = values + 1;
    while (cursor < tokens.length) {
      while (tokens[cursor]?.value === ",") cursor += 1;
      const valuesOpen = cursor;
      if (tokens[valuesOpen]?.value !== "(") break;
      const valuesClose = tokens.findIndex(
        (token, index) =>
          index > valuesOpen &&
          token.value === ")" &&
          token.depth === tokens[valuesOpen]!.depth,
      );
      if (valuesClose === -1) {
        return { status: "parse-error", reason: "INSERT VALUES list is malformed" };
      }
      tuples.push(tokens.slice(valuesOpen + 1, valuesClose));
      cursor = valuesClose + 1;
    }
    if (tuples.length === 0) {
      return { status: "parse-error", reason: "INSERT VALUES list is malformed" };
    }
    const allRowsBound = tuples.every((tuple) => {
      const entries = splitTopLevelList(tuple);
      return tenantIndexes.every((index) =>
        entries[index]?.some(
          (token) => token.kind === "parameter" && token.value === TENANT_PARAMETER,
        ),
      );
    });
    if (allRowsBound) {
      return { status: "safe", reason: `${TENANT_PARAMETER} supplies every INSERT tenant value` };
    }
    return { status: "unsafe", reason: `${TENANT_PARAMETER} does not supply every INSERT tenant value` };
  }

  const select = tokens.findIndex((token, index) => index > close && upper(token) === "SELECT");
  if (select !== -1) {
    if (tokens.slice(select + 1).some((token) => ["UNION", "INTERSECT", "EXCEPT"].includes(upper(token)))) {
      return { status: "unknown", reason: "compound INSERT SELECT is not analyzed" };
    }
    const from = tokens.findIndex((token, index) => index > select && upper(token) === "FROM" && token.depth === tokens[select]!.depth);
    const projection = splitTopLevelList(tokens.slice(select + 1, from === -1 ? tokens.length : from));
    if (tenantIndexes.some((index) => projection[index]?.some((token) => token.kind === "parameter" && token.value === TENANT_PARAMETER))) {
      return { status: "safe", reason: `${TENANT_PARAMETER} supplies an INSERT tenant column through SELECT` };
    }
    return { status: "unsafe", reason: `${TENANT_PARAMETER} does not supply the INSERT tenant column` };
  }

  return { status: "unknown", reason: "unsupported INSERT form" };
}

/**
 * Conservatively determines whether SQL binds the verified tenant context in a
 * filtering/mutating position. Comments and string literals are discarded by
 * the lexer, and unsupported SQL is reported rather than guessed safe.
 */
export function diagnoseSqlTenantBinding(sql: string): SqlTenantDiagnostic {
  const lexed = tokenizeSql(sql);
  if (lexed.error) return { status: "parse-error", reason: lexed.error };
  const tokens = lexed.tokens!;
  const meaningful = tokens.filter((token) => token.value !== ";");
  if (meaningful.length === 0) return { status: "parse-error", reason: "SQL is empty" };
  const semicolons = tokens.filter((token) => token.value === ";" && token.depth === 0);
  if (semicolons.length > 1 || (semicolons.length === 1 && tokens.at(-1)?.value !== ";")) {
    return { status: "unknown", reason: "multiple SQL statements are not analyzed" };
  }

  const statement = upper(meaningful[0]);
  if (statement === "SELECT" || statement === "UPDATE" || statement === "DELETE") {
    return diagnosePredicateStatement(meaningful, statement);
  }
  if (statement === "INSERT") return diagnoseInsert(meaningful);
  return { status: "unknown", reason: `unsupported SQL statement '${statement || meaningful[0]!.value}'` };
}
