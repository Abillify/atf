// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision_Receipt transparency log (Req 15.3, design.md §Receipts).
 *
 * An append-only Merkle Tree (RFC 6962) over signed Decision_Receipts:
 *
 *   - Leaf hash:   H(0x00 || data)        — data = the COSE_Sign1 bytes
 *   - Node hash:   H(0x01 || left || right)
 *   - Tree head:   MerkleTreeHead { tree_size, root_hash } signed as a
 *                  COSE_Sign1 (SCITT-style Signed Tree Head) with the same
 *                  Ed25519 key that signs the receipts themselves. The signed
 *                  head is the audit anchor: an attacker who rewrites history
 *                  in `receipt_log` cannot produce a new root that still
 *                  matches a previously published, signed head.
 *   - Inclusion:   Proof for leaf `i` is the list of sibling hashes up to the
 *                  root; `verifyInclusionProof` recomputes the root from the
 *                  leaf and checks it against the signed head's root.
 *
 * The in-memory tree is the hot path (routes answer proofs from it); the
 * Postgres table `receipt_log` (migration 46) is the durable, append-only
 * record — triggers + role revocations make UPDATE/DELETE impossible for the
 * application role, mirroring the `audit_log` immutability pattern.
 *
 * Pure WebCrypto/Uint8Array — no Node-only imports — so the verification
 * half can be reused by the offline `atf-verify` CLI.
 */

import {
  coseSign1,
  coseSign1Verify,
  cborEncode,
  cborEncodeSign1,
  cborDecode,
  cborDecodeSign1,
  type CborValue,
} from "@atf/security-kit";

// ---------------------------------------------------------------------------
// Hashing primitives (RFC 6962 §2.1)
// ---------------------------------------------------------------------------

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
export const HASH_BYTES = 32;

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data.slice());
  return new Uint8Array(digest);
}

/** RFC 6962 leaf hash: H(0x00 || data). */
export async function merkleLeafHash(data: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(data.length + 1);
  buf[0] = LEAF_PREFIX;
  buf.set(data, 1);
  return sha256(buf);
}

/** RFC 6962 node hash: H(0x01 || left || right). */
export async function merkleNodeHash(
  left: Uint8Array,
  right: Uint8Array,
): Promise<Uint8Array> {
  const buf = new Uint8Array(1 + left.length + right.length);
  buf[0] = NODE_PREFIX;
  buf.set(left, 1);
  buf.set(right, 1 + left.length);
  return sha256(buf);
}

// ---------------------------------------------------------------------------
// RFC 6962 proof path helpers (bit decomposition of indices)
// ---------------------------------------------------------------------------

/**
 * Split a tree of `size` leaves into the two subtrees RFC 6962 defines:
 * the largest perfect binary tree smaller than `size` on the left.
 * Throws a `RangeError` for size <= 1 (a single leaf has no split).
 */
export function splitPoint(size: number): number {
  if (size <= 1) throw new RangeError("split requires size > 1");
  // Largest power of two strictly less than size.
  let k = 1;
  while (k * 2 < size) k *= 2;
  return k;
}

/**
 * Compute the inclusion proof (list of sibling hashes, leaf-to-root order)
 * for leaf `index` of the given leaf-hash list. Purely structural — hashing
 * is done by the caller-supplied `hashFn` so the same code works with the
 * async WebCrypto hash.
 */
export async function inclusionProof(
  leaves: readonly Uint8Array[],
  index: number,
  hashFn: (l: Uint8Array, r: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array[]> {
  if (index < 0 || index >= leaves.length) {
    throw new RangeError(`leaf index ${index} out of range`);
  }
  const proof: Uint8Array[] = [];
  let lo = 0;
  let hi = leaves.length;
  while (hi - lo > 1) {
    const mid = lo + splitPoint(hi - lo);
    if (index < mid) {
      // Leaf is in the left subtree: sibling is the root of the right part.
      proof.push(await subtreeRoot(leaves.slice(mid, hi), hashFn));
      hi = mid;
    } else {
      // Leaf is in the right subtree: sibling is the root of the left part.
      proof.push(await subtreeRoot(leaves.slice(lo, mid), hashFn));
      lo = mid;
    }
  }
  // The walk above descends root-to-leaf, so the collected siblings are in
  // root-to-leaf order; RFC 6962 proofs (and verifyInclusionProof) consume
  // them leaf-to-root.
  proof.reverse();
  return proof;
}

/** Root hash of a (possibly empty) contiguous leaf range. */
export async function subtreeRoot(
  leaves: readonly Uint8Array[],
  hashFn: (l: Uint8Array, r: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (leaves.length === 0) throw new RangeError("empty subtree");
  if (leaves.length === 1) {
    const only = leaves[0];
    if (only === undefined) throw new RangeError("empty subtree");
    return only;
  }
  const mid = splitPoint(leaves.length);
  const left = await subtreeRoot(leaves.slice(0, mid), hashFn);
  const right = await subtreeRoot(leaves.slice(mid), hashFn);
  return hashFn(left, right);
}

/**
 * Verify an inclusion proof: recompute the root from `leaf`, `index` and the
 * proof path, and compare against `root`. `treeSize` bounds the walk exactly
 * like RFC 6962 §2.1.1 (the proof path alone is ambiguous without it).
 * The proof path is consumed leaf-to-root: the first element is the leaf's
 * own sibling, the last element the sibling at the top split.
 */
export async function verifyInclusionProof(
  root: Uint8Array,
  leaf: Uint8Array,
  index: number,
  treeSize: number,
  proof: readonly Uint8Array[],
  hashFn: (l: Uint8Array, r: Uint8Array) => Promise<Uint8Array>,
): Promise<boolean> {
  if (treeSize <= 0 || index < 0 || index >= treeSize) return false;
  const result = await recomputeRoot(leaf, index, treeSize, proof, 0, hashFn);
  if (result === undefined) return false;
  // Every proof element must be consumed exactly once — extra or missing
  // hashes mean the proof does not match this (index, treeSize) pair.
  if (result.used !== proof.length) return false;
  return equalBytes(result.hash, root);
}

/**
 * Recompute the root from a leaf by walking the RFC 6962 tree structure
 * recursively: the subtree containing `index` is combined with the next
 * proof element (its sibling at that level) on the correct side, bottom-up.
 * Returns `undefined` when the proof runs out of elements mid-walk.
 */
async function recomputeRoot(
  leaf: Uint8Array,
  index: number,
  size: number,
  proof: readonly Uint8Array[],
  used: number,
  hashFn: (l: Uint8Array, r: Uint8Array) => Promise<Uint8Array>,
): Promise<{ hash: Uint8Array; used: number } | undefined> {
  if (size === 1) return { hash: leaf, used };
  const mid = splitPoint(size);
  if (index < mid) {
    // Leaf is in the left subtree: the sibling roots the right part.
    const inner = await recomputeRoot(leaf, index, mid, proof, used, hashFn);
    if (inner === undefined) return undefined;
    const sibling = proof[inner.used];
    if (sibling === undefined) return undefined;
    return { hash: await hashFn(inner.hash, sibling), used: inner.used + 1 };
  }
  // Leaf is in the right subtree: the sibling roots the left part.
  const inner = await recomputeRoot(
    leaf,
    index - mid,
    size - mid,
    proof,
    used,
    hashFn,
  );
  if (inner === undefined) return undefined;
  const sibling = proof[inner.used];
  if (sibling === undefined) return undefined;
  return { hash: await hashFn(sibling, inner.hash), used: inner.used + 1 };
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Hex helpers (hashes are stored/transmitted as lowercase hex)
// ---------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new RangeError("invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merkle Tree Head (signed audit anchor)
// ---------------------------------------------------------------------------

/**
 * Domain-separation marker for tree-head signatures: it is fed to COSE as
 * `externalAad`, which is part of the Sig_structure — so a receipt signature
 * (empty AAD) can never be replayed as a tree head and vice versa.
 */
const TREE_HEAD_CONTENT_TYPE = "application/atf-merkle-tree-head";

export interface MerkleTreeHeadData {
  /** Number of leaves covered. */
  treeSize: number;
  /** 32-byte Merkle root over the leaves. */
  rootHash: Uint8Array;
  /** ISO-8601 timestamp when the head was computed. */
  timestamp: string;
}

/** Canonical CBOR encoding of a tree head: [tree_size, root_hash, timestamp]. */
export function encodeTreeHead(head: MerkleTreeHeadData): Uint8Array {
  return cborEncode([
    head.treeSize,
    head.rootHash,
    head.timestamp,
  ] as CborValue[]);
}

export function decodeTreeHead(payload: Uint8Array): MerkleTreeHeadData {
  const v = cborDecode(payload);
  if (!Array.isArray(v)) throw new RangeError("tree head payload is not an array");
  const treeSize = v[0];
  const rootHash = v[1];
  const timestamp = v[2];
  if (
    typeof treeSize !== "number" ||
    !(rootHash instanceof Uint8Array) ||
    typeof timestamp !== "string"
  ) {
    throw new RangeError("malformed tree head payload");
  }
  return { treeSize, rootHash, timestamp };
}

/**
 * Sign a tree head as COSE_Sign1 (externalAad = content-type marker so a
 * receipt signature can never be replayed as a tree head and vice versa).
 */
export async function signTreeHead(
  head: MerkleTreeHeadData,
  privateKey: CryptoKey,
  kid: string,
): Promise<Uint8Array> {
  const payload = encodeTreeHead(head);
  const message = await coseSign1(privateKey, payload, {
    kid,
    externalAad: new TextEncoder().encode(TREE_HEAD_CONTENT_TYPE),
  });
  return cborEncodeSign1(message);
}

/**
 * Verify a signed tree head: COSE signature (against the raw Ed25519 key)
 * over the tree-head domain. Returns the decoded head on success,
 * `undefined` on any failure — never throws.
 */
export async function verifySignedTreeHead(
  coseBytes: Uint8Array,
  publicKeyRaw: Uint8Array,
): Promise<MerkleTreeHeadData | undefined> {
  try {
    const msg = cborDecodeSign1(coseBytes);
    const ok = await coseSign1Verify(
      msg,
      publicKeyRaw,
      new TextEncoder().encode(TREE_HEAD_CONTENT_TYPE),
    );
    if (!ok) return undefined;
    return decodeTreeHead(msg.payload);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Append-only log (in-memory hot path + pluggable durable sink)
// ---------------------------------------------------------------------------

export interface ReceiptLogEntry {
  /** 0-based position in the tree. */
  seq: number;
  receiptId: string;
  /** The COSE_Sign1 receipt bytes (leaf data). */
  coseBytes: Uint8Array;
  /** H(0x00 || coseBytes). */
  leafHash: Uint8Array;
  appendedAt: string;
}

export interface SignedTreeHead {
  treeSize: number;
  /** COSE_Sign1 over encodeTreeHead(...). */
  coseBytes: Uint8Array;
}

/** Durable sink — implemented by Postgres (`receipt_log`), optional in tests. */
export interface ReceiptLogSink {
  append(entry: ReceiptLogEntry): Promise<void>;
  /** Persist a signed tree head (audit anchor). */
  saveTreeHead(head: SignedTreeHead): Promise<void>;
  /**
   * Every logged receipt in append order (oldest first). Optional: a sink
   * that implements it lets the in-memory tree be rebuilt after a restart
   * (`InMemoryTransparencyLog.hydrate`).
   */
  loadEntries?(): Promise<{ receiptId: string; coseBytes: Uint8Array }[]>;
}

export interface InclusionProofResult {
  leafIndex: number;
  treeSize: number;
  /** Hex sibling hashes, leaf-to-root. */
  nodeHashes: string[];
}

export interface TransparencyLog {
  /** Append a receipt; returns its leaf entry. Idempotent per receipt id. */
  append(receiptId: string, coseBytes: Uint8Array): Promise<ReceiptLogEntry>;
  size(): number;
  entryByReceiptId(receiptId: string): ReceiptLogEntry | undefined;
  /** Current (unsigned) tree head. */
  currentHead(): Promise<MerkleTreeHeadData>;
  /** Sign the current head and remember it as an audit anchor. */
  sealTreeHead(): Promise<SignedTreeHead>;
  /** Latest sealed head, if any. */
  latestTreeHead(): SignedTreeHead | undefined;
  /** All sealed heads (oldest first). */
  treeHeads(): readonly SignedTreeHead[];
  /** Inclusion proof for a receipt against a given tree size (default: latest sealed). */
  proofForReceipt(
    receiptId: string,
    treeSize?: number,
  ): Promise<InclusionProofResult | undefined>;
}

/**
 * In-memory RFC-6962 append-only log. Every append recomputes the root
 * lazily (cached until the next append); sealed heads are kept for proof
 * verification against historical tree sizes.
 */
export class InMemoryTransparencyLog implements TransparencyLog {
  private readonly entries: ReceiptLogEntry[] = [];
  private readonly byReceiptId = new Map<string, ReceiptLogEntry>();
  private readonly heads: SignedTreeHead[] = [];
  private cachedRoot: Uint8Array | undefined;
  private readonly sink: ReceiptLogSink | undefined;
  private readonly privateKey: CryptoKey;
  private readonly kid: string;

  constructor(
    privateKey: CryptoKey,
    kid: string,
    sink?: ReceiptLogSink,
  ) {
    this.privateKey = privateKey;
    this.kid = kid;
    this.sink = sink;
  }

  async append(
    receiptId: string,
    coseBytes: Uint8Array,
  ): Promise<ReceiptLogEntry> {
    const existing = this.byReceiptId.get(receiptId);
    if (existing !== undefined) return existing;
    const leafHash = await merkleLeafHash(coseBytes);
    const entry: ReceiptLogEntry = {
      seq: this.entries.length,
      receiptId,
      coseBytes: coseBytes.slice(),
      leafHash,
      appendedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.byReceiptId.set(receiptId, entry);
    this.cachedRoot = undefined;
    if (this.sink !== undefined) await this.sink.append(entry);
    return entry;
  }

  /**
   * Rebuild the in-memory tree from the durable sink (Req 15.3) so that a
   * restarted replica continues the same log instead of starting a new tree
   * at position 0 while `receipt_log` still holds the earlier receipts. Leaf
   * positions are the 0-based append order of the durable rows; leaf hashes
   * are recomputed from the stored COSE bytes. Sealed heads are not
   * reloaded: the proof route seals a fresh head over the rebuilt tree on
   * demand, and heads sealed before this fix may cover a tree that started
   * mid-log. Must run before the first append; returns the number of
   * entries loaded (0 without a sink or when the sink cannot load).
   */
  async hydrate(): Promise<number> {
    if (this.entries.length > 0) {
      throw new Error("transparency log hydrate() must run before the first append");
    }
    if (this.sink?.loadEntries === undefined) return 0;
    const rows = await this.sink.loadEntries();
    for (const row of rows) {
      if (this.byReceiptId.has(row.receiptId)) continue;
      const entry: ReceiptLogEntry = {
        seq: this.entries.length,
        receiptId: row.receiptId,
        coseBytes: row.coseBytes.slice(),
        leafHash: await merkleLeafHash(row.coseBytes),
        appendedAt: "",
      };
      this.entries.push(entry);
      this.byReceiptId.set(row.receiptId, entry);
    }
    this.cachedRoot = undefined;
    return this.entries.length;
  }

  size(): number {
    return this.entries.length;
  }

  entryByReceiptId(receiptId: string): ReceiptLogEntry | undefined {
    return this.byReceiptId.get(receiptId);
  }

  async currentHead(): Promise<MerkleTreeHeadData> {
    return {
      treeSize: this.entries.length,
      rootHash: await this.rootHash(),
      timestamp: new Date().toISOString(),
    };
  }

  private async rootHash(): Promise<Uint8Array> {
    if (this.entries.length === 0) {
      // RFC 6962 leaves the empty tree undefined; use H(0x00) as a stable
      // sentinel so sealed heads of an empty log still verify.
      if (this.cachedRoot === undefined) {
        this.cachedRoot = await merkleLeafHash(new Uint8Array(0));
      }
      return this.cachedRoot;
    }
    if (this.cachedRoot === undefined) {
      this.cachedRoot = await subtreeRoot(
        this.entries.map((e) => e.leafHash),
        merkleNodeHash,
      );
    }
    return this.cachedRoot;
  }

  async sealTreeHead(): Promise<SignedTreeHead> {
    const head = await this.currentHead();
    const coseBytes = await signTreeHead(head, this.privateKey, this.kid);
    const sealed: SignedTreeHead = {
      treeSize: head.treeSize,
      coseBytes,
    };
    this.heads.push(sealed);
    if (this.sink !== undefined) await this.sink.saveTreeHead(sealed);
    return sealed;
  }

  latestTreeHead(): SignedTreeHead | undefined {
    return this.heads[this.heads.length - 1];
  }

  treeHeads(): readonly SignedTreeHead[] {
    return this.heads;
  }

  async proofForReceipt(
    receiptId: string,
    treeSize?: number,
  ): Promise<InclusionProofResult | undefined> {
    const entry = this.byReceiptId.get(receiptId);
    if (entry === undefined) return undefined;
    const size = treeSize ?? this.latestTreeHead()?.treeSize ?? this.entries.length;
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

// ---------------------------------------------------------------------------
// Offline verification (shared by routes and the atf-verify CLI)
// ---------------------------------------------------------------------------

export interface ReceiptInclusionCheck {
  /** The receipt's leaf hash (hex). */
  leafHash: string;
  /** The tree head the proof was checked against. */
  head: MerkleTreeHeadData;
  /** Whether the COSE signature over the tree head verified. */
  headSignatureValid: boolean;
  /** Whether the inclusion proof recomputes the head's root. */
  inclusionValid: boolean;
}

/**
 * Verify that a receipt (COSE_Sign1 bytes) is included in the tree covered
 * by a signed tree head. Fully offline: needs only the raw Ed25519 public
 * key, the receipt bytes, the signed head, and the proof.
 */
export async function verifyReceiptInclusion(
  receiptCoseBytes: Uint8Array,
  signedHead: Uint8Array,
  proof: InclusionProofResult,
  publicKeyRaw: Uint8Array,
): Promise<ReceiptInclusionCheck | undefined> {
  const head = await verifySignedTreeHead(signedHead, publicKeyRaw);
  if (head === undefined) return undefined;
  const leaf = await merkleLeafHash(receiptCoseBytes);
  const inclusionValid = await verifyInclusionProof(
    head.rootHash,
    leaf,
    proof.leafIndex,
    proof.treeSize,
    proof.nodeHashes.map(hexToBytes),
    merkleNodeHash,
  );
  return {
    leafHash: bytesToHex(leaf),
    head,
    headSignatureValid: true,
    inclusionValid,
  };
}
