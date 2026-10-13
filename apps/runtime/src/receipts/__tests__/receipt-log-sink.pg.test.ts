// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PostgresReceiptLogSink round-trip against a real Postgres (Req 15.3):
 * receipts appended through one transparency log are reloaded by a second
 * log (a restarted replica) in the same order, so the rebuilt tree continues
 * the durable `receipt_log` instead of starting again at position 0.
 *
 * Env-gated via TEST_POSTGRES_URL (wired in the CI test job). The table is
 * created with the migration-46 columns but without the immutability
 * trigger, so this suite never depends on (or interferes with) the full
 * migration state of the shared test database.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { createDatabase, type Database } from "../../db/database.js";
import { PostgresReceiptLogSink } from "../receipt-log-sink.js";
import {
  hexToBytes,
  InMemoryTransparencyLog,
  merkleNodeHash,
  verifyInclusionProof,
} from "../transparency-log.js";

const PG_URL = process.env["TEST_POSTGRES_URL"];

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "PostgresReceiptLogSink (real Postgres)",
  () => {
    let db: Database;

    beforeAll(async () => {
      const created = await createDatabase(PG_URL ?? "");
      if (created === undefined) throw new Error("createDatabase returned undefined");
      db = created;
      await db.query(
        `CREATE TABLE IF NOT EXISTS receipt_log (
           seq         BIGSERIAL PRIMARY KEY,
           receipt_id  TEXT NOT NULL UNIQUE,
           leaf_hash   TEXT NOT NULL,
           cose_bytes  TEXT NOT NULL,
           appended_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
    });

    afterAll(async () => {
      if (db !== undefined) await db.close();
    });

    test("a restarted log hydrates every durable entry in append order", async () => {
      const pair = (await globalThis.crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const sink = new PostgresReceiptLogSink(db);
      const first = new InMemoryTransparencyLog(pair.privateKey, "kid-pg", sink);
      await first.hydrate();
      const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
      for (const id of ids) {
        await first.append(id, new TextEncoder().encode(`cose-${id}`));
      }

      const restarted = new InMemoryTransparencyLog(pair.privateKey, "kid-pg", sink);
      const loaded = await restarted.hydrate();
      expect(loaded).toBe(await sink.count());
      const seqs = ids.map((id) => restarted.entryByReceiptId(id)?.seq);
      expect(seqs).toEqual(ids.map((id) => first.entryByReceiptId(id)?.seq));
      expect(
        bytesOf(restarted.entryByReceiptId(ids[0] ?? "")?.coseBytes),
      ).toEqual(`cose-${ids[0]}`);

      // Proofs from the rebuilt tree verify against its own head.
      const head = await restarted.currentHead();
      for (const id of ids) {
        const proof = await restarted.proofForReceipt(id, head.treeSize);
        if (proof === undefined) throw new Error("missing proof");
        const ok = await verifyInclusionProof(
          head.rootHash,
          restarted.entryByReceiptId(id)?.leafHash as Uint8Array,
          proof.leafIndex,
          proof.treeSize,
          proof.nodeHashes.map(hexToBytes),
          merkleNodeHash,
        );
        expect(ok).toBe(true);
      }
    });
  },
);

function bytesOf(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes ?? new Uint8Array(0));
}
