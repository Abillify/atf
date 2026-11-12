// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared transparency log against a real Postgres (ADR 0039): several log
 * instances — standing in for replicas — append concurrently into one
 * `receipt_log`, and every instance then sees one gapless leaf order, one
 * root, and proofs that verify no matter which instance produced them.
 *
 * Env-gated via TEST_POSTGRES_URL (wired in the CI test job). Each test uses
 * fresh tables, created with the migration-46 columns.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../../db/database.js";
import { PostgresTransparencyLog } from "../postgres-transparency-log.js";
import {
  bytesToHex,
  InMemoryTransparencyLog,
  merkleLeafHash,
  merkleNodeHash,
  subtreeRoot,
  verifyReceiptInclusion,
} from "../transparency-log.js";

const PG_URL = process.env["TEST_POSTGRES_URL"];

async function keyPair(): Promise<{ privateKey: CryptoKey; publicKeyRaw: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    publicKeyRaw: new Uint8Array(Buffer.from(jwk.x as string, "base64url")),
  };
}

function receiptBytes(i: number): Uint8Array {
  return new TextEncoder().encode(`receipt-body-${i}-${"x".repeat(i % 7)}`);
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "PostgresTransparencyLog (real Postgres)",
  () => {
    let db: Database;

    beforeAll(async () => {
      const created = await createDatabase(PG_URL ?? "");
      if (created === undefined) throw new Error("createDatabase returned undefined");
      db = created;
    });

    beforeEach(async () => {
      await db.query(`DROP TABLE IF EXISTS receipt_log`);
      await db.query(`DROP TABLE IF EXISTS receipt_tree_heads`);
      await db.query(
        `CREATE TABLE receipt_log (
           seq         BIGSERIAL PRIMARY KEY,
           receipt_id  TEXT NOT NULL UNIQUE,
           leaf_hash   TEXT NOT NULL,
           cose_bytes  TEXT NOT NULL,
           appended_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      await db.query(
        `CREATE TABLE receipt_tree_heads (
           id          BIGSERIAL PRIMARY KEY,
           tree_size   BIGINT NOT NULL,
           root_hash   TEXT NOT NULL,
           cose_bytes  TEXT NOT NULL,
           sealed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
    });

    afterAll(async () => {
      if (db !== undefined) {
        await db.query(`DROP TABLE IF EXISTS receipt_log`);
        await db.query(`DROP TABLE IF EXISTS receipt_tree_heads`);
        await db.close();
      }
    });

    test("concurrent appends from three instances form one gapless tree", async () => {
      const { privateKey } = await keyPair();
      const replicas = [0, 1, 2].map(
        (r) => new PostgresTransparencyLog(db, privateKey, `kid-${r}`),
      );
      const total = 60;
      await Promise.all(
        Array.from({ length: total }, (_, i) =>
          replicas[i % replicas.length]?.append(`r-${i}`, receiptBytes(i)),
        ),
      );
      // Re-appending is idempotent, also across instances.
      await replicas[2]?.append("r-0", receiptBytes(0));

      const heads = [];
      for (const replica of replicas) {
        await replica.refresh();
        expect(replica.size()).toBe(total);
        const positions = new Set<number>();
        for (let i = 0; i < total; i++) {
          const entry = replica.entryByReceiptId(`r-${i}`);
          expect(entry).toBeDefined();
          positions.add(entry?.seq ?? -1);
        }
        // Every position 0..total-1 is used exactly once.
        expect([...positions].sort((a, b) => a - b)).toEqual(
          Array.from({ length: total }, (_, i) => i),
        );
        heads.push(bytesToHex((await replica.currentHead()).rootHash));
      }
      expect(new Set(heads).size).toBe(1);
    });

    test("leaf positions match the durable order, even with sequence gaps", async () => {
      const { privateKey } = await keyPair();
      const log = new PostgresTransparencyLog(db, privateKey, "kid");
      await log.append("a", receiptBytes(1));
      // A conflicting insert consumes a sequence value without a row.
      await db.query(
        `INSERT INTO receipt_log (receipt_id, leaf_hash, cose_bytes) VALUES ('a', 'x', 'x')
         ON CONFLICT (receipt_id) DO NOTHING`,
      );
      await log.append("b", receiptBytes(2));
      expect(log.entryByReceiptId("a")?.seq).toBe(0);
      expect(log.entryByReceiptId("b")?.seq).toBe(1);
      const expected = await subtreeRoot(
        [await merkleLeafHash(receiptBytes(1)), await merkleLeafHash(receiptBytes(2))],
        merkleNodeHash,
      );
      expect(bytesToHex((await log.currentHead()).rootHash)).toBe(bytesToHex(expected));
    });

    test("a head sealed by one replica proves a receipt appended by another", async () => {
      const { privateKey, publicKeyRaw } = await keyPair();
      const a = new PostgresTransparencyLog(db, privateKey, "kid");
      const b = new PostgresTransparencyLog(db, privateKey, "kid");
      await a.append("from-a", receiptBytes(10));
      await b.append("from-b", receiptBytes(11));
      await a.append("from-a-2", receiptBytes(12));

      const sealed = await b.sealTreeHead();
      expect(sealed.treeSize).toBe(3);
      // `a` picks up b's head on refresh and proves against it.
      await a.refresh();
      expect(a.latestTreeHead()?.treeSize).toBe(3);
      const proof = await a.proofForReceipt("from-b", sealed.treeSize);
      if (proof === undefined) throw new Error("expected a proof");
      const check = await verifyReceiptInclusion(
        receiptBytes(11),
        sealed.coseBytes,
        proof,
        publicKeyRaw,
      );
      expect(check?.headSignatureValid).toBe(true);
      expect(check?.inclusionValid).toBe(true);
    });

    test("heads from the per-process logs before the switch are kept but never used", async () => {
      const { privateKey, publicKeyRaw } = await keyPair();
      // The pre-0039 situation: one replica's in-memory log saw only part of
      // the durable rows and sealed a head over its own ordering.
      const legacy = new InMemoryTransparencyLog(privateKey, "kid");
      await legacy.append("only-on-replica-a", receiptBytes(20));
      const legacyHead = await legacy.sealTreeHead();
      await db.query(
        `INSERT INTO receipt_log (receipt_id, leaf_hash, cose_bytes) VALUES ($1, $2, $3)`,
        [
          "from-replica-b",
          bytesToHex(await merkleLeafHash(receiptBytes(21))),
          bytesToHex(receiptBytes(21)),
        ],
      );
      await db.query(
        `INSERT INTO receipt_log (receipt_id, leaf_hash, cose_bytes) VALUES ($1, $2, $3)`,
        [
          "only-on-replica-a",
          bytesToHex(await merkleLeafHash(receiptBytes(20))),
          bytesToHex(receiptBytes(20)),
        ],
      );
      await db.query(
        `INSERT INTO receipt_tree_heads (tree_size, root_hash, cose_bytes) VALUES ($1, '', $2)`,
        [legacyHead.treeSize, bytesToHex(legacyHead.coseBytes)],
      );

      const shared = new PostgresTransparencyLog(db, privateKey, "kid");
      await shared.refresh();
      expect(shared.size()).toBe(2);
      // The legacy head covers a different ordering: not adopted.
      expect(shared.treeHeads()).toHaveLength(0);
      // The proof that was issued with it remains valid on its own terms.
      const legacyProof = await legacy.proofForReceipt("only-on-replica-a");
      if (legacyProof === undefined) throw new Error("expected a legacy proof");
      const legacyCheck = await verifyReceiptInclusion(
        receiptBytes(20),
        legacyHead.coseBytes,
        legacyProof,
        publicKeyRaw,
      );
      expect(legacyCheck?.inclusionValid).toBe(true);
      // The shared log proves the same receipt against its own head.
      const head = await shared.sealTreeHead();
      const proof = await shared.proofForReceipt("only-on-replica-a", head.treeSize);
      if (proof === undefined) throw new Error("expected a proof");
      expect(proof.leafIndex).toBe(1);
      const check = await verifyReceiptInclusion(
        receiptBytes(20),
        head.coseBytes,
        proof,
        publicKeyRaw,
      );
      expect(check?.inclusionValid).toBe(true);
    });

    test("a restarted instance continues the same tree", async () => {
      const { privateKey } = await keyPair();
      const first = new PostgresTransparencyLog(db, privateKey, "kid");
      for (let i = 0; i < 5; i++) await first.append(`p-${i}`, receiptBytes(30 + i));
      const before = bytesToHex((await first.currentHead()).rootHash);
      const restarted = new PostgresTransparencyLog(db, privateKey, "kid");
      await restarted.refresh();
      expect(bytesToHex((await restarted.currentHead()).rootHash)).toBe(before);
      const next = await restarted.append("p-5", receiptBytes(35));
      expect(next.seq).toBe(5);
    });
  },
);
