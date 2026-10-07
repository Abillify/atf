// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the operator audit log (`src/observability/audit-log.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryAuditLog,
  PostgresAuditLog,
  createAuditLog,
  AUDIT_CHAIN_GENESIS_HASH,
  computeAuditHash,
  verifyAuditChain,
  signAuditAnchor,
  verifyAuditAnchor,
  type AuditRecord,
} from "../audit-log.js";
import type { Database } from "../../db/database.js";

describe("InMemoryAuditLog", () => {
  it("records and lists newest-first", async () => {
    const log = new InMemoryAuditLog();
    log.record({
      actor: "alice",
      role: "admin",
      action: "flows.publish",
      target: "f1",
    });
    log.record({
      actor: "bob",
      role: "operator",
      action: "approvals.resolve",
      target: "a1",
    });
    const list = await log.list();
    const [first, second] = list;
    if (first === undefined || second === undefined) {
      throw new Error("expected two audit records");
    }
    expect(first.actor).toBe("bob");
    expect(second.actor).toBe("alice");
    expect(first.id).toBeGreaterThan(second.id);
    expect(first.at).toBeDefined();
  });

  it("defaults outcome to success and respects explicit outcome", async () => {
    const log = new InMemoryAuditLog();
    log.record({ actor: "a", action: "x" });
    log.record({ actor: "a", action: "y", outcome: "denied" });
    const list = await log.list();
    const recordX = list.find((r) => r.action === "x");
    const recordY = list.find((r) => r.action === "y");
    if (recordX === undefined || recordY === undefined) {
      throw new Error("expected both records to be found");
    }
    expect(recordX.outcome).toBe("success");
    expect(recordY.outcome).toBe("denied");
  });

  it("filters by actor and action prefix", async () => {
    const log = new InMemoryAuditLog();
    log.record({ actor: "alice", action: "flows.publish" });
    log.record({ actor: "alice", action: "replay.run" });
    log.record({ actor: "bob", action: "flows.delete" });
    expect(await log.list({ actor: "alice" })).toHaveLength(2);
    expect(await log.list({ actionPrefix: "flows." })).toHaveLength(2);
    expect(
      await log.list({ actor: "alice", actionPrefix: "flows." }),
    ).toHaveLength(1);
  });

  it("honours and clamps the limit", async () => {
    const log = new InMemoryAuditLog();
    for (let i = 0; i < 10; i++) log.record({ actor: "a", action: `act${i}` });
    expect(await log.list({ limit: 3 })).toHaveLength(3);
    expect(await log.list({ limit: 0 })).toHaveLength(1); // clamped to >= 1
  });

  it("evicts oldest beyond the bound", async () => {
    const log = new InMemoryAuditLog(2);
    log.record({ actor: "a", action: "1" });
    log.record({ actor: "a", action: "2" });
    log.record({ actor: "a", action: "3" });
    const list = await log.list({ limit: 100 });
    expect(list.map((r) => r.action)).toEqual(["3", "2"]);
  });
});

describe("PostgresAuditLog", () => {
  it("writes through to the database and maps rows", async () => {
    const inserts: unknown[][] = [];
    const db: Database = {
      async query<T = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        const trimmed = text.trim();
        if (/^SELECT nextval/i.test(trimmed)) {
          return [{ id: 2 }] as unknown as T[];
        }
        if (/^INSERT/i.test(trimmed)) {
          inserts.push([...(params ?? [])]);
          return [] as T[];
        }
        if (/^SELECT hash FROM/i.test(trimmed)) {
          return [] as T[];
        }
        // SELECT (list query)
        return [
          {
            id: 2,
            actor: "alice",
            role: "admin",
            action: "flows.publish",
            target: "f1",
            outcome: "success",
            details: { version: 4 },
            created_at: new Date(0),
            hash: "deadbeef",
            prev_hash: AUDIT_CHAIN_GENESIS_HASH,
          },
        ] as unknown as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const log = new PostgresAuditLog(db);
    log.record({
      actor: "alice",
      role: "admin",
      action: "flows.publish",
      target: "f1",
      details: { version: 4 },
    });
    await log.flush?.();
    expect(inserts).toHaveLength(1);
    const firstInsert = inserts[0];
    if (firstInsert === undefined) throw new Error("expected a first insert");
    expect(firstInsert[1]).toBe("alice");

    const list = await log.list();
    const firstRecord = list[0];
    if (firstRecord === undefined) throw new Error("expected a first record");
    expect(firstRecord.actor).toBe("alice");
    expect(firstRecord.details).toEqual({ version: 4 });
  });

  it("falls back to the in-memory mirror when the query fails", async () => {
    const db: Database = {
      async query<T = Record<string, unknown>>(text: string): Promise<T[]> {
        const trimmed = text.trim();
        if (/^SELECT nextval/i.test(trimmed)) return [{ id: 1 }] as unknown as T[];
        if (/^SELECT hash FROM/i.test(trimmed)) return [] as T[];
        if (/^INSERT/i.test(trimmed)) return [] as T[];
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(trimmed)) return [] as T[];
        if (/pg_advisory_xact_lock/i.test(trimmed)) return [] as T[];
        throw new Error("db down"); // list()/reads fail
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const log = new PostgresAuditLog(db);
    log.record({ actor: "bob", action: "replay.run" });
    await log.flush?.();
    expect(log.writeFailures()).toBe(0); // the write itself succeeded
    const list = await log.list();
    const firstRecord = list[0];
    if (firstRecord === undefined) throw new Error("expected a first record");
    expect(firstRecord.actor).toBe("bob"); // served from mirror
  });

  /**
   * Fake Database with an in-memory row store: the tip SELECT reads the real
   * stored tip, INSERT appends — enough to exercise the transactional chain
   * write (Req 1.2/1.3) and inject tip-read failures.
   */
  function chainDb(opts: {
    failTipRead?: () => boolean;
    failInsert?: () => boolean;
  } = {}): {
    db: Database;
    rows: { id: number; hash: string | null; prev_hash: string | null }[];
    statements: string[];
  } {
    const rows: { id: number; hash: string | null; prev_hash: string | null }[] =
      [];
    const statements: string[] = [];
    let nextId = 1;
    const db: Database = {
      async query<T = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        const trimmed = text.trim();
        statements.push(trimmed.split("\n")[0] ?? trimmed);
        if (/^SELECT hash FROM/i.test(trimmed)) {
          if (opts.failTipRead?.() === true) throw new Error("tip read failed");
          const tip = rows[rows.length - 1];
          return (tip === undefined ? [] : [{ hash: tip.hash }]) as unknown as T[];
        }
        if (/^SELECT nextval/i.test(trimmed)) {
          return [{ id: nextId++ }] as unknown as T[];
        }
        if (/^INSERT/i.test(trimmed)) {
          if (opts.failInsert?.() === true) throw new Error("insert failed");
          const p = params ?? [];
          rows.push({
            id: Number(p[0]),
            hash: String(p[7]),
            prev_hash: String(p[8]),
          });
          return [] as T[];
        }
        return [] as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    return { db, rows, statements };
  }

  it("recordRequired resolves only after the row is durably written (Req 1.4)", async () => {
    const { db, rows } = chainDb();
    const log = new PostgresAuditLog(db);
    await log.recordRequired({ actor: "alice", action: "flows.publish" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prev_hash).toBe(AUDIT_CHAIN_GENESIS_HASH);
    expect(log.writeFailures()).toBe(0);
  });

  it("recordRequired rejects when the insert fails (Req 1.4)", async () => {
    const { db, rows } = chainDb({ failInsert: () => true });
    const log = new PostgresAuditLog(db);
    let failures = 0;
    log.onWriteFailure = () => {
      failures += 1;
    };
    expect(log.writeFailures()).toBe(0);
    await expect(
      log.recordRequired({ actor: "alice", action: "flows.publish" }),
    ).rejects.toThrow("insert failed");
    expect(rows).toHaveLength(0);
    expect(log.writeFailures()).toBe(1);
    expect(failures).toBe(1);
  });

  it("a failing tip read propagates instead of restarting the chain at genesis (Req 1.2/1.3)", async () => {
    let tipBroken = true;
    const { db, rows } = chainDb({ failTipRead: () => tipBroken });
    const log = new PostgresAuditLog(db);
    await expect(
      log.recordRequired({ actor: "alice", action: "a1" }),
    ).rejects.toThrow("tip read failed");
    expect(rows).toHaveLength(0);
    // Once the read recovers, the write must chain against the REAL tip —
    // never silently restart at genesis after an outage.
    tipBroken = false;
    await log.recordRequired({ actor: "alice", action: "a2" });
    await log.recordRequired({ actor: "alice", action: "a3" });
    expect(rows).toHaveLength(2);
    const [second, third] = rows;
    expect(second?.prev_hash).toBe(AUDIT_CHAIN_GENESIS_HASH); // table was empty
    expect(third?.prev_hash).toBe(second?.hash); // real chaining resumes
  });

  it("refuses to extend a tip row whose hash is NULL (corrupted chain)", async () => {
    const { db, rows } = chainDb();
    rows.push({ id: 0, hash: null, prev_hash: null }); // corrupted stored tip
    const log = new PostgresAuditLog(db);
    await expect(
      log.recordRequired({ actor: "alice", action: "a1" }),
    ).rejects.toThrow(/corrupted chain/i);
    expect(rows).toHaveLength(1); // nothing appended
  });

  it("tracks pendingWrites and writeFailures for best-effort record() (Req 1.6/1.9)", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db: Database = {
      async query<T = Record<string, unknown>>(text: string): Promise<T[]> {
        const trimmed = text.trim();
        if (/^INSERT/i.test(trimmed)) {
          await gate; // hold the write open so `pending` stays visible
          return [] as T[];
        }
        if (/^SELECT hash FROM/i.test(trimmed)) return [] as T[];
        if (/^SELECT nextval/i.test(trimmed)) return [{ id: 1 }] as unknown as T[];
        return [] as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const log = new PostgresAuditLog(db);
    log.record({ actor: "a", action: "x" });
    log.record({ actor: "a", action: "y" });
    expect(log.pendingWrites()).toBeGreaterThan(0);
    release?.();
    await log.flush?.();
    expect(log.pendingWrites()).toBe(0);
    expect(log.writeFailures()).toBe(0);
  });

  it("counts a failed best-effort record() without throwing (Req 1.9)", async () => {
    const { db } = chainDb({ failInsert: () => true });
    const log = new PostgresAuditLog(db);
    log.record({ actor: "a", action: "x" });
    await log.flush?.();
    expect(log.writeFailures()).toBe(1);
    expect(log.pendingWrites()).toBe(0);
  });
});

describe("createAuditLog", () => {
  it("returns in-memory when no db is given", () => {
    expect(createAuditLog()).toBeInstanceOf(InMemoryAuditLog);
  });
});

describe("hash chain", () => {
  it("chains records in InMemoryAuditLog and verifies clean", async () => {
    const log = new InMemoryAuditLog();
    log.record({ actor: "alice", action: "flows.publish", target: "f1" });
    log.record({ actor: "bob", action: "flows.delete", target: "f2" });
    log.record({ actor: "carol", action: "approvals.resolve", target: "a1" });

    const result = await log.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);

    const list = await log.list({ limit: 100 });
    // ascending id order (list() is newest-first, so reverse)
    const ascending = list.slice().reverse();
    const [first, second, third] = ascending;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected three ascending records");
    }
    expect(first.prevHash).toBe(AUDIT_CHAIN_GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
  });

  it("detects a tampered record (field mutation breaks hash)", async () => {
    const log = new InMemoryAuditLog();
    log.record({ actor: "alice", action: "flows.publish", target: "f1" });
    log.record({ actor: "bob", action: "flows.delete", target: "f2" });

    const list = (await log.list({ limit: 100 })).slice().reverse();
    const [first, second] = list;
    if (first === undefined || second === undefined) {
      throw new Error("expected two records");
    }
    const tampered: AuditRecord[] = [
      { ...first, actor: "mallory" }, // mutate first record's actor after the fact
      second,
    ];

    const result = verifyAuditChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toBe("hash_mismatch");
    expect(result.brokenAt?.id).toBe(first.id);
  });

  it("detects a reordered/deleted record (prevHash mismatch)", async () => {
    const log = new InMemoryAuditLog();
    log.record({ actor: "alice", action: "a1" });
    log.record({ actor: "alice", action: "a2" });
    log.record({ actor: "alice", action: "a3" });

    const ascending = (await log.list({ limit: 100 })).slice().reverse();
    // Remove the middle record — the chain from record 3 onward no longer
    // matches its stored prevHash against record 1's hash.
    const [first, , third] = ascending;
    if (first === undefined || third === undefined) {
      throw new Error("expected first and third records");
    }
    const withGap = [first, third];

    const result = verifyAuditChain(withGap);
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toBe("prev_hash_mismatch");
  });

  it("computeAuditHash is deterministic and sensitive to every field", () => {
    const base = {
      id: 1,
      at: "2024-01-01T00:00:00.000Z",
      actor: "alice",
      role: "admin" as string | undefined,
      action: "flows.publish",
      target: "f1" as string | undefined,
      outcome: "success" as const,
      details: { version: 1 } as Record<string, unknown> | undefined,
    };
    const h1 = computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, base);
    const h2 = computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, base);
    expect(h1).toBe(h2);

    const differentActor = computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, {
      ...base,
      actor: "mallory",
    });
    expect(differentActor).not.toBe(h1);

    const differentPrev = computeAuditHash("f".repeat(64), base);
    expect(differentPrev).not.toBe(h1);
  });

  it("PostgresAuditLog.verifyChain verifies the full chain via ASC query", async () => {
    const rows = [
      {
        id: 1,
        actor: "alice",
        role: null,
        action: "a1",
        target: null,
        outcome: "success",
        details: null,
        created_at: new Date(0),
        hash: "",
        prev_hash: AUDIT_CHAIN_GENESIS_HASH,
      },
      {
        id: 2,
        actor: "bob",
        role: null,
        action: "a2",
        target: null,
        outcome: "success",
        details: null,
        created_at: new Date(1),
        hash: "",
        prev_hash: "",
      },
    ];
    const [row1, row2] = rows;
    if (row1 === undefined || row2 === undefined) {
      throw new Error("expected two rows");
    }
    row1.hash = computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, {
      id: 1,
      at: row1.created_at.toISOString(),
      actor: "alice",
      role: undefined,
      action: "a1",
      target: undefined,
      outcome: "success",
      details: undefined,
    });
    row2.prev_hash = row1.hash;
    row2.hash = computeAuditHash(row1.hash, {
      id: 2,
      at: row2.created_at.toISOString(),
      actor: "bob",
      role: undefined,
      action: "a2",
      target: undefined,
      outcome: "success",
      details: undefined,
    });

    const db: Database = {
      async query<T = Record<string, unknown>>(text: string): Promise<T[]> {
        if (/ORDER BY id ASC/i.test(text)) return rows as unknown as T[];
        return [] as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const log = new PostgresAuditLog(db);
    const result = await log.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
  });

  it("PostgresAuditLog.verifyChain falls back to mirror on query failure", async () => {
    const db: Database = {
      async query<T = Record<string, unknown>>(): Promise<T[]> {
        throw new Error("db down");
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const log = new PostgresAuditLog(db);
    const result = await log.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(0);
  });
});

describe("external anchoring", () => {
  it("signs and verifies an anchor against an unchanged tip", () => {
    const tip = { id: 42, hash: "abc123" };
    const secret = "test-secret";
    const anchor = signAuditAnchor(tip, secret);
    expect(anchor.uptoId).toBe(42);
    expect(anchor.tipHash).toBe("abc123");

    const result = verifyAuditAnchor(anchor, tip, secret);
    expect(result.valid).toBe(true);
  });

  it("rejects an anchor when the record's hash changed since anchoring", () => {
    const tip = { id: 42, hash: "abc123" };
    const anchor = signAuditAnchor(tip, "secret");
    const rewritten = { id: 42, hash: "rewritten-hash" };
    const result = verifyAuditAnchor(anchor, rewritten, "secret");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
  });

  it("rejects an anchor when the record no longer exists", () => {
    const anchor = signAuditAnchor({ id: 42, hash: "abc123" }, "secret");
    const result = verifyAuditAnchor(anchor, undefined, "secret");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("record_not_found");
  });

  it("rejects an anchor verified under the wrong secret", () => {
    const tip = { id: 42, hash: "abc123" };
    const anchor = signAuditAnchor(tip, "secret-a");
    const result = verifyAuditAnchor(anchor, tip, "secret-b");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });
});
