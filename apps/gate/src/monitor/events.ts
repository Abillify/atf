// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { EventEmitter } from "node:events";
import type { AuthDisplayReferences } from "../config/auth-references.ts";
import { projectAuthMeta } from "../config/auth-references.ts";
import {
  DEFAULT_REDACT_OPTIONS,
  redactEventMeta,
  type RedactOptions,
} from "../observability/redact.ts";

export type MonitorEventType =
  | "connection"
  | "disconnection"
  | "auth"
  | "auth_failure"
  | "tool_call"
  | "transaction"
  | "tool_result"
  | "approval_requested"
  | "approval_resolved"
  | "router"
  | "llm_request"
  | "llm_response"
  | "error";

export interface MonitorEvent {
  /** Monotonic id, assigned by the bus. */
  id: number;
  /** ISO timestamp. */
  ts: string;
  type: MonitorEventType;
  sessionId?: string;
  username?: string;
  subject?: string;
  authMethod?: string;
  tool?: string;
  /** Inbound HTTP headers, redacted (no Authorization value). */
  headers?: Record<string, string>;
  durationMs?: number;
  status?: "ok" | "error" | "pending" | "approved" | "denied";
  message?: string;
  /** Arbitrary structured detail (tool args, row counts, ...). */
  meta?: Record<string, unknown>;
  /**
   * True when this event was ingested from another instance via the optional
   * monitor cluster bridge (see monitor/cluster-bridge.ts), rather than
   * originating locally. Lets the bridge avoid re-publishing an event it just
   * received back onto the shared channel.
   */
  remote?: boolean;
}

/** Input accepted by publish() - id/ts are filled in by the bus. */
export type MonitorEventInput = Omit<MonitorEvent, "id" | "ts">;

/**
 * In-process pub/sub for live request monitoring. Keeps a bounded ring buffer
 * so a freshly connected dashboard can replay the most recent activity.
 */
export class MonitorBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: MonitorEvent[] = [];
  private nextId = 1;

  private readonly redactOptions: RedactOptions;

  constructor(
    private readonly bufferSize: number = 200,
    redactOptions: RedactOptions = DEFAULT_REDACT_OPTIONS,
    private readonly authDisplayReferences?: AuthDisplayReferences,
  ) {
    // Dashboards + internal listeners; raise the cap above the default of 10.
    this.emitter.setMaxListeners(0);
    this.redactOptions = redactOptions;
  }

  /**
   * Publish an event.
   *
   * Redaction happens HERE, once, rather than at each of the four consumers
   * (dashboard ring buffer, SSE subscribers, audit file, Redis cluster bridge).
   * A single choke point is the only way to guarantee that adding a fifth
   * consumer later cannot accidentally reintroduce a raw-payload sink.
   */
  publish(input: MonitorEventInput): MonitorEvent {
    const authMeta =
      input.type === "auth" && this.authDisplayReferences
        ? projectAuthMeta(input.meta, this.authDisplayReferences)
        : input.meta;
    const safeMeta = redactEventMeta(authMeta, this.redactOptions);
    const event: MonitorEvent = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      ...input,
      ...(safeMeta !== undefined ? { meta: safeMeta } : {}),
    };
    if (this.bufferSize > 0) {
      this.buffer.push(event);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    this.emitter.emit("event", event);
    return event;
  }

  /**
   * Re-emit an event that originated on another instance (via the optional
   * monitor cluster bridge) onto this bus's buffer/subscribers, tagged
   * `remote: true`. Keeps its original `id`/`ts` from the origin instance
   * rather than reassigning local ones, so ordering/dedup stays meaningful
   * across the cluster.
   */
  ingestRemote(event: MonitorEvent): void {
    const tagged: MonitorEvent = { ...event, remote: true };
    if (this.bufferSize > 0) {
      this.buffer.push(tagged);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    this.emitter.emit("event", tagged);
  }

  /** Recent events for replay on dashboard connect. */
  recent(): MonitorEvent[] {
    return [...this.buffer];
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(listener: (event: MonitorEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
