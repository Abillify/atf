// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Lint regression gate for Biome: fails only when errors or warnings grow
 * beyond the checked-in baseline.
 *
 * Same mechanism as the repository-wide gate in
 * `scripts/check-lint-baseline.ts`, kept workspace-local so Gate can be linted
 * on its own. Gate previously had NO linter at all — `bun run typecheck` was
 * doing duty as one, which catches type errors and nothing else.
 *
 * Introducing Biome surfaced a real backlog (9 errors, all
 * `lint/a11y/useButtonType` inside the monitor dashboard's HTML asset, plus 182
 * warnings dominated by `lint/style/noNonNullAssertion`). Requiring zero on day
 * one would block every merge, and a gate that always fails gets removed. The
 * baseline lets only NEW violations fail; the backlog is reduced deliberately
 * and the baseline tightened as it shrinks.
 *
 * Three genuine errors were fixed rather than baselined, because they were
 * latent bugs rather than style: an object literal with a `then` property
 * (`src/db/template.ts` — thenable objects behave unexpectedly under `await`)
 * and two `forEach` callbacks returning a value.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const baselinePath = resolve(root, ".biome-baseline.json");
const reportPath = resolve(root, "biome-report.json");

const result = spawnSync(
  resolve(root, "node_modules", ".bin", "biome"),
  [
    "lint",
    "--max-diagnostics=5000",
    "--reporter=json",
    "--no-errors-on-unmatched",
  ],
  { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
);

if (result.stdout) {
  writeFileSync(reportPath, result.stdout);
}

let report: { diagnostics: { severity: string }[] };
try {
  report = JSON.parse(readFileSync(reportPath, "utf-8"));
} catch {
  console.error(`Could not read biome report at ${reportPath}`);
  console.error(result.stderr);
  process.exit(1);
}

let errors = 0;
let warnings = 0;
for (const diag of report.diagnostics) {
  if (diag.severity === "error") errors++;
  else if (diag.severity === "warning") warnings++;
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as {
  errors: number;
  warnings: number;
};

console.log(
  `Biome totals: ${errors} errors, ${warnings} warnings ` +
    `(baseline: ${baseline.errors} errors, ${baseline.warnings} warnings)`,
);

let failed = false;
if (errors > baseline.errors) {
  console.error(`❌ Errors increased: ${errors} > baseline ${baseline.errors}`);
  failed = true;
}
if (warnings > baseline.warnings) {
  console.error(
    `❌ Warnings increased: ${warnings} > baseline ${baseline.warnings}`,
  );
  failed = true;
}

if (failed) {
  console.error(
    "\nRun `bun run lint` locally to see the new problems, then fix them " +
      "or (if the increase is expected and reviewed) update .biome-baseline.json.",
  );
  process.exit(1);
}

if (errors < baseline.errors || warnings < baseline.warnings) {
  console.log(
    "\n✅ Below baseline — consider tightening .biome-baseline.json to lock in the improvement.",
  );
} else {
  console.log("\n✅ At or below baseline.");
}
