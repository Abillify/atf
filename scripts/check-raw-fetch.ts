// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Egress_Guard hygiene gate (Req 7.1/7.2).
 *
 *   bun run check:raw-fetch   # fail if a bare fetch(...) call appears in the runtime
 *
 * Every outbound HTTP call in the runtime must go through the Egress_Guard
 * (`ctx.egress.fetch` / `egressFetch` from `security/egress.ts`, or an
 * injected `fetchFn` seam that defaults to it). A bare global `fetch(` would
 * bypass SSRF protection (private/loopback/metadata blocking, DNS pinning,
 * redirect revalidation, size limits) entirely.
 *
 * The check flags `fetch(` occurrences that are NOT a member or identifier
 * call — `this.fetchFn(`, `egressFetch(`, `fetchJson(`, `deps.fetch(` and
 * `typeof fetch` are fine; a bare `fetch(url)` is not. Tests may stub the
 * global (they never ship), and `security/egress.ts` implements the guard
 * itself, so both are excluded.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const srcDir = join(root, "apps", "runtime", "src");

/** Directories/files that may legitimately touch the global fetch. */
const EXCLUDED_PATHS = [
  "apps/runtime/src/security/egress.ts",
  "apps/runtime/src/security/__tests__",
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

/**
 * Bare global fetch call: `fetch(` not preceded by an identifier character,
 * a dot (member access), or `)` (call result). `typeof fetch` and
 * declarations like `function fetch(` are filtered by the keyword check.
 */
const RAW_FETCH = /(^|[^A-Za-z0-9_.$])fetch\s*\(/g;
const KEYWORD_BEFORE = /\b(typeof|function|const|let|var|interface|type)\s*$/;

const violations: string[] = [];

for (const file of walk(srcDir)) {
  const rel = relative(root, file).split("\\").join("/");
  if (rel.includes("/__tests__/") || rel.endsWith(".test.ts")) continue;
  if (EXCLUDED_PATHS.includes(rel)) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    // Skip comment lines (line comments, JSDoc openers, and continuation
    // stars) so prose like "outbound fetch (...)" does not fail the gate.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      return;
    }
    const code = line.replace(/\/\/.*$/, "");
    for (const match of code.matchAll(RAW_FETCH)) {
      const prefix = match[1] ?? "";
      if (KEYWORD_BEFORE.test(prefix)) continue;
      violations.push(`${rel}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `check-raw-fetch: ${violations.length} bare fetch() call(s) outside the Egress_Guard:\n`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nRoute outbound HTTP through egressFetch (security/egress.ts) or an\n" +
      "injectable fetchFn seam defaulting to it — see Req 7.1/7.2.",
  );
  process.exit(1);
}

console.log("check-raw-fetch: OK — no bare fetch() outside the Egress_Guard.");
