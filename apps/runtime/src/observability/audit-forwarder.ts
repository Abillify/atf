// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Continuous audit forwarding to an external SIEM (review follow-up G3).
 *
 * `GET /monitoring/audit/export` answers pull requests; this module pushes.
 * A background loop reads `audit_log` from a persisted position and ships the
 * entries as NDJSON batches to an HTTPS webhook through the Egress_Guard
 * (`egressFetch` — never the global fetch, `bun run check:raw-fetch` pins
 * this). The position advances ONLY after the target answered the batch with
 * HTTP 2xx, so a crash between send and commit re-sends at most one batch:
 * delivery is at-least-once and never skips an entry.
 *
 * With several replicas, exactly one sends: every tick first takes the
 * session-level advisory lock `atf:audit_forward` on a pinned connection; a
 * replica that cannot take it skips the tick (the holder is mid-batch).
 *
 * Failures (non-2xx, transport errors, a rejected private-address target)
 * leave the position untouched and grow an exponential backoff capped at
 * five minutes, so a receiving outage becomes lag — visible in
 * `aiperator_audit_forward_lag` — instead of data loss.
 */

import type { Database } from "../db/database.js";
import { egressFetch } from "../security/egress.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import { auditRowToRecord, type AuditRecord } from "./audit-log.js";

/** Advisory-lock namespace for the single-sender election (G3). */
export const AUDIT_FORWARD_LOCK_KEY = "atf:audit_forward";

/** Default batch size (`AUDIT_FORWARD_BATCH_SIZE`). */
export const DEFAULT_AUDIT_FORWARD_BATCH_SIZE = 100;
/** Default tick interval in ms (`AUDIT_FORWARD_INTERVAL_MS`). */
export const DEFAULT_AUDIT_FORWARD_INTERVAL_MS = 15_000;
/** Backoff ceiling after consecutive failures. */
const MAX_BACKOFF_MS = 300_000;

export interface AuditForwarderOptions {
  /** Webhook receiving the NDJSON batches (HTTPS in production). */
  url: string;
  /** Optional bearer token (`AUDIT_FORWARD_TOKEN`). */
  token?: string;
  /** Entries per request. Default 100. */
  batchSize?: number;
  /** Tick interval in ms. Default 15 000. */
  intervalMs?: number;
  /**
   * Fetch seam for tests; defaults to the process-wide Egress_Guard, which is
   * what keeps private-address targets rejected without
   * `EGRESS_ALLOW_PRIVATE_HOSTS`.
   */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  logger?: Logger;
  metrics?: Metrics;
}

export interface AuditForwarderStats {
  /** Entries delivered with HTTP 2xx since process start. */
  entriesSent: number;
  /** Failed batch attempts since process start. */
  failures: number;
  /** Entries persisted in audit_log beyond the forwarded position. */
  lag: number;
}

export interface AuditForwarder {
  /** Starts the periodic loop (idempotent). */
  start(): void;
  /** Stops the periodic loop. */
  stop(): void;
  /**
   * Runs one drain cycle now, ignoring the backoff window — used by the
   * timer and by tests/shutdown paths.
   */
  forwardNow(): Promise<void>;
  /** Current counters for the lag gauge and diagnostics. */
  stats(): AuditForwarderStats;
}

interface ForwardRow {
  id: number | string;
  actor: string;
  role: string | null;
  action: string;
  target: string | null;
  outcome: string;
  details: unknown;
  created_at: string | Date;
  hash: string;
  prev_hash: string;
}

/**
 * Position store on `audit_forward_state` (migration 53). Mutable by design:
 * it is delivery bookkeeping, not evidence, so it must survive the audit
 * trail's append-only rules. Every method takes the pinned operator-plane
 * connection — the same one holding the sender advisory lock — so position
 * reads, batch reads, and position writes all share one session.
 */
const ForwardPositionStore = {
  async read(db: Database, target: string): Promise<number> {
    const rows = await db.query<{ last_id: number | string }>(
      `SELECT last_id FROM audit_forward_state WHERE target = $1`,
      [target],
    );
    const raw = rows[0]?.last_id;
    return raw === undefined ? 0 : Number(raw);
  },

  async write(db: Database, target: string, lastId: number): Promise<void> {
    await db.query(
      `INSERT INTO audit_forward_state (target, last_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (target) DO UPDATE
         SET last_id = EXCLUDED.last_id, updated_at = now()`,
      [target, lastId],
    );
  },
};

class PostgresAuditForwarder implements AuditForwarder {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Consecutive failed attempts — drives the exponential backoff. */
  private consecutiveFailures = 0;
  /** Wall-clock ms before which the timer skips the tick. */
  private backoffUntil = 0;
  private entriesSent = 0;
  private failures = 0;
  /** Last computed lag, refreshed after every drain; read by the metrics probe. */
  private lag = 0;

  constructor(
    private readonly db: Database,
    private readonly opts: AuditForwarderOptions,
  ) {
    this.batchSize = opts.batchSize ?? DEFAULT_AUDIT_FORWARD_BATCH_SIZE;
    this.intervalMs = opts.intervalMs ?? DEFAULT_AUDIT_FORWARD_INTERVAL_MS;
    this.fetchFn = opts.fetchFn ?? ((u, init) => egressFetch(u, init));
  }

  start(): void {
    if (this.timer !== undefined) return;
    // Immediate first drain, then the interval; unref so the timer alone
    // never keeps the process alive (same convention as the audit anchor).
    void this.forwardNow().catch(() => {});
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  stats(): AuditForwarderStats {
    return {
      entriesSent: this.entriesSent,
      failures: this.failures,
      lag: this.lag,
    };
  }

  private async tick(): Promise<void> {
    if (Date.now() < this.backoffUntil) return;
    await this.forwardNow().catch(() => {});
  }

  /**
   * One drain cycle under the single-sender advisory lock. The audit trail
   * lives on the operator plane (BYPASSRLS), and the session-level advisory
   * lock must be taken, held, and released on ONE pinned connection — so the
   * whole cycle runs on the operator connection pinned via
   * `withConnection`, exactly like `PostgresAuditLog.verifyChain`. Holding
   * that connection while a webhook responds is the honest trade for
   * "exactly one replica sends".
   */
  async forwardNow(): Promise<void> {
    if (this.running) return; // overlap guard within this process
    this.running = true;
    try {
      const run = async (db: Database): Promise<void> => {
        const lockRows = await db.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
          [AUDIT_FORWARD_LOCK_KEY],
        );
        if (lockRows[0]?.locked !== true) return; // another replica is sending
        try {
          await this.drain(db);
        } finally {
          await db
            .query(`SELECT pg_advisory_unlock(hashtext($1))`, [
              AUDIT_FORWARD_LOCK_KEY,
            ])
            .catch(() => {});
        }
      };
      const runPinned = (db: Database): Promise<void> =>
        db.withConnection !== undefined ? db.withConnection(run) : run(db);
      await this.db.withOperator((op) => runPinned(op));
    } finally {
      this.running = false;
    }
  }

  /** Send batches until the log is drained or a send fails. */
  private async drain(db: Database): Promise<void> {
    let lastId = await ForwardPositionStore.read(db, this.opts.url);
    for (;;) {
      const rows = await db.query<ForwardRow>(
        `SELECT id, actor, role, action, target, outcome, details, created_at, hash, prev_hash
           FROM audit_log WHERE id > $1 ORDER BY id ASC LIMIT $2`,
        [lastId, this.batchSize],
      );
      if (rows.length === 0) break;
      const records: AuditRecord[] = rows.map(auditRowToRecord);
      const body = records.map((r) => JSON.stringify(r)).join("\n");
      const headers: Record<string, string> = {
        "content-type": "application/x-ndjson",
      };
      if (this.opts.token !== undefined && this.opts.token !== "") {
        headers.authorization = `Bearer ${this.opts.token}`;
      }
      let res: Response;
      try {
        res = await this.fetchFn(this.opts.url, {
          method: "POST",
          headers,
          body,
        });
      } catch (err) {
        this.recordFailure(err, rows.length);
        return;
      }
      if (res.status < 200 || res.status >= 300) {
        this.opts.metrics?.recordCounter(
          "aiperator_audit_forward_failures_total",
          { status: String(res.status) },
        );
        this.failures += 1;
        this.consecutiveFailures += 1;
        this.backoffUntil = Date.now() + this.currentBackoffMs();
        this.opts.logger?.warn("Audit forwarding batch rejected; retrying later", {
          status: res.status,
          entries: rows.length,
          backoffMs: this.currentBackoffMs(),
        });
        return;
      }
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      lastId = Number(last.id);
      // Position advances only after HTTP 2xx — at-least-once, never a gap.
      await ForwardPositionStore.write(db, this.opts.url, lastId);
      this.entriesSent += rows.length;
      this.opts.metrics?.recordCounter(
        "aiperator_audit_forward_entries_total",
        {},
        rows.length,
      );
      this.consecutiveFailures = 0;
      this.backoffUntil = 0;
      if (rows.length < this.batchSize) break;
    }
    this.lag = await this.computeLag(db, lastId);
    this.opts.metrics?.setAuditForwardLagProbe?.(() => this.lag);
  }

  private async computeLag(db: Database, lastId: number): Promise<number> {
    try {
      const rows = await db.query<{ max_id: number | string | null }>(
        `SELECT MAX(id) AS max_id FROM audit_log`,
      );
      const maxId = Number(rows[0]?.max_id ?? 0);
      return Number.isFinite(maxId) ? Math.max(0, maxId - lastId) : 0;
    } catch {
      return 0;
    }
  }

  private currentBackoffMs(): number {
    const exp = Math.min(this.consecutiveFailures, 10);
    return Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.max(0, exp - 1));
  }

  private recordFailure(err: unknown, entries: number): void {
    this.opts.metrics?.recordCounter(
      "aiperator_audit_forward_failures_total",
      { error: "transport" },
    );
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.backoffUntil = Date.now() + this.currentBackoffMs();
    this.opts.logger?.warn("Audit forwarding batch failed; retrying later", {
      error: err instanceof Error ? err.message : String(err),
      entries,
      backoffMs: this.currentBackoffMs(),
    });
  }
}

/**
 * Build the SIEM forwarder. Returns `undefined` when forwarding is not
 * configured or the audit trail is not durable (in-memory audit_log has no
 * position to resume from — forwarding would resend everything after every
 * restart and lose nothing only by luck).
 */
export function createAuditForwarder(
  db: Database | undefined,
  opts: AuditForwarderOptions,
  logger?: Logger,
): AuditForwarder | undefined {
  if (opts.url === "") return undefined;
  if (db === undefined) {
    logger?.warn(
      "AUDIT_FORWARD_URL is set but no DATABASE_URL is configured — audit forwarding needs the durable audit log and stays disabled",
    );
    return undefined;
  }
  return new PostgresAuditForwarder(db, {
    ...opts,
    ...(logger !== undefined ? { logger } : {}),
  });
}
