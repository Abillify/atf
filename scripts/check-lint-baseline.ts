// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Lint regression gate with per-finding fingerprints (Req 13.4, 13.5).
 *
 *   bun run lint:baseline                 # fail on any finding outside the baseline
 *   bun run lint:baseline -- --update     # record the current findings as the baseline
 *
 * The repository carries a stock of pre-existing Biome findings. Demanding
 * zero from day one would block every pull request behind an unrelated
 * cleanup, and disabling the linter would let new problems in unnoticed. This
 * gate therefore records each accepted finding individually — file, rule, and
 * a hash of the offending source line — instead of only aggregate counts.
 *
 * Why fingerprints and not counts: with aggregate counts, fixing one finding
 * silently pays for introducing another one anywhere in the tree, and a
 * finding that merely moves to a different line of the same file is invisible.
 * A fingerprint ties each tolerated finding to the exact code that produces
 * it: any new finding fails the gate even when the totals go down, and moving
 * code around without fixing it still fails.
 *
 * The line *number* is deliberately not part of the fingerprint — only the
 * trimmed source line's hash — so unrelated edits above a finding do not
 * invalidate it. Editing the offending line itself does change the hash,
 * which is intended: the old finding is gone and the new one needs review.
 *
 * Reduction targets (Req 13.5): errors to 0, warnings by at least 50 % from
 * the starting point of 655. Each reduction lands as its own commit, per rule;
 * `--update` is run only as part of such a reviewed reduction commit, never to
 * paper over a regression.
 *
 * The formatter is deliberately not part of this gate. Formatting differences
 * across the tree are extensive and reformatting them in one commit would
 * destroy `git blame` for little benefit. Format the files you touch
 * (`bunx biome format --write <path>`) and leave the rest.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const baselinePath = resolve(root, ".biome-baseline.json");
const update = process.argv.includes("--update");

/**
 * Must stay above the total number of diagnostics, otherwise Biome truncates
 * its report and findings silently disappear from the gate. The check below
 * fails loudly when the cap is reached.
 */
const MAX_DIAGNOSTICS = 10_000;

/** How many new findings to list before collapsing the rest. */
const MAX_REPORTED = 50;

interface BiomeDiagnostic {
	severity: string;
	category: string;
	location: {
		path: string;
		start: { line: number; column: number };
	};
}

interface BaselineEntry {
	/** Biome rule, e.g. `lint/style/noNonNullAssertion`. */
	rule: string;
	severity: "error" | "warning";
	/** Path relative to the repository root. */
	file: string;
	/** sha256 (truncated) of the trimmed offending source line. */
	hash: string;
	/** How many identical fingerprints occur (same file, rule, line text). */
	count: number;
}

interface Baseline {
  version: 1;
  note: string;
  findings: BaselineEntry[];
}

const result = spawnSync(
  resolve(root, "node_modules", ".bin", "biome"),
  [
    "lint",
    `--max-diagnostics=${MAX_DIAGNOSTICS}`,
    "--reporter=json",
    "--no-errors-on-unmatched",
  ],
  { cwd: root, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
);

if (!result.stdout) {
	console.error("Biome produced no report.");
	console.error(result.stderr);
	process.exit(1);
}

let report: { diagnostics: BiomeDiagnostic[] };
try {
	report = JSON.parse(result.stdout) as typeof report;
} catch (error) {
	console.error(`Could not parse the Biome report: ${(error as Error).message}`);
	console.error(result.stderr);
	process.exit(1);
}

// Only errors and warnings are gated; Biome's `info` severity is advisory.
const gated = report.diagnostics.filter(
	(d) => d.severity === "error" || d.severity === "warning",
);

if (report.diagnostics.length >= MAX_DIAGNOSTICS) {
  console.error(
    `Diagnostic count (${report.diagnostics.length}) reached the reporting cap of ${MAX_DIAGNOSTICS}; the report is truncated and the gate cannot be trusted. Raise MAX_DIAGNOSTICS in scripts/check-lint-baseline.ts.`,
  );
  process.exit(1);
}

// Cache file contents so each source file is read once, not once per finding.
const lineCache = new Map<string, string[]>();
function sourceLine(relPath: string, line: number): string {
	let lines = lineCache.get(relPath);
	if (!lines) {
		try {
			lines = readFileSync(resolve(root, relPath), "utf-8").split("\n");
		} catch {
			lines = [];
		}
		lineCache.set(relPath, lines);
	}
	return (lines[line - 1] ?? "").trim();
}

function fingerprint(d: BiomeDiagnostic): string {
	const hash = createHash("sha256")
		.update(sourceLine(d.location.path, d.location.start.line))
		.digest("hex")
		.slice(0, 16);
	return `${d.severity}\u0000${d.category}\u0000${d.location.path}\u0000${hash}`;
}

const current = new Map<string, number>();
for (const d of gated) {
	const key = fingerprint(d);
	current.set(key, (current.get(key) ?? 0) + 1);
}

function keyToEntry(key: string, count: number): BaselineEntry {
	const [severity, rule, file, hash] = key.split("\u0000");
	return { rule: rule ?? "", severity: severity as "error" | "warning", file: file ?? "", hash: hash ?? "", count };
}

function entryToKey(e: BaselineEntry): string {
	return `${e.severity}\u0000${e.rule}\u0000${e.file}\u0000${e.hash}`;
}

let errors = 0;
let warnings = 0;
for (const d of gated) {
	if (d.severity === "error") errors++;
	else warnings++;
}

if (update) {
	const findings: BaselineEntry[] = [...current.entries()]
    .map(([key, count]) => keyToEntry(key, count))
    .sort(
      (a, b) =>
        a.rule.localeCompare(b.rule) ||
        a.file.localeCompare(b.file) ||
        a.hash.localeCompare(b.hash),
    );
	const next: Baseline = {
    version: 1,
    note: "Generated by `bun run lint:baseline -- --update`. Each entry is one tolerated Biome finding, identified by file, rule, and a hash of the offending source line. Run --update only as part of a reviewed reduction commit (Req 13.5) — never to admit new findings.",
    findings,
  };
	writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
	console.log(
    `Baseline updated: ${findings.length} fingerprints (${errors} errors, ${warnings} warnings).`,
  );
	process.exit(0);
}

let baseline: Baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Baseline;
  if (baseline.version !== 1 || !Array.isArray(baseline.findings)) {
    throw new Error("unexpected shape");
  }
} catch (error) {
  console.error(
    `Missing or unreadable ${baselinePath} (${(error as Error).message}). Create it with \`bun run lint:baseline -- --update\`.`,
  );
  process.exit(1);
}

const allowed = new Map<string, number>();
for (const e of baseline.findings) {
  const key = entryToKey(e);
  allowed.set(key, (allowed.get(key) ?? 0) + e.count);
}

const isNew = (k: string) => (current.get(k) ?? 0) > (allowed.get(k) ?? 0);
const isFixed = (k: string) => (allowed.get(k) ?? 0) > (current.get(k) ?? 0);

const newKeys = [...current.keys()].filter(isNew).sort();
const fixedKeys = [...allowed.keys()].filter(isFixed).sort();
const newErrorCount = newKeys.reduce(
  (n, k) =>
    n +
    ((current.get(k) ?? 0) - (allowed.get(k) ?? 0)) *
      (k.startsWith("error") ? 1 : 0),
  0,
);
const newWarningCount = newKeys.reduce(
  (n, k) =>
    n +
    ((current.get(k) ?? 0) - (allowed.get(k) ?? 0)) *
      (k.startsWith("warning") ? 1 : 0),
  0,
);

console.log(
  `Biome lint: ${errors} errors, ${warnings} warnings (baseline: ${baseline.findings.length} fingerprints).`,
);

if (newKeys.length > 0) {
  console.error(
    `\n${newErrorCount + newWarningCount} finding(s) not present in the baseline (${newErrorCount} error(s), ${newWarningCount} warning(s)):`,
  );
  for (const key of newKeys.slice(0, MAX_REPORTED)) {
    const e = keyToEntry(
      key,
      (current.get(key) ?? 0) - (allowed.get(key) ?? 0),
    );
    console.error(
      `  ${e.severity}  ${e.rule}  ${e.file}${e.count > 1 ? ` (x${e.count})` : ""}`,
    );
  }
  if (newKeys.length > MAX_REPORTED) {
    console.error(`  ... and ${newKeys.length - MAX_REPORTED} more`);
  }
  console.error(
    "\nFix them. Only run `bun run lint:baseline -- --update` as part of a reviewed commit that intentionally changes the accepted stock.",
  );
  process.exit(1);
}

if (fixedKeys.length > 0) {
  console.log(
    `${fixedKeys.length} baseline fingerprint(s) no longer match — the stock shrank. Run \`bun run lint:baseline -- --update\` to lock in the improvement.`,
  );
} else {
  console.log("At baseline.");
}
