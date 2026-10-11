// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * One-shot mode `once` (requirements 10.5, 10.8, design.md): all sources
 * one after another, one run per source. {@link aggregateExitCode} is pure and
 * returns `0` only when all sources were synchronized successfully.
 *
 * Exit-code priority: `78` (EX_CONFIG, configuration error, detected before
 * any run) before `2` (Extract auth/connection error) before `1`
 * (listing/source error, failed items or needs-authorization)
 * before `0`.
 *
 * Decision (design.md): a source skipped for missing authorization counts as
 * an error (1) in one-shot mode; a cron job should not report green when a
 * configured source was never synchronized.
 */

import type { SourceConfig } from "../config/schema.js";
import type { RunReport } from "../sync/run.js";

/** Konfigurierte Exit-Codes (design.md, sysexits-kompatibel). */
export const EXIT_OK = 0;
export const EXIT_ITEM_OR_SOURCE_FAILURE = 1;
export const EXIT_EXTRACT_AUTH_OR_CONNECTION = 2;
export const EXIT_USAGE = 64;
export const EXIT_CONFIG = 78;

/** Result category of a source in one-shot mode. */
export type OnceSourceResult =
  | { kind: "ok" }
  | { kind: "needs-authorization" }
  | { kind: "source-error" }
  | { kind: "extract-error" }
  | { kind: "config-error" };

/**
 * Pure aggregation of the exit codes (10.5, 10.8):
 * 78 for a configuration error, 2 for Extract auth/connection,
 * 1 for a source/listing error, failed items or
 * needs-authorization, otherwise 0.
 */
export function aggregateExitCode(
  results: readonly OnceSourceResult[],
): number {
  if (results.some((r) => r.kind === "config-error")) return EXIT_CONFIG;
  if (results.some((r) => r.kind === "extract-error"))
    return EXIT_EXTRACT_AUTH_OR_CONNECTION;
  if (results.some((r) => r.kind !== "ok")) return EXIT_ITEM_OR_SOURCE_FAILURE;
  return EXIT_OK;
}

/** Maps a {@link RunReport} to a result category. */
export function resultFromRunReport(report: RunReport): OnceSourceResult {
  switch (report.outcome) {
    case "needs-authorization":
      return { kind: "needs-authorization" };
    case "reauth-required":
      // Extract-Auth-Abbruch (401 trotz Refresh) — Exit 2 (10.8).
      return { kind: "extract-error" };
    case "incomplete":
      return { kind: "source-error" };
    case "ok":
      return report.counters.failed > 0
        ? { kind: "source-error" }
        : { kind: "ok" };
  }
}

/**
 * Runs all sources sequentially (one run per source, 10.5) and returns the
 * result categories. `runSource` does not abort; errors are reported as a
 * {@link RunReport} with the matching outcome; a thrown exception counts
 * as a source error.
 */
export async function runOnce(
  sources: readonly SourceConfig[],
  runSource: (src: SourceConfig, signal: AbortSignal) => Promise<RunReport>,
  signal: AbortSignal = new AbortController().signal,
): Promise<OnceSourceResult[]> {
  const results: OnceSourceResult[] = [];
  for (const src of sources) {
    if (signal.aborted) {
      results.push({ kind: "source-error" });
      continue;
    }
    try {
      const report = await runSource(src, signal);
      results.push(resultFromRunReport(report));
    } catch {
      results.push({ kind: "source-error" });
    }
  }
  return results;
}
