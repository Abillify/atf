// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `@atf/observability` — the shared tracing implementation used by every ATF
 * service (runtime, search, extract). One tracer, one wire format
 * (OTLP/HTTP JSON), one propagation convention (W3C Trace Context).
 */

export {
  createTracer,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  NOOP_TRACER,
  parseTraceparent,
} from "./tracing.js";
export type {
  AttributeValue,
  Span,
  SpanContext,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Tracer,
  TracerFactoryOptions,
  TracerLogger,
  TracerOptions,
  TracingConfig,
} from "./tracing.js";
