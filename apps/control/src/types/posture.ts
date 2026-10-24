// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Governance posture types — mirrored from the runtime's posture report
 * (`GET /monitoring/posture`). Deliberately standalone: the Control app never
 * imports from the runtime package, so the wire format is restated here.
 */

/** Outcome of one posture check. */
export type PostureStatus = "ok" | "warn" | "fail";

/** One posture check result. */
export interface PostureCheck {
  /** Stable machine-readable id (e.g. `"evidence_key"`). */
  id: string;
  /** Control area the check belongs to (e.g. `"evidence"`, `"privacy"`). */
  area: string;
  status: PostureStatus;
  /** Human-readable explanation of the status. */
  message: string;
}

/** Aggregated posture report as returned by `GET /monitoring/posture`. */
export interface PostureReport {
  /** ISO-8601 timestamp of report generation. */
  generatedAt: string;
  /** Effective operational profile (`ATF_PROFILE`/`APP_ENV`). */
  operationalProfile: string;
  /** Applied configuration preset (`ATF_PRESET`), or `null`. */
  preset: string | null;
  /** Worst status across all checks (`fail` > `warn` > `ok`). */
  status: PostureStatus;
  /** Number of checks per status. */
  summary: { ok: number; warn: number; fail: number };
  /** Individual check results, in report order. */
  checks: PostureCheck[];
  /** Result of the production-readiness gate for the same config. */
  productionGate: { fatal: string[]; warnings: string[] };
}
