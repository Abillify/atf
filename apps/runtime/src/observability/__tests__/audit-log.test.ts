// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the operator audit log (`src/observability/audit-log.ts`).
 */

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
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
import { parseEvidenceSigningKey } from "../evidence-key.js";
import type { Database } from "../../db/database.js";

/** base64-encoded 32-byte Ed25519 seed for the evidence-key anchor tests. */
const SEED_B64 = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i + 1),
).toString("base64");

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
        if (/^INSERT INTO audit_log\b/i.test(trimmed)) {
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
        if (/^INSERT INTO audit_log\b/i.test(trimmed)) {
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
        if (/^INSERT INTO audit_log\b/i.test(trimmed)) {
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

  /**
   * Regression: Postgres `jsonb` does NOT preserve object key order — on
   * read-back the driver returns nested `details` keys in jsonb's own storage
   * order. The chain hash must therefore be independent of key order at every
   * depth, or verifyChain() reports false hash_mismatch failures against
   * Postgres for every record with nested details.
   */
  it("computeAuditHash is independent of details key order (jsonb round-trip)", () => {
    const detailsInsertionOrder = {
      zulu: 1,
      alpha: { delta: "d", bravo: { y: 2, x: 1 } },
      mike: [3, { q: 1, p: 2 }],
    };
    // Same values, keys inserted in a different order — what jsonb read-back
    // *may* hand back after Postgres has normalised its storage order.
    const detailsReordered = {
      mike: [3, { p: 2, q: 1 }],
      bravo_placeholder: undefined,
      alpha: { bravo: { x: 1, y: 2 }, delta: "d" },
      zulu: 1,
    } as Record<string, unknown>;
    delete detailsReordered.bravo_placeholder;

    const base = {
      id: 7,
      at: "2024-01-01T00:00:00.000Z",
      actor: "alice",
      role: undefined,
      action: "flows.publish",
      target: undefined,
      outcome: "success" as const,
    };
    const h1 = computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, {
      ...base,
      details: detailsInsertionOrder,
    });
    const h2 = computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, {
      ...base,
      details: detailsReordered,
    });
    expect(h1).toBe(h2);

    // Sensitivity preserved: a changed VALUE (not just order) still differs.
    const h3 = computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, {
      ...base,
      details: { ...detailsInsertionOrder, zulu: 2 },
    });
    expect(h3).not.toBe(h1);
  });

  it("verifyChain passes when stored details come back with reordered keys", async () => {
    // Simulate the Postgres flow: hash at write time with insertion order,
    // then verify from rows whose details have jsonb-normalised key order.
    const log = new InMemoryAuditLog();
    log.record({
      actor: "alice",
      action: "flows.publish",
      details: { zeta: 1, alpha: { y: { b: 2, a: 1 }, x: 0 }, mid: 5 },
    });
    log.record({ actor: "bob", action: "flows.delete" });

    const ascending = (await log.list({ limit: 100 })).slice().reverse();
    const first = ascending[0];
    if (first === undefined || first.details === undefined) {
      throw new Error("expected a first record with details");
    }
    // Rebuild the first record the way a jsonb read-back would deliver it.
    const jsonbStyleDetails = JSON.parse(
      '{"alpha":{"x":0,"y":{"a":1,"b":2}},"mid":5,"zeta":1}',
    ) as Record<string, unknown>;
    const asReadBack: AuditRecord[] = [
      { ...first, details: jsonbStyleDetails },
      ascending[1] as AuditRecord,
    ];
    const result = verifyAuditChain(asReadBack);
    expect(result.valid).toBe(true);
  });

  describe("legacy hash form (rows written before details were canonicalized)", () => {
    const base = {
      id: 1,
      at: "2024-01-01T00:00:00.000Z",
      actor: "alice",
      action: "flows.publish",
      outcome: "success" as const,
    };
    /** The pre-fix construction, replicated independently of the module. */
    const legacyHash = (
      prev: string,
      details: Record<string, unknown> | undefined,
    ): string =>
      createHash("sha256")
        .update(prev)
        .update(
          JSON.stringify({
            id: base.id,
            at: base.at,
            actor: base.actor,
            role: null,
            action: base.action,
            target: null,
            outcome: "success",
            details: details ?? null,
          }),
        )
        .digest("hex");
    const record = (
      details: Record<string, unknown> | undefined,
      hash: string,
    ): AuditRecord => ({
      ...base,
      ...(details !== undefined ? { details } : {}),
      hash,
      prevHash: AUDIT_CHAIN_GENESIS_HASH,
    });

    it("accepts a pre-fix row whose as-stored key order was not sorted, and counts it", () => {
      // jsonb order (shorter key first) == insertion order, but not sorted.
      const details = { to: "b", from: "a" };
      const rec = record(details, legacyHash(AUDIT_CHAIN_GENESIS_HASH, details));
      // Sanity: this row would NOT verify under the canonical form alone.
      expect(computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, rec)).not.toBe(rec.hash);
      const result = verifyAuditChain([rec]);
      expect(result.valid).toBe(true);
      expect(result.legacyForm).toBe(1);
    });

    it("a record without details is identical in both forms (no legacy count)", () => {
      const rec = record(undefined, legacyHash(AUDIT_CHAIN_GENESIS_HASH, undefined));
      const result = verifyAuditChain([rec]);
      expect(result.valid).toBe(true);
      expect(result.legacyForm).toBeUndefined();
    });

    it("rows hashed in canonical form are not counted as legacy", () => {
      const details = { b: 1, a: 2 };
      const rec = record(details, computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, { ...base, details }));
      const result = verifyAuditChain([rec]);
      expect(result.valid).toBe(true);
      expect(result.legacyForm).toBeUndefined();
    });

    it("the legacy allowance does not accept a changed VALUE", () => {
      const original = { to: "b", from: "a" };
      const rec = record(
        { to: "EVIL", from: "a" },
        legacyHash(AUDIT_CHAIN_GENESIS_HASH, original),
      );
      const result = verifyAuditChain([rec]);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toEqual({ id: 1, reason: "hash_mismatch" });
    });

    it("a legacy row whose key order was reordered after hashing stays unverifiable", () => {
      // Hashed as { zz, a } (insertion order, not sorted) but read back as
      // { a, zz } (jsonb order): indistinguishable from tampering, and a
      // false-positive before the fix as well. Documented, not papered over.
      const rec = record(
        { a: 2, zz: 1 },
        legacyHash(AUDIT_CHAIN_GENESIS_HASH, { zz: 1, a: 2 }),
      );
      expect(verifyAuditChain([rec]).valid).toBe(false);
    });

    describe("cut-off", () => {
      const details = { to: "b", from: "a" };
      const legacyRow = () => record(details, legacyHash(AUDIT_CHAIN_GENESIS_HASH, details));

      it("accepts the legacy form below the cut-off", () => {
        const result = verifyAuditChain([legacyRow()], { legacyCutoffId: 2 });
        expect(result.valid).toBe(true);
        expect(result.legacyForm).toBe(1);
      });

      it("rejects the legacy form at and after the cut-off", () => {
        for (const cutoff of [1, 0]) {
          const result = verifyAuditChain([legacyRow()], { legacyCutoffId: cutoff });
          expect(result.valid).toBe(false);
          expect(result.brokenAt).toEqual({ id: 1, reason: "legacy_hash_after_cutoff" });
          expect(result.message).toBe("legacy hash form after cut-off at id 1");
        }
      });

      it("without a cut-off the legacy form stays acceptable", () => {
        expect(verifyAuditChain([legacyRow()]).valid).toBe(true);
      });

      it("canonical rows verify on either side of the cut-off", () => {
        const canonical = record(
          { b: 1, a: 2 },
          computeAuditHash(AUDIT_CHAIN_GENESIS_HASH, { ...base, details: { b: 1, a: 2 } }),
        );
        expect(verifyAuditChain([canonical], { legacyCutoffId: 1 }).valid).toBe(true);
        expect(verifyAuditChain([canonical], { legacyCutoffId: 0 }).valid).toBe(true);
      });

      it("the in-memory log is canonical only", async () => {
        const log = new InMemoryAuditLog();
        log.record({ actor: "alice", action: "a", details: { b: 1, a: 2 } });
        expect((await log.verifyChain()).valid).toBe(true);
      });
    });

    it("a prev_hash mismatch is still detected on legacy-form rows", () => {
      const first = record(
        { to: "b", from: "a" },
        legacyHash(AUDIT_CHAIN_GENESIS_HASH, { to: "b", from: "a" }),
      );
      const second: AuditRecord = {
        ...first,
        id: 2,
        prevHash: "f".repeat(64),
        hash: "0".repeat(64),
      };
      const result = verifyAuditChain([first, second]);
      expect(result.valid).toBe(false);
    });
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

  it("signs an anchor with the Ed25519 evidence key (alg + kid stamped)", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const tip = { id: 7, hash: "tip-hash" };
    const anchor = signAuditAnchor(tip, key);
    expect(anchor.alg).toBe("ed25519");
    expect(anchor.kid).toBe(key.kid);
    expect(verifyAuditAnchor(anchor, tip, key).valid).toBe(true);
  });

  it("verifies an Ed25519 anchor with the PUBLIC key only — no secret", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const tip = { id: 7, hash: "tip-hash" };
    const anchor = signAuditAnchor(tip, key);
    // An independent auditor holds only the raw 32-byte public key.
    expect(verifyAuditAnchor(anchor, tip, key.publicKeyRaw).valid).toBe(true);
  });

  it("rejects an Ed25519 anchor under a foreign public key", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    const other = parseEvidenceSigningKey(
      Buffer.alloc(32, 9).toString("base64"),
    );
    if (key === undefined || other === undefined)
      throw new Error("expected keys");
    const tip = { id: 7, hash: "tip-hash" };
    const anchor = signAuditAnchor(tip, key);
    expect(verifyAuditAnchor(anchor, tip, other.publicKeyRaw).valid).toBe(
      false,
    );
  });

  it("rejects an Ed25519 anchor verified with only an HMAC secret", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const tip = { id: 7, hash: "tip-hash" };
    const anchor = signAuditAnchor(tip, key);
    const result = verifyAuditAnchor(anchor, tip, "some-hmac-secret");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects a legacy HMAC anchor verified with Ed25519 key material", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const tip = { id: 7, hash: "tip-hash" };
    const anchor = signAuditAnchor(tip, "legacy-hmac-secret");
    const result = verifyAuditAnchor(anchor, tip, key);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("detects a rewritten record under an Ed25519 anchor", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const tip = { id: 7, hash: "tip-hash" };
    const anchor = signAuditAnchor(tip, key);
    const result = verifyAuditAnchor(anchor, { id: 7, hash: "rewritten" }, key);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
  });
});
