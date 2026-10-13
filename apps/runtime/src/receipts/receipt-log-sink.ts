// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Durable Postgres sink for the Decision_Receipt transparency log (Req 15.3).
 *
 * `receipt_log` / `receipt_tree_heads` (migration 46) are append-only: the
 * immutability triggers plus the role revocations in `rls-onboarding.ts` make
 * UPDATE/DELETE impossible for the application role, so the durable record
 * cannot be rewritten after the fact. The in-memory tree in
 * `transparency-log.ts` stays the hot path for proofs; this sink only mirrors
 * appends and sealed heads.
 *
 * `cose_bytes` is stored as lowercase hex in a TEXT column: the Bun SQL
 * adapter passes parameters through as text, and hex keeps the column
 * dump-comparable next to the hex `leaf_hash` / `root_hash` columns.
 */

import type { Database } from "../db/database.js";
import { cborDecodeSign1 } from "@atf/security-kit";
import type {
  ReceiptLogEntry,
  ReceiptLogSink,
  SignedTreeHead,
} from "./transparency-log.js";
import {
  bytesToHex,
  decodeTreeHead,
  hexToBytes,
} from "./transparency-log.js";

interface ReceiptLogRow {
  seq: string | number;
  receipt_id: string;
  leaf_hash: string;
  cose_bytes: string;
}

/**
 * Mirrors every transparency-log append and every sealed tree head into
 * Postgres. Failures propagate — the caller (receipt issuance path) treats a
 * failing sink as a degraded, not broken, deployment and logs a warning.
 */
export class PostgresReceiptLogSink implements ReceiptLogSink {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async append(entry: ReceiptLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO receipt_log (receipt_id, leaf_hash, cose_bytes)
       VALUES ($1, $2, $3)
       ON CONFLICT (receipt_id) DO NOTHING`,
      [entry.receiptId, bytesToHex(entry.leafHash), bytesToHex(entry.coseBytes)],
    );
  }

  async saveTreeHead(head: SignedTreeHead): Promise<void> {
    // root_hash is a denormalised convenience column for operator queries;
    // the signed COSE message stays the source of truth (it is verified on
    // read, the column never is). A head whose payload cannot be decoded is
    // stored with an empty column rather than lost.
    let rootHash = "";
    try {
      const decoded = decodeTreeHead(cborDecodeSign1(head.coseBytes).payload);
      rootHash = bytesToHex(decoded.rootHash);
    } catch {
      // keep "" — see above
    }
    await this.db.query(
      `INSERT INTO receipt_tree_heads (tree_size, root_hash, cose_bytes)
       VALUES ($1, $2, $3)`,
      [head.treeSize, rootHash, bytesToHex(head.coseBytes)],
    );
  }

  /** All sealed tree heads, oldest first (operator / CLI export). */
  async listTreeHeads(): Promise<SignedTreeHead[]> {
    const rows = await this.db.query<{ tree_size: string | number; cose_bytes: string }>(
      `SELECT tree_size, cose_bytes FROM receipt_tree_heads ORDER BY id ASC`,
    );
    return rows.map((r) => ({
      treeSize: Number(r.tree_size),
      coseBytes: hexToBytes(r.cose_bytes),
    }));
  }

  /**
   * Every logged receipt in append order, used to rebuild the in-memory tree
   * after a restart. `seq` comes from a sequence and may have gaps (e.g. an
   * `ON CONFLICT DO NOTHING` insert still consumes a value), so the tree
   * position is the row's rank in this ordering, not `seq` itself.
   */
  async loadEntries(): Promise<{ receiptId: string; coseBytes: Uint8Array }[]> {
    const rows = await this.db.query<{ receipt_id: string; cose_bytes: string }>(
      `SELECT receipt_id, cose_bytes FROM receipt_log ORDER BY seq ASC`,
    );
    return rows.map((r) => ({
      receiptId: r.receipt_id,
      coseBytes: hexToBytes(r.cose_bytes),
    }));
  }

  /** Look up a logged receipt by id (durable proof of publication). */
  async getByReceiptId(receiptId: string): Promise<ReceiptLogEntry | undefined> {
    const rows = await this.db.query<ReceiptLogRow>(
      `SELECT seq, receipt_id, leaf_hash, cose_bytes
         FROM receipt_log WHERE receipt_id = $1`,
      [receiptId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      seq: Number(row.seq),
      receiptId: row.receipt_id,
      leafHash: hexToBytes(row.leaf_hash),
      coseBytes: hexToBytes(row.cose_bytes),
      appendedAt: "",
    };
  }

  /** Number of logged receipts (monitoring / consistency self-check). */
  async count(): Promise<number> {
    const rows = await this.db.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM receipt_log`,
    );
    return Number(rows[0]?.n ?? 0);
  }
}
