// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Bundle-Size-Gate: Checks gzip size of initial JS bundles produced by `next build`.
 *
 * Reads the Next.js build manifest (.next/build-manifest.json) to find all JS
 * chunks listed as "initial" (i.e. loaded on every route), gzip-compresses each
 * file in memory, and fails with exit code 1 if any single bundle exceeds the
 * configured threshold.
 *
 * The gate is intentionally strict: one oversized chunk is enough to fail so that
 * regressions are caught per-bundle rather than hidden by an average.
 *
 * Requirement: 19.1, 19.2
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { gzipSync } from "zlib";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Maximum allowed gzip size per initial JS bundle (bytes). */
const THRESHOLD_BYTES = 250 * 1024; // 250 KB

/**
 * Locate the Next.js build output. The frontend builds into `frontend/.next`,
 * but this gate may be invoked from the repo root (CI does `cd frontend && next
 * build` then `cd .. && bun run scripts/check-bundle-size.ts`) or from inside
 * `frontend/`. Probe both so the gate works regardless of the caller's cwd.
 */
function resolveNextDir(): string {
  const candidates = [
    resolve(process.cwd(), ".next"),
    resolve(process.cwd(), "frontend", ".next"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? resolve(process.cwd(), ".next"); // default target for the "not found" error message
}

const NEXT_DIR = resolveNextDir();
const BUILD_MANIFEST_PATH = join(NEXT_DIR, "build-manifest.json");

// ─── Types ───────────────────────────────────────────────────────────────────

interface BuildManifest {
  pages: Record<string, string[]>;
  /** Next 13+ app dir pages map */
  rootMainFiles?: string[];
}

interface BundleResult {
  file: string;
  rawBytes: number;
  gzipBytes: number;
  passed: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatKB(bytes: number): string {
  return (bytes / 1024).toFixed(1) + " KB";
}

/**
 * Collect the set of initial JS chunks from the build manifest.
 *
 * "Initial" chunks are those emitted for every page route — they represent what
 * a first-time visitor must download before the page becomes interactive. Next.js
 * records them under each page key; the union across all pages gives the full
 * initial set.
 */
function collectInitialChunks(manifest: BuildManifest): Set<string> {
  const chunks = new Set<string>();

  // Pages router: manifest.pages maps route → [chunk, …]
  if (manifest.pages) {
    for (const files of Object.values(manifest.pages)) {
      for (const f of files) {
        if (f.endsWith(".js")) {
          chunks.add(f);
        }
      }
    }
  }

  // App router: rootMainFiles are always loaded
  if (manifest.rootMainFiles) {
    for (const f of manifest.rootMainFiles) {
      if (f.endsWith(".js")) {
        chunks.add(f);
      }
    }
  }

  return chunks;
}

/**
 * Recursively find all .js files under a directory.
 * Fallback when no build manifest is present (e.g. custom build setups).
 */
function findJsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findJsFiles(full));
    } else if (entry.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

// ─── Core logic ──────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(NEXT_DIR)) {
    console.error(
      `❌ .next directory not found at ${NEXT_DIR}\n` +
        `   Run the frontend build first: bun run build`,
    );
    process.exit(1);
  }

  // ── Resolve bundle files ──────────────────────────────────────────────────

  let chunkPaths: string[];

  if (existsSync(BUILD_MANIFEST_PATH)) {
    const manifest: BuildManifest = JSON.parse(
      readFileSync(BUILD_MANIFEST_PATH, "utf-8"),
    );
    const chunks = collectInitialChunks(manifest);

    if (chunks.size === 0) {
      console.warn(
        "⚠️  No initial JS chunks found in build manifest — scanning static/chunks instead.",
      );
      chunkPaths = findJsFiles(join(NEXT_DIR, "static", "chunks"));
    } else {
      // Resolve relative chunk paths (e.g. "static/chunks/…") to absolute paths
      chunkPaths = [...chunks]
        .map((rel) => {
          // Next.js manifest paths start with "static/" — resolve relative to .next
          const full = join(NEXT_DIR, rel);
          return existsSync(full) ? full : null;
        })
        .filter((p): p is string => p !== null);
    }
  } else {
    console.warn(
      `⚠️  build-manifest.json not found — scanning .next/static/chunks for all JS files.`,
    );
    chunkPaths = findJsFiles(join(NEXT_DIR, "static", "chunks"));
  }

  if (chunkPaths.length === 0) {
    console.error(
      "❌ No JS bundle files found. Ensure the frontend has been built with `bun run build`.",
    );
    process.exit(1);
  }

  // ── Measure gzip size of each bundle ─────────────────────────────────────

  const results: BundleResult[] = chunkPaths.map((filePath) => {
    const raw = readFileSync(filePath);
    const gz = gzipSync(raw, { level: 9 });
    return {
      file: filePath.replace(NEXT_DIR + "/", ""),
      rawBytes: raw.length,
      gzipBytes: gz.length,
      passed: gz.length <= THRESHOLD_BYTES,
    };
  });

  results.sort((a, b) => b.gzipBytes - a.gzipBytes);

  // ── Report ───────────────────────────────────────────────────────────────

  const failed = results.filter((r) => !r.passed);
  const thresholdKB = formatKB(THRESHOLD_BYTES);

  console.log(
    "╔══════════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║       Bundle-Size-Gate: Initial JS Chunks (gzip)               ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════════╣",
  );
  console.log(`║  Threshold per bundle: ${thresholdKB.padEnd(42)} ║`);
  console.log(
    `║  Bundles checked:      ${String(results.length).padEnd(42)} ║`,
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════════╣",
  );

  for (const r of results) {
    const status = r.passed ? "✅" : "❌";
    const gzLabel = formatKB(r.gzipBytes).padStart(8);
    const rawLabel = formatKB(r.rawBytes).padStart(8);
    // Truncate long file names for display
    const display =
      r.file.length > 42 ? "…" + r.file.slice(-41) : r.file.padEnd(43);
    console.log(`║  ${status} ${display} ${gzLabel} gz (${rawLabel} raw) ║`);
  }

  console.log(
    "╚══════════════════════════════════════════════════════════════════╝",
  );

  if (failed.length > 0) {
    console.error(
      `\n❌ FAILED: ${failed.length} bundle(s) exceed the ${thresholdKB} gzip threshold:`,
    );
    for (const r of failed) {
      console.error(
        `   • ${r.file}: ${formatKB(r.gzipBytes)} gz (limit: ${thresholdKB})`,
      );
    }
    console.error(
      "\n   Reduce bundle size by code-splitting, lazy imports, or removing unused dependencies.",
    );
    process.exit(1);
  }

  console.log(
    `\n✅ PASSED: All ${results.length} initial JS bundle(s) are within the ${thresholdKB} gzip limit.`,
  );
  process.exit(0);
}

main();
