// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Coverage gate: checks line coverage of the core modules and fails below 80%.
 *
 * Core modules (security and execution core):
 *   src/graph/, src/config/, src/middleware/, src/db/, src/mcp/
 *
 * Reads the lcov file (coverage/lcov.info) and computes the aggregated line
 * coverage per core module path. Exit code 1 when the threshold is missed.
 *
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────────────

const THRESHOLD = 80; // percent line coverage required

const CORE_MODULE_PREFIXES = [
  "src/graph/",
  "src/config/",
  "src/middleware/",
  "src/db/",
  "src/mcp/",
];

const LCOV_PATH = resolve(process.cwd(), "coverage", "lcov.info");

// ─── LCOV Parser ────────────────────────────────────────────────────────────

interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
}

function parseLcov(content: string): FileCoverage[] {
  const results: FileCoverage[] = [];
  let currentFile = "";
  let linesFound = 0;
  let linesHit = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("SF:")) {
      currentFile = trimmed.slice(3);
    } else if (trimmed.startsWith("LF:")) {
      linesFound = parseInt(trimmed.slice(3), 10);
    } else if (trimmed.startsWith("LH:")) {
      linesHit = parseInt(trimmed.slice(3), 10);
    } else if (trimmed === "end_of_record") {
      if (currentFile) {
        results.push({ file: currentFile, linesFound, linesHit });
      }
      currentFile = "";
      linesFound = 0;
      linesHit = 0;
    }
  }

  return results;
}

// ─── Core logic ─────────────────────────────────────────────────────────────

function normalizePath(filePath: string): string {
  // Convert absolute paths to relative by stripping the cwd prefix
  const cwd = process.cwd();
  if (filePath.startsWith(cwd)) {
    return filePath.slice(cwd.length + 1); // +1 for the trailing slash
  }
  // Already relative or from different root — try to find src/ prefix
  const srcIndex = filePath.indexOf("src/");
  if (srcIndex !== -1) {
    return filePath.slice(srcIndex);
  }
  return filePath;
}

function isCoreModule(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return CORE_MODULE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isTestFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return (
    normalized.includes("__tests__") ||
    normalized.includes(".test.") ||
    normalized.includes(".spec.")
  );
}

function main(): void {
  if (!existsSync(LCOV_PATH)) {
    console.error(
      `❌ Coverage report not found at ${LCOV_PATH}\n` +
        `   Run tests with coverage first: bun test --coverage`,
    );
    process.exit(1);
  }

  const lcovContent = readFileSync(LCOV_PATH, "utf-8");
  const allFiles = parseLcov(lcovContent);

  // Filter to core modules, excluding test files
  const coreFiles = allFiles.filter(
    (f) => isCoreModule(f.file) && !isTestFile(f.file),
  );

  if (coreFiles.length === 0) {
    console.error(
      "❌ No core module files found in coverage report.\n" +
        `   Expected files under: ${CORE_MODULE_PREFIXES.join(", ")}\n` +
        `   LCOV path: ${LCOV_PATH}`,
    );
    process.exit(1);
  }

  // Aggregate per module prefix
  const moduleStats = new Map<
    string,
    { linesFound: number; linesHit: number; files: number }
  >();

  for (const prefix of CORE_MODULE_PREFIXES) {
    moduleStats.set(prefix, { linesFound: 0, linesHit: 0, files: 0 });
  }

  let totalLinesFound = 0;
  let totalLinesHit = 0;

  for (const file of coreFiles) {
    const normalized = normalizePath(file.file);
    for (const prefix of CORE_MODULE_PREFIXES) {
      if (normalized.startsWith(prefix)) {
        const stats = moduleStats.get(prefix);
        if (stats === undefined) break; // unreachable: pre-populated for every prefix above
        stats.linesFound += file.linesFound;
        stats.linesHit += file.linesHit;
        stats.files += 1;
        break;
      }
    }
    totalLinesFound += file.linesFound;
    totalLinesHit += file.linesHit;
  }

  // Report per-module coverage
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║         Coverage Gate: Core Module Line Coverage            ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  console.log(
    `║  Threshold: ${THRESHOLD}% line coverage                             ║`,
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );

  let anyModuleBelow = false;

  for (const [prefix, stats] of moduleStats) {
    if (stats.linesFound === 0) {
      console.log(
        `║  ${prefix.padEnd(20)} — no instrumented files found        ║`,
      );
      continue;
    }
    const pct = (stats.linesHit / stats.linesFound) * 100;
    const status = pct >= THRESHOLD ? "✅" : "❌";
    if (pct < THRESHOLD) anyModuleBelow = true;
    console.log(
      `║  ${status} ${prefix.padEnd(18)} ${pct.toFixed(1).padStart(5)}% (${stats.linesHit}/${stats.linesFound} lines, ${stats.files} files) `,
    );
  }

  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );

  const totalPct =
    totalLinesFound > 0 ? (totalLinesHit / totalLinesFound) * 100 : 0;
  const totalMeetsThreshold =
    totalLinesHit * 100 >= THRESHOLD * totalLinesFound;
  const totalStatus = totalMeetsThreshold ? "✅" : "❌";
  console.log(
    `║  ${totalStatus} TOTAL (core)      ${totalPct.toFixed(2).padStart(6)}% (${totalLinesHit}/${totalLinesFound} lines, ${coreFiles.length} files) `,
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );

  if (!totalMeetsThreshold) {
    console.error(
      `\n❌ FAILED: Aggregate core module line coverage ${totalPct.toFixed(2)}% (${totalLinesHit}/${totalLinesFound} lines) is below ${THRESHOLD}% threshold.`,
    );
    process.exit(1);
  }

  if (anyModuleBelow) {
    console.warn(
      `\n⚠️  WARNING: Some individual modules are below ${THRESHOLD}%, but aggregate passes.`,
    );
    console.warn(`   Consider increasing coverage in underperforming modules.`);
  }

  console.log(
    `\n✅ PASSED: Core module line coverage ${totalPct.toFixed(1)}% ≥ ${THRESHOLD}%`,
  );
  process.exit(0);
}

main();
