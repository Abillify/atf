// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Audit hash chain against a REAL Postgres.
 *
 * The defect: `details` is stored in a `jsonb` column, and `jsonb` does not
 * preserve key order (it stores keys by length, then bytes). A hash computed
 * over the insertion-ordered object no longer matched the same record after a
 * round-trip, so `verifyChain()` reported false `hash_mismatch` on every row
 * with multi-key details. The unit tests simulate that reorder with
 * `JSON.parse`; this suite proves it against the real database engine,
 * including the number normalisation `jsonb` performs, and pins the
 * legacy-form fallback for rows written before the fix.
 *
 * Env-gated via TEST_POSTGRES_URL (wired in the CI test job). Uses the shared
 * `audit_log` table the same way `regulated-audit.test.ts` does (created if
 * missing, WITHOUT the immutability trigger, emptied first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { wrapBunSql, type Database } from "../../db/database.js";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  PostgresAuditLog,
} from "../audit-log.js";

const PG_URL = process.env["TEST_POSTGRES_URL"];

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "audit hash chain · real Postgres jsonb round-trip",
  () => {
    let sql: InstanceType<typeof Bun.SQL>;
    let db: Database;

    const rawRows = async () =>
      (await sql.unsafe(
        `SELECT id, details::text AS details_text, hash, prev_hash FROM audit_log ORDER BY id ASC`,
      )) as unknown as {
        id: number | string;
        details_text: string | null;
        hash: string;
        prev_hash: string;
      }[];

    beforeAll(async () => {
      sql = new Bun.SQL(PG_URL ?? "");
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS audit_log (
           id BIGSERIAL PRIMARY KEY,
           actor TEXT NOT NULL, role TEXT, action TEXT NOT NULL,
           target TEXT, outcome TEXT, details JSONB,
           hash TEXT, prev_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      db = wrapBunSql(sql);
    });

    afterAll(async () => {
      await sql?.unsafe(`DELETE FROM audit_log`).catch(() => {});
      await sql?.close();
    });

    test("multi-key, nested and numeric details verify after the jsonb round-trip", async () => {
      await sql.unsafe(`DELETE FROM audit_log`);
      const log = new PostgresAuditLog(db);
      // Keys deliberately NOT in jsonb storage order (length, then bytes) and
      // NOT sorted; numbers that jsonb re-renders; unicode; array of objects.
      const inserted = [
        {
          zeta_long_key: 1,
          a: { yy: [1, { q: 1, pp: 2 }], x: 1.5 },
          mid: "ü€😀",
        },
        { to: "b", from: "a", big: 1e21, small: 0.1, whole: 1.0, neg: -0 },
        { z: null, nested: { deep: { deeper: { b: 2, a: 1 } } } },
      ];
      for (const [i, details] of inserted.entries()) {
        await log.recordRequired({
          actor: "alice",
          action: `flows.publish.${i}`,
          details,
        });
      }

      // The test is only meaningful if jsonb really reordered at least one row.
      const rows = await rawRows();
      const reordered = rows.some((r, i) => {
        const stored = Object.keys(
          JSON.parse(r.details_text ?? "{}") as Record<string, unknown>,
        );
        return stored.join() !== Object.keys(inserted[i] ?? {}).join();
      });
      expect(reordered).toBe(true);

      const result = await log.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.checked).toBe(3);
      expect(result.legacyForm).toBeUndefined();
    });

    test("a tampered VALUE in the stored details is detected", async () => {
      await sql.unsafe(`DELETE FROM audit_log`);
      const log = new PostgresAuditLog(db);
      await log.recordRequired({
        actor: "alice",
        action: "flows.delete",
        details: { flow: "f1", reason: "cleanup" },
      });
      await log.recordRequired({ actor: "bob", action: "flows.publish" });
      await sql.unsafe(
        `UPDATE audit_log SET details = '{"flow":"f1","reason":"cover-up"}'::jsonb WHERE id = (SELECT min(id) FROM audit_log)`,
      );
      const result = await log.verifyChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt?.reason).toBe("hash_mismatch");
    });

    test("a row hashed in the pre-fix form (as-stored key order) still verifies and is counted", async () => {
      await sql.unsafe(`DELETE FROM audit_log`);
      const log = new PostgresAuditLog(db);
      await log.recordRequired({ actor: "alice", action: "first" });

      // Emulate a row written before details were canonicalized: insertion
      // order { to, from } == jsonb storage order (shorter key first), but NOT
      // key-sorted ({ from, to }), so only the legacy form can match.
      const tip = (await rawRows()).at(-1);
      if (tip === undefined) throw new Error("expected a tip row");
      const idRows = (await sql.unsafe(
        `SELECT nextval(pg_get_serial_sequence('audit_log', 'id')) AS id`,
      )) as unknown as { id: number | string }[];
      const id = Number(idRows[0]?.id);
      const at = new Date().toISOString();
      const details = { to: "b", from: "a" };
      const legacyHash = createHash("sha256")
        .update(tip.hash)
        .update(
          JSON.stringify({
            id,
            at,
            actor: "mallory-free",
            role: null,
            action: "legacy.row",
            target: null,
            outcome: "success",
            details,
          }),
        )
        .digest("hex");
      await sql.unsafe(
        `INSERT INTO audit_log (id, actor, role, action, target, outcome, details, hash, prev_hash, created_at)
         VALUES ($1, 'mallory-free', NULL, 'legacy.row', NULL, 'success', $2::jsonb, $3, $4, $5)`,
        [id, JSON.stringify(details), legacyHash, tip.hash, at],
      );

      const result = await log.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.checked).toBe(2);
      expect(result.legacyForm).toBe(1);

      // The legacy allowance does not weaken value tamper-evidence.
      await sql.unsafe(
        `UPDATE audit_log SET details = '{"to":"EVIL","from":"a"}'::jsonb WHERE id = $1`,
        [id],
      );
      const tampered = await log.verifyChain();
      expect(tampered.valid).toBe(false);
      expect(tampered.brokenAt).toEqual({ id, reason: "hash_mismatch" });
    });

    test("the genesis hash anchors the first row", async () => {
      await sql.unsafe(`DELETE FROM audit_log`);
      const log = new PostgresAuditLog(db);
      await log.recordRequired({ actor: "alice", action: "only" });
      expect((await rawRows())[0]?.prev_hash).toBe(AUDIT_CHAIN_GENESIS_HASH);
    });
  },
);
