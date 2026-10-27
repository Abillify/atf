// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Guard against `$n::jsonb` in the Runtime's SQL.
 *
 * The Runtime talks to Postgres through Bun's SQL client, which binds a
 * JavaScript string cast as `$n::jsonb` as a JSON *string scalar*. A value
 * written with `JSON.stringify(...)` then lands as `"{…}"` and every JSON
 * operator on the column (`->>`, `@>`, `?`, `||`) matches nothing. Writers use
 * `$n::text::jsonb` instead (see `apps/runtime/src/db/json-column.ts`).
 *
 * A bare `$n::jsonb` is allowed only when the line, or one of the five lines
 * above it, carries `jsonb-cast-ok:` with a reason (for example an object
 * parameter, which Bun encodes correctly).
 *
 * Usage: bun run scripts/check-jsonb-casts.ts
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIR = join(ROOT, "apps/runtime/src");
const CAST = /\$\d+::jsonb\b/;
const MARKER = "jsonb-cast-ok:";
const LOOKBACK = 5;

export interface Finding {
  file: string;
  line: number;
  text: string;
}

/** Bare `$n::jsonb` casts in `source` that carry no `jsonb-cast-ok:` marker nearby. */
export function findUnmarkedCasts(file: string, source: string): Finding[] {
  const lines = source.split("\n");
  const findings: Finding[] = [];
  lines.forEach((text, index) => {
    if (!CAST.test(text)) return;
    // Prose about the pattern (comments) is not SQL.
    const trimmed = text.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    const window = lines.slice(Math.max(0, index - LOOKBACK), index + 1);
    if (window.some((l) => l.includes(MARKER))) return;
    findings.push({ file, line: index + 1, text: text.trim() });
  });
  return findings;
}

function isTestPath(path: string): boolean {
  return path.includes("/__tests__/") || /\.test\.tsx?$/.test(path);
}

if (import.meta.main) {
  const findings: Finding[] = [];
  for await (const path of new Glob("**/*.ts").scan({ cwd: SCAN_DIR, absolute: true })) {
    if (isTestPath(path)) continue;
    findings.push(...findUnmarkedCasts(relative(ROOT, path), readFileSync(path, "utf8")));
  }
  if (findings.length > 0) {
    console.error(
      `${findings.length} bare \`$n::jsonb\` cast(s): Bun stores a stringified value as a JSON string scalar. Use \`$n::text::jsonb\`, or mark an object parameter with "${MARKER} <reason>".`,
    );
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`);
    process.exit(1);
  }
  console.log("No bare $n::jsonb casts in apps/runtime/src.");
}
