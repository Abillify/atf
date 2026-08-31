// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Minimal, safe SQL template processor for author-controlled conditional
 * fragments. It does NOT evaluate arbitrary expressions - it only includes or
 * excludes pre-written SQL based on named booleans computed from the auth
 * context (see ./conditions.ts). Caller input still flows exclusively through
 * `:param.*` bind tokens compiled afterwards.
 *
 * Supported directives (nesting allowed):
 *   {{if:NAME}} ...sql... {{endif}}
 *   {{if:NAME}} ...sql... {{else}} ...sql... {{endif}}
 *
 * Whitespace inside the braces is ignored: `{{ if:NAME }}` works too.
 */

type Token =
  | { kind: "text"; value: string }
  | { kind: "if"; name: string }
  | { kind: "else" }
  | { kind: "endif" };

const DIRECTIVE_RE = /\{\{\s*(if:[A-Za-z_][\w]*|else|endif)\s*\}\}/g;

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of template.matchAll(DIRECTIVE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ kind: "text", value: template.slice(last, idx) });
    const directive = m[1]!;
    if (directive === "else") tokens.push({ kind: "else" });
    else if (directive === "endif") tokens.push({ kind: "endif" });
    else tokens.push({ kind: "if", name: directive.slice(3) });
    last = idx + m[0].length;
  }
  if (last < template.length) tokens.push({ kind: "text", value: template.slice(last) });
  return tokens;
}

type Node =
  | { type: "text"; value: string }
  | { type: "if"; name: string; consequent: Node[]; else: Node[] };

function parse(tokens: Token[], start: number, stopAt: Set<Token["kind"]>): [Node[], number] {
  const nodes: Node[] = [];
  let i = start;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (stopAt.has(tok.kind)) return [nodes, i];

    if (tok.kind === "text") {
      nodes.push({ type: "text", value: tok.value });
      i++;
    } else if (tok.kind === "if") {
      const [thenNodes, afterThen] = parse(tokens, i + 1, new Set(["else", "endif"]));
      let elseNodes: Node[] = [];
      let cursor = afterThen;
      if (tokens[cursor]?.kind === "else") {
        const [parsedElse, afterElse] = parse(tokens, cursor + 1, new Set(["endif"]));
        elseNodes = parsedElse;
        cursor = afterElse;
      }
      if (tokens[cursor]?.kind !== "endif") {
        throw new Error(`Unclosed {{if:${tok.name}}} in SQL template`);
      }
      nodes.push({ type: "if", name: tok.name, consequent: thenNodes, else: elseNodes });
      i = cursor + 1;
    } else {
      throw new Error(`Unexpected {{${tok.kind}}} without matching {{if:...}}`);
    }
  }
  return [nodes, i];
}

function render(nodes: Node[], conditions: Record<string, boolean>): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
    } else {
      if (!(node.name in conditions)) {
        throw new Error(`SQL template references unknown condition '${node.name}'`);
      }
      out += render(conditions[node.name] ? node.consequent : node.else, conditions);
    }
  }
  return out;
}

/**
 * Resolve `{{if:...}}` directives in a SQL template using the given condition
 * map, returning plain SQL (still containing any `:param.*` / `:ctx.*` tokens).
 */
export function renderSqlTemplate(template: string, conditions: Record<string, boolean>): string {
  if (!template.includes("{{")) return template;
  const tokens = tokenize(template);
  const [nodes, end] = parse(tokens, 0, new Set());
  if (end !== tokens.length) {
    throw new Error("Dangling {{else}}/{{endif}} in SQL template");
  }
  return render(nodes, conditions);
}
