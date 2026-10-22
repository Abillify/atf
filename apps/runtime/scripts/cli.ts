#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * aiperator CLI (`scripts/cli.ts`)
 *
 * A developer-facing command-line tool for working with aiperator flows locally.
 * Covers the four most common operations:
 *
 *   validate <file|dir>   — Validate flow YAML/JSON files offline (no server needed)
 *   diff <fileA> <fileB>  — Show structural diff between two flow definitions
 *   deploy <file>         — Push a flow to a running server (validate + PUT /flows/:id/draft + publish)
 *   test <flowId>         — Run a quick smoke-test against a running server
 *   verify-bundle <file>  — Verify a signed Evidence Bundle offline (no network)
 *   flows release <id>    — Run the flow's bench file against a server as a release gate
 *
 * Usage:
 *   bun run scripts/cli.ts validate flows/my-flow.yaml
 *   bun run scripts/cli.ts diff flows/v1.yaml flows/v2.yaml
 *   bun run scripts/cli.ts deploy flows/my-flow.yaml --server http://localhost:3000
 *   bun run scripts/cli.ts test my-flow --message "Hello" --server http://localhost:3000
 *
 * Options (all subcommands):
 *   --server <url>   Backend base URL (default: $AIPERATOR_SERVER or http://localhost:3000)
 *   --token <jwt>    Auth token (default: $AIPERATOR_TOKEN)
 *   --json           Output raw JSON (skips formatted output)
 *   --help, -h       Show help
 *
 * No external dependencies — uses Node/Bun built-ins only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFlowFile, resolveConfigFile } from "../src/util/parse-flow-file.js";
import { validateFlow } from "../src/graph/flow-validator.js";
import { validateFlowSource } from "../src/graph/flow-parser/validate.js";
import {
  resolveFlowIncludes,
  resolveRawFlowVariables,
} from "../src/graph/flow-parser/normalize.js";
import {
  loadModelShortcuts,
  resolveModelShortcuts,
} from "../src/graph/flow-parser/model-shortcuts.js";
import {
  ProviderInstancesSchema,
  setProviderRegistry,
} from "../src/config/providers.js";
import {
  BENCH_DIR_NAME,
  BENCH_FILE_SUFFIX,
  loadBenchFile,
  type BenchFile,
} from "../src/eval/bench-contract.js";
import { computeFlowDigest } from "../src/graph/flow-revision.js";
import { createHttpExecutor } from "../src/eval/run.js";
import {
  aggregateStats,
  buildReleaseReceipt,
  compareBaseline,
  computeBenchDigest,
  evaluateThresholds,
  runBenchCases,
  signReleaseReceipt,
  versionGateProblem,
  type ReleaseBaseline,
} from "../src/eval/flow-release.js";
import {
  parseEvidenceSigningKey,
  type Ed25519EvidenceKey,
} from "../src/observability/evidence-key.js";
import type { FlowDefinition } from "../src/types/flow.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const ok = `${c.green}✓${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const info = `${c.cyan}ℹ${c.reset}`;

function bold(s: string): string { return `${c.bold}${s}${c.reset}`; }
function dim(s: string): string { return `${c.gray}${s}${c.reset}`; }

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  positional: string[];
  server: string;
  token: string;
  json: boolean;
  help: boolean;
  /** validate: fail when an entry flow has no semantic `metadata.version`. */
  requireVersion: boolean;
  /** verify-bundle: JWKS (http(s) URL or local file) with the Ed25519 evidence key. */
  jwks?: string;
  /** verify-bundle: key id to select from the JWKS (default: the bundle's kid). */
  kid?: string;
  /** flows release: directory holding the flow and its `bench/` file. */
  flowsDir?: string;
  /** flows release: git ref the flow version is compared against. */
  base?: string;
  /** flows release: previous release receipt used as a baseline. */
  baseline?: string;
  /** flows release: Ed25519 key file used to sign the release receipt. */
  signingKeyFile?: string;
  /** flows release: path the release receipt is written to. */
  out?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip bun + script
  const result: ParsedArgs = {
    command: "",
    positional: [],
    server: process.env["AIPERATOR_SERVER"] ?? "http://localhost:3000",
    token: process.env["AIPERATOR_TOKEN"] ?? "",
    json: false,
    help: false,
    requireVersion: false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "--help" || a === "-h") { result.help = true; i++; continue; }
    if (a === "--json") { result.json = true; i++; continue; }
    if (a === "--require-version") { result.requireVersion = true; i++; continue; }
    if (a === "--server" && i + 1 < args.length) { result.server = args[++i] ?? ""; i++; continue; }
    if (a === "--token" && i + 1 < args.length) { result.token = args[++i] ?? ""; i++; continue; }
    if (a === "--jwks" && i + 1 < args.length) {
      result.jwks = args[++i] ?? "";
      i++;
      continue;
    }
    if (a === "--kid" && i + 1 < args.length) {
      result.kid = args[++i] ?? "";
      i++;
      continue;
    }
    if (a === "--flows-dir" && i + 1 < args.length) { result.flowsDir = args[++i] ?? ""; i++; continue; }
    if (a === "--base" && i + 1 < args.length) { result.base = args[++i] ?? ""; i++; continue; }
    if (a === "--baseline" && i + 1 < args.length) { result.baseline = args[++i] ?? ""; i++; continue; }
    if (a === "--signing-key-file" && i + 1 < args.length) { result.signingKeyFile = args[++i] ?? ""; i++; continue; }
    if (a === "--out" && i + 1 < args.length) { result.out = args[++i] ?? ""; i++; continue; }
    if (!result.command && !a.startsWith("-")) { result.command = a; i++; continue; }
    if (!a.startsWith("-")) { result.positional.push(a); i++; continue; }
    i++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function api(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data: unknown;
  try { data = await resp.json(); } catch { data = null; }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFlowFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    console.error(`${fail} File not found: ${filePath}`);
    process.exit(1);
  }
  try {
    return parseFlowFile(filePath);
  } catch (err) {
    console.error(`${fail} Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const RESERVED_FLOW_BASES = new Set([
  "dispatch",
  "access",
  "canary",
  "guardrails",
  "experiments",
  "mcp",
  "tool-authz",
  "compliance-policy",
  "shadow",
  "model-shortcuts",
  // Mirrors RESERVED_BASES in src/graph/flow-parser/loader.ts: shared config,
  // never a flow definition.
  "constants",
]);

function isFlowCandidate(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!/\.(yaml|yml|json)$/.test(ext)) return false;
  const base = path.basename(filePath, ext);
  return !RESERVED_FLOW_BASES.has(base) && !base.endsWith(".example");
}

/** Finds the closest flow root so a directly validated subflow can resolve shortcuts. */
function findFlowsDir(filePath: string): string {
  let directory = path.dirname(filePath);
  while (true) {
    for (const ext of [".yaml", ".yml", ".json"]) {
      if (fs.existsSync(path.join(directory, `model-shortcuts${ext}`))) {
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(filePath);
    directory = parent;
  }
}

type FlowIssue = { path: string; message: string };
/**
 * The causes behind a failed load: schema failures name each offending field
 * (zod `flatten()` shape), anything else keeps its serialized details. A bare
 * "Schema validation failed" would force the author to start the runtime to
 * learn what is wrong.
 */
export function flowIssues(reason: string, details: unknown): FlowIssue[] {
  if (details !== null && typeof details === "object") {
    const flat = details as { formErrors?: unknown; fieldErrors?: unknown };
    const issues: FlowIssue[] = [];
    if (Array.isArray(flat.formErrors)) {
      for (const message of flat.formErrors) issues.push({ path: "$", message: String(message) });
    }
    if (flat.fieldErrors !== null && typeof flat.fieldErrors === "object") {
      for (const [field, messages] of Object.entries(flat.fieldErrors as Record<string, unknown>)) {
        for (const message of Array.isArray(messages) ? messages : [messages]) {
          issues.push({ path: field, message: String(message) });
        }
      }
    }
    if (issues.length > 0) return [{ path: "$", message: reason }, ...issues];
  }
  if (details === undefined) return [{ path: "$", message: reason }];
  const text = typeof details === "string" ? details : JSON.stringify(details);
  return [{ path: "$", message: `${reason}: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}` }];
}
function invalidReport(issues: FlowIssue[]): ReturnType<typeof validateFlow> {
  return { valid: false, errors: issues, warnings: [], meta: { nodeCount: 0, edgeCount: 0 } };
}
/** Mirrors the production loader: includes, variables, model shortcuts, then schema validation. */
function validateFlowFile(filePath: string): ReturnType<typeof validateFlow> {
  const raw = loadFlowFile(filePath);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return validateFlow(raw);
  }

  const flowsDir = findFlowsDir(filePath);
  const fileName = path.relative(flowsDir, filePath);
  const source = raw as Record<string, unknown>;
  let resolved: ReturnType<typeof validateFlowSource>;
  try {
    resolveFlowIncludes(source, flowsDir, fileName);
    const shortcuts = loadModelShortcuts(flowsDir);
    resolved = validateFlowSource(source, (flow, overrides, name) => {
      resolveRawFlowVariables(flow, overrides, name);
      if (shortcuts !== null) resolveModelShortcuts(flow, shortcuts, name);
    });
  } catch (err) {
    // An unresolvable include, variable or shortcut throws; report it as the
    // file's error instead of aborting the whole run with a stack trace.
    return invalidReport([{ path: "$", message: err instanceof Error ? err.message : String(err) }]);
  }
  if (!resolved.success) {
    return invalidReport(flowIssues(resolved.error.reason, resolved.error.details));
  }
  return validateFlow(resolved.data);
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * `validate --require-version`: the problem with a flow's declared
 * `metadata.version`, or undefined when it is a semantic version (x.y.z). The
 * version is what `flow_version` in the debug trace reports, so a flow without
 * one cannot be verified after a rollout.
 */
export function flowVersionProblem(raw: unknown): string | undefined {
  const metadata =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).metadata
      : undefined;
  const version =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).version
      : undefined;
  if (typeof version === "string" && SEMVER_RE.test(version)) return undefined;
  return version === undefined
    ? "metadata.version is required (semantic version, e.g. 1.0.0)"
    : `metadata.version must be a semantic version (x.y.z), found ${JSON.stringify(version)}`;
}

function isSubflowFile(filePath: string): boolean {
  const flowsDir = findFlowsDir(filePath);
  const relativePath = path.relative(flowsDir, filePath);
  return relativePath === "subflows" || relativePath.startsWith(`subflows${path.sep}`);
}

/** Bench files (`<FLOWS_DIR>/bench/<flowId>.bench.yaml`) are not flows. */
function isBenchFile(filePath: string): boolean {
  const flowsDir = findFlowsDir(filePath);
  const relativePath = path.relative(flowsDir, filePath);
  return relativePath === BENCH_DIR_NAME || relativePath.startsWith(`${BENCH_DIR_NAME}${path.sep}`);
}

function flowSkipReason(filePath: string): string | undefined {
  if (!isFlowCandidate(filePath)) {
    return "reserved configuration or example file, not a flow definition";
  }
  if (isSubflowFile(filePath)) {
    return "sub-flow fragment; it is validated through its including parent flow";
  }
  if (isBenchFile(filePath)) {
    return "bench file; it is validated by `flows release`, not as a flow";
  }
  return undefined;
}

function collectFlowFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  if (stat.isDirectory()) {
    return fs.readdirSync(target)
      .map((file) => path.join(target, file))
      .filter(isFlowCandidate)
      .filter((file) => !isSubflowFile(file))
      .filter((file) => !isBenchFile(file))
      .sort();
  }
  return [];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Publishes provider instances from the `PROVIDERS` env var so `llm.provider`
 * references resolve during offline validation. Deliberately does NOT call
 * `loadConfig()` — that would enforce every unrelated env requirement and
 * `process.exit(1)` on the first missing variable, which is wrong for a
 * self-contained flow validator. Without `PROVIDERS` set the registry stays
 * empty and only the built-in wire protocols resolve, matching prior behaviour.
 */
export function registerProvidersFromEnv(): void {
  const providersRaw = process.env.PROVIDERS;
  if (!providersRaw) return;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(providersRaw);
  } catch {
    console.log(
      `${warn} ${dim("PROVIDERS is set but is not valid JSON — provider names will not resolve")}`,
    );
    return;
  }
  const parsed = ProviderInstancesSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.log(
      `${warn} ${dim("PROVIDERS is set but does not match the provider schema — provider names will not resolve")}`,
    );
    return;
  }
  setProviderRegistry(parsed.data);
}

/** validate: check flow files offline without a running server. */
async function cmdValidate(args: ParsedArgs): Promise<number> {
  const [target] = args.positional;
  if (!target) {
    console.error(`${fail} Usage: aiperator validate <file|dir>`);
    return 1;
  }

  registerProvidersFromEnv();

  if (!fs.existsSync(target)) {
    console.error(`${fail} File not found: ${target}`);
    return 1;
  }
  const targetStat = fs.statSync(target);
  const skipReason = targetStat.isFile() ? flowSkipReason(target) : undefined;
  if (skipReason !== undefined) {
    console.log(`${info} ${dim(`${target} skipped — ${skipReason}`)}`);
    return 0;
  }

  const files = collectFlowFiles(target);
  if (files.length === 0 && targetStat.isDirectory() && path.basename(target) === "subflows") {
    console.log(`${info} ${dim(`${target} contains sub-flow fragments; they are validated through their including parent flows`)}`);
    return 0;
  }
  if (files.length === 0 && targetStat.isDirectory() && path.basename(target) === BENCH_DIR_NAME) {
    console.log(`${info} ${dim(`${target} contains bench files; they are validated by \`flows release\`, not as flows`)}`);
    return 0;
  }
  if (files.length === 0) {
    console.error(`${fail} No YAML/JSON flow files found at: ${target}`);
    return 1;
  }

  let exitCode = 0;
  const results: Array<{ file: string; valid: boolean; errors: number; warnings: number }> = [];

  for (const file of files) {
    const report = validateFlowFile(file);
    if (args.requireVersion) {
      const problem = flowVersionProblem(loadFlowFile(file));
      if (problem !== undefined) {
        report.errors.push({ path: "metadata.version", message: problem });
        report.valid = false;
      }
    }

    results.push({
      file,
      valid: report.valid,
      errors: report.errors.length,
      warnings: report.warnings.length,
    });

    if (args.json) continue;

    const icon = report.valid ? ok : fail;
    const flowId = report.meta.flowId ?? path.basename(file);
    const nodeCount = report.meta.nodeCount;
    const edgeCount = report.meta.edgeCount;
    console.log(`${icon} ${bold(flowId)} ${dim(`(${file})`)} — ${nodeCount} nodes, ${edgeCount} edges`);

    for (const e of report.errors) {
      console.log(`   ${fail} ${c.red}ERROR${c.reset}  [${e.path}] ${e.message}`);
    }
    for (const w of report.warnings) {
      console.log(`   ${warn} ${c.yellow}WARN${c.reset}   [${w.path}] ${w.message}`);
    }
    if (!report.valid) exitCode = 1;
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const valid = results.filter((r) => r.valid).length;
    const invalid = results.length - valid;
    const totalWarnings = results.reduce((n, r) => n + r.warnings, 0);
    console.log(`\n${dim("────────────────────────")}`);
    console.log(`${info} ${bold(`${files.length} file(s)`)} checked — ${c.green}${valid} valid${c.reset}, ${invalid > 0 ? c.red : ""}${invalid} invalid${c.reset}, ${totalWarnings} warning(s)`);
  }
  return exitCode;
}

/** diff: show structural diff between two flow versions. */
async function cmdDiff(args: ParsedArgs): Promise<number> {
  const [fileA, fileB] = args.positional;
  if (!fileA || !fileB) {
    console.error(`${fail} Usage: aiperator diff <fileA> <fileB>`);
    return 1;
  }

  const rawA = loadFlowFile(fileA);
  const rawB = loadFlowFile(fileB);

  // Import diffFlows from the backend module.
  const { diffFlows } = await import("../src/graph/flow-diff.js");
  const { validateFlowDefinition } = await import("../src/graph/flow-parser.js");

  const resA = validateFlowDefinition(rawA);
  const resB = validateFlowDefinition(rawB);
  if (!resA.success) {
    console.error(`${fail} ${fileA} is invalid: ${resA.error.reason}`); return 1;
  }
  if (!resB.success) {
    console.error(`${fail} ${fileB} is invalid: ${resB.error.reason}`); return 1;
  }

  const diff = diffFlows(resA.data, resB.data);

  if (args.json) {
    console.log(JSON.stringify(diff, null, 2));
    return 0;
  }

  console.log(`\n${bold("Flow diff")}  ${dim(fileA)} → ${dim(fileB)}\n`);

  if (diff.unchanged) {
    console.log(`${ok} Flows are structurally identical.`);
    return 0;
  }

  const sections = [
    { label: "Nodes added",    items: (diff as Record<string, unknown[]>)["nodesAdded"] ?? [] },
    { label: "Nodes removed",  items: (diff as Record<string, unknown[]>)["nodesRemoved"] ?? [] },
    { label: "Nodes changed",  items: (diff as Record<string, unknown[]>)["nodesChanged"] ?? [] },
    { label: "Edges added",    items: (diff as Record<string, unknown[]>)["edgesAdded"] ?? [] },
    { label: "Edges removed",  items: (diff as Record<string, unknown[]>)["edgesRemoved"] ?? [] },
    { label: "Edges changed",  items: (diff as Record<string, unknown[]>)["edgesChanged"] ?? [] },
  ];

  for (const { label, items } of sections) {
    if (items.length === 0) continue;
    console.log(`${bold(label)} (${items.length})`);
    for (const item of items.slice(0, 10)) {
      console.log(`  ${dim("·")} ${JSON.stringify(item)}`);
    }
    if (items.length > 10) console.log(dim(`  … and ${items.length - 10} more`));
    console.log();
  }
  return 0;
}

/** deploy: validate + push flow to a running server. */
async function cmdDeploy(args: ParsedArgs): Promise<number> {
  const [file] = args.positional;
  if (!file) {
    console.error(`${fail} Usage: aiperator deploy <file> [--server <url>] [--token <jwt>]`);
    return 1;
  }
  if (!args.token) {
    console.error(`${fail} --token is required for deploy (or set AIPERATOR_TOKEN)`);
    return 1;
  }

  // 1. Validate locally first.
  const raw = loadFlowFile(file);
  const report = validateFlow(raw);
  if (!report.valid) {
    console.error(`${fail} Flow has validation errors — aborting deploy:`);
    for (const e of report.errors) console.error(`   ${fail} [${e.path}] ${e.message}`);
    return 1;
  }
  const flowId = report.meta.flowId;
  if (!flowId) {
    console.error(`${fail} Flow definition is missing an 'id' field`);
    return 1;
  }
  console.log(`${ok} Local validation passed — ${report.meta.nodeCount} nodes, ${report.meta.edgeCount} edges`);

  // 2. Save as draft.
  const draftUrl = `${args.server}/flows/${encodeURIComponent(flowId)}/draft`;
  console.log(`${info} Saving draft to ${draftUrl} …`);
  const draftRes = await api("PUT", draftUrl, args.token, { definition: raw });
  if (draftRes.status >= 400) {
    console.error(`${fail} Draft failed (HTTP ${draftRes.status}):`, JSON.stringify(draftRes.data, null, 2));
    return 1;
  }
  console.log(`${ok} Draft saved`);

  // 3. Publish.
  const publishUrl = `${args.server}/flows/${encodeURIComponent(flowId)}/publish`;
  console.log(`${info} Publishing …`);
  const pubRes = await api("POST", publishUrl, args.token, {});
  if (pubRes.status >= 400) {
    console.error(`${fail} Publish failed (HTTP ${pubRes.status}):`, JSON.stringify(pubRes.data, null, 2));
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(pubRes.data, null, 2));
  } else {
    console.log(`${ok} ${bold(flowId)} published successfully`);
  }
  return 0;
}

/** Connects to DATABASE_URL (or --database-url) for the rls-* commands. */
async function connectForRls(
  _args: ParsedArgs,
): Promise<import("../src/db/database.js").Database> {
  const rawArgv = process.argv.slice(2);
  const dbIdx = rawArgv.indexOf("--database-url");
  const url =
    (dbIdx !== -1 && rawArgv[dbIdx + 1]) || process.env["DATABASE_URL"];
  if (!url) {
    console.error(
      `${fail} Set DATABASE_URL or pass --database-url <postgres-connection-string>`,
    );
    process.exit(1);
  }
  const { createDatabase } = await import("../src/db/database.js");
  const db = await createDatabase(url);
  if (db === undefined) {
    console.error(
      `${fail} Could not connect (Bun's native SQL client is unavailable in this runtime).`,
    );
    process.exit(1);
  }
  return db;
}

function printRlsStatus(
  status: import("../src/db/rls-onboarding.js").RlsOnboardingStatus,
): void {
  console.log(`\n${bold("Row-Level Security status")}\n`);
  for (const t of status.tables) {
    const icon = t.exists && t.enabled && t.forced ? ok : t.exists ? warn : fail;
    const detail = !t.exists
      ? "table not found"
      : `enabled=${t.enabled} forced=${t.forced}`;
    console.log(`  ${icon} ${t.table.padEnd(24)} ${dim(detail)}`);
  }
  console.log();
  console.log(
    `  ${status.rolesConfigured ? ok : warn} least-privilege roles (aiperator_app / aiperator_operator) ${status.rolesConfigured ? "configured" : "NOT configured"}`,
  );
  if (status.multiTenantDetected !== undefined) {
    console.log(
      `  ${status.multiTenantDetected ? warn : info} multi-tenant deployment detected: ${status.multiTenantDetected} ${status.tenantCount !== undefined ? dim(`(${status.tenantCount} tenants)`) : ""}`,
    );
  }
  console.log();
  if (status.fullyEnforced) {
    console.log(`${ok} ${bold("RLS is fully enforced")} on all tenant tables.`);
  } else if (status.multiTenantDetected === true) {
    console.log(
      `${fail} ${bold("RLS is NOT fully enforced")} and this deployment has multiple tenants — ` +
        `cross-tenant data isolation currently relies solely on application-level query predicates. ` +
        `Run ${bold("bun run scripts/cli.ts rls-setup --confirm")} to close this gap.`,
    );
  } else {
    console.log(
      `${warn} ${bold("RLS is NOT fully enforced")}. Run ${bold("bun run scripts/cli.ts rls-setup --confirm")} before onboarding a second tenant.`,
    );
  }
}

/** rls-status: read-only report of tenant-table RLS enforcement. */
async function cmdRlsStatus(args: ParsedArgs): Promise<number> {
  const { checkRlsOnboarding } = await import("../src/db/rls-onboarding.js");
  const db = await connectForRls(args);
  try {
    const status = await checkRlsOnboarding(db);
    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      printRlsStatus(status);
    }
    return status.fullyEnforced ? 0 : 1;
  } finally {
    await db.close();
  }
}

/** rls-setup: apply the RLS onboarding statements (idempotent), then re-verify. */
async function cmdRlsSetup(args: ParsedArgs): Promise<number> {
  const rawArgv = process.argv.slice(2);
  const confirmed = rawArgv.includes("--confirm");
  const { checkRlsOnboarding, applyRlsOnboarding } = await import(
    "../src/db/rls-onboarding.js"
  );
  const db = await connectForRls(args);
  try {
    const before = await checkRlsOnboarding(db);
    if (before.fullyEnforced) {
      console.log(`${ok} RLS is already fully enforced — nothing to do.`);
      return 0;
    }

    console.log(`${bold("Planned changes:")}`);
    console.log(
      `  - Create least-privilege role ${bold("aiperator_app")} (if missing)`,
    );
    console.log(
      `  - Create BYPASSRLS role ${bold("aiperator_operator")} (if missing)`,
    );
    console.log(
      `  - ENABLE + FORCE ROW LEVEL SECURITY with a tenant_isolation policy on:`,
    );
    for (const t of before.tables) {
      if (!t.exists) continue;
      console.log(`      ${dim("·")} ${t.table}`);
    }
    console.log(
      `\n${warn} ${bold("This modifies live database schema/roles.")} ` +
        `Neither role is granted a password here — set credentials out-of-band ` +
        `and point DATABASE_URL at aiperator_app / DATABASE_OPERATOR_URL at aiperator_operator afterwards.\n`,
    );

    if (!confirmed) {
      console.log(
        `${info} Dry run only (no changes applied). Re-run with ${bold("--confirm")} to apply.`,
      );
      return 1;
    }

    const result = await applyRlsOnboarding(db, { confirm: true });
    console.log(`${ok} Applied ${result.statementsApplied} statement(s).\n`);
    printRlsStatus(result.status);
    return result.status.fullyEnforced ? 0 : 1;
  } finally {
    await db.close();
  }
}

/**
 * doctor: local environment/config diagnostic.
 *
 * Reuses the SAME `loadConfig()` the server calls at startup — Bun
 * auto-loads `.env`/`.env.local` from the cwd, so this sees exactly what a
 * real `bun run src/index.ts` would see. Two layers of checks:
 *
 *   1. `loadConfig()` itself — Zod schema validation of every env var. A
 *      failure here means the server would refuse to boot; `loadConfig`
 *      already prints the offending variable names and exits 1, which this
 *      command surfaces unchanged (it IS the diagnostic).
 *   2. `checkProductionReadiness()` — the same secure-defaults gate the
 *      server runs after loading config, pretty-printed here instead of only
 *      appearing in server startup logs.
 *
 * With `--server <url>`, additionally probes the LIVE `/health/ready`
 * endpoint of a running instance (useful for "is my deployed instance
 * healthy", as opposed to "would a fresh boot with my current env succeed").
 */
async function cmdDoctor(args: ParsedArgs): Promise<number> {
  console.log(`${bold("aiperator doctor")} — environment & readiness check\n`);

  let exitCode = 0;

  // 1. Config loading (Zod schema validation). loadConfig() exits(1) itself
  // on failure with the invalid/missing variable names already printed to
  // stderr — nothing more to add here, just let it happen and report success
  // when it doesn't.
  const { loadConfig, checkProductionReadiness } = await import(
    "../src/config/index.js"
  );
  console.log(`${info} Loading configuration from environment…`);
  const config = loadConfig();
  console.log(`${ok} Configuration is structurally valid.\n`);

  // 2. Production-readiness gate (secure-defaults check).
  console.log(`${bold("Readiness checks")} (APP_ENV=${config.appEnv})\n`);
  const { fatal, warnings } = checkProductionReadiness(config);

  if (fatal.length === 0 && warnings.length === 0) {
    console.log(`${ok} No issues found.`);
  } else {
    for (const msg of fatal) {
      console.log(`  ${fail} ${c.red}FATAL${c.reset}  ${msg}`);
    }
    for (const msg of warnings) {
      console.log(`  ${warn} ${c.yellow}WARN${c.reset}   ${msg}`);
    }
  }
  if (fatal.length > 0) exitCode = 1;

  console.log(
    `\n${dim("────────────────────────")}\n${bold(`${fatal.length} fatal`)}, ${bold(`${warnings.length} warning(s)`)}`,
  );

  // 3. Optional live probe of a running instance.
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes("--server")) {
    const healthUrl = `${args.server}/health/ready`;
    console.log(`\n${info} Probing live instance at ${healthUrl} …`);
    try {
      const resp = await fetch(healthUrl);
      const body = (await resp.json().catch(() => ({}))) as {
        status?: string;
        checks?: Record<string, { status?: string; reason?: string }>;
      };
      const icon = resp.ok ? ok : fail;
      console.log(`  ${icon} HTTP ${resp.status} — status: ${body.status ?? "unknown"}`);
      for (const [name, check] of Object.entries(body.checks ?? {})) {
        const checkIcon = check.status === "ok" || check.status === "unconfigured" ? ok : warn;
        console.log(
          `    ${checkIcon} ${name}: ${check.status}${check.reason ? ` — ${check.reason}` : ""}`,
        );
      }
      if (!resp.ok) exitCode = 1;
    } catch (err) {
      console.log(`  ${fail} Could not reach ${healthUrl}: ${err instanceof Error ? err.message : String(err)}`);
      exitCode = 1;
    }
  } else {
    console.log(
      `\n${dim(`(pass --server <url> to also probe a running instance's /health/ready)`)}`,
    );
  }

  return exitCode;
}

/**
 * posture: report which governance controls are active.
 *
 * Without `--server` the report is built locally from the current environment
 * (config loading works like `doctor`; the compliance policy is read from
 * FLOWS_DIR). With `--server` the live report of a running instance is fetched
 * from `GET /monitoring/posture`. Exit code 1 when at least one check fails.
 */
async function cmdPosture(args: ParsedArgs): Promise<number> {
  const { buildPostureReport, formatPostureReportAsTable } = await import(
    "../src/compliance/posture.js"
  );
  type PostureReportLike = Parameters<typeof formatPostureReportAsTable>[0];

  let report: PostureReportLike;
  const rawArgv = process.argv.slice(2);

  if (rawArgv.includes("--server")) {
    const url = `${args.server}/monitoring/posture`;
    const headers: Record<string, string> = {};
    if (args.token) headers.Authorization = `Bearer ${args.token}`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers });
    } catch (err) {
      console.error(`${fail} Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      console.error(
        `${fail} ${url} responded HTTP ${resp.status}${body.error?.message ? `: ${body.error.message}` : ""}`,
      );
      return 1;
    }
    try {
      report = (await resp.json()) as PostureReportLike;
    } catch (err) {
      console.error(`${fail} ${url} did not return a posture report: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (!Array.isArray(report.checks)) {
      console.error(`${fail} ${url} returned a malformed posture report (missing checks).`);
      return 1;
    }
  } else {
    // Local mode: configuration facts only. Flow files are not loaded here,
    // so flow-load failures cannot be known and are reported as zero.
    const { loadConfig } = await import("../src/config/index.js");
    const config = loadConfig();
    const { createCompliancePolicyLoader } = await import(
      "../src/compliance/policy-loader.js"
    );
    const compliancePolicyLoaded = createCompliancePolicyLoader(config.flowsDir).hasPolicy;
    report = buildPostureReport(config, { compliancePolicyLoaded, flowLoadFailures: 0 });
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${bold("aiperator posture")} — active governance controls\n`);
    console.log(formatPostureReportAsTable(report));
    if (!rawArgv.includes("--server")) {
      console.log(
        `\n${dim("(local mode reflects the current configuration; pass --server <url> for a running instance's live report)")}`,
      );
    }
  }
  return report.summary.fail > 0 ? 1 : 0;
}

/** test: send a message to a flow and stream the response. */
async function cmdTest(args: ParsedArgs): Promise<number> {
  const [flowId] = args.positional;
  if (!flowId) {
    console.error(`${fail} Usage: aiperator test <flowId> [--message "text"] [--server <url>] [--token <jwt>]`);
    return 1;
  }
  if (!args.token) {
    console.error(`${fail} --token is required for test (or set AIPERATOR_TOKEN)`);
    return 1;
  }

  // Parse --message from args
  const rawArgv = process.argv.slice(2);
  const msgIdx = rawArgv.indexOf("--message");
  const message = msgIdx !== -1 && msgIdx + 1 < rawArgv.length
    ? (rawArgv[msgIdx + 1] ?? "Hello! What can you do?")
    : "Hello! What can you do?";

  const url = `${args.server}/v1/chat/completions`;
  console.log(`${info} Testing flow ${bold(flowId)} on ${url}`);
  console.log(`${dim("User:")} ${message}\n${dim("Assistant:")} `);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({
      model: flowId,
      messages: [{ role: "user", content: message }],
      stream: true,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error(`\n${fail} HTTP ${resp.status}: ${errText}`);
    return 1;
  }

  if (!resp.body) {
    console.error(`\n${fail} No response body`);
    return 1;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = parsed.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          process.stdout.write(delta);
          fullText += delta;
        }
      } catch { /* skip non-JSON SSE lines */ }
    }
  }

  process.stdout.write("\n");

  if (args.json) {
    console.log(JSON.stringify({ flowId, message, response: fullText }));
  } else {
    console.log(`\n${ok} Flow responded successfully (${fullText.length} chars)`);
  }
  return 0;
}

/**
 * Load a JWKS from an http(s) URL or a local file and pick the Ed25519
 * verification key: the one whose `kid` matches `kid`, or — when no `kid` is
 * given — the bundle's `kid`, or (if the bundle carries none either) a
 * single-key JWKS. Throws with a human-readable message on any input problem.
 */
async function loadJwksEd25519Key(
  source: string,
  kid: string | undefined,
): Promise<{ publicKeyRaw: Uint8Array; kid: string | undefined }> {
  let body: string;
  if (/^https?:\/\//i.test(source)) {
    let resp: Response;
    try {
      resp = await fetch(source, { headers: { Accept: "application/json" } });
    } catch (err) {
      throw new Error(`could not fetch JWKS from ${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`JWKS fetch failed: HTTP ${resp.status} from ${source}`);
    }
    body = await resp.text();
  } else {
    if (!fs.existsSync(source)) {
      throw new Error(`JWKS file not found: ${source}`);
    }
    body = fs.readFileSync(source, "utf-8");
  }

  let keys: JsonWebKey[];
  try {
    const parsed = JSON.parse(body) as { keys?: unknown };
    if (!parsed || !Array.isArray(parsed.keys)) {
      throw new Error('expected a JSON object with a "keys" array');
    }
    keys = parsed.keys as JsonWebKey[];
  } catch (err) {
    throw new Error(`failed to parse JWKS ${source}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const okp = keys.filter((k) => k.kty === "OKP" && k.crv === "Ed25519");
  if (okp.length === 0) {
    throw new Error(`JWKS ${source} contains no OKP/Ed25519 keys`);
  }
  let selected: JsonWebKey | undefined;
  if (kid !== undefined) {
    selected = okp.find((k) => k.kid === kid);
    if (!selected) {
      throw new Error(`no key with kid "${kid}" in JWKS ${source} (has: ${okp.map((k) => k.kid ?? "?").join(", ")})`);
    }
  } else if (okp.length === 1) {
    selected = okp[0];
  } else {
    throw new Error(
      `JWKS ${source} has ${okp.length} Ed25519 keys — select one with --kid (${okp.map((k) => k.kid ?? "?").join(", ")})`,
    );
  }

  const { jwkToEd25519RawKey } = await import("@atf/security-kit");
  try {
    return { publicKeyRaw: jwkToEd25519RawKey(selected), kid: selected.kid };
  } catch (err) {
    throw new Error(`invalid Ed25519 JWK in ${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * verify-bundle: offline signature/hash verification of a Verifiable
 * Evidence Bundle (see `src/observability/evidence-bundle.ts`).
 *
 * Two verification modes (ADR 0030):
 *
 *  - `--jwks <url|file> [--kid <kid>]` — Ed25519 bundles: the public key comes
 *    from the issuing server's `/.well-known/atf-evidence-jwks.json` (or a
 *    saved copy of it). No shared secret is involved, so an auditor, customer
 *    or regulator can verify independently.
 *  - `--secret <s>` — legacy HMAC-SHA256 bundles: requires the shared signing
 *    secret (`EVIDENCE_BUNDLE_SECRET`, falling back to `AUDIT_ANCHOR_SECRET`
 *    on the server side). Kept so pre-existing bundles stay verifiable.
 *
 * The bundle's own `algorithm` field decides which key material applies;
 * the wrong kind fails verification rather than being silently accepted.
 */
async function cmdVerifyBundle(args: ParsedArgs): Promise<number> {
  const [file] = args.positional;
  if (!file) {
    console.error(
      `${fail} Usage: aiperator verify-bundle <bundle.json> --jwks <url|file> [--kid <kid>]  (Ed25519)\n` +
        `       or: aiperator verify-bundle <bundle.json> --secret <secret>                (legacy HMAC)`,
    );
    return 1;
  }

  if (!fs.existsSync(file)) {
    console.error(`${fail} File not found: ${file}`);
    return 1;
  }

  let signed: import("../src/observability/evidence-bundle.js").SignedEvidenceBundle;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    signed = JSON.parse(
      raw,
    ) as import("../src/observability/evidence-bundle.js").SignedEvidenceBundle;
  } catch (err) {
    console.error(
      `${fail} Failed to parse ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (
    !signed ||
    typeof signed !== "object" ||
    !signed.bundle ||
    !signed.contentHash ||
    !signed.signature
  ) {
    console.error(
      `${fail} ${file} does not look like a signed evidence bundle (missing bundle/contentHash/signature)`,
    );
    return 1;
  }

  // Resolve the verifier: JWKS (asymmetric) wins when given; otherwise fall
  // back to the legacy shared-secret path.
  let verifier: string | Uint8Array;
  let verifierLabel: string;
  if (args.jwks !== undefined && args.jwks !== "") {
    try {
      const key = await loadJwksEd25519Key(args.jwks, args.kid ?? signed.kid);
      verifier = key.publicKeyRaw;
      verifierLabel = `Ed25519 key ${key.kid ?? "?"} from ${args.jwks}`;
    } catch (err) {
      console.error(
        `${fail} ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  } else {
    const rawArgv = process.argv.slice(2);
    const secretIdx = rawArgv.indexOf("--secret");
    const secret =
      (secretIdx !== -1 ? rawArgv[secretIdx + 1] : undefined) ??
      process.env["EVIDENCE_BUNDLE_SECRET"] ??
      process.env["AUDIT_ANCHOR_SECRET"];
    if (!secret) {
      console.error(
        `${fail} --jwks <url|file> (Ed25519 bundles) or --secret is required (or set EVIDENCE_BUNDLE_SECRET / AUDIT_ANCHOR_SECRET)`,
      );
      return 1;
    }
    verifier = secret;
    verifierLabel = "shared HMAC secret";
  }

  const { verifyEvidenceBundle } =
    await import("../src/observability/evidence-bundle.js");
  const result = verifyEvidenceBundle(signed, verifier);

  if (args.json) {
    console.log(
      JSON.stringify(
        { file, executionId: signed.bundle.executionId, ...result },
        null,
        2,
      ),
    );
    return result.valid ? 0 : 1;
  }

  console.log(`${bold("Evidence bundle verification")}  ${dim(file)}\n`);
  console.log(`  execution: ${signed.bundle.executionId}`);
  console.log(`  generated: ${signed.bundle.generatedAt}`);
  console.log(
    `  algorithm: ${signed.algorithm}${signed.kid !== undefined ? ` (kid ${signed.kid})` : ""}`,
  );
  console.log(`  verifier:  ${verifierLabel}\n`);

  if (result.valid) {
    console.log(
      `${ok} Signature and content hash are valid — this bundle has not been altered since it was signed.`,
    );
    return 0;
  }
  const reasonText =
    result.reason === "content_hash_mismatch"
      ? "the bundle content does not match its recorded content hash (content was modified)"
      : signed.algorithm === "ed25519"
        ? "the Ed25519 signature does not match the recorded content hash (wrong key, or signature was forged/tampered)"
        : "the signature does not match the recorded content hash (wrong secret, or signature was forged/tampered)";
  console.error(`${fail} Verification FAILED: ${reasonText}`);
  return 1;
}

// ---------------------------------------------------------------------------
// flows release
// ---------------------------------------------------------------------------

/** Reads `metadata.version` from a raw flow object, if present. */
function flowMetadataVersion(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const metadata = (raw as Record<string, unknown>).metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const version = (metadata as Record<string, unknown>).version;
  return typeof version === "string" ? version : undefined;
}

/**
 * `flows release <flowId>`: run the flow's bench file against a running
 * server as a release gate (E6). Loads and validates the bench file, checks
 * the SemVer version gate against `--base`, executes the cases with
 * concurrency 2, evaluates the thresholds and optionally compares against a
 * previous release receipt (`--baseline`).
 */
async function cmdFlowsRelease(args: ParsedArgs): Promise<number> {
  const flowId = args.positional[0];
  if (!flowId) {
    console.error(`${fail} flows release requires a flow id: flows release <flowId> --flows-dir <dir>`);
    return 1;
  }
  const flowsDir = args.flowsDir;
  if (!flowsDir) {
    console.error(`${fail} flows release requires --flows-dir <dir>`);
    return 1;
  }

  const flowPath = resolveConfigFile(flowsDir, flowId);
  if (flowPath === null) {
    console.error(`${fail} Flow file not found for ${flowId} in ${flowsDir}`);
    return 1;
  }
  const benchPath = resolveConfigFile(path.join(flowsDir, BENCH_DIR_NAME), `${flowId}${BENCH_FILE_SUFFIX}`);
  if (benchPath === null) {
    console.error(`${fail} Bench file not found: ${path.join(flowsDir, BENCH_DIR_NAME, `${flowId}${BENCH_FILE_SUFFIX}.yaml`)}`);
    return 1;
  }

  // 1. Bench laden/validieren.
  let bench: BenchFile;
  try {
    bench = loadBenchFile(benchPath);
  } catch (err) {
    console.error(`${fail} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (bench.flow !== flowId) {
    console.error(`${fail} Bench file ${benchPath} is for flow ${JSON.stringify(bench.flow)}, not ${JSON.stringify(flowId)}`);
    return 1;
  }

  // 2. Kopf-Version und -Digest des Flows.
  const headRaw = loadFlowFile(flowPath);
  const headVersion = flowMetadataVersion(headRaw);
  const headDigest = computeFlowDigest(headRaw as FlowDefinition);

  // 3. Version-Gate gegen --base (git show <base>:<pfad>).
  let baseVersion: string | undefined;
  if (args.base !== undefined && args.base !== "") {
    const gitCwd = path.dirname(path.resolve(flowPath));
    const rel = path.relative(gitCwd, path.resolve(flowPath)) || path.basename(flowPath);
    const shown = Bun.spawnSync({
      cmd: ["git", "show", `${args.base}:${rel}`],
      cwd: gitCwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (shown.exitCode !== 0) {
      console.error(`${fail} git show ${args.base}:${rel} failed — is the flow file committed at that ref?`);
      return 1;
    }
    let baseRaw: unknown;
    try {
      const text = shown.stdout.toString();
      baseRaw = /\.json$/i.test(flowPath) ? JSON.parse(text) : parseYaml(text);
    } catch (err) {
      console.error(`${fail} Failed to parse base flow: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    baseVersion = flowMetadataVersion(baseRaw);
    const baseDigest = computeFlowDigest(baseRaw as FlowDefinition);
    const problem = versionGateProblem({
      digestChanged: baseDigest !== headDigest,
      baseVersion,
      headVersion,
    });
    if (problem !== undefined) {
      console.error(`${fail} Version gate: ${problem}`);
      return 1;
    }
    if (!args.json) console.log(`${ok} Version gate passed (${baseVersion ?? "?"} → ${headVersion ?? "?"}).`);
  }

  // 4. Fälle gegen den Server ausführen (Concurrency 2).
  // Plain fetch: the release gate targets an operator-chosen server, the
  // same way `posture` does (the egress guard would block local testing).
  const executor = createHttpExecutor(args.server, args.token !== "" ? args.token : undefined, fetch, false);
  if (!args.json) {
    console.log(`${info} Running ${bench.cases.length} bench case(s) against ${args.server} (concurrency 2)…`);
  }
  let run: Awaited<ReturnType<typeof runBenchCases>>;
  try {
    run = await runBenchCases(bench, executor, 2);
  } catch (err) {
    console.error(`${fail} Bench run failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const stats = aggregateStats(run.report, run.stats);

  if (!args.json) {
    console.log(`\n${bold("Flow release bench")}  ${dim(flowId)}\n`);
    for (const cs of run.stats) {
      console.log(`  ${cs.passed ? ok : fail} ${cs.id} ${dim(`${Math.round(cs.latencyMs)}ms${cs.tokens !== undefined ? ` · ${cs.tokens} tokens` : ""}`)}`);
    }
    console.log(
      `\n  pass rate: ${(stats.passRate * 100).toFixed(1)}% (${stats.passed}/${stats.cases})` +
      `  p50 latency: ${Math.round(stats.latencyMsP50)}ms` +
      `  p50 tokens: ${Math.round(stats.tokensP50)}`,
    );
  }

  // 5. Schwellen prüfen.
  const failures: string[] = [];
  for (const message of evaluateThresholds(stats, bench.thresholds)) {
    failures.push(`Threshold: ${message}`);
    console.error(`${fail} Threshold: ${message}`);
  }

  // Baseline-Vergleich (passRate darf nicht sinken).
  if (args.baseline !== undefined && args.baseline !== "") {
    let baseline: ReleaseBaseline;
    try {
      baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8")) as ReleaseBaseline;
    } catch (err) {
      console.error(`${fail} Failed to read baseline receipt ${args.baseline}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const comparison = compareBaseline(baseline, stats);
    if (!args.json) for (const delta of comparison.deltas) console.log(`  ${dim(delta)}`);
    for (const message of comparison.failures) {
      failures.push(`Baseline: ${message}`);
      console.error(`${fail} Baseline: ${message}`);
    }
  }

  if (failures.length > 0) {
    if (args.json) {
      console.log(JSON.stringify({ flowId, flowVersion: headVersion, flowDigest: headDigest, ...stats, ok: false, failures }, null, 2));
    }
    return 1;
  }

  // 6. Mit --signing-key-file: signiertes Release-Receipt schreiben (T-353),
  //    sonst nur Bericht. Nur ein passierter Gate erzeugt ein Receipt.
  let receiptOut: string | undefined;
  if (args.signingKeyFile !== undefined && args.signingKeyFile !== "") {
    if (headVersion === undefined || headVersion === "") {
      console.error(`${fail} Cannot sign a release receipt: the flow file has no metadata.version`);
      return 1;
    }
    let key: Ed25519EvidenceKey | undefined;
    try {
      key = parseEvidenceSigningKey(fs.readFileSync(args.signingKeyFile, "utf8").trim());
    } catch (err) {
      console.error(`${fail} Failed to read signing key ${args.signingKeyFile}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (key === undefined) {
      console.error(`${fail} Signing key file ${args.signingKeyFile} is empty`);
      return 1;
    }
    const receipt = signReleaseReceipt(
      buildReleaseReceipt({
        flowId,
        flowVersion: headVersion,
        flowDigest: headDigest,
        ...(args.base !== undefined && args.base !== "" ? { baseRef: args.base } : {}),
        ...(baseVersion !== undefined ? { baseFlowVersion: baseVersion } : {}),
        benchDigest: computeBenchDigest(bench),
        results: stats,
        thresholds: bench.thresholds,
        createdAt: new Date().toISOString(),
      }),
      key,
    );
    receiptOut =
      args.out !== undefined && args.out !== ""
        ? args.out
        : path.join(process.cwd(), `${flowId}.release-receipt.json`);
    try {
      fs.writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    } catch (err) {
      console.error(`${fail} Failed to write release receipt ${receiptOut}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ flowId, flowVersion: headVersion, flowDigest: headDigest, ...stats, ok: true, failures: [], ...(receiptOut !== undefined ? { receiptPath: receiptOut } : {}) }, null, 2));
  } else {
    console.log(`${ok} Release gate passed.`);
    if (receiptOut !== undefined) console.log(`${ok} Release receipt written to ${receiptOut}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
${bold("aiperator")} — CLI for the AI Agent Orchestration Platform

${bold("Usage:")}
  bun run scripts/cli.ts <command> [options]

${bold("Commands:")}
  ${bold("validate")} <file|dir> [--require-version]  Validate flow YAML/JSON files offline (--require-version: metadata.version must be x.y.z)
  ${bold("diff")} <fileA> <fileB>            Show structural diff between two flows
  ${bold("deploy")} <file>                   Validate + publish a flow to a server
  ${bold("test")} <flowId>                   Send a test message to a flow
  ${bold("doctor")} [--server <url>]         Check local env/config for startup issues (optionally probe a live instance)
  ${bold("posture")} [--server <url>]        Show which governance controls are active (ok/warn/fail)
  ${bold("rls-status")}                      Report Row-Level Security enforcement per tenant table
  ${bold("rls-setup")} [--confirm]            Onboard Row-Level Security (dry-run unless --confirm)
  ${bold("verify-bundle")} <bundle.json>      Verify a signed Evidence Bundle offline (--jwks Ed25519 / --secret legacy HMAC)
  ${bold("flows release")} <flowId>          Run a flow's bench file against a server as a release gate (--flows-dir, --base, --baseline)

${bold("Options:")}
  --server <url>                    Backend base URL (default: AIPERATOR_SERVER env or http://localhost:3000)
  --token <jwt>                     Auth token (default: AIPERATOR_TOKEN env)
  --message <text>                  Message to send (test command, default: "Hello!")
  --database-url <url>              Postgres connection string (rls-* commands; default: DATABASE_URL env)
  --confirm                         Apply changes (rls-setup command; otherwise a dry-run)
  --jwks <url|file>                 JWKS with the Ed25519 evidence key (verify-bundle; e.g. https://host/.well-known/atf-evidence-jwks.json)
  --kid <kid>                       Key id to select from the JWKS (verify-bundle; default: the bundle's kid)
  --secret <value>                  Legacy HMAC signing secret (verify-bundle; default: EVIDENCE_BUNDLE_SECRET/AUDIT_ANCHOR_SECRET env)
  --flows-dir <dir>                 Directory with the flow and its bench/ file (flows release)
  --base <git-ref>                  Fail when the flow changed but metadata.version was not raised vs this ref (flows release)
  --baseline <receipt.json>         Previous release receipt; its pass rate must not be undercut (flows release)
  --signing-key-file <file>         Ed25519 key file used to sign the release receipt (flows release)
  --out <file>                      Path to write the release receipt to (flows release)
  --json                            Output raw JSON
  --help, -h                        Show this help

${bold("Examples:")}
  bun run scripts/cli.ts validate flows/
  bun run scripts/cli.ts validate flows/my-flow.yaml
  bun run scripts/cli.ts diff flows/v1.yaml flows/v2.yaml
  bun run scripts/cli.ts deploy flows/my-flow.yaml --token sk-...
  bun run scripts/cli.ts test my-flow --message "What is the capital of France?"
  AIPERATOR_TOKEN=sk-... bun run scripts/cli.ts test my-flow --json
  bun run scripts/cli.ts doctor
  bun run scripts/cli.ts doctor --server https://aiperator.example.com
  bun run scripts/cli.ts posture
  bun run scripts/cli.ts posture --server https://aiperator.example.com --token sk-... --json
  DATABASE_URL=postgres://... bun run scripts/cli.ts rls-status
  DATABASE_URL=postgres://... bun run scripts/cli.ts rls-setup --confirm
  bun run scripts/cli.ts verify-bundle bundle.json --jwks https://aiperator.example.com/.well-known/atf-evidence-jwks.json
  bun run scripts/cli.ts verify-bundle bundle.json --jwks jwks.json --kid abc123
  bun run scripts/cli.ts verify-bundle bundle.json --secret my-signing-secret
  bun run scripts/cli.ts flows release my-flow --flows-dir flows --server http://localhost:3000
  bun run scripts/cli.ts flows release my-flow --flows-dir flows --base origin/main --baseline release-receipt.json
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || !args.command) {
    showHelp();
    process.exit(0);
  }

  let exitCode = 0;
  switch (args.command) {
    case "validate":
      exitCode = await cmdValidate(args);
      break;
    case "diff":
      exitCode = await cmdDiff(args);
      break;
    case "deploy":
      exitCode = await cmdDeploy(args);
      break;
    case "test":
      exitCode = await cmdTest(args);
      break;
    case "doctor":
      exitCode = await cmdDoctor(args);
      break;
    case "posture":
      exitCode = await cmdPosture(args);
      break;
    case "rls-status":
      exitCode = await cmdRlsStatus(args);
      break;
    case "rls-setup":
      exitCode = await cmdRlsSetup(args);
      break;
    case "verify-bundle":
      exitCode = await cmdVerifyBundle(args);
      break;
    case "flows": {
      const sub = args.positional.shift();
      if (sub === "release") {
        exitCode = await cmdFlowsRelease(args);
      } else {
        console.error(`${fail} Unknown flows subcommand: ${sub ?? "(none)"} — expected "release"`);
        showHelp();
        exitCode = 1;
      }
      break;
    }
    default:
      console.error(`${fail} Unknown command: ${args.command}`);
      showHelp();
      exitCode = 1;
  }
  process.exit(exitCode);
}

// Only run the CLI when executed directly (`bun run scripts/cli.ts …`), not
// when imported by a test. Importing must not trigger `main()` / `process.exit`.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`${fail} Unhandled error:`, err);
    process.exit(1);
  });
}
