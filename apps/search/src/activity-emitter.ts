// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * activity-emitter.ts
 *
 * A lightweight, process-wide EventEmitter that broadcasts real-time activity
 * events (ingest, search, delete, query) to all connected SSE clients.
 *
 * The "query" type covers read-only lookups (list_collections,
 * collection_stats, list_documents, list_folders, get_document, get_documents,
 * get_summary, get_summaries) — mostly issued via the MCP tools.
 *
 * Usage
 * ─────
 * Handlers call `emitActivity(event)` after completing an operation.
 * The SSE handler subscribes via `onActivity` / `offActivity` and forwards
 * events to every connected browser tab.
 */

import { EventEmitter } from "node:events";
import { transactionCorrelation } from "./transaction-context.js";

export type ActivityType = "ingest" | "search" | "delete" | "query";
export type ActivityStatus = "ok" | "error";

export interface ActivityEvent {
  /** Unique event ID (used as SSE `id:` field for last-event-id reconnection). */
  id: string;
  /**
   * Tenant the event belongs to, set wherever the emitting request has a
   * resolvable scope. The activity stream uses it to hide events from
   * subscribers of other tenants; events without a tenant (emitted outside
   * any request scope, e.g. background work) are withheld from tenant-scoped
   * subscribers and visible only to operator and service viewers.
   */
  tenantId?: string;
  type: ActivityType;
  status: ActivityStatus;
  /** Human-readable one-liner, e.g. '"foo bar" in documents [hybrid]'. */
  summary: string;
  /** ISO timestamp of when the operation completed. */
  timestamp: string;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
  /** Optional structured payload (response JSON, error message, …). */
  detail?: unknown;
  /** Optional token usage details including per-model costs. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    modelCosts?: Record<string, number>;
  };
}

const _emitter = new EventEmitter();
// Prevent Node from warning about large numbers of SSE connections.
_emitter.setMaxListeners(0);

const ACTIVITY_EVENT = "activity";

export function emitActivity(event: ActivityEvent): void {
  const correlation = transactionCorrelation();
  const detail = Object.keys(correlation).length === 0
    ? event.detail
    : { ...(event.detail && typeof event.detail === "object" ? event.detail : {}), ...correlation };
  _emitter.emit(ACTIVITY_EVENT, { ...event, detail });
}

export function onActivity(listener: (event: ActivityEvent) => void): void {
  _emitter.on(ACTIVITY_EVENT, listener as (...args: unknown[]) => void);
}

export function offActivity(listener: (event: ActivityEvent) => void): void {
  _emitter.off(ACTIVITY_EVENT, listener as (...args: unknown[]) => void);
}
