#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * atf-doctor probe for Extract (`apps/extract/scripts/doctor-probe.ts`).
 *
 * Started by `scripts/atf-doctor.ts` in a dedicated child process whose
 * environment is built only from the operator's env file. The probe loads the
 * Extract configuration, runs the production-readiness gate, and writes
 * exactly one JSON line to stdout:
 *
 *   {"service":"extract","configError":null,"fatal":[],"warnings":[],"posture":null}
 *
 * `loadConfig()` throws on invalid configuration; the error message names
 * only variables, never values. If the process dies before this probe can
 * report, the parent turns the exit code and the (truncated, masked) stderr
 * into `configError`.
 */

import { loadConfig } from "../src/config.js";
import { checkProductionReadiness } from "../src/prod-gate.js";

interface ProbeResult {
  service: string;
  configError: string | null;
  fatal: string[];
  warnings: string[];
  posture: null;
}

function emit(result: ProbeResult): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

try {
  const config = loadConfig();
  const report = checkProductionReadiness(config);
  emit({
    service: "extract",
    configError: null,
    fatal: report.fatal,
    warnings: report.warnings,
    posture: null,
  });
} catch (err) {
  emit({
    service: "extract",
    configError: err instanceof Error ? err.message : String(err),
    fatal: [],
    warnings: [],
    posture: null,
  });
}
