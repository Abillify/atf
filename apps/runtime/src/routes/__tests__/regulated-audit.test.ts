// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Every route of a regulated action must use
 * `recordRequired`; this test scans the route sources and makes sure no
 * regulated action falls back to best-effort `record()` or loses auditing
 * altogether.
 *
 * Req 1.1–1.3 (Task 3.7, Properties 1 & 2): chain linearity with N
 * parallel writers and genesis fault injection. The fake database stub
 * simulates `pg_advisory_xact_lock` as a transactional mutex: if the
 * production code does not take the lock (or reads the tip before it), the
 * chain forks and the property test fails. A real Postgres parallel test
 * runs env-gated via TEST_POSTGRES_URL.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import type { Database } from "../../db/database.ts";
import { wrapBunSql } from "../../db/database.ts";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  PostgresAuditLog,
} from "../../observability/audit-log.ts";
import { REGULATED_ACTIONS } from "../../compliance/regulated-actions.ts";

// ---------------------------------------------------------------------------
// Task 3.8: every regulated action is audited via recordRequired
// ---------------------------------------------------------------------------

// flows.ts was split into flows-routes-* modules (Phase 18.4, Req 13.6); the
// scan covers the router root plus every module that can host a route.
const ROUTE_FILES = [
  "flows.ts",
  "flows-routes-list.ts",
  "flows-routes-source.ts",
  "flows-routes-catalog.ts",
  "flows-routes-crud.ts",
  "flows-routes-inspect.ts",
  "flows-routes-ops.ts",
  "control.ts",
  "tenants.ts",
  "compliance.ts",
];

describe("Regulated actions use recordRequired (Req 1.5)", () => {
  const sources = ROUTE_FILES.map((file) => ({
    file,
    text: readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
  }));

  for (const action of REGULATED_ACTIONS) {
    test(`"${action}" is audited via recordRequired`, () => {
      // recordRequired({ ... action: "<id>" ... }): the action field must be
      // inside the audit object of the recordRequired call.
      const pattern = new RegExp(
        `recordRequired\\(\\{[\\s\\S]{0,400}?action: "${action}"`,
      );
      const hit = sources.find((src) => pattern.test(src.text));
      expect(
        hit,
        `${action}: no recordRequired call with action:"${action}" found — ` +
          `regulated actions must not fall back to best-effort record() (Req 1.5).`,
      ).toBeDefined();
    });
  }

  test("regulated routes answer 503 AUDIT_UNAVAILABLE on an audit failure", () => {
    // Every file with recordRequired must also import the 503 fallback.
    for (const src of sources) {
      if (!src.text.includes("recordRequired(")) continue;
      expect(src.text).toContain("AUDIT_UNAVAILABLE_BODY");
      expect(src.text).toContain("AUDIT_UNAVAILABLE_STATUS");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.7: Properties 1 & 2: chain linearity and genesis behavior
// ---------------------------------------------------------------------------

/**
 * Fake database that models the Postgres semantics of the chain table:
 * - `pg_advisory_xact_lock` is implemented as a transactional mutex
 *   (held until COMMIT/ROLLBACK), exactly the mechanism the production
 *   code has to rely on.
 * - Tip read/INSERT work on shared rows with real await points, so
 *   parallel callers can actually interleave.
 */
function lockedChainDb(): {
  db: Database;
  rows: { id: number; hash: string | null; prev_hash: string | null }[];
  injectTipFailure: (fail: boolean) => void;
  injectInsertFailure: (fail: boolean) => void;
} {
  const rows: { id: number; hash: string | null; prev_hash: string | null }[] =
    [];
  let nextId = 1;
  let tipFails = false;
  let insertFails = false;

  // Transactional mutex: simulates pg_advisory_xact_lock with a clean
  // handoff to the next waiter.
  let locked = false;
  const waiters: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (!locked) {
      locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    // The lock was handed directly to this waiter.
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next !== undefined) next();
    else locked = false;
  };

  const db: Database = {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const trimmed = text.trim();
      // Every query step yields the event loop → real interleaving
      // opportunities for parallel recordRequired callers.
      await Promise.resolve();
      if (/pg_advisory_xact_lock/i.test(trimmed)) {
        await acquire();
        return [] as T[];
      }
      if (/^SELECT hash FROM/i.test(trimmed)) {
        if (tipFails) throw new Error("injected tip read failure");
        const tip = rows[rows.length - 1];
        return (tip === undefined ? [] : [{ hash: tip.hash }]) as unknown as T[];
      }
      if (/^SELECT nextval/i.test(trimmed)) {
        return [{ id: nextId++ }] as unknown as T[];
      }
      if (/^INSERT INTO audit_log\b/i.test(trimmed)) {
        if (insertFails) throw new Error("injected insert failure");
        const p = params ?? [];
        rows.push({
          id: Number(p[0]),
          hash: String(p[7]),
          prev_hash: String(p[8]),
        });
        return [] as T[];
      }
      if (/^(COMMIT|ROLLBACK)$/i.test(trimmed)) {
        release();
        return [] as T[];
      }
      return [] as T[];
    },
    async close() {},
    async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
      return cb(this);
    },
  };
  return {
    db,
    rows,
    injectTipFailure: (fail) => {
      tipFails = fail;
    },
    injectInsertFailure: (fail) => {
      insertFails = fail;
    },
  };
}

describe("Audit chain linearity (Properties 1 & 2)", () => {
  test("N parallel writers produce a linear chain without forks", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 24 }), async (n) => {
        const { db, rows } = lockedChainDb();
        const log = new PostgresAuditLog(db);
        const writers = Array.from({ length: n }, (_, i) =>
          log.recordRequired({ actor: `writer-${i}`, action: `a${i}` }),
        );
        await Promise.all(writers);
        expect(rows).toHaveLength(n);
        // Property 1: sorted by id, every row maps exactly onto the hash of
        // the previous row; the first row onto genesis, no forks.
        const sorted = [...rows].sort((a, b) => a.id - b.id);
        let expectedPrev = AUDIT_CHAIN_GENESIS_HASH;
        for (const row of sorted) {
          expect(row.prev_hash).toBe(expectedPrev);
          expect(row.hash).not.toBeNull();
          expectedPrev = row.hash ?? expectedPrev;
        }
      }),
      { numRuns: 25 },
    );
  });

  test("after a failure the chain continues at the real tip, never anew at genesis (Property 2)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        async (before, after) => {
          const { db, rows, injectTipFailure, injectInsertFailure } =
            lockedChainDb();
          const log = new PostgresAuditLog(db);
          for (let i = 0; i < before; i++) {
            await log.recordRequired({ actor: "a", action: `ok-${i}` });
          }
          const tipBefore = rows[rows.length - 1]?.hash;
          // Fault injection: tip read and INSERT fail.
          injectTipFailure(true);
          await expect(
            log.recordRequired({ actor: "a", action: "boom-tip" }),
          ).rejects.toThrow("injected tip read failure");
          injectTipFailure(false);
          injectInsertFailure(true);
          await expect(
            log.recordRequired({ actor: "a", action: "boom-insert" }),
          ).rejects.toThrow("injected insert failure");
          injectInsertFailure(false);
          // Afterwards: no new genesis chain; the next success attaches to
          // the (unchanged) tip from before the failures.
          for (let i = 0; i < after; i++) {
            await log.recordRequired({ actor: "a", action: `resume-${i}` });
          }
          const sorted = [...rows].sort((a, b) => a.id - b.id);
          expect(sorted).toHaveLength(before + after);
          let expectedPrev = AUDIT_CHAIN_GENESIS_HASH;
          for (const row of sorted) {
            expect(row.prev_hash).toBe(expectedPrev);
            expectedPrev = row.hash ?? expectedPrev;
          }
          expect(tipBefore).toBeDefined();
        },
      ),
      { numRuns: 20 },
    );
  });

  // Env-gated: real Postgres parallel test against two PostgresAuditLog
  // instances (simulates two replicas). Only runs with TEST_POSTGRES_URL.
  const pgUrl = process.env["TEST_POSTGRES_URL"];
  test.skipIf(pgUrl === undefined || pgUrl === "")(
    "two replicas write linearly through the advisory lock (real Postgres)",
    async () => {
      if (pgUrl === undefined || pgUrl === "") return;
      const sqlA = new Bun.SQL(pgUrl);
      const sqlB = new Bun.SQL(pgUrl);
      try {
        await sqlA.unsafe(
          `CREATE TABLE IF NOT EXISTS audit_log (
             id BIGSERIAL PRIMARY KEY,
             actor TEXT NOT NULL, role TEXT, action TEXT NOT NULL,
             target TEXT, outcome TEXT, details JSONB,
             hash TEXT, prev_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
           )`,
        );
        await sqlA.unsafe(
          `CREATE TABLE IF NOT EXISTS audit_chain_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        );
        await sqlA.unsafe(`DELETE FROM audit_log`);
        await sqlA.unsafe(`DELETE FROM audit_chain_meta`);
        const logA = new PostgresAuditLog(wrapBunSql(sqlA));
        const logB = new PostgresAuditLog(wrapBunSql(sqlB));
        const writes = Array.from({ length: 10 }, (_, i) =>
          (i % 2 === 0 ? logA : logB).recordRequired({
            actor: `replica-${i % 2}`,
            action: `p-${i}`,
          }),
        );
        await Promise.all(writes);
        const rows = (await sqlA.unsafe(
          `SELECT hash, prev_hash FROM audit_log ORDER BY id ASC`,
        )) as unknown as { hash: string; prev_hash: string }[];
        expect(rows).toHaveLength(10);
        let expectedPrev = AUDIT_CHAIN_GENESIS_HASH;
        for (const row of rows) {
          expect(row.prev_hash).toBe(expectedPrev);
          expectedPrev = row.hash;
        }
      } finally {
        await sqlA.close();
        await sqlB.close();
      }
    },
  );
});
