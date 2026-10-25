#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * atf-doctor probe for the Runtime (`apps/runtime/scripts/doctor-probe.ts`).
 *
 * Started by `scripts/atf-doctor.ts` in a dedicated child process whose
 * environment is built only from the operator's env file. The probe loads the
 * Runtime configuration, runs the production-readiness gate and the
 * governance posture report, and writes exactly one JSON line to stdout:
 *
 *   {"service":"runtime","configError":null,"fatal":[],"warnings":[],"posture":{…}}
 *
 * `loadConfig()` calls `process.exit(1)` on invalid configuration and names
 * only the offending variables on stderr; the parent turns the exit code and
 * the (truncated, masked) stderr into `configError` in that case. Everything
 * this process would otherwise print goes to stderr so stdout stays a single
 * JSON line.
 */

import { checkProductionReadiness, loadConfig } from "../src/config/index.js";
import { createCompliancePolicyLoader } from "../src/compliance/policy-loader.js";
import { buildPostureReport, type PostureReport } from "../src/compliance/posture.js";
import { collectFlowFiles, registerProvidersFromEnv, validateFlowFile } from "./cli.js";

interface ProbeResult {
  service: string;
  configError: string | null;
  fatal: string[];
  warnings: string[];
  posture: PostureReport | null;
}

// The reused cli.ts helpers report through console.log; redirect it to stderr
// so stdout carries nothing but the single JSON result line.
console.log = (...args: unknown[]): void => {
  console.error(...args);
};

function emit(result: ProbeResult): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

try {
  const config = loadConfig();
  // No cluster state: the doctor judges the env file offline, not a running
  // deployment, so cluster/RLS checks are skipped by omission.
  const { fatal, warnings } = checkProductionReadiness(config, undefined, process.env);

  let compliancePolicyLoaded = false;
  try {
    compliancePolicyLoaded = createCompliancePolicyLoader(config.flowsDir).hasPolicy;
  } catch {
    // An unreadable flows directory simply means no policy could be loaded.
  }

  // Same validation as `cli.ts validate`; an unreadable FLOWS_DIR leaves the
  // count at 0 because there is nothing to validate.
  let flowLoadFailures = 0;
  try {
    registerProvidersFromEnv();
    for (const file of collectFlowFiles(config.flowsDir)) {
      if (!validateFlowFile(file).valid) flowLoadFailures += 1;
    }
  } catch {
    flowLoadFailures = 0;
  }

  const posture = buildPostureReport(config, {
    compliancePolicyLoaded,
    flowLoadFailures,
    env: process.env,
  });
  emit({ service: "runtime", configError: null, fatal, warnings, posture });
} catch (err) {
  emit({
    service: "runtime",
    configError: err instanceof Error ? err.message : String(err),
    fatal: [],
    warnings: [],
    posture: null,
  });
}
