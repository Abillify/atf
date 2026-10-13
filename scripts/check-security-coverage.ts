// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Security-module coverage gate (Requirement 13.7).
 *
 * Runs the runtime test suite with coverage and enforces a minimum coverage
 * threshold for the security-critical modules listed in Requirement 13.7.
 *
 * IMPORTANT LIMITATION (verified against Bun 1.4.2): Bun's test runner does
 * not emit branch-coverage data. The lcov report contains no `BRDA:`/`BRF:`
 * records and the text reporter has no Branch column; this applies to all
 * currently available Bun versions and reporters (text, lcov). To honour the
 * spirit of Requirement 13.7 without a different test runner, this gate
 * enforces per-file LINE and FUNCTION coverage (both >= 90 %) as a proxy for
 * branch coverage. Line+function coverage underestimates missed branches, so
 * the threshold is deliberately applied per file — a single uncovered
 * security branch inside an otherwise-covered function still shows up as a
 * missed line in practice for the guard-style code in these modules.
 *
 * The threshold is never lowered to accommodate missing tests: add tests.
 *
 * Usage:
 *   bun run scripts/check-security-coverage.ts [--skip-run]
 *
 *   --skip-run  Reuse the lcov.info from a previous run (coverage/lcov.info
 *               under apps/runtime) instead of re-running the test suite.
 *
 * Exit codes: 0 = all targets meet the threshold, 1 = violation or tooling
 * error.
 */

import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RUNTIME_DIR = join(REPO_ROOT, "apps", "runtime");

/** Requirement 13.7: security-critical runtime modules. */
const TARGETS = [
  "src/middleware/auth.ts",
  "src/observability/audit-log.ts",
  "src/graph/pii-vault.ts",
  "src/graph/tool-authz.ts",
  "src/config/prod-gate.ts",
] as const;

/** Minimum coverage percentage per target file (lines and functions). */
const MIN_PERCENT = 90;

interface FileCoverage {
  linesFound: number;
  linesHit: number;
  funcsFound: number;
  funcsHit: number;
}

/**
 * Parse an lcov.info file and return per-source-file coverage records keyed by
 * the `SF:` path. Bun emits paths relative to the coverage run directory.
 */
async function parseLcov(
  path: string,
): Promise<Map<string, FileCoverage>> {
  const result = new Map<string, FileCoverage>();
  // Holds the record of the record currently being read, so the counters below
  // never need a map lookup with a non-null assertion.
  let current: FileCoverage | undefined;
  const text = await Bun.file(path).text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SF:")) {
      const name = trimmed.slice(3);
      let record = result.get(name);
      if (!record) {
        record = { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 };
        result.set(name, record);
      }
      current = record;
    } else if (!current) {
      continue;
    } else if (trimmed.startsWith("LF:")) {
      current.linesFound = Number(trimmed.slice(3));
    } else if (trimmed.startsWith("LH:")) {
      current.linesHit = Number(trimmed.slice(3));
    } else if (trimmed.startsWith("FNF:")) {
      current.funcsFound = Number(trimmed.slice(4));
    } else if (trimmed.startsWith("FNH:")) {
      current.funcsHit = Number(trimmed.slice(4));
    }
  }
  return result;
}

async function main(): Promise<number> {
  const skipRun = process.argv.includes("--skip-run");
  let lcovPath: string;
  let tempDir: string | undefined;

  if (skipRun) {
    lcovPath = join(RUNTIME_DIR, "coverage", "lcov.info");
    if (!existsSync(lcovPath)) {
      console.error(
        `--skip-run given but ${lcovPath} does not exist. Run without --skip-run first.`,
      );
      return 1;
    }
  } else {
    tempDir = mkdtempSync(join(tmpdir(), "atf-sec-cov-"));
    lcovPath = join(tempDir, "lcov.info");
    // Spawn the runtime suite with coverage into a throwaway directory so a
    // developer's local ./coverage is never clobbered. The full suite is used
    // (not a scoped file list) so transitive execution through the tested
    // modules counts, matching how the modules run in production.
    const proc = spawnSync(
      "bun",
      [
        "test",
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${tempDir}`,
        "src",
        "scripts",
      ],
      { cwd: RUNTIME_DIR, stdio: ["ignore", "inherit", "inherit"] },
    );
    if (proc.status !== 0) {
      console.error(
        `Test run with coverage failed (exit ${proc.status}); cannot evaluate the coverage gate.`,
      );
      return 1;
    }
  }

  try {
    const coverage = await parseLcov(lcovPath);
    let failed = false;
    const rows: string[] = [];

    for (const target of TARGETS) {
      // Bun may emit the SF path relative to the run dir or absolute; match
      // by suffix to be robust across versions.
      const entry = [...coverage.entries()].find(([k]) => k.endsWith(target));
      if (!entry) {
        console.error(
          `FAIL: ${target} — no coverage record found in lcov.info (file never loaded by the test suite?).`,
        );
        failed = true;
        continue;
      }
      const c = entry[1];
      const linePct = c.linesFound > 0 ? (100 * c.linesHit) / c.linesFound : 0;
      const funcPct = c.funcsFound > 0 ? (100 * c.funcsHit) / c.funcsFound : 0;
      const ok = linePct >= MIN_PERCENT && funcPct >= MIN_PERCENT;
      if (!ok) failed = true;
      rows.push(
        `${ok ? "PASS" : "FAIL"}  ${target}  lines ${linePct.toFixed(2)}% (${c.linesHit}/${c.linesFound})  funcs ${funcPct.toFixed(2)}% (${c.funcsHit}/${c.funcsFound})`,
      );
    }

    console.log(
      `\nSecurity-module coverage (Req 13.7; Bun lacks branch data — lines+functions >= ${MIN_PERCENT}% enforced as proxy):`,
    );
    for (const row of rows) console.log(`  ${row}`);

    if (failed) {
      console.error(
        `\nCoverage gate FAILED: one or more security modules are below ${MIN_PERCENT}%. Add tests — do not lower the threshold.`,
      );
      return 1;
    }
    console.log("\nCoverage gate passed.");
    return 0;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

process.exit(await main());
