// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Route catalog for the ATF Runtime, parsed from the real router tree.
 *
 * The same parser backs two consumers:
 *  - `scripts/generate-route-reference.ts` (ARCHITECTURE.md table, Req 14.3)
 *  - `src/openapi.ts` (the OpenAPI document served at /openapi.json, Req 14.5)
 *
 * Parsing the sources at request time is cheap (a few hundred KB of text) and
 * guarantees the documented surface can never drift from the mounted routes.
 * The parser is deliberately line-oriented: the codebase registers routes as
 * single-line `router.get("/path", ...)` calls, so a full AST is not needed.
 * Comment and string content is stripped before brace tracking so prose like
 * `("…")` in a comment cannot shift the block stack.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "all", "head", "options"] as const;
const NEW_HONO_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Hono\b/;
const SUB_MOUNT_RE = /\b([A-Za-z_$][\w$]*)\.route\(\s*"([^"]*)",\s*([A-Za-z_$][\w$]*)\s*[(,]/g;
const REGISTER_CALL_RE = /\b(register[A-Za-z_$][\w$]*)\(\s*([A-Za-z_$][\w$]*)\s*,/g;
const FACTORY_DEF_RE = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*Router)\b/gm;

/** Strip line comments and double-quoted strings so brace counting is safe. */
function stripForBraces(line: string): string {
  return line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** All TypeScript sources under `dir`, excluding tests and node_modules. */
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

export interface RouteEntry {
  method: string;
  path: string;
}

export interface Mount {
  mountPath: string;
  factory: string;
  condition: string | null;
  file: string;
  /** Set for direct `app.<method>("/path", ...)` registrations. */
  directRoute?: RouteEntry;
}

export interface RouteGroup {
  /** Factory name, e.g. `createChatRouter`; `(direct)` for app-level routes. */
  group: string;
  mount: string;
  condition: string | null;
  routes: RouteEntry[];
}

/**
 * Parse `app.route(...)` mounts and direct `app.<method>("/path", ...)`
 * registrations from a bootstrap file, tracking the enclosing `if` condition
 * with a brace-depth block stack.
 */
function parseBootstrapMounts(file: string): Mount[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const mounts: Mount[] = [];
  const blockStack: Array<{ kind: "if" | "other"; cond: string | null; depth: number }> = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const code = stripForBraces(raw);

    // app.route("<path>", <factory>(...) — path/factory may sit on the next lines.
    if (/\bapp\.route\(/.test(code)) {
      const window = lines.slice(i, i + 4).join(" ");
      const m = window.match(/app\.route\(\s*"([^"]*)",\s*([A-Za-z_$][\w$]*)/);
      if (m) {
        const cond = [...blockStack].reverse().find((b) => b.kind === "if")?.cond ?? null;
        mounts.push({ mountPath: m[1]!, factory: m[2]!, condition: cond, file });
      }
    }
    // Direct app-level route registration (e.g. app.get("/monitoring/auth/config")).
    // Matched against the raw line: stripForBraces() would blank the path.
    const direct = raw.match(
      new RegExp(`\\bapp\\.(${HTTP_METHODS.join("|")})\\(\\s*"([^"]*)"`),
    );
    if (direct && /^\s*app\./.test(code)) {
      const cond = [...blockStack].reverse().find((b) => b.kind === "if")?.cond ?? null;
      mounts.push({
        mountPath: "/",
        factory: `(direct)`,
        condition: cond,
        file,
        directRoute: { method: direct[1]!.toUpperCase(), path: direct[2]! },
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
    if (consumed > 0) i += consumed;
  }
  return mounts;
}

/** Routes registered on one specific local Hono variable within `text`. */
function collectLocalRoutesFor(text: string, varName: string): RouteEntry[] {
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

function joinMount(prefix: string, routePath: string): string {
  if (prefix === "/" || prefix === "") return routePath;
  return `${prefix.replace(/\/$/, "")}${routePath}`;
}

/**
 * Catalog of every Runtime route, derived from the bootstrap mounts and the
 * mounted factory sources. `srcRoot` is the runtime `src/` directory.
 */
export function buildRuntimeRouteCatalog(srcRoot: string): {
  groups: RouteGroup[];
} {
  const allSources = sources(srcRoot);
  const sourceTexts = new Map<string, string>();
  for (const f of allSources) sourceTexts.set(f, fs.readFileSync(f, "utf8"));

  const factoryFiles = new Map<string, string>();
  for (const [file, text] of sourceTexts) {
    for (const m of text.matchAll(FACTORY_DEF_RE)) {
      factoryFiles.set(m[1] as string, file);
    }
  }

  const registerFileCache = new Map<string, string | undefined>();
  function findRegisterFunctionFile(fn: string): string | undefined {
    if (registerFileCache.has(fn)) return registerFileCache.get(fn);
    let found: string | undefined;
    for (const [file, text] of sourceTexts) {
      if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`).test(text)) {
        found = file;
        break;
      }
    }
    registerFileCache.set(fn, found);
    return found;
  }

  /**
   * Collect routes registered on the Hono instance(s) created in `file`.
   * Local sub-routers (`x.route(prefix, local)`) and `register*(router, ...)`
   * delegation into sibling modules are followed; routes are returned relative
   * to the factory's own mount point.
   */
  function collectRoutes(file: string, visited: Set<string>): RouteEntry[] {
    if (visited.has(file)) return [];
    visited.add(file);
    const text = sourceTexts.get(file) ?? "";

    const routerVars = new Set<string>();
    for (const line of text.split("\n")) {
      const m = NEW_HONO_RE.exec(line);
      if (m) routerVars.add(m[1] as string);
    }
    if (routerVars.size === 0) return [];

    const routes: RouteEntry[] = [];
    const delegations: string[] = [];
    const subMounts: Array<{ parent: string; prefix: string; child: string }> = [];

    for (const line of text.split("\n")) {
      const code = line.replace(/\/\/.*$/, "");
      for (const m of code.matchAll(
        new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.(${HTTP_METHODS.join("|")})\\(\\s*"([^"]*)"`, "g"),
      )) {
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
        if (arg && routerVars.has(arg)) delegations.push(fn!);
      }
    }

    for (const sub of subMounts) {
      if (!routerVars.has(sub.child)) continue;
      for (const r of collectLocalRoutesFor(text, sub.child)) {
        routes.push({ method: r.method, path: joinMount(sub.prefix, r.path) });
      }
    }
    for (const fn of delegations) {
      const target = findRegisterFunctionFile(fn);
      if (!target) continue;
      for (const r of collectRoutes(target, visited)) routes.push(r);
    }
    return routes;
  }

  const bootstrapFiles = [
    path.join(srcRoot, "bootstrap", "routes-inference.ts"),
    path.join(srcRoot, "bootstrap", "routes-management.ts"),
    path.join(srcRoot, "bootstrap", "autopilot.ts"),
  ].filter((f) => fs.existsSync(f));

  const mounts = bootstrapFiles.flatMap(parseBootstrapMounts);

  const groups: RouteGroup[] = [];
  for (const mount of mounts) {
    const directRoute = mount.directRoute;
    if (directRoute) {
      groups.push({
        group: "(direct)",
        mount: "/",
        condition: mount.condition,
        routes: [directRoute],
      });
      continue;
    }
    const file = factoryFiles.get(mount.factory);
    let routes: RouteEntry[];
    if (file) {
      routes = collectRoutes(file, new Set());
    } else {
      // Local stub router (autopilot's 503 stub) — matches everything.
      routes = [{ method: "ALL", path: "/*" }];
    }
    const seen = new Set<string>();
    groups.push({
      group: mount.factory,
      mount: mount.mountPath,
      condition: mount.condition,
      routes: routes
        .map((r) => ({ method: r.method, path: joinMount(mount.mountPath, r.path) }))
        .filter((r) => {
          const key = `${r.method} ${r.path}`;
          return seen.has(key) ? false : seen.add(key);
        }),
    });
  }
  return { groups };
}
