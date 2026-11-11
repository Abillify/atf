// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Artur Krueger

/**
 * Tests for the audit SIEM forwarder (review follow-up G3): batching,
 * at-least-once position semantics (retry after 500, no gap after restart),
 * single-sender election via advisory lock, and Egress_Guard rejection of
 * private-address targets.
 */

import { describe, expect, test } from "bun:test";
import type { Database } from "../../db/database.js";
import { createRuntimeEgress } from "../../security/egress.js";
import {
  AUDIT_FORWARD_LOCK_KEY,
  createAuditForwarder,
  type AuditForwarder,
} from "../audit-forwarder.js";
import type { Metrics } from "../metrics.js";

// ---------------------------------------------------------------------------
// Fake Postgres: an in-memory audit_log plus the audit_forward_state row,
// scripted advisory-lock behavior, and a recording fetch seam.
// ---------------------------------------------------------------------------

interface FakeRow {
  id: number;
  actor: string;
  role: string | null;
  action: string;
  target: string | null;
  outcome: string;
  details: unknown;
  created_at: string;
  hash: string;
  prev_hash: string;
}

interface FakeOptions {
  /** Rows in audit_log, ascending by id. */
  rows: FakeRow[];
  /** Persisted forward position (survives "restarts" via this object). */
  state: { lastId: number };
  /** When false, pg_try_advisory_lock returns false (another sender holds it). */
  lockAvailable?: boolean;
}

function makeRow(id: number): FakeRow {
  return {
    id,
    actor: `user-${id}`,
    role: "operator",
    action: "test.action",
    target: `target-${id}`,
    outcome: "success",
    details: { n: id },
    created_at: `2026-06-0${(id % 9) + 1}T00:00:00.000Z`,
    hash: `h${id}`,
    prev_hash: `h${id - 1}`,
  };
}

function fakeDb(opts: FakeOptions): Database {
  const lockAvailable = opts.lockAvailable ?? true;
  const query = async (
    text: string,
    params?: readonly unknown[],
    // biome-ignore lint/suspicious/noExplicitAny: scripted fake returns heterogeneous rows
  ): Promise<any[]> => {
    if (text.includes("pg_try_advisory_lock")) {
      expect(params?.[0]).toBe(AUDIT_FORWARD_LOCK_KEY);
      return [{ locked: lockAvailable }];
    }
    if (text.includes("pg_advisory_unlock")) return [{ unlocked: true }];
    if (text.includes("SELECT last_id FROM audit_forward_state")) {
      return opts.state.lastId > 0 ? [{ last_id: opts.state.lastId }] : [];
    }
    if (text.includes("INSERT INTO audit_forward_state")) {
      opts.state.lastId = Number(params?.[1]);
      return [];
    }
    if (text.includes("MAX(id)")) {
      const max = opts.rows.reduce((m, r) => Math.max(m, r.id), 0);
      return [{ max_id: max }];
    }
    if (text.includes("FROM audit_log")) {
      const after = Number(params?.[0]);
      const limit = Number(params?.[1]);
      return opts.rows.filter((r) => r.id > after).slice(0, limit);
    }
    throw new Error(`Unexpected SQL: ${text}`);
  };
  const db: Database = {
    query,
    close: async () => {},
    withOperator: async <T>(cb: (db: Database) => Promise<T>): Promise<T> =>
      cb(db),
  };
  return db;
}

interface SentBatch {
  url: string;
  headers: Record<string, string>;
  lines: string[];
}

function recordingFetch(
  responder: (batch: SentBatch, attempt: number) => number,
): {
  calls: SentBatch[];
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: SentBatch[] = [];
  const fetchFn = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    const body = String(init.body ?? "");
    const batch: SentBatch = {
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      lines: body === "" ? [] : body.split("\n"),
    };
    calls.push(batch);
    const status = responder(batch, calls.length);
    return new Response("", { status });
  };
  return { calls, fetchFn };
}

const URL = "https://siem.example.com/ingest/audit";

/** Unwrap a forwarder the tests expect to exist, failing loudly if not. */
function mustForwarder(
  db: Database,
  opts: Parameters<typeof createAuditForwarder>[1],
): AuditForwarder {
  const fwd = createAuditForwarder(db, opts);
  if (fwd === undefined) throw new Error("expected a forwarder");
  return fwd;
}

// ---------------------------------------------------------------------------

describe("createAuditForwarder", () => {
  test("disabled without a URL or without a durable audit log", () => {
    const state = { lastId: 0 };
    const db = fakeDb({ rows: [], state });
    expect(
      createAuditForwarder(db, { url: "", fetchFn: async () => new Response() }),
    ).toBeUndefined();
    expect(
      createAuditForwarder(undefined, {
        url: URL,
        fetchFn: async () => new Response(),
      }),
    ).toBeUndefined();
    expect(createAuditForwarder(db, { url: URL })).toBeDefined();
  });

  test("batches entries as NDJSON and advances the position per batch", async () => {
    const rows = [1, 2, 3, 4, 5].map(makeRow);
    const state = { lastId: 0 };
    const db = fakeDb({ rows, state });
    const { calls, fetchFn } = recordingFetch(() => 202);
    const fwd = mustForwarder(db, {
      url: URL,
      token: "s-i-e-m-token-1234567890",
      batchSize: 2,
      fetchFn,
    });
    expect(fwd).toBeDefined();
    await fwd.forwardNow();

    // 5 rows, batch size 2 → three batches: 2 + 2 + 1.
    expect(calls.map((c) => c.lines.length)).toEqual([2, 2, 1]);
    const ids = calls.flatMap((c) =>
      c.lines.map((l) => (JSON.parse(l) as { id: number }).id),
    );
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    // Wire shape: the same record fields the export endpoint serves.
    const firstBatch = calls[0];
    if (firstBatch === undefined) throw new Error("expected a batch");
    const firstLine = firstBatch.lines[0];
    if (firstLine === undefined) throw new Error("expected a line");
    const first = JSON.parse(firstLine) as Record<string, unknown>;
    expect(first).toMatchObject({
      id: 1,
      actor: "user-1",
      role: "operator",
      action: "test.action",
      target: "target-1",
      outcome: "success",
      details: { n: 1 },
      hash: "h1",
      prevHash: "h0",
    });
    expect(typeof first.at).toBe("string");
    // Every request: NDJSON content type and the bearer token.
    for (const c of calls) {
      expect(c.url).toBe(URL);
      expect(c.headers["content-type"]).toBe("application/x-ndjson");
      expect(c.headers.authorization).toBe("Bearer s-i-e-m-token-1234567890");
    }
    expect(state.lastId).toBe(5);
    expect(fwd.stats()).toMatchObject({ entriesSent: 5, failures: 0 });
  });

  test("no token → no authorization header", async () => {
    const state = { lastId: 0 };
    const db = fakeDb({ rows: [makeRow(1)], state });
    const { calls, fetchFn } = recordingFetch(() => 200);
    const fwd = mustForwarder(db, { url: URL, fetchFn });
    await fwd.forwardNow();
    expect(calls).toHaveLength(1);
    const only = calls[0];
    if (only === undefined) throw new Error("expected a batch");
    expect(only.headers.authorization).toBeUndefined();
  });

  test("HTTP 500: position stays, retry later delivers without gaps or duplicates", async () => {
    const rows = [1, 2, 3].map(makeRow);
    const state = { lastId: 0 };
    const db = fakeDb({ rows, state });
    const { calls, fetchFn } = recordingFetch((_b, attempt) =>
      attempt === 1 ? 500 : 200,
    );
    const fwd = mustForwarder(db, {
      url: URL,
      batchSize: 10,
      fetchFn,
    });
    await fwd.forwardNow();
    // Failed batch must NOT advance the position.
    expect(state.lastId).toBe(0);
    expect(fwd.stats()).toMatchObject({ entriesSent: 0, failures: 1 });

    // The backoff only gates the timer; an explicit cycle retries immediately.
    await fwd.forwardNow();
    expect(state.lastId).toBe(3);
    expect(calls).toHaveLength(2);
    // The retry re-sends the same batch (at-least-once) — and nothing was skipped.
    const retry = calls[1];
    if (retry === undefined) throw new Error("expected a retry batch");
    const ids = retry.lines.map((l) => (JSON.parse(l) as { id: number }).id);
    expect(ids).toEqual([1, 2, 3]);
    expect(fwd.stats()).toMatchObject({ entriesSent: 3, failures: 1 });
  });

  test("transport failure mid-log: drained batches keep their position, remainder resumes", async () => {
    const rows = [1, 2, 3, 4].map(makeRow);
    const state = { lastId: 0 };
    const db = fakeDb({ rows, state });
    const { calls, fetchFn } = recordingFetch((_b, attempt) =>
      attempt === 2 ? 503 : 200,
    );
    const fwd = mustForwarder(db, {
      url: URL,
      batchSize: 2,
      fetchFn,
    });
    await fwd.forwardNow();
    // First batch delivered, second rejected → drain stops at 2.
    expect(state.lastId).toBe(2);
    expect(calls).toHaveLength(2);

    await fwd.forwardNow();
    // Resumes exactly where it stopped: no gap, no duplicate of ids 1–2.
    const resumed = calls
      .slice(2)
      .flatMap((c) => c.lines.map((l) => (JSON.parse(l) as { id: number }).id));
    expect(resumed).toEqual([3, 4]);
    expect(state.lastId).toBe(4);
  });

  test("restart resumes from the persisted position — no gap, no resend", async () => {
    const rows = [1, 2, 3, 4, 5, 6].map(makeRow);
    // Shared state simulates the audit_forward_state table across restarts.
    const state = { lastId: 0 };
    const first = recordingFetch(() => 200);
    const fwdA = mustForwarder(fakeDb({ rows: rows.slice(0, 3), state }), {
      url: URL,
      batchSize: 10,
      fetchFn: first.fetchFn,
    });
    await fwdA.forwardNow();
    expect(state.lastId).toBe(3);

    // "Restart": a fresh forwarder against the same table, now with more rows.
    const second = recordingFetch(() => 200);
    const fwdB = mustForwarder(fakeDb({ rows, state }), {
      url: URL,
      batchSize: 10,
      fetchFn: second.fetchFn,
    });
    await fwdB.forwardNow();
    const ids = second.calls.flatMap((c) =>
      c.lines.map((l) => (JSON.parse(l) as { id: number }).id),
    );
    expect(ids).toEqual([4, 5, 6]);
    expect(state.lastId).toBe(6);
  });

  test("advisory lock held by another replica → this instance sends nothing", async () => {
    const state = { lastId: 0 };
    const db = fakeDb({ rows: [makeRow(1)], state, lockAvailable: false });
    const { calls, fetchFn } = recordingFetch(() => 200);
    const fwd = mustForwarder(db, { url: URL, fetchFn });
    await fwd.forwardNow();
    expect(calls).toHaveLength(0);
    expect(state.lastId).toBe(0);
    expect(fwd.stats()).toMatchObject({ entriesSent: 0, failures: 0 });
  });

  test("two forwarders on one database: the lock winner sends, the loser skips", async () => {
    const rows = [1, 2].map(makeRow);
    const state = { lastId: 0 };
    // A shared "session" flag models the session-level advisory lock: the
    // first taker wins until it unlocks; the second sees false.
    let lockHeld = false;
    const dbWithLock = (): Database => {
      const base = fakeDb({ rows, state });
      return {
        ...base,
        query: ((text: string, params?: readonly unknown[]) => {
          if (text.includes("pg_try_advisory_lock")) {
            const got = !lockHeld;
            if (got) lockHeld = true;
            return Promise.resolve([{ locked: got }]);
          }
          if (text.includes("pg_advisory_unlock")) {
            lockHeld = false;
            return Promise.resolve([{ unlocked: true }]);
          }
          return base.query(text, params);
        }) as Database["query"],
      };
    };
    const a = recordingFetch(() => 200);
    const b = recordingFetch(() => 200);
    const fwdA = mustForwarder(dbWithLock(), {
      url: URL,
      fetchFn: a.fetchFn,
    });
    const fwdB = mustForwarder(dbWithLock(), {
      url: URL,
      fetchFn: b.fetchFn,
    });
    // Sequential cycles: A takes the lock and drains; B then finds the log
    // empty (position already at the tip) and sends nothing.
    await fwdA.forwardNow();
    await fwdB.forwardNow();
    expect(a.calls.flatMap((c) => c.lines)).toHaveLength(2);
    expect(b.calls).toHaveLength(0);
    expect(state.lastId).toBe(2);
  });

  test("private-address target is rejected by the Egress_Guard without an allow-list", async () => {
    const rows = [makeRow(1)];
    const state = { lastId: 0 };
    const db = fakeDb({ rows, state });
    // Real guard (no EGRESS_ALLOW_PRIVATE_HOSTS): loopback and RFC1918 targets
    // must throw before any request leaves the process.
    const guard = createRuntimeEgress({});
    const fwd = mustForwarder(db, {
      url: "http://127.0.0.1:9/nope",
      batchSize: 10,
      fetchFn: (u, init) => guard.fetch(u, init),
    });
    await fwd.forwardNow();
    expect(state.lastId).toBe(0);
    expect(fwd.stats()).toMatchObject({ entriesSent: 0, failures: 1 });

    const fwdRfc1918 = mustForwarder(db, {
      url: "https://10.0.0.5/ingest",
      batchSize: 10,
      fetchFn: (u, init) => guard.fetch(u, init),
    });
    await fwdRfc1918.forwardNow();
    expect(state.lastId).toBe(0);
    expect(fwdRfc1918.stats().failures).toBe(1);
  });

  test("lag reflects entries that arrived while draining", async () => {
    const rows = [1, 2].map(makeRow);
    const state = { lastId: 0 };
    const db = fakeDb({ rows, state });
    // The audit trail grows while the (slow) webhook is being called: the
    // drain finishes at id 2, the fresh tip is 5 → lag 3.
    const { fetchFn } = recordingFetch(() => {
      rows.push(makeRow(3), makeRow(4), makeRow(5));
      return 200;
    });
    const fwd = mustForwarder(db, {
      url: URL,
      batchSize: 10,
      fetchFn,
    });
    await fwd.forwardNow();
    expect(state.lastId).toBe(2);
    expect(fwd.stats().lag).toBe(3);

    // A following drain delivers the rest and the lag clears.
    const { fetchFn: fetch2 } = recordingFetch(() => 200);
    const fwd2 = mustForwarder(fakeDb({ rows, state }), {
      url: URL,
      batchSize: 10,
      fetchFn: fetch2,
    });
    await fwd2.forwardNow();
    expect(state.lastId).toBe(5);
    expect(fwd2.stats().lag).toBe(0);
  });

  test("metrics: entries counter, failure counter, and lag probe", async () => {
    const seen: Array<{ name: string; labels: Record<string, string>; by: number }> = [];
    let lagProbe: (() => number) | undefined;
    const metrics = {
      recordCounter: (
        name: string,
        labels: Record<string, string>,
        by?: number,
      ) => {
        seen.push({ name, labels, by: by ?? 1 });
      },
      setAuditForwardLagProbe: (probe: () => number) => {
        lagProbe = probe;
      },
    } as unknown as Metrics;
    const rows = [1, 2, 3].map(makeRow);
    const state = { lastId: 0 };
    const db = fakeDb({ rows, state });
    const { fetchFn } = recordingFetch(() => 200);
    const fwd = mustForwarder(db, {
      url: URL,
      batchSize: 2,
      fetchFn,
      metrics,
    });
    await fwd.forwardNow();
    expect(
      seen.filter((s) => s.name === "aiperator_audit_forward_entries_total"),
    ).toEqual([
      { name: "aiperator_audit_forward_entries_total", labels: {}, by: 2 },
      { name: "aiperator_audit_forward_entries_total", labels: {}, by: 1 },
    ]);
    expect(lagProbe).toBeDefined();
    const probe = lagProbe;
    if (probe === undefined) throw new Error("expected a lag probe");
    expect(probe()).toBe(0);

    // A rejected batch records a failure counter with the status label.
    const failing = recordingFetch(() => 429);
    const fwd2 = mustForwarder(fakeDb({ rows, state: { lastId: 0 } }), {
      url: URL,
      batchSize: 10,
      fetchFn: failing.fetchFn,
      metrics,
    });
    await fwd2.forwardNow();
    expect(
      seen.some(
        (s) =>
          s.name === "aiperator_audit_forward_failures_total" &&
          s.labels.status === "429",
      ),
    ).toBe(true);
  });

  test("start/stop is idempotent and stop halts the timer", async () => {
    const state = { lastId: 0 };
    const db = fakeDb({ rows: [], state });
    const { fetchFn } = recordingFetch(() => 200);
    const fwd = mustForwarder(db, {
      url: URL,
      intervalMs: 60_000,
      fetchFn,
    });
    expect(() => {
      fwd.start();
      fwd.start();
      fwd.stop();
      fwd.stop();
    }).not.toThrow();
  });
});
