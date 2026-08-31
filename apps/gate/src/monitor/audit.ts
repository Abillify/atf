// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { MonitoringConfig } from "../config/schema.ts";
import type { MonitorBus, MonitorEvent } from "./events.ts";
import { logger } from "../logger.ts";

/**
 * Append-only audit sink.
 *
 * Subscribes to the MonitorBus and writes each (optionally filtered) event as a
 * single JSON line to a file, giving a durable record that survives process
 * restarts — unlike the in-memory ring buffer. One object per line (JSONL) so
 * it streams cleanly into log shippers and is trivial to grep or replay.
 */
export class AuditSink {
  private stream?: WriteStream;
  private unsubscribe?: () => void;
  private readonly allowed?: Set<string>;

  constructor(private readonly config: NonNullable<MonitoringConfig["audit"]>) {
    if (config.events && config.events.length > 0) {
      this.allowed = new Set(config.events);
    }
  }

  /** Open the audit file and start recording. No-op when disabled/misconfigured. */
  attach(bus: MonitorBus): void {
    if (!this.config.enabled) return;
    if (!this.config.file) {
      logger.warn("audit logging enabled but monitoring.audit.file is not set — audit disabled");
      return;
    }
    try {
      mkdirSync(dirname(this.config.file), { recursive: true });
      this.stream = createWriteStream(this.config.file, { flags: "a" });
      this.stream.on("error", (err) => logger.error(`audit log write error: ${err.message}`));
    } catch (err) {
      logger.error(`failed to open audit log '${this.config.file}': ${(err as Error).message}`);
      return;
    }

    this.unsubscribe = bus.subscribe((event) => this.write(event));
    logger.info(`audit log enabled → ${this.config.file}`);
  }

  private write(event: MonitorEvent): void {
    if (!this.stream) return;
    if (this.allowed && !this.allowed.has(event.type)) return;
    try {
      this.stream.write(JSON.stringify(event) + "\n");
    } catch (err) {
      logger.error(`audit log write failed: ${(err as Error).message}`);
    }
  }

  /** Stop recording and flush the file. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}
