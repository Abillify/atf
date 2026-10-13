// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the browser-side receipt verifier (Req 15.7).
 *
 * Two layers:
 *   1. Pure browser path — keys generated with WebCrypto, receipts signed with
 *      `@atf/security-kit` COSE helpers, verified through `lib/receipt-verify`.
 *   2. Cross-app consistency — receipts + Merkle proofs produced by the real
 *      runtime transparency log (`apps/runtime/src/receipts/`) must be
 *      accepted by the browser verifier, proving the mirrored Merkle/tree-head
 *      logic in `receipt-verify.ts` has not drifted from the runtime.
 */

import { describe, expect, test } from "vitest";
import {
  base64UrlEncode,
  cborEncode,
  cborEncodeSign1,
  coseSign1,
} from "@atf/security-kit";
import {
  selectJwk,
  verifyReceiptInclusion,
  verifyReceiptSignature,
  type JwkEntry,
  type ReceiptProofResponse,
} from "../lib/receipt-verify";
// Runtime sources of truth — same pattern as edge-rules.parity.test.ts.
import { parseReceiptSigningKey } from "../../../runtime/src/receipts/signing-key";
import { InMemoryTransparencyLog } from "../../../runtime/src/receipts/transparency-log";

// A deterministic 32-byte Ed25519 seed (base64), same fixture style as the
// runtime receipt tests. The attacker seed differs so its key is genuinely
// another key pair.
const SEED_B64 = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const ATTACKER_SEED_B64 = "DAkJDAkJDAkJDAkJDAkJDAkJDAkJDAkJDAkJDAkJCQk=";

async function makeKey(seed: string = SEED_B64) {
  return parseReceiptSigningKey(seed);
}

/** Sign an arbitrary payload as a COSE_Sign1 receipt (base64url form). */
async function makeReceiptCose(
  privateKey: CryptoKey,
  kid: string,
  body: string,
): Promise<string> {
  const payload = cborEncode({ body });
  const msg = await coseSign1(privateKey, payload, { kid });
  return base64UrlEncode(cborEncodeSign1(msg));
}

// ---------------------------------------------------------------------------
// selectJwk
// ---------------------------------------------------------------------------

describe("selectJwk", () => {
  const k1: JwkEntry = { kty: "OKP", kid: "a" };
  const k2: JwkEntry = { kty: "OKP", kid: "b" };

  test("matches by kid", () => {
    expect(selectJwk([k1, k2], "b")).toBe(k2);
  });

  test("falls back to the single key when kid is missing", () => {
    expect(selectJwk([k1], null)).toBe(k1);
    expect(selectJwk([k1], "")).toBe(k1);
  });

  test("ambiguous without kid when several keys exist", () => {
    expect(selectJwk([k1, k2], null)).toBeUndefined();
  });

  test("unknown kid resolves to nothing", () => {
    expect(selectJwk([k1], "zzz")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyReceiptSignature (pure browser path)
// ---------------------------------------------------------------------------

describe("verifyReceiptSignature", () => {
  test("accepts a valid COSE_Sign1 receipt", async () => {
    const key = await makeKey();
    const coseB64 = await makeReceiptCose(key.privateKey, key.kid, "hi");
    const result = await verifyReceiptSignature(coseB64, [key.jwk]);
    expect(result.signatureValid).toBe(true);
    expect(result.kid).toBe(key.kid);
    expect(result.error).toBeUndefined();
  });

  test("rejects a tampered signature byte", async () => {
    const key = await makeKey();
    const coseB64 = await makeReceiptCose(key.privateKey, key.kid, "hi");
    const raw = Uint8Array.from(atob(coseB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    // Flip the last bit of the final byte (part of the signature).
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
    const result = await verifyReceiptSignature(base64UrlEncode(raw), [key.jwk]);
    expect(result.signatureValid).toBe(false);
  });

  test("reports an unknown kid as an error", async () => {
    const key = await makeKey();
    const other = await makeKey(ATTACKER_SEED_B64);
    const coseB64 = await makeReceiptCose(key.privateKey, key.kid, "hi");
    const result = await verifyReceiptSignature(coseB64, [other.jwk]);
    expect(result.signatureValid).toBe(false);
    expect(result.error).toContain(key.kid);
  });

  test("rejects non-base64url input", async () => {
    const key = await makeKey();
    const result = await verifyReceiptSignature("not base64!!", [key.jwk]);
    expect(result.signatureValid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// verifyReceiptInclusion — cross-app consistency with the runtime log
// ---------------------------------------------------------------------------

async function buildProofResponse(
  receiptId: string,
  log: InMemoryTransparencyLog,
): Promise<ReceiptProofResponse> {
  const proof = await log.proofForReceipt(receiptId);
  if (proof === undefined) throw new Error(`missing proof for ${receiptId}`);
  const head = log.latestTreeHead();
  if (head === undefined) throw new Error("missing sealed head");
  return {
    receipt_id: receiptId,
    proof: {
      leaf_index: proof.leafIndex,
      tree_size: proof.treeSize,
      node_hashes: [...proof.nodeHashes],
    },
    tree_head: { tree_size: head.treeSize, cose_base64: base64UrlEncode(head.coseBytes) },
  };
}

describe("verifyReceiptInclusion (runtime cross-consistency)", () => {
  test("browser verifier accepts proofs from the runtime transparency log", async () => {
    const key = await makeKey();
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    const ids = ["r0", "r1", "r2", "r3"];
    const cose: string[] = [];
    for (const id of ids) {
      const c = await makeReceiptCose(key.privateKey, key.kid, id);
      cose.push(c);
      await log.append(id, Uint8Array.from(atob(c.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
        ch.charCodeAt(0),
      ));
    }
    await log.sealTreeHead();

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === undefined) continue;
      const proofResp = await buildProofResponse(id, log);
      const check = await verifyReceiptInclusion(cose[i] as string, proofResp, [key.jwk]);
      expect(check.headSignatureValid).toBe(true);
      expect(check.inclusionValid).toBe(true);
      expect(check.leafIndex).toBe(i);
      expect(check.treeSize).toBe(ids.length);
      expect(check.error).toBeUndefined();
    }
  });

  test("rejects a tampered proof path", async () => {
    const key = await makeKey();
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    const c = await makeReceiptCose(key.privateKey, key.kid, "x");
    await log.append("x", Uint8Array.from(atob(c.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
      ch.charCodeAt(0),
    ));
    await log.append("y", new Uint8Array([1, 2, 3]));
    await log.sealTreeHead();

    const proofResp = await buildProofResponse("x", log);
    expect(proofResp.proof.node_hashes.length).toBeGreaterThan(0);
    const first = proofResp.proof.node_hashes[0] as string;
    const flipped =
      first[0] === "0" ? `1${first.slice(1)}` : `0${first.slice(1)}`;
    proofResp.proof.node_hashes[0] = flipped;

    const check = await verifyReceiptInclusion(c, proofResp, [key.jwk]);
    expect(check.headSignatureValid).toBe(true);
    expect(check.inclusionValid).toBe(false);
    expect(check.error).toContain("inclusion");
  });

  test("rejects a tree head signed by a different key", async () => {
    const key = await makeKey();
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    const c = await makeReceiptCose(key.privateKey, key.kid, "x");
    await log.append("x", Uint8Array.from(atob(c.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
      ch.charCodeAt(0),
    ));
    await log.sealTreeHead();
    const proofResp = await buildProofResponse("x", log);

    const attacker = await makeKey(ATTACKER_SEED_B64);
    const check = await verifyReceiptInclusion(c, proofResp, [attacker.jwk]);
    expect(check.headSignatureValid).toBe(false);
    expect(check.inclusionValid).toBe(false);
  });

  test("rejects a proof whose tree_size does not match the sealed head", async () => {
    const key = await makeKey();
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    const c = await makeReceiptCose(key.privateKey, key.kid, "x");
    await log.append("x", Uint8Array.from(atob(c.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
      ch.charCodeAt(0),
    ));
    await log.sealTreeHead();
    const proofResp = await buildProofResponse("x", log);
    proofResp.proof.tree_size = 99;

    const check = await verifyReceiptInclusion(c, proofResp, [key.jwk]);
    expect(check.headSignatureValid).toBe(true);
    expect(check.inclusionValid).toBe(false);
    expect(check.error).toContain("tree_size");
  });
});
