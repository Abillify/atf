// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * i18n coverage guard: no user-visible English text may be hard-coded in a
 * component. Every JSX text, descriptive attribute (`title`, `placeholder`,
 * `aria-label`, …) and string result of a conditional inside JSX must go
 * through `translate()`/`t()` with a key in both catalogs.
 *
 * It parses the sources with `@babel/parser` (a pinned devDependency), so it
 * sees real JSX structure rather than guessing with regular expressions. It
 * also checks string literals passed to `new Error(...)`, `setError(...)` and
 * `toast.*(...)`/`addToast({ title | message })`, which end up on screen. A string that is deliberately not translated (a brand
 * name, a unit, a code token) goes into ALLOWED with a reason.
 */

import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { parse } from "@babel/parser";
import { de } from "../lib/i18n/catalogs/de";
import { en } from "../lib/i18n/catalogs/en";

const SRC = join(__dirname, "..");
/** Descriptive attributes, plus any prop named like one (canvasLabel, emptyText, …). */
const TEXT_PROP = /(label|text|title|message|hint|description|placeholder|heading|caption|tooltip)$/i;
const ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label", "description", "emptyText", "emptyMessage", "hint", "tooltip", "confirmLabel", "cancelLabel", "heading", "subtitle", "caption", "helperText", "aria-description", "ariaLabel", "emptyLabel", "loadingText"]);
const RAW_ELEMENTS = new Set(["code", "pre", "kbd", "samp"]);

/** Literals that are the same in every language, with the reason. */
const ALLOWED = new Set<string>([
  // Product and protocol names, units and tokens.
  "Aiperator", "ATF", "LLM", "MCP", "RAG", "BPMN", "JSON", "YAML", "SSE", "OIDC", "SSO", "BYOK", "OTel", "API", "ID", "URL", "ms", "s", "tok", "USD", "EUR", "N/A",
]);

interface Finding {
  file: string;
  line: number;
  text: string;
}

const HAS_WORD = /[A-Za-z]{2,}/;
const TOKEN_LIKE = /^[a-z0-9_.:/#?=&-]+$/;
const CONSTANT_LIKE = /^[A-Z0-9_]+$/;
const URL_LIKE = /^https?:\/\//;
const SKIPPED_DIR = /__tests__|lib\/i18n/;
const FEEDBACK_SKIPPED_DIR = /__tests__|\/api$|\/api\//;

const prose = (s: string): boolean => {
  const trimmed = s.trim();
  return (
    HAS_WORD.test(s) &&
    !TOKEN_LIKE.test(trimmed) &&
    !CONSTANT_LIKE.test(trimmed) &&
    !URL_LIKE.test(trimmed) &&
    !ALLOWED.has(trimmed)
  );
};

/**
 * Every source file is read once (in parallel) and parsed at most once: the two
 * scans below walk the same `.tsx` files, and parsing is what costs time.
 */
const texts = new Map<string, string>();
// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are walked generically.
const asts = new Map<string, any>();
function astOf(file: string) {
  let ast = asts.get(file);
  if (ast === undefined) {
    ast = parse(texts.get(file) ?? "", { sourceType: "module", plugins: ["jsx", "typescript"] });
    asts.set(file, ast);
  }
  return ast;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return SKIPPED_DIR.test(path) ? [] : sources(path);
    return entry.endsWith(".tsx") && !entry.includes(".test.") ? [path] : [];
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are walked generically.
type Node = any;

function findings(file: string): Finding[] {
  const ast = astOf(file);
  const out: Finding[] = [];
  const rel = relative(SRC, file);
  const report = (node: Node, text: string) =>
    out.push({ file: rel, line: node.loc.start.line, text: text.replace(/\s+/g, " ").trim() });
  const results = (e: Node, acc: Node[]) => {
    if (!e) return;
    if (e.type === "StringLiteral") acc.push(e);
    else if (e.type === "ConditionalExpression") {
      results(e.consequent, acc);
      results(e.alternate, acc);
    } else if (e.type === "LogicalExpression") results(e.right, acc);
  };
  const visit = (node: Node, depth: number, rawParent: boolean) => {
    if (!node || typeof node.type !== "string") return;
    const fn = /Function|ArrowFunction|ClassMethod|ObjectMethod/.test(node.type);
    const d = depth + (fn ? 1 : 0);
    let raw = rawParent;
    if (node.type === "JSXElement") {
      const name = node.openingElement?.name?.name;
      raw = typeof name === "string" && RAW_ELEMENTS.has(name);
    }
    if (d > 0 && !raw) {
      if (node.type === "JSXText" && prose(node.value)) report(node, node.value);
      const containers: Node[] = [];
      if (node.type === "JSXElement" || node.type === "JSXFragment") {
        for (const child of node.children) if (child.type === "JSXExpressionContainer") containers.push(child);
      }
      if (
        node.type === "JSXAttribute" &&
        typeof node.name?.name === "string" &&
        (ATTRS.has(node.name.name) || (TEXT_PROP.test(node.name.name) && node.name.name !== "className"))
      ) {
        if (node.value?.type === "StringLiteral" && prose(node.value.value)) report(node.value, node.value.value);
        if (node.value?.type === "JSXExpressionContainer") containers.push(node.value);
      }
      for (const container of containers) {
        const acc: Node[] = [];
        results(container.expression, acc);
        for (const lit of acc) if (prose(lit.value)) report(lit, lit.value);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key.endsWith("Comments")) continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child, d, raw);
      else if (value && typeof value === "object" && typeof value.type === "string") {
        // Attribute values are not children of a raw element.
        visit(value, d, node.type === "JSXAttribute" ? false : raw);
      }
    }
  };
  visit(ast.program, 0, false);
  return out;
}

/** Directories whose errors reach the user; `lib/` helpers throw developer errors. */
const FEEDBACK_DIRS = ["components", "hooks", "app"];
function feedbackSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return FEEDBACK_SKIPPED_DIR.test(path) ? [] : feedbackSources(path);
    return /\.tsx?$/.test(entry) && !entry.includes(".test.") ? [path] : [];
  });
}
function feedbackFindings(file: string): Finding[] {
  const ast = astOf(file);
  const out: Finding[] = [];
  const rel = relative(SRC, file);
  const literal = (n: Node): string | undefined =>
    n?.type === "StringLiteral"
      ? n.value
      : n?.type === "TemplateLiteral" && n.expressions.length === 0
        ? n.quasis[0].value.cooked
        : undefined;
  const check = (n: Node) => {
    const text = literal(n);
    if (text !== undefined && prose(text))
      out.push({ file: rel, line: n.loc.start.line, text: text.replace(/\s+/g, " ").trim() });
  };
  const visit = (node: Node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "NewExpression" && node.callee.name === "Error") check(node.arguments[0]);
    if (node.type === "CallExpression") {
      const c = node.callee;
      if (c.type === "Identifier" && c.name === "setError") check(node.arguments[0]);
      if (c.type === "MemberExpression" && c.object.name === "toast") check(node.arguments[0]);
      if (c.type === "Identifier" && c.name === "addToast" && node.arguments[0]?.type === "ObjectExpression") {
        for (const prop of node.arguments[0].properties) {
          if (prop.key?.name === "title" || prop.key?.name === "message") check(prop.value);
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key.endsWith("Comments")) continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  visit(ast.program);
  return out;
}
const componentFiles = sources(SRC);
const feedbackFiles = FEEDBACK_DIRS.flatMap((d) => feedbackSources(join(SRC, d)));

describe("i18n coverage", () => {
  beforeAll(async () => {
    const files = [...new Set([...componentFiles, ...feedbackFiles])];
    await Promise.all(files.map(async (file) => texts.set(file, await readFile(file, "utf8"))));
  });

  test("no hard-coded user-visible text in components", () => {
    const all = componentFiles.flatMap(findings);
    expect(all.map((f) => `${f.file}:${f.line} ${JSON.stringify(f.text)}`)).toEqual([]);
  });

  test("no hard-coded user-visible text in thrown errors, setError() and toasts", () => {
    const all = feedbackFiles.flatMap(feedbackFindings);
    expect(all.map((f) => `${f.file}:${f.line} ${JSON.stringify(f.text)}`)).toEqual([]);
  });
  test("the German catalog translates every key and keeps every placeholder", () => {
    const missing = Object.keys(en).filter((k) => !(k in de));
    expect(missing).toEqual([]);
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const mismatched = (Object.keys(en) as (keyof typeof en)[]).filter(
      (k) => JSON.stringify(placeholders(en[k])) !== JSON.stringify(placeholders(de[k])),
    );
    expect(mismatched).toEqual([]);
  });
});
