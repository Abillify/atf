// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Req 1.5 (Task 3.8): jede Route einer Regulierten_Aktion muss
 * `recordRequired` verwenden — dieser Test scannt die Route-Quellen und
 * stellt sicher, dass keine regulierte Aktion auf best-effort `record()`
 * zurückfällt oder die Auditierung ganz verliert.
 *
 * Req 1.1–1.3 (Task 3.7, Properties 1 & 2): Kettenlinearität mit N
 * parallelen Writern und Genesis-Fehlerinjektion. Der Fake-Database-Stub
 * simuliert `pg_advisory_xact_lock` als transaktionalen Mutex — schreibt
 * der Produktionscode den Lock nicht (oder liest den Tip davor), zweigt
 * die Kette ab und der Property-Test schlägt fehl. Ein echter
 * Postgres-Paralleltest läuft env-gated über TEST_POSTGRES_URL.
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
// Task 3.8 — jede regulierte Aktion wird über recordRequired auditiert
// ---------------------------------------------------------------------------

const ROUTE_FILES = [
  "flows.ts",
  "control.ts",
  "tenants.ts",
  "compliance.ts",
];

describe("Regulierte Aktionen verwenden recordRequired (Req 1.5)", () => {
  const sources = ROUTE_FILES.map((file) => ({
    file,
    text: readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
  }));

  for (const action of REGULATED_ACTIONS) {
    test(`"${action}" wird per recordRequired auditiert`, () => {
      // recordRequired({ ... action: "<id>" ... }) — das action-Feld muss
      // innerhalb des Audit-Objekts der recordRequired-Call stehen.
      const pattern = new RegExp(
        `recordRequired\\(\\{[\\s\\S]{0,400}?action: "${action}"`,
      );
      const hit = sources.find((src) => pattern.test(src.text));
      expect(
        hit,
        `${action}: kein recordRequired-Aufruf mit action:"${action}" gefunden — ` +
          `Regulierte Aktionen dürfen nicht auf best-effort record() fallen (Req 1.5).`,
      ).toBeDefined();
    });
  }

  test("regulierte Routen liefern bei Audit-Fehler 503 AUDIT_UNAVAILABLE", () => {
    // Jede Datei mit recordRequired muss auch den 503-Fallback importieren.
    for (const src of sources) {
      if (!src.text.includes("recordRequired(")) continue;
      expect(src.text).toContain("AUDIT_UNAVAILABLE_BODY");
      expect(src.text).toContain("AUDIT_UNAVAILABLE_STATUS");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.7 — Properties 1 & 2: Kettenlinearität und Genesis-Verhalten
// ---------------------------------------------------------------------------

/**
 * Fake-Database, die die Postgres-Semantik der Ketten-Tabelle modelliert:
 * - `pg_advisory_xact_lock` wird als transaktionaler Mutex implementiert
 *   (hält bis COMMIT/ROLLBACK) — genau der Mechanismus, auf den sich der
 *   Produktionscode verlassen muss.
 * - Tip-Lesen/INSERT arbeiten auf gemeinsamen Zeilen, mit echten await-
 *   Punkten, damit parallele Aufrufer tatsächlich interleaven können.
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

  // Transaktionaler Mutex: simuliert pg_advisory_xact_lock mit sauberer
  // Übergabe (Handoff) an den nächsten Wartenden.
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
    // Der Lock wurde direkt an diesen Wartenden übergeben.
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
      // Jeder Query-Schritt gibt den Event-Loop frei → echte Interleaving-
      // Möglichkeiten für parallele recordRequired-Aufrufer.
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
      if (/^INSERT/i.test(trimmed)) {
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

describe("Audit-Kettenlinearität (Properties 1 & 2)", () => {
  test("N parallele Writer erzeugen eine lineare Kette ohne Abzweigung", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 24 }), async (n) => {
        const { db, rows } = lockedChainDb();
        const log = new PostgresAuditLog(db);
        const writers = Array.from({ length: n }, (_, i) =>
          log.recordRequired({ actor: `writer-${i}`, action: `a${i}` }),
        );
        await Promise.all(writers);
        expect(rows).toHaveLength(n);
        // Property 1: sortiert nach id bildet jede Zeile genau auf den Hash
        // der Vorgängerzeile — erste Zeile an Genesis, keine Abzweigung.
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

  test("nach einem Fehler wird die Kette am realen Tip fortgesetzt, nie neu bei Genesis (Property 2)", async () => {
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
          // Fehlerinjektion: Tip-Lesen und INSERT schlagen fehl.
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
          // Danach: keine Genesis-Neukette — der nächste Erfolg hängt sich an
          // den (unveränderten) Tip vor den Fehlern.
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

  // Env-gated: echter Postgres-Paralleltest gegen zwei PostgresAuditLog-
  // Instanzen (simuliert zwei Replicas). Läuft nur mit TEST_POSTGRES_URL.
  const pgUrl = process.env["TEST_POSTGRES_URL"];
  test.skipIf(pgUrl === undefined || pgUrl === "")(
    "zwei Replicas schreiben linear über den Advisory-Lock (echtes Postgres)",
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
        await sqlA.unsafe(`DELETE FROM audit_log`);
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
