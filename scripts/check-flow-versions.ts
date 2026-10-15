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
 *   - a prompt (`prompts/…`) or sub-flow (`subflows/…`) file changed and a
 *     flow that includes it did not increase its version — the include
 *     changes the flow's behaviour just as much as an edit to the flow.
 *
 * Usage:
 *   bun run scripts/check-flow-versions.ts --base <git-ref> [flows-dir …]
 *
 * Flows directories default to `deploy/examples/flows`. Files are recognised
 * by content (an object with `id` and a `nodes` array); the reserved
 * configuration files of other subsystems and `*.example.*` templates are
 * skipped (docs/FLOWS.md). Without a usable base (first commit, unknown ref)
 * the check reports that and passes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

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
  /** Changed prompt/sub-flow files this flow includes. */
  changedIncludes: string[];
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
    : `included file(s) changed: ${changedIncludes.join(", ")}`;
  return [
    `${path}: ${why} but metadata.version stayed ${head.version} (was ${base.version ?? "unset"}); increase it`,
  ];
}

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

function main(): void {
  const argv = process.argv.slice(2);
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : process.env.FLOW_VERSION_BASE;
  const dirs = argv.filter((a, i) => a !== "--base" && i !== baseIndex + 1);
  const flowDirs = dirs.length > 0 ? dirs : ["deploy/examples/flows"];

  if (base === undefined || base === "" || /^0+$/.test(base)) {
    console.log("check-flow-versions: no base revision given — nothing to compare, passing.");
    return;
  }
  try {
    git(["rev-parse", "--verify", `${base}^{commit}`]);
  } catch {
    console.log(`check-flow-versions: base ${base} is not available — nothing to compare, passing.`);
    return;
  }

  const violations: string[] = [];
  let checked = 0;
  for (const dir of flowDirs) {
    const changed = new Set(
      git(["diff", "--name-only", `${base}...HEAD`, "--", dir])
        .split("\n")
        .filter((p) => p !== ""),
    );
    if (changed.size === 0) continue;
    const changedIncludeFiles = [...changed].filter((p) => {
      const rel = relative(dir, p);
      return rel.startsWith("prompts/") || rel.startsWith("subflows/");
    });

    for (const path of listFiles(dir)) {
      if (!FLOW_EXTENSIONS.has(extname(path))) continue;
      const rel = relative(dir, path);
      if (rel.startsWith("prompts/") || rel.startsWith("subflows/")) continue;
      const headText = readFileSync(path, "utf8");
      const head = parseFlow(path, headText);
      if (head === undefined) continue;
      const includes = changedIncludeFiles.filter((inc) =>
        headText.includes(relative(dirname(path), inc)) || headText.includes(basename(inc)),
      );
      if (!changed.has(path) && includes.length === 0) continue;
      const baseText = gitShow(base, path);
      const baseDoc = baseText === undefined ? undefined : parseFlow(path, baseText);
      checked++;
      violations.push(
        ...checkFlowChange({ path, base: baseDoc, head, changedIncludes: includes }),
      );
    }
  }

  if (violations.length > 0) {
    console.error(`Flow version check failed (${violations.length}):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`check-flow-versions: ${checked} changed flow(s) versioned correctly against ${base}.`);
}

if (import.meta.main) main();
