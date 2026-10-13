// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Client-side Decision_Receipt verification for the Control trace viewer
 * (Req 15.7).
 *
 * The runtime issues COSE_Sign1 receipts anchored in an RFC 6962 transparency
 * log (Req 15.3). This module re-checks both halves in the browser using only
 * WebCrypto via `@atf/security-kit/browser`:
 *
 *   1. Receipt signature — COSE_Sign1 over the receipt payload, verified
 *      against the tenant-facing JWKS at `/.well-known/atf-receipt-jwks.json`.
 *   2. Merkle inclusion — the proof path from `GET /v1/receipts/:id/proof` is
 *      recomputed and matched against the root inside the signed tree head.
 *
 * The Merkle helpers deliberately mirror the runtime implementation in
 * `apps/runtime/src/receipts/transparency-log.ts` (leaf H(0x00||data), node
 * H(0x01||l||r), RFC 6962 split). They are re-implemented here — rather than
 * imported — because runtime code must never enter the frontend bundle; the
 * cross-app consistency test in `__tests__/receipt-verify.test.ts` proves the
 * browser verifier accepts proofs produced by the runtime log.
 */

import {
  base64UrlDecode,
  cborDecode,
  cborDecodeSign1,
  COSE_ALG_EDDSA,
  coseSign1Verify,
  decodeProtectedHeader,
  jwkToEd25519RawKey,
} from "@atf/security-kit/browser";
import { json } from "./control-api";

// ---------------------------------------------------------------------------
// API shapes (mirror apps/runtime/src/routes/receipts.ts)
// ---------------------------------------------------------------------------

/** One receipt as returned by `GET /v1/receipts?execution_id=`. */
export interface ReceiptListItem {
  receipt_id: string;
  kind: string;
  cose_base64: string;
  payload: Record<string, unknown>;
}

export interface ReceiptsListResponse {
  execution_id: string;
  receipts: ReceiptListItem[];
}

/** `GET /v1/receipts/:id/proof` response. */
export interface ReceiptProofResponse {
  receipt_id: string;
  proof: {
    leaf_index: number;
    tree_size: number;
    node_hashes: string[];
  };
  tree_head: {
    tree_size: number;
    cose_base64: string;
  };
}

/** JWKS entry — the TS lib's JsonWebKey has no `kid`, so intersect locally. */
export type JwkEntry = JsonWebKey & { kid?: string };

// ---------------------------------------------------------------------------
// Fetch helpers (all through lib/control-api, Req 9.2)
// ---------------------------------------------------------------------------

export async function fetchExecutionReceipts(
  executionId: string,
  token: string | undefined,
): Promise<ReceiptsListResponse> {
  return json<ReceiptsListResponse>(
    `/v1/receipts?execution_id=${encodeURIComponent(executionId)}`,
    { target: "backend", token },
  );
}

export async function fetchReceiptProof(
  receiptId: string,
  token: string | undefined,
): Promise<ReceiptProofResponse> {
  return json<ReceiptProofResponse>(
    `/v1/receipts/${encodeURIComponent(receiptId)}/proof`,
    { target: "backend", token },
  );
}

export async function fetchReceiptJwks(): Promise<JwkEntry[]> {
  const body = await json<{ keys: JwkEntry[] }>(
    "/.well-known/atf-receipt-jwks.json",
    { target: "backend" },
  );
  return body.keys ?? [];
}

// ---------------------------------------------------------------------------
// Merkle verification (mirrors runtime transparency-log.ts, RFC 6962)
// ---------------------------------------------------------------------------

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

/** Domain marker fed to COSE as externalAad for tree-head signatures. */
const TREE_HEAD_CONTENT_TYPE = "application/atf-merkle-tree-head";

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data.slice());
  return new Uint8Array(digest);
}

async function merkleLeafHash(data: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(data.length + 1);
  buf[0] = LEAF_PREFIX;
  buf.set(data, 1);
  return sha256(buf);
}

async function merkleNodeHash(
  left: Uint8Array,
  right: Uint8Array,
): Promise<Uint8Array> {
  const buf = new Uint8Array(1 + left.length + right.length);
  buf[0] = NODE_PREFIX;
  buf.set(left, 1);
  buf.set(right, 1 + left.length);
  return sha256(buf);
}

/** Largest power of two strictly below `size` (RFC 6962 split point). */
function splitPoint(size: number): number {
  if (size <= 1) throw new RangeError("split requires size > 1");
  let k = 1;
  while (k * 2 < size) k *= 2;
  return k;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Recompute the root from leaf + proof path; undefined when the path runs out. */
async function recomputeRoot(
  leaf: Uint8Array,
  index: number,
  size: number,
  proof: readonly Uint8Array[],
  used: number,
): Promise<{ hash: Uint8Array; used: number } | undefined> {
  if (size === 1) return { hash: leaf, used };
  const mid = splitPoint(size);
  if (index < mid) {
    const inner = await recomputeRoot(leaf, index, mid, proof, used);
    if (inner === undefined) return undefined;
    const sibling = proof[inner.used];
    if (sibling === undefined) return undefined;
    return { hash: await merkleNodeHash(inner.hash, sibling), used: inner.used + 1 };
  }
  const inner = await recomputeRoot(leaf, index - mid, size - mid, proof, used);
  if (inner === undefined) return undefined;
  const sibling = proof[inner.used];
  if (sibling === undefined) return undefined;
  return { hash: await merkleNodeHash(sibling, inner.hash), used: inner.used + 1 };
}

/** Verify an inclusion proof against a known root (proof path leaf-to-root). */
export async function verifyInclusionProof(
  root: Uint8Array,
  leaf: Uint8Array,
  index: number,
  treeSize: number,
  proof: readonly Uint8Array[],
): Promise<boolean> {
  if (treeSize <= 0 || index < 0 || index >= treeSize) return false;
  const result = await recomputeRoot(leaf, index, treeSize, proof, 0);
  if (result === undefined) return false;
  if (result.used !== proof.length) return false;
  return equalBytes(result.hash, root);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new RangeError("invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Decoded signed tree head (matches runtime `MerkleTreeHeadData`). */
export interface TreeHeadData {
  treeSize: number;
  rootHash: Uint8Array;
  timestamp: string;
}

/** Verify a signed tree head COSE message; undefined on any failure. */
export async function verifySignedTreeHead(
  coseBytes: Uint8Array,
  publicKeyRaw: Uint8Array,
): Promise<TreeHeadData | undefined> {
  try {
    const msg = cborDecodeSign1(coseBytes);
    const ok = await coseSign1Verify(
      msg,
      publicKeyRaw,
      new TextEncoder().encode(TREE_HEAD_CONTENT_TYPE),
    );
    if (!ok) return undefined;
    const v = cborDecode(msg.payload);
    if (!Array.isArray(v)) return undefined;
    const treeSize = v[0];
    const rootHash = v[1];
    const timestamp = v[2];
    if (
      typeof treeSize !== "number" ||
      !(rootHash instanceof Uint8Array) ||
      typeof timestamp !== "string"
    ) {
      return undefined;
    }
    return { treeSize, rootHash, timestamp };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Receipt + inclusion verification
// ---------------------------------------------------------------------------

export interface ReceiptSignatureCheck {
  signatureValid: boolean;
  kid: string | null;
  /** Set when verification could not run at all (bad encoding, unknown kid). */
  error?: string;
}

export interface InclusionCheck {
  headSignatureValid: boolean;
  inclusionValid: boolean;
  leafIndex: number;
  treeSize: number;
  rootHash: string | null;
  headTimestamp: string | null;
  error?: string;
}

/** Pick the JWKS key for a kid; falls back to the only key when kid is absent. */
export function selectJwk(keys: readonly JwkEntry[], kid: string | null): JwkEntry | undefined {
  if (kid !== null && kid !== undefined && kid !== "") {
    return keys.find((k) => k.kid === kid);
  }
  return keys.length === 1 ? keys[0] : undefined;
}

/** Verify the COSE_Sign1 signature of one receipt against the JWKS. */
export async function verifyReceiptSignature(
  coseB64: string,
  keys: readonly JwkEntry[],
): Promise<ReceiptSignatureCheck> {
  let coseBytes: Uint8Array;
  try {
    coseBytes = base64UrlDecode(coseB64);
  } catch {
    return { signatureValid: false, kid: null, error: "receipt is not valid base64url" };
  }
  let kid: string | null = null;
  try {
    const msg = cborDecodeSign1(coseBytes);
    const header = decodeProtectedHeader(msg.protectedBytes);
    if (header.alg !== COSE_ALG_EDDSA) {
      return {
        signatureValid: false,
        kid: header.kid ?? null,
        error: `unsupported COSE algorithm ${String(header.alg)}`,
      };
    }
    kid = header.kid ?? null;
    const key = selectJwk(keys, kid);
    if (key === undefined) {
      return {
        signatureValid: false,
        kid,
        error:
          kid !== null
            ? `no JWKS key with kid ${kid}`
            : "receipt has no kid and the JWKS holds multiple keys",
      };
    }
    const raw = jwkToEd25519RawKey(key);
    const ok = await coseSign1Verify(msg, raw);
    return { signatureValid: ok, kid };
  } catch (err) {
    return {
      signatureValid: false,
      kid,
      error: err instanceof Error ? err.message : "receipt could not be decoded",
    };
  }
}

/** Verify the Merkle inclusion proof + signed tree head for one receipt. */
export async function verifyReceiptInclusion(
  coseB64: string,
  proofResp: ReceiptProofResponse,
  keys: readonly JwkEntry[],
): Promise<InclusionCheck> {
  const base: InclusionCheck = {
    headSignatureValid: false,
    inclusionValid: false,
    leafIndex: proofResp.proof.leaf_index,
    treeSize: proofResp.proof.tree_size,
    rootHash: null,
    headTimestamp: null,
  };
  try {
    const coseBytes = base64UrlDecode(coseB64);
    const msg = cborDecodeSign1(coseBytes);
    const header = decodeProtectedHeader(msg.protectedBytes);
    const key = selectJwk(keys, header.kid ?? null);
    if (key === undefined) {
      return { ...base, error: "no matching JWKS key for the receipt kid" };
    }
    const raw = jwkToEd25519RawKey(key);
    const head = await verifySignedTreeHead(
      base64UrlDecode(proofResp.tree_head.cose_base64),
      raw,
    );
    if (head === undefined) {
      return { ...base, error: "tree head signature does not verify against this key" };
    }
    if (head.treeSize !== proofResp.proof.tree_size) {
      return {
        ...base,
        headSignatureValid: true,
        rootHash: bytesToHex(head.rootHash),
        headTimestamp: head.timestamp,
        error: `proof tree_size ${String(proofResp.proof.tree_size)} does not match head tree_size ${String(head.treeSize)}`,
      };
    }
    const leaf = await merkleLeafHash(coseBytes);
    const proof = proofResp.proof.node_hashes.map(hexToBytes);
    const inclusionValid = await verifyInclusionProof(
      head.rootHash,
      leaf,
      proofResp.proof.leaf_index,
      proofResp.proof.tree_size,
      proof,
    );
    return {
      headSignatureValid: true,
      inclusionValid,
      leafIndex: proofResp.proof.leaf_index,
      treeSize: proofResp.proof.tree_size,
      rootHash: bytesToHex(head.rootHash),
      headTimestamp: head.timestamp,
      ...(inclusionValid
        ? {}
        : { error: "inclusion proof does not recompute the signed tree root" }),
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : "proof could not be verified",
    };
  }
}

// ---------------------------------------------------------------------------
// Export helpers (Req 15.7 — download receipts from the trace viewer)
// ---------------------------------------------------------------------------

/** Trigger a browser download of one receipt (payload + COSE + proof). */
export function downloadReceipt(
  receipt: ReceiptListItem,
  proof: ReceiptProofResponse | undefined,
): void {
  const bundle = {
    receipt_id: receipt.receipt_id,
    cose_base64: receipt.cose_base64,
    payload: receipt.payload,
    ...(proof !== undefined ? { proof: proof.proof, tree_head: proof.tree_head } : {}),
  };
  downloadJson(`${receipt.receipt_id}.atf-receipt.json`, bundle);
}

/** Trigger a browser download of every receipt of an execution as one JSON. */
export function downloadAllReceipts(
  executionId: string,
  receipts: readonly ReceiptListItem[],
): void {
  downloadJson(`${executionId}.atf-receipts.json`, {
    execution_id: executionId,
    exported_at: new Date().toISOString(),
    receipts,
  });
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
