#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Writes the generated Runtime route-group reference into ARCHITECTURE.md
 * (between the BEGIN/END GENERATED markers), or checks it is current
 * (`--check`, CI). Req 14.3, Task 20.3.
 *
 * Usage (from the repository root):
 *   bun run route-reference        # write ARCHITECTURE.md
 *   bun run route-reference:check  # exit 1 when the table is stale
 *
 * The table is derived from the real router tree: the `app.route(...)` mounts
 * in `src/bootstrap/routes-*.ts` / `src/bootstrap/autopilot.ts`, plus every
 * `router.<method>("/path", ...)` registration inside the mounted factory
 * (following local sub-routers and `register*Routes(router, ...)` delegation).
 * A hand-maintained route list drifts the moment a router is added; this one
 * fails CI instead.
 *
 * The parser is deliberately line-oriented: the codebase registers routes as
 * single-line `router.get("/path", ...)` calls, so a full AST is not needed.
 * Comment and string content is stripped before brace tracking so prose like
 * `("…")` in a comment cannot shift the block stack.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dirname, "..", "..", "..");
const srcDir = path.join(root, "apps", "runtime", "src");
const architectureFile = path.join(root, "ARCHITECTURE.md");

const BEGIN = "<!-- BEGIN GENERATED: runtime route groups (bun run route-reference) -->";
const END = "<!-- END GENERATED: runtime route groups -->";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "all", "head", "options"] as const;
const METHOD_RE = new RegExp(
  `\\b([A-Za-z_$][\\w$]*)\\.(${HTTP_METHODS.join("|")})\\(\\s*"([^"]*)"`,
  "g",
);
const NEW_HONO_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Hono\b/;
const SUB_MOUNT_RE = /\b([A-Za-z_$][\w$]*)\.route\(\s*"([^"]*)",\s*([A-Za-z_$][\w$]*)\s*[(,]/g;
const REGISTER_CALL_RE = /\b(register[A-Za-z_$][\w$]*)\(\s*([A-Za-z_$][\w$]*)\s*,/g;
const FACTORY_DEF_RE = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*Router)\b/gm;

/** Strip line comments and double-quoted strings so brace counting is safe. */
function stripForBraces(line: string): string {
  return line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function readSource(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** All TypeScript sources under src/, excluding tests. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const allSources = sources(srcDir);

/** Map of `createXRouter` factory name -> defining file. */
const factoryFiles = new Map<string, string>();
for (const file of allSources) {
  const text = readSource(file);
  for (const m of text.matchAll(FACTORY_DEF_RE)) {
    factoryFiles.set(m[1] as string, file);
  }
}

interface RouteEntry {
  method: string;
  path: string;
}

/**
 * Collect the routes registered on the Hono instance(s) created in `file`.
 * `visited` guards against cycles through delegation. Local sub-routers
 * (`x.route(prefix, local)`) and `register*(router, ...)` delegation into
 * sibling modules are followed; routes are returned relative to the factory's
 * own mount point.
 */
function collectRoutes(file: string, visited: Set<string> = new Set()): RouteEntry[] {
  if (visited.has(file)) return [];
  visited.add(file);
  const text = readSource(file);

  // Router variables declared in this file (e.g. `const router = new Hono()`).
  const routerVars = new Set<string>();
  for (const line of text.split("\n")) {
    const m = NEW_HONO_RE.exec(line);
    if (m) routerVars.add(m[1] as string);
  }
  if (routerVars.size === 0) return [];

  const routes: RouteEntry[] = [];
  const delegations: Array<{ fn: string; file: string }> = [];
  const subMounts: Array<{ parent: string; prefix: string; child: string }> = [];

  for (const line of text.split("\n")) {
    const code = line.replace(/\/\/.*$/, "");
    for (const m of code.matchAll(METHOD_RE)) {
      const [, varName, method, routePath] = m;
      if (varName && routerVars.has(varName)) {
        routes.push({ method: method!.toUpperCase(), path: routePath! });
      }
    }
    for (const m of code.matchAll(SUB_MOUNT_RE)) {
      const [, parent, prefix, child] = m;
      if (parent && routerVars.has(parent)) subMounts.push({ parent, prefix, child: child! });
    }
    for (const m of code.matchAll(REGISTER_CALL_RE)) {
      const [, fn, arg] = m;
      if (arg && routerVars.has(arg)) delegations.push({ fn: fn!, file });
    }
  }

  // Sub-mounted local routers inherit the mount prefix.
  for (const sub of subMounts) {
    if (!routerVars.has(sub.child)) continue;
    const childRoutes = collectLocalRoutesFor(text, sub.child, visited);
    for (const r of childRoutes) {
      routes.push({ method: r.method, path: joinMount(sub.prefix, r.path) });
    }
  }

  // register*(router, ...) delegation into sibling modules.
  for (const d of delegations) {
    const target = findRegisterFunctionFile(d.fn);
    if (!target) continue;
    for (const r of collectRoutes(target, visited)) routes.push(r);
  }

  return routes;
}

/** Routes registered on one specific local Hono variable within `text`. */
function collectLocalRoutesFor(
  text: string,
  varName: string,
  _visited: Set<string>,
): RouteEntry[] {
  const routes: RouteEntry[] = [];
  for (const line of text.split("\n")) {
    const code = line.replace(/\/\/.*$/, "");
    const re = new RegExp(`\\b${varName}\\.(${HTTP_METHODS.join("|")})\\(\\s*"([^"]*)"`, "g");
    for (const m of code.matchAll(re)) {
      routes.push({ method: m[1]!.toUpperCase(), path: m[2]! });
    }
  }
  return routes;
}

const registerFileCache = new Map<string, string | undefined>();
function findRegisterFunctionFile(fn: string): string | undefined {
  if (registerFileCache.has(fn)) return registerFileCache.get(fn);
  let found: string | undefined;
  for (const file of allSources) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`).test(readSource(file))) {
      found = file;
      break;
    }
  }
  registerFileCache.set(fn, found);
  return found;
}

function joinMount(prefix: string, routePath: string): string {
  if (prefix === "/" || prefix === "") return routePath;
  return `${prefix.replace(/\/$/, "")}${routePath}`;
}

interface Mount {
  mountPath: string;
  factory: string;
  condition: string | null;
  file: string;
}

/**
 * Parse the bootstrap files for `app.route(...)` mounts and direct
 * `app.<method>("/path", ...)` registrations, tracking the enclosing `if`
 * condition with a brace-depth block stack.
 */
function parseBootstrapMounts(file: string): Mount[] {
  const text = readSource(file);
  const lines = text.split("\n");
  const mounts: Mount[] = [];
  const blockStack: Array<{ kind: "if" | "other"; cond: string | null; depth: number }> = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const code = stripForBraces(raw);

    // app.route("<path>", <factory>(...) — path/factory may sit on the next lines.
    const routeCall = /\bapp\.route\(/.test(raw.replace(/\/\/.*$/, ""));
    if (routeCall) {
      const window = lines.slice(i, i + 4).join(" ");
      const m = window.match(/app\.route\(\s*"([^"]*)",\s*([A-Za-z_$][\w$]*)/);
      if (m) {
        const cond = [...blockStack].reverse().find((b) => b.kind === "if")?.cond ?? null;
        mounts.push({
          mountPath: m[1]!,
          factory: m[2]!,
          condition: cond,
          file: path.relative(root, file),
        });
      }
    }
    // Direct app-level route registration (e.g. app.get("/monitoring/auth/config")).
    const direct = raw
      .replace(/\/\/.*$/, "")
      .match(new RegExp(`\\bapp\\.(${HTTP_METHODS.join("|")})\\(\\s*"([^"]*)"`));
    if (direct && /^(\s*)app\./.test(raw)) {
      const cond = [...blockStack].reverse().find((b) => b.kind === "if")?.cond ?? null;
      mounts.push({
        mountPath: "/",
        factory: `${direct[1]!.toUpperCase()} ${direct[2]}`,
        condition: cond,
        file: path.relative(root, file),
      });
    }

    // Block stack bookkeeping on the comment/string-stripped line.
    const ifStart = code.match(/\bif\s*\(/);
    let consumed = 0;
    if (ifStart) {
      // Collect a possibly multi-line if condition up to its `) {`.
      let cond = code.slice((ifStart.index as number) + 4);
      let j = i;
      let parens = countChar(cond, "(") - countChar(cond, ")");
      while (parens > 0 && j + 1 < lines.length) {
        j++;
        const next = stripForBraces(lines[j]!);
        cond += " " + next;
        parens += countChar(next, "(") - countChar(next, ")");
      }
      cond = cond.replace(/\)\s*\{?\s*$/, "").trim();
      blockStack.push({ kind: "if", cond: cond || null, depth });
      consumed = j - i;
    } else if (/\{\s*$/.test(code)) {
      blockStack.push({ kind: "other", cond: null, depth });
    }

    depth += countChar(code, "{") - countChar(code, "}");
    while (blockStack.length > 0 && depth <= blockStack[blockStack.length - 1]!.depth) {
      blockStack.pop();
    }
    if (consumed > 0) {
      i += consumed;
    }
  }
  return mounts;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// ── Build the table ──────────────────────────────────────────────────────────

const bootstrapFiles = [
  path.join(srcDir, "bootstrap", "routes-inference.ts"),
  path.join(srcDir, "bootstrap", "routes-management.ts"),
  path.join(srcDir, "bootstrap", "autopilot.ts"),
];

const mounts: Mount[] = bootstrapFiles.flatMap(parseBootstrapMounts);

interface Row {
  group: string;
  mount: string;
  enabled: string;
  routes: string;
}

function conditionNote(cond: string | null): string {
  if (cond === null) return "always";
  // Shorten the common `x !== undefined` / `config.y === true` shapes.
  return `\`${cond
    .replace(/ !== undefined/g, " is set")
    .replace(/ === true/g, "")
    .replace(/config\./g, "")}\``;
}

const rows: Row[] = [];
for (const mount of mounts) {
  if (mount.mountPath === "/" && /^[A-Z]+ \//.test(mount.factory)) {
    // Direct app-level route: the factory field already holds "GET /path".
    rows.push({
      group: "(direct)",
      mount: "/",
      enabled: conditionNote(mount.condition),
      routes: mount.factory,
    });
    continue;
  }
  const file = factoryFiles.get(mount.factory);
  let routeList: string;
  if (file) {
    const routes = collectRoutes(file);
    const seen = new Set<string>();
    const parts = routes
      .map((r) => `${r.method} \`${joinMount(mount.mountPath, r.path)}\``)
      .filter((p) => (seen.has(p) ? false : seen.add(p)));
    routeList =
      parts.length > 0 ? parts.join("<br/>") : "_no static routes (transport-only router)_";
  } else {
    // Local stub router (autopilot) or unknown factory.
    routeList = "_stub router (503 until configured)_";
  }
  rows.push({
    group: `\`${mount.factory}\``,
    mount: mount.mountPath === "/" ? "— (full paths)" : `\`${mount.mountPath}\``,
    enabled: conditionNote(mount.condition),
    routes: routeList,
  });
}

const table = [
  "| Router group | Mount | Enabled when | Endpoints |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.group} | ${r.mount} | ${r.enabled} | ${r.routes} |`),
].join("\n");

const section = [
  `Updated with \`bun run route-reference\` from the real router tree`,
  `(\`src/bootstrap/routes-inference.ts\`, \`routes-management.ts\`, \`autopilot.ts\`).`,
  `Conditional groups are mounted only when their bootstrap condition holds.`,
  ``,
  table,
].join("\n");

const replacement = `${BEGIN}\n${section}\n${END}`;

const existing = readSource(architectureFile);
const start = existing.indexOf(BEGIN);
const end = existing.indexOf(END);
if (start === -1 || end === -1) {
  console.error(
    `ARCHITECTURE.md is missing the GENERATED markers:\n  ${BEGIN}\n  ${END}\nAdd them around the route table under "### Runtime".`,
  );
  process.exit(1);
}
const updated = existing.slice(0, start) + replacement + existing.slice(end + END.length);

const check = process.argv.includes("--check");
if (check) {
  if (existing === updated) {
    console.log(`✓ Runtime route table in ARCHITECTURE.md is up to date (${rows.length} groups).`);
  } else {
    console.error("✗ Runtime route table in ARCHITECTURE.md is stale. Run `bun run route-reference` and commit the result.");
    process.exit(1);
  }
} else {
  fs.writeFileSync(architectureFile, updated, "utf8");
  console.log(`✓ Wrote runtime route table (${rows.length} groups) into ARCHITECTURE.md`);
}
