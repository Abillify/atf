#!/usr/bin/env node
/**
 * Coverage ratchet.
 *
 * Reads `coverage/lcov.info` and fails when line coverage drops below
 * `MIN_COVERAGE_PCT`. Same ratchet philosophy as the repository-wide lint
 * baseline in `scripts/check-lint-baseline.ts`: hold the line, then raise it.
 *
 *   bun run --filter @atf/search coverage:check
 *
 * Not currently wired into CI. Run it after a coverage-enabled test run:
 * `node node_modules/vitest/vitest.mjs run --coverage`.
 *
 * Why a ratchet and not a flat 80%
 * ────────────────────────────────
 * This service started at ~27% line coverage. Setting the gate to 80% today
 * would fail every run immediately, and the realistic response to a gate that
 * always fails is to delete it. The threshold is therefore pinned just below
 * the current level: it cannot silently regress, and it is raised as coverage is
 * added.
 */

import { readFileSync } from "node:fs";

const MIN = Number(process.env.MIN_COVERAGE_PCT ?? "42");
const LCOV = process.env.LCOV_PATH ?? "coverage/lcov.info";

let text;
try {
  text = readFileSync(LCOV, "utf8");
} catch (err) {
  console.error(
    `Coverage gate: cannot read ${LCOV} — run the test suite with --coverage first. (${err.message})`,
  );
  process.exit(1);
}

let hit = 0;
let found = 0;
for (const line of text.split("\n")) {
  if (line.startsWith("LH:")) hit += Number(line.slice(3));
  if (line.startsWith("LF:")) found += Number(line.slice(3));
}

if (found === 0) {
  console.error("Coverage gate: lcov.info contains no line records.");
  process.exit(1);
}

const pct = (hit / found) * 100;
const label = `${pct.toFixed(2)}% (${hit}/${found} lines)`;

if (pct + 1e-9 < MIN) {
  console.error(`❌ Coverage ${label} is below the required ${MIN}%.`);
  process.exit(1);
}

console.log(`✅ Coverage ${label} meets the ${MIN}% threshold.`);
if (pct >= MIN + 3) {
  console.log(
    `   Coverage is ${(pct - MIN).toFixed(2)} points above the gate — ` +
      `raise MIN_COVERAGE_PCT to lock the gain in.`,
  );
}
