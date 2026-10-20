// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow version gate.
 *
 * A flow's `metadata.version` is what identifies a deployed revision: it is
 * recorded as `flow_version` in every execution trace and is how a rollout is
 * verified. A change that leaves the version untouched makes two different
 * behaviours indistinguishable in traces, receipts and evaluations. This
 * check fails when, compared with a base revision:
 *
 *   - a changed flow differs in anything but `metadata.version` and its
 *     version did not increase (semantic versioning);
 *   - a new flow has no valid `metadata.version`;
 *   - a file the flow depends on changed and the flow did not increase its
 *     version. Dependencies are resolved from the parsed flow, transitively,
 *     the way the runtime's flow parser resolves them (all paths relative to
 *     the flows directory):
 *       · `metadata.$include.subflows` (sub-flow files, nested up to 3 levels)
 *       · `#[[file:…]]` prompt includes in any `systemPrompt` (nodes and
 *         overrides, in sub-flows too; prompt files may nest up to 5 levels)
 *       · `model-shortcuts.*` when any node uses `llm.shortcut`
 *       · `constants.*` when the flow (or a sub-flow) references `const.<name>`
 *       · the shared configuration files `guardrails`, `dispatch`,
 *         `tool-authz`, `compliance-policy`, `access`, `canary` and
 *         `experiments`, which apply to every flow.
 *
 * Bump size (documented rule, reported as a warning, not a failure): a change
 * to the step graph (node ids/types or edges) is a flow-contract change and
 * should raise at least the minor version; prompt, parameter and include
 * changes need a patch bump.
 *
 * Usage:
 *   bun run scripts/check-flow-versions.ts --base <git-ref> [--allow-missing-base] [flows-dir …]
 *
 * Flows directories default to `deploy/examples/flows`. Files are recognised
 * by content (an object with `id` and a `nodes` array); the reserved
 * configuration files of other subsystems and `*.example.*` templates are
 * skipped (docs/FLOWS.md).
 *
 * Without a usable base (no ref, all-zero ref, unknown ref) the check cannot
 * compare anything. In CI (`CI=true` or `GITHUB_ACTIONS`) that FAILS, so a
 * misconfigured pipeline cannot silently skip the gate; locally it warns and
 * passes. `--allow-missing-base` opts out of the CI failure explicitly.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, posix, relative } from "node:path";

const RESERVED_BASENAMES = new Set([
  "dispatch",
  "access",
  "canary",
  "guardrails",
  "experiments",
  "mcp",
  "tool-authz",
  "compliance-policy",
  "shadow",
  "slo",
]);
const FLOW_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

export interface FlowDoc {
  id: string;
  version: string | undefined;
  /** The parsed document without `metadata.version`, for change detection. */
  body: unknown;
}

/** Parses a flow file's text; undefined when it is not a flow. */
export function parseFlow(path: string, text: string): FlowDoc | undefined {
  const name = basename(path, extname(path));
  if (RESERVED_BASENAMES.has(name) || name.endsWith(".example")) return undefined;
  let raw: unknown;
  try {
    raw = extname(path) === ".json" ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const doc = raw as Record<string, unknown>;
  if (typeof doc.id !== "string" || !Array.isArray(doc.nodes)) return undefined;
  const metadata =
    doc.metadata !== null && typeof doc.metadata === "object"
      ? { ...(doc.metadata as Record<string, unknown>) }
      : undefined;
  const version =
    typeof metadata?.version === "string" || typeof metadata?.version === "number"
      ? String(metadata.version)
      : undefined;
  if (metadata !== undefined) delete metadata.version;
  return { id: doc.id, version, body: { ...doc, ...(metadata !== undefined ? { metadata } : {}) } };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** -1 / 0 / 1 like a comparator; undefined when either is not semver. */
export function compareSemver(a: string, b: string): number | undefined {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (ma === null || mb === null) return undefined;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return Math.sign(d);
  }
  // A release is greater than its pre-releases; pre-releases compare lexically.
  const pa = ma[4];
  const pb = mb[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  );
}

export interface FlowChange {
  path: string;
  base: FlowDoc | undefined;
  head: FlowDoc;
  /** Changed files (prompts, sub-flows, shortcuts, shared config) this flow depends on. */
  changedIncludes: string[];
  /** The step graph (node ids/types or edges) differs from the base. */
  graphChanged?: boolean;
}

/** Violations for one flow; empty when the change is versioned correctly. */
export function checkFlowChange(change: FlowChange): string[] {
  const { path, base, head, changedIncludes } = change;
  if (head.version === undefined || compareSemver(head.version, head.version) === undefined) {
    return [`${path}: metadata.version must be a semantic version (x.y.z), found ${JSON.stringify(head.version)}`];
  }
  if (base === undefined) return [];
  const bodyChanged = stable(base.body) !== stable(head.body);
  if (!bodyChanged && changedIncludes.length === 0) return [];
  const order = base.version === undefined ? 1 : compareSemver(head.version, base.version);
  if (order === undefined || order > 0) return [];
  const why = bodyChanged
    ? "its definition changed"
    : `dependent file(s) changed: ${changedIncludes.join(", ")}`;
  return [
    `${path}: ${why} but metadata.version stayed ${head.version} (was ${base.version ?? "unset"}); increase it`,
  ];
}

/**
 * Warnings about the SIZE of an otherwise sufficient bump: a changed step
 * graph is a contract change and should raise at least the minor version.
 */
export function bumpWarnings(change: FlowChange): string[] {
  const { path, base, head, graphChanged } = change;
  if (graphChanged !== true || base?.version === undefined || head.version === undefined) return [];
  const a = SEMVER.exec(base.version);
  const b = SEMVER.exec(head.version);
  if (a === null || b === null) return [];
  const higherMajorOrMinor = Number(b[1]) > Number(a[1]) || (Number(b[1]) === Number(a[1]) && Number(b[2]) > Number(a[2]));
  if (compareSemver(head.version, base.version) === 1 && !higherMajorOrMinor) {
    return [
      `${path}: the step graph (nodes/edges) changed; ${base.version} -> ${head.version} is only a patch bump, a graph change should raise at least the minor version`,
    ];
  }
  return [];
}

// ─── Dependency resolution ───────────────────────────────────────────────────

/** Reads a file relative to the flows directory; undefined when it does not exist. */
export type ReadFlowFile = (relPath: string) => string | undefined;

const PROMPT_INCLUDE = /#\[\[file:([^\]]+)\]\]/g;
const MAX_SUBFLOW_DEPTH = 3;
const MAX_PROMPT_DEPTH = 5;
/** Shared configuration read for every flow (docs/FLOWS.md). */
const SHARED_CONFIG = [
  "guardrails",
  "dispatch",
  "tool-authz",
  "compliance-policy",
  "access",
  "canary",
  "experiments",
];
const MODEL_SHORTCUTS = "model-shortcuts";
/** Variables resolve `{{const.<name>}}` / `const.<name>` against `constants.*`. */
const FLOW_CONSTANTS = "constants";
const CONSTANT_REFERENCE = /\bconst\.[A-Za-z_]/;

function parseDocument(path: string, text: string): Record<string, unknown> | undefined {
  try {
    const raw = extname(path) === ".json" ? JSON.parse(text) : Bun.YAML.parse(text);
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when any object in the tree has a string `shortcut` (an `llm.shortcut` reference). */
function usesShortcut(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesShortcut);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([k, v]) => (k === "shortcut" && typeof v === "string") || usesShortcut(v),
  );
}

/** `systemPrompt` strings of nodes and their overrides, where prompt includes are resolved. */
function systemPrompts(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    if (typeof n.systemPrompt === "string") out.push(n.systemPrompt);
    if (Array.isArray(n.overrides)) {
      for (const o of n.overrides) {
        if (o !== null && typeof o === "object" && typeof (o as Record<string, unknown>).systemPrompt === "string") {
          out.push((o as Record<string, string>).systemPrompt as string);
        }
      }
    }
  }
  return out;
}

function normalizeRel(rel: string): string {
  return posix.normalize(rel.trim().split("\\").join("/"));
}

/**
 * Every file (relative to the flows directory) the flow's behaviour depends
 * on, resolved from the parsed definition like the runtime's flow parser:
 * sub-flows (transitively), prompt files (transitively) and, when the flow
 * uses `llm.shortcut`, the model shortcuts; shared configuration always.
 * The flow file itself is not included.
 */
export function resolveFlowDependencies(
  entryPath: string,
  entryText: string,
  readFile: ReadFlowFile,
  flowFiles: readonly string[] = [],
): Set<string> {
  const deps = new Set<string>();
  let shortcuts = false;
  let constants = false;
  const visitPrompt = (rel: string, depth: number): void => {
    const file = normalizeRel(rel);
    if (deps.has(file) || depth > MAX_PROMPT_DEPTH) return;
    deps.add(file);
    const text = readFile(file);
    if (text === undefined) return;
    for (const m of text.matchAll(PROMPT_INCLUDE)) visitPrompt(m[1] as string, depth + 1);
  };

  const visitDoc = (doc: Record<string, unknown>, depth: number, seen: Set<string>): void => {
    if (usesShortcut(doc.nodes)) shortcuts = true;
    if (CONSTANT_REFERENCE.test(JSON.stringify(doc))) constants = true;
    for (const prompt of systemPrompts(doc)) {
      for (const m of prompt.matchAll(PROMPT_INCLUDE)) visitPrompt(m[1] as string, 1);
    }
    const include = (doc.metadata as Record<string, unknown> | undefined)?.$include;
    const subflows =
      include !== null && typeof include === "object" ? (include as Record<string, unknown>).subflows : undefined;
    if (!Array.isArray(subflows) || depth >= MAX_SUBFLOW_DEPTH) return;
    for (const entry of subflows) {
      if (typeof entry !== "string") continue;
      const file = normalizeRel(entry);
      if (seen.has(file)) continue;
      seen.add(file);
      deps.add(file);
      const text = readFile(file);
      const sub = text === undefined ? undefined : parseDocument(file, text);
      if (sub !== undefined) visitDoc(sub, depth + 1, seen);
    }
  };

  const entry = parseDocument(entryPath, entryText);
  if (entry !== undefined) visitDoc(entry, 0, new Set([normalizeRel(entryPath)]));

  const sharedNames = new Set(SHARED_CONFIG);
  if (shortcuts) sharedNames.add(MODEL_SHORTCUTS);
  if (constants) sharedNames.add(FLOW_CONSTANTS);
  for (const file of flowFiles) {
    const rel = normalizeRel(file);
    if (!rel.includes("/") && sharedNames.has(basename(rel, extname(rel)))) deps.add(rel);
  }
  return deps;
}

/** Sorted `id:type` of nodes and `source->target` of edges: the shape of the step graph. */
export function graphShape(text: string, path: string): string | undefined {
  const doc = parseDocument(path, text);
  if (doc === undefined) return undefined;
  const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []).map((n) => {
    const o = (n ?? {}) as Record<string, unknown>;
    return `${String(o.id)}:${String(o.type)}`;
  });
  const edges = (Array.isArray(doc.edges) ? doc.edges : []).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return `${String(o.source)}->${String(o.target)}`;
  });
  return JSON.stringify([nodes.sort(), edges.sort()]);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitShow(ref: string, path: string): string | undefined {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** True on CI runners, where a missing base must fail instead of skipping the gate. */
export function isCi(env: Record<string, string | undefined> = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || (env.GITHUB_ACTIONS ?? "") !== "";
}

function missingBase(reason: string, allow: boolean): void {
  if (isCi() && !allow) {
    console.error(
      `check-flow-versions: ${reason} - cannot compare flow versions. Failing because this is CI; ` +
        "provide FLOW_VERSION_BASE / --base, or pass --allow-missing-base to skip deliberately.",
    );
    process.exit(1);
  }
  console.log(`check-flow-versions: ${reason} - nothing to compare, passing (not CI).`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : process.env.FLOW_VERSION_BASE;
  const allowMissingBase = argv.includes("--allow-missing-base");
  const dirs = argv.filter((a, i) => a !== "--base" && i !== baseIndex + 1 && a !== "--allow-missing-base");
  const flowDirs = dirs.length > 0 ? dirs : ["deploy/examples/flows"];

  if (base === undefined || base === "" || /^0+$/.test(base)) {
    missingBase("no base revision given", allowMissingBase);
    return;
  }
  try {
    git(["rev-parse", "--verify", `${base}^{commit}`]);
  } catch {
    missingBase(`base ${base} is not available`, allowMissingBase);
    return;
  }

  const violations: string[] = [];
  const warnings: string[] = [];
  let checked = 0;
  for (const dir of flowDirs) {
    const changed = new Set(
      git(["diff", "--name-only", `${base}...HEAD`, "--", dir])
        .split("\n")
        .filter((p) => p !== ""),
    );
    if (changed.size === 0) continue;
    const changedRel = new Set([...changed].map((p) => normalizeRel(relative(dir, p))));
    const allFiles = listFiles(dir);
    const topLevel = allFiles.map((f) => normalizeRel(relative(dir, f)));
    const readHead = (rel: string): string | undefined => {
      const abs = join(dir, rel);
      return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : undefined;
    };

    for (const path of allFiles) {
      if (!FLOW_EXTENSIONS.has(extname(path))) continue;
      const rel = normalizeRel(relative(dir, path));
      if (rel.startsWith("prompts/") || rel.startsWith("subflows/")) continue;
      const headText = readFileSync(path, "utf8");
      const head = parseFlow(path, headText);
      if (head === undefined) continue;
      const deps = resolveFlowDependencies(rel, headText, readHead, topLevel);
      const changedDeps = [...deps].filter((d) => changedRel.has(d)).sort();
      if (!changed.has(path) && changedDeps.length === 0) continue;
      const baseText = gitShow(base, path);
      const baseDoc = baseText === undefined ? undefined : parseFlow(path, baseText);
      checked++;

      let graphChanged = false;
      if (baseText !== undefined) {
        const shapeOf = (t: string | undefined, p: string): string | undefined =>
          t === undefined ? undefined : graphShape(t, p);
        graphChanged = shapeOf(baseText, path) !== shapeOf(headText, path);
        for (const dep of changedDeps) {
          if (!dep.startsWith("subflows/")) continue;
          const before = shapeOf(gitShow(base, join(dir, dep)), dep);
          const after = shapeOf(readHead(dep), dep);
          if (before !== after) graphChanged = true;
        }
      }
      const change: FlowChange = { path, base: baseDoc, head, changedIncludes: changedDeps, graphChanged };
      violations.push(...checkFlowChange(change));
      warnings.push(...bumpWarnings(change));
    }
  }

  for (const w of warnings) console.warn(`  warning: ${w}`);
  if (violations.length > 0) {
    console.error(`Flow version check failed (${violations.length}):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`check-flow-versions: ${checked} changed flow(s) versioned correctly against ${base}.`);
}

if (import.meta.main) main();
