// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared Decision_Receipt transparency log on Postgres (ADR 0039).
 *
 * `InMemoryTransparencyLog` numbers leaves per process, so two replicas build
 * two different trees and an inclusion proof from one does not verify against
 * a head sealed by the other. Here the `receipt_log` table is the source of
 * truth for leaf order:
 *
 *   - `append` inserts under `pg_advisory_xact_lock(hashtext('atf:receipt_log'))`
 *     in one transaction — the audit-chain discipline of ADR 0026 — so commits
 *     happen in `seq` order across all replicas.
 *   - The leaf index is the row's RANK in `ORDER BY seq`, not `seq` itself: a
 *     sequence value is consumed even by an insert that ends in a conflict or
 *     a rollback, so `seq` can have gaps while the tree must not.
 *   - Every replica keeps a mirror of the table, extended by `refresh()` with
 *     the rows committed since its last read. Because commits are serialised
 *     by the lock, `seq > last` never skips a row a later refresh would miss.
 *   - Sealed heads are read back from `receipt_tree_heads` and adopted only
 *     when their root matches the shared tree at their size. Heads sealed by
 *     the per-process logs before the switch cover a different ordering; they
 *     stay valid for the proofs issued with them (immutable artifacts), but
 *     this log never proves against them.
 *
 * Formats are unchanged — leaf hash, tree-head encoding, COSE envelope and
 * proof shape are the ones `atf-verify` already accepts (docs/STABILITY.md).
 *
 * Limitation, stated in the upgrade notes: a replica still running the
 * pre-0039 write-behind sink appends WITHOUT the lock, so during a rolling
 * upgrade its rows can commit out of `seq` order. Upgrade receipt-issuing
 * replicas together.
 */

import type { Database } from "../db/database.js";
import { cborDecodeSign1 } from "@atf/security-kit";
import {
  bytesToHex,
  decodeTreeHead,
  equalBytes,
  hexToBytes,
  inclusionProof,
  merkleLeafHash,
  merkleNodeHash,
  signTreeHead,
  subtreeRoot,
  type InclusionProofResult,
  type MerkleTreeHeadData,
  type ReceiptLogEntry,
  type SignedTreeHead,
  type TransparencyLog,
} from "./transparency-log.js";

/** Advisory-lock key that serialises appends across replicas. */
export const RECEIPT_LOG_LOCK_KEY = "atf:receipt_log";

interface LogRow {
  seq: string | number;
  receipt_id: string;
  cose_bytes: string;
  appended_at: string | Date | null;
}

interface HeadRow {
  id: string | number;
  tree_size: string | number;
  cose_bytes: string;
}

export class PostgresTransparencyLog implements TransparencyLog {
  private readonly entries: ReceiptLogEntry[] = [];
  private readonly byReceiptId = new Map<string, ReceiptLogEntry>();
  private readonly heads: SignedTreeHead[] = [];
  /** Highest `receipt_log.seq` mirrored so far. */
  private lastSeq = 0;
  /** Highest `receipt_tree_heads.id` examined so far. */
  private lastHeadId = 0;
  /** Root per tree size, so adopting heads and sealing never recompute twice. */
  private readonly rootBySize = new Map<number, Uint8Array>();
  /** Serialises refreshes within this process. */
  private refreshing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly privateKey: CryptoKey,
    private readonly kid: string,
  ) {}

  /** Runs `cb` on one pinned connection so BEGIN … COMMIT share a session. */
  private pinned<T>(cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withConnection !== undefined
      ? this.db.withConnection(cb)
      : cb(this.db);
  }

  /**
   * Catch up with rows and heads committed by any replica since the last
   * read. Cheap when nothing changed (two indexed range scans).
   */
  async refresh(): Promise<void> {
    const run = this.refreshing.then(() => this.load());
    // A failed refresh must not poison the chain for the next caller.
    this.refreshing = run.catch(() => {});
    await run;
  }

  private async load(): Promise<void> {
    const rows = await this.db.query<LogRow>(
      `SELECT seq, receipt_id, cose_bytes, appended_at
         FROM receipt_log WHERE seq > $1 ORDER BY seq ASC`,
      [this.lastSeq],
    );
    for (const row of rows) {
      const seq = Number(row.seq);
      if (seq > this.lastSeq) this.lastSeq = seq;
      if (this.byReceiptId.has(row.receipt_id)) continue;
      const coseBytes = hexToBytes(row.cose_bytes);
      const entry: ReceiptLogEntry = {
        seq: this.entries.length,
        receiptId: row.receipt_id,
        coseBytes,
        leafHash: await merkleLeafHash(coseBytes),
        appendedAt:
          row.appended_at instanceof Date
            ? row.appended_at.toISOString()
            : (row.appended_at ?? ""),
      };
      this.entries.push(entry);
      this.byReceiptId.set(entry.receiptId, entry);
    }

    const headRows = await this.db.query<HeadRow>(
      `SELECT id, tree_size, cose_bytes
         FROM receipt_tree_heads WHERE id > $1 ORDER BY id ASC`,
      [this.lastHeadId],
    );
    for (const row of headRows) {
      const id = Number(row.id);
      if (id > this.lastHeadId) this.lastHeadId = id;
      const head: SignedTreeHead = {
        treeSize: Number(row.tree_size),
        coseBytes: hexToBytes(row.cose_bytes),
      };
      if (await this.matchesSharedTree(head)) this.heads.push(head);
    }
  }

  /**
   * A sealed head is usable only if its signed root is the root of THIS
   * tree at its size. The signature itself is not checked here: it was made
   * with this deployment's key when the head was written, and the proof
   * consumer verifies it anyway; what matters is the ordering it covers.
   */
  private async matchesSharedTree(head: SignedTreeHead): Promise<boolean> {
    if (head.treeSize < 1 || head.treeSize > this.entries.length) return false;
    let decoded: MerkleTreeHeadData;
    try {
      decoded = decodeTreeHead(cborDecodeSign1(head.coseBytes).payload);
    } catch {
      return false;
    }
    if (decoded.treeSize !== head.treeSize) return false;
    return equalBytes(decoded.rootHash, await this.rootAt(head.treeSize));
  }

  private async rootAt(size: number): Promise<Uint8Array> {
    const cached = this.rootBySize.get(size);
    if (cached !== undefined) return cached;
    const root =
      size === 0
        ? await merkleLeafHash(new Uint8Array(0))
        : await subtreeRoot(
            this.entries.slice(0, size).map((e) => e.leafHash),
            merkleNodeHash,
          );
    this.rootBySize.set(size, root);
    return root;
  }

  async append(
    receiptId: string,
    coseBytes: Uint8Array,
  ): Promise<ReceiptLogEntry> {
    const known = this.byReceiptId.get(receiptId);
    if (known !== undefined) return known;
    const leafHash = await merkleLeafHash(coseBytes);
    await this.pinned(async (db) => {
      await db.query("BEGIN");
      try {
        // Serialises every receipt append across all replicas until COMMIT,
        // so rows commit in `seq` order and the mirror's `seq > last` read
        // never skips one.
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          RECEIPT_LOG_LOCK_KEY,
        ]);
        await db.query(
          `INSERT INTO receipt_log (receipt_id, leaf_hash, cose_bytes)
           VALUES ($1, $2, $3)
           ON CONFLICT (receipt_id) DO NOTHING`,
          [receiptId, bytesToHex(leafHash), bytesToHex(coseBytes)],
        );
        await db.query("COMMIT");
      } catch (err) {
        try {
          await db.query("ROLLBACK");
        } catch {
          /* the rollback error must not mask the original error */
        }
        throw err;
      }
    });
    await this.refresh();
    const entry = this.byReceiptId.get(receiptId);
    if (entry === undefined) {
      throw new Error(
        `receipt ${receiptId} was appended but is not visible in receipt_log`,
      );
    }
    return entry;
  }

  size(): number {
    return this.entries.length;
  }

  entryByReceiptId(receiptId: string): ReceiptLogEntry | undefined {
    return this.byReceiptId.get(receiptId);
  }

  async currentHead(): Promise<MerkleTreeHeadData> {
    await this.refresh();
    const treeSize = this.entries.length;
    return {
      treeSize,
      rootHash: await this.rootAt(treeSize),
      timestamp: new Date().toISOString(),
    };
  }

  async sealTreeHead(): Promise<SignedTreeHead> {
    const head = await this.currentHead();
    const coseBytes = await signTreeHead(head, this.privateKey, this.kid);
    const sealed: SignedTreeHead = { treeSize: head.treeSize, coseBytes };
    // Several replicas may seal the same size; the content is identical up to
    // the timestamp, and extra rows are harmless.
    await this.db.query(
      `INSERT INTO receipt_tree_heads (tree_size, root_hash, cose_bytes)
       VALUES ($1, $2, $3)`,
      [head.treeSize, bytesToHex(head.rootHash), bytesToHex(coseBytes)],
    );
    // Picked up (and verified against the tree) by the next refresh; adding
    // it here as well keeps `latestTreeHead()` current for the caller.
    this.heads.push(sealed);
    await this.refresh();
    return sealed;
  }

  latestTreeHead(): SignedTreeHead | undefined {
    let latest: SignedTreeHead | undefined;
    for (const head of this.heads) {
      if (latest === undefined || head.treeSize >= latest.treeSize) latest = head;
    }
    return latest;
  }

  treeHeads(): readonly SignedTreeHead[] {
    return this.heads;
  }

  async proofForReceipt(
    receiptId: string,
    treeSize?: number,
  ): Promise<InclusionProofResult | undefined> {
    await this.refresh();
    const entry = this.byReceiptId.get(receiptId);
    if (entry === undefined) return undefined;
    const size =
      treeSize ?? this.latestTreeHead()?.treeSize ?? this.entries.length;
    if (size <= entry.seq || size > this.entries.length) return undefined;
    const leaves = this.entries.slice(0, size).map((e) => e.leafHash);
    const proof = await inclusionProof(leaves, entry.seq, merkleNodeHash);
    return {
      leafIndex: entry.seq,
      treeSize: size,
      nodeHashes: proof.map(bytesToHex),
    };
  }
}
