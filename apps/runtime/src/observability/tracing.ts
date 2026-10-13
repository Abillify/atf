// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Distributed Tracing (`src/observability/tracing.ts`)
 *
 * Thin re-export shim over `@atf/observability` — the shared tracer that every
 * ATF service (runtime, search, extract) uses, so all services speak the same
 * W3C Trace Context propagation and OTLP/HTTP JSON wire format.
 *
 * The only runtime-specific piece kept here: OTLP export goes through the
 * process-wide Egress_Guard (`egressFetch`) instead of the global `fetch`, so
 * the platform's SSRF posture applies to the collector endpoint as well.
 */

import { egressFetch } from "../security/egress.js";
import {
  createTracer as createSharedTracer,
  type Tracer,
  type TracerLogger,
  type TracingConfig,
} from "@atf/observability";

export * from "@atf/observability";

/**
 * Creates a tracer whose OTLP export is routed through the Egress_Guard.
 * Returns a no-op tracer when tracing is disabled so the hot path pays nothing.
 */
export function createTracer(
  config: TracingConfig,
  logger?: TracerLogger,
): Tracer {
  return createSharedTracer(config, logger, { fetchFn: egressFetch });
}
