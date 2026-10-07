// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * reporter.ts
 *
 * Shared rendering of a production-readiness report. Every service prints its
 * findings the same way — one banner, fatals first, a stable prefix per line —
 * so operators and log scrapers see a uniform signal across runtime, search,
 * gate and extract.
 */

import type { ProdGate } from "./rules.ts";

export interface ReportSink {
  error(line: string): void;
  warn(line: string): void;
  info(line: string): void;
}

export interface ReportOutcome {
  /** True when the process must not start (fatals present in production). */
  abort: boolean;
  fatalCount: number;
  warningCount: number;
}

/**
 * Emit the gate's findings to a sink. In production, fatals are logged as
 * errors and the outcome says `abort`; outside production everything is a
 * warning and startup continues.
 */
export function reportProdGate(gate: ProdGate, serviceName: string, sink: ReportSink): ReportOutcome {
  const fatalCount = gate.fatalFindings.length;
  const warningCount = gate.warnings.length;
  if (fatalCount === 0 && warningCount === 0) {
    sink.info(`[${serviceName}] production-readiness: no findings (environment=${gate.environment}).`);
    return { abort: false, fatalCount, warningCount };
  }
  const header = `[${serviceName}] production-readiness (${gate.environment}): ${fatalCount} fatal, ${warningCount} warning`;
  if (gate.isProduction && fatalCount > 0) sink.error(header);
  else sink.warn(header);
  for (const finding of gate.fatalFindings) {
    if (gate.isProduction) sink.error(`  FATAL: ${finding}`);
    else sink.warn(`  would-be-fatal-in-production: ${finding}`);
  }
  for (const finding of gate.warnings) {
    sink.warn(`  warning: ${finding}`);
  }
  return { abort: gate.isProduction && fatalCount > 0, fatalCount, warningCount };
}
