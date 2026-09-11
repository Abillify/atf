// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * trace-context.ts
 *
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) propagation.
 *
 * Stores the incoming `traceparent` and `tracestate` per async context so the
 * outbound clients (vision model, Search ingest, async callback) forward them
 * without threading parameters through the whole pipeline.
 *
 * This matters more here than in a single-hop service: a conversion fans out to
 * one model call per page and then to two Search endpoints, so a trace is the
 * only way to attribute a slow ingest to the page that caused it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceContext {
  /** W3C traceparent header value, e.g. "00-<trace-id>-<parent-id>-01". */
  traceparent?: string;
  /** W3C tracestate header value (vendor-specific key=value pairs). */
  tracestate?: string;
}

export const traceContextStorage = new AsyncLocalStorage<TraceContext>();

/** Read the current async context's trace context, or undefined if none. */
export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

/**
 * Inject W3C Trace Context headers into an outbound request headers object.
 * No-op when no trace context is active in the current async scope.
 */
export function injectTraceHeaders(headers: Record<string, string>): void {
  const ctx = getTraceContext();
  if (!ctx) return;
  if (ctx.traceparent) headers["traceparent"] = ctx.traceparent;
  if (ctx.tracestate) headers["tracestate"] = ctx.tracestate;
}
