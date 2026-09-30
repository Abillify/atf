// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Einmal-Modus `once` (requirements 10.5, 10.8, design.md): alle Sources
 * nacheinander, ein Run pro Source. {@link aggregateExitCode} ist rein und
 * liefert `0` nur, wenn alle Sources erfolgreich synchronisiert wurden.
 *
 * Prioritaet der Exit-Codes: `78` (EX_CONFIG, Konfigurationsfehler — vor
 * jedem Run erkannt) vor `2` (Extract-Auth-/Verbindungsfehler) vor `1`
 * (Listing-/Source-Fehler, fehlgeschlagene Items oder needs-authorization)
 * vor `0`.
 *
 * Entscheidung (design.md): Eine wegen fehlender Autorisierung uebersprungene
 * Source zaehlt im Einmal-Modus als Fehler (1) — ein Cron-Job soll nicht
 * gruen melden, wenn eine konfigurierte Source nie synchronisiert wurde.
 */

import type { SourceConfig } from "../config/schema.js";
import type { RunReport } from "../sync/run.js";

/** Konfigurierte Exit-Codes (design.md, sysexits-kompatibel). */
export const EXIT_OK = 0;
export const EXIT_ITEM_OR_SOURCE_FAILURE = 1;
export const EXIT_EXTRACT_AUTH_OR_CONNECTION = 2;
export const EXIT_USAGE = 64;
export const EXIT_CONFIG = 78;

/** Ergebnis-Kategorie einer Source im Einmal-Modus. */
export type OnceSourceResult =
  | { kind: "ok" }
  | { kind: "needs-authorization" }
  | { kind: "source-error" }
  | { kind: "extract-error" }
  | { kind: "config-error" };

/**
 * Reine Aggregation der Exit-Codes (10.5, 10.8):
 * 78 bei Konfigurationsfehler, 2 bei Extract-Auth/Verbindung,
 * 1 bei Source-/Listing-Fehler, fehlgeschlagenen Items oder
 * needs-authorization, sonst 0.
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

/** Abbildung eines {@link RunReport} auf eine Ergebnis-Kategorie. */
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
 * Fuehrt alle Sources sequentiell (ein Run pro Source, 10.5) und liefert die
 * Ergebnis-Kategorien. `runSource` bricht nicht ab — Fehler werden als
 * {@link RunReport} mit entsprechendem Outcome berichtet; eine geworfene
 * Ausnahme zaehlt als Source-Fehler.
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
