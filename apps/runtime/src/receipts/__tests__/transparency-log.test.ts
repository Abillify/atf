// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { cborDecodeSign1, coseSign1Verify } from "@atf/security-kit";

import {
  bytesToHex,
  equalBytes,
  hexToBytes,
  inclusionProof,
  merkleLeafHash,
  merkleNodeHash,
  signTreeHead,
  splitPoint,
  subtreeRoot,
  verifyInclusionProof,
  verifySignedTreeHead,
  verifyReceiptInclusion,
  InMemoryTransparencyLog,
  type MerkleTreeHeadData,
  type ReceiptLogEntry,
  type ReceiptLogSink,
  type SignedTreeHead,
} from "../transparency-log.js";

async function leafOf(data: Uint8Array): Promise<Uint8Array> {
  return merkleLeafHash(data);
}

function dataOf(byte: number, len = 8): Uint8Array {
  return new Uint8Array(len).fill(byte);
}

describe("RFC 6962 hashing primitives", () => {
  test("leaf hash matches H(0x00 || data) against node:crypto", async () => {
    const data = new TextEncoder().encode("receipt-payload");
    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(data)]))
      .digest("hex");
    expect(bytesToHex(await merkleLeafHash(data))).toBe(expected);
  });

  test("node hash matches H(0x01 || l || r) against node:crypto", async () => {
    const l = new Uint8Array(32).fill(1);
    const r = new Uint8Array(32).fill(2);
    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from([0x01]), Buffer.from(l), Buffer.from(r)]))
      .digest("hex");
    expect(bytesToHex(await merkleNodeHash(l, r))).toBe(expected);
  });

  test("leaf and node prefixes keep the same input distinct", async () => {
    const data = new Uint8Array(32).fill(7);
    const asLeaf = await merkleLeafHash(data);
    const asNode = await merkleNodeHash(data.slice(0, 16), data.slice(16));
    expect(equalBytes(asLeaf, asNode)).toBe(false);
  });
});

describe("splitPoint", () => {
  test("largest power of two strictly below size", () => {
    expect(splitPoint(2)).toBe(1);
    expect(splitPoint(3)).toBe(2);
    expect(splitPoint(5)).toBe(4);
    expect(splitPoint(8)).toBe(4);
    expect(splitPoint(9)).toBe(8);
    expect(splitPoint(17)).toBe(16);
  });

  test("throws for size <= 1", () => {
    expect(() => splitPoint(1)).toThrow(RangeError);
    expect(() => splitPoint(0)).toThrow(RangeError);
  });
});

describe("inclusion proofs (structural)", () => {
  const sizes = [1, 2, 3, 4, 5, 7, 8, 9, 16, 17];

  test("proof for every index of several tree sizes verifies", async () => {
    for (const size of sizes) {
      const leaves: Uint8Array[] = [];
      for (let i = 0; i < size; i++) {
        leaves.push(await leafOf(dataOf(i + 1)));
      }
      const root = await subtreeRoot(leaves, merkleNodeHash);
      for (let i = 0; i < size; i++) {
        const proof = await inclusionProof(leaves, i, merkleNodeHash);
        const ok = await verifyInclusionProof(
          root,
          leaves[i] as Uint8Array,
          i,
          size,
          proof,
          merkleNodeHash,
        );
        expect(ok).toBe(true);
      }
    }
  });

  test("single-leaf tree has an empty proof path", async () => {
    const leaves = [await leafOf(dataOf(42))];
    const proof = await inclusionProof(leaves, 0, merkleNodeHash);
    expect(proof.length).toBe(0);
    const root = await subtreeRoot(leaves, merkleNodeHash);
    expect(equalBytes(root, leaves[0] as Uint8Array)).toBe(true);
  });

  test("tampered leaf fails verification", async () => {
    const leaves = [];
    for (let i = 0; i < 6; i++) leaves.push(await leafOf(dataOf(i + 1)));
    const root = await subtreeRoot(leaves, merkleNodeHash);
    const proof = await inclusionProof(leaves, 2, merkleNodeHash);
    const bad = await leafOf(dataOf(99));
    const ok = await verifyInclusionProof(
      root,
      bad,
      2,
      6,
      proof,
      merkleNodeHash,
    );
    expect(ok).toBe(false);
  });

  test("wrong index fails verification", async () => {
    const leaves = [];
    for (let i = 0; i < 5; i++) leaves.push(await leafOf(dataOf(i + 1)));
    const root = await subtreeRoot(leaves, merkleNodeHash);
    const proof = await inclusionProof(leaves, 1, merkleNodeHash);
    const ok = await verifyInclusionProof(
      root,
      leaves[1] as Uint8Array,
      3,
      5,
      proof,
      merkleNodeHash,
    );
    expect(ok).toBe(false);
  });

  test("out-of-range index / tree size fails closed", async () => {
    const leaves = [await leafOf(dataOf(1)), await leafOf(dataOf(2))];
    const root = await subtreeRoot(leaves, merkleNodeHash);
    const proof = await inclusionProof(leaves, 0, merkleNodeHash);
    expect(
      await verifyInclusionProof(root, leaves[0] as Uint8Array, 2, 2, proof, merkleNodeHash),
    ).toBe(false);
    expect(
      await verifyInclusionProof(root, leaves[0] as Uint8Array, 0, 0, proof, merkleNodeHash),
    ).toBe(false);
  });

  test("truncated proof path fails verification", async () => {
    const leaves = [];
    for (let i = 0; i < 4; i++) leaves.push(await leafOf(dataOf(i + 1)));
    const root = await subtreeRoot(leaves, merkleNodeHash);
    const proof = await inclusionProof(leaves, 0, merkleNodeHash);
    const ok = await verifyInclusionProof(
      root,
      leaves[0] as Uint8Array,
      0,
      4,
      proof.slice(0, proof.length - 1),
      merkleNodeHash,
    );
    expect(ok).toBe(false);
  });

  test("extra proof hashes fail verification", async () => {
    const leaves = [await leafOf(dataOf(1))];
    const root = await subtreeRoot(leaves, merkleNodeHash);
    const ok = await verifyInclusionProof(
      root,
      leaves[0] as Uint8Array,
      0,
      1,
      [await leafOf(dataOf(2))],
      merkleNodeHash,
    );
    expect(ok).toBe(false);
  });
});

describe("hex helpers", () => {
  test("round-trip", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 254, 255]);
    expect(bytesToHex(bytes)).toBe("00010f10feff");
    expect(Array.from(hexToBytes("00010f10feff"))).toEqual(Array.from(bytes));
  });

  test("rejects invalid hex", () => {
    expect(() => hexToBytes("0")).toThrow(RangeError);
    expect(() => hexToBytes("zz")).toThrow(RangeError);
  });
});

describe("signed tree heads", () => {
  async function makeKey(): Promise<{ privateKey: CryptoKey; publicKeyRaw: Uint8Array; kid: string }> {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const jwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as JsonWebKey & { x: string };
    const publicKeyRaw = Buffer.from(jwk.x, "base64url");
    return { privateKey: pair.privateKey, publicKeyRaw, kid: "test-kid" };
  }

  test("sign → verify round-trip returns the decoded head", async () => {
    const { privateKey, publicKeyRaw, kid } = await makeKey();
    const head: MerkleTreeHeadData = {
      treeSize: 7,
      rootHash: new Uint8Array(32).fill(3),
      timestamp: "2026-02-01T12:00:00.000Z",
    };
    const cose = await signTreeHead(head, privateKey, kid);
    const verified = await verifySignedTreeHead(cose, publicKeyRaw);
    expect(verified).toBeDefined();
    expect(verified?.treeSize).toBe(7);
    expect(bytesToHex(verified?.rootHash as Uint8Array)).toBe(
      bytesToHex(head.rootHash),
    );
    expect(verified?.timestamp).toBe(head.timestamp);
  });

  test("verification with the wrong key fails", async () => {
    const a = await makeKey();
    const b = await makeKey();
    const head: MerkleTreeHeadData = {
      treeSize: 1,
      rootHash: new Uint8Array(32).fill(9),
      timestamp: "2026-02-01T12:00:00.000Z",
    };
    const cose = await signTreeHead(head, a.privateKey, a.kid);
    expect(await verifySignedTreeHead(cose, b.publicKeyRaw)).toBeUndefined();
  });

  test("tampered head bytes fail verification", async () => {
    const { privateKey, publicKeyRaw, kid } = await makeKey();
    const head: MerkleTreeHeadData = {
      treeSize: 4,
      rootHash: new Uint8Array(32).fill(5),
      timestamp: "2026-02-01T12:00:00.000Z",
    };
    const cose = await signTreeHead(head, privateKey, kid);
    const tampered = cose.slice();
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] as number) ^ 0x01;
    expect(await verifySignedTreeHead(tampered, publicKeyRaw)).toBeUndefined();
  });

  test("domain separation: a tree-head signature is not a valid receipt signature", async () => {
    const { privateKey, publicKeyRaw, kid } = await makeKey();
    const head: MerkleTreeHeadData = {
      treeSize: 2,
      rootHash: new Uint8Array(32).fill(1),
      timestamp: "2026-02-01T12:00:00.000Z",
    };
    const headCose = await signTreeHead(head, privateKey, kid);
    // The same bytes verified with EMPTY externalAad (the receipt domain)
    // must fail — externalAad is part of the COSE Sig_structure.
    const msg = cborDecodeSign1(headCose);
    const ok = await coseSign1Verify(msg, publicKeyRaw);
    expect(ok).toBe(false);
  });

  test("garbage input never throws", async () => {
    const { publicKeyRaw } = await makeKey();
    expect(
      await verifySignedTreeHead(new Uint8Array([1, 2, 3]), publicKeyRaw),
    ).toBeUndefined();
  });
});

describe("InMemoryTransparencyLog", () => {
  async function makeLog(sink?: ReceiptLogSink) {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const jwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as JsonWebKey & { x: string };
    const publicKeyRaw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
    const log = new InMemoryTransparencyLog(pair.privateKey, "kid-1", sink);
    return { log, publicKeyRaw };
  }

  function receiptBytes(n: number): Uint8Array {
    return new TextEncoder().encode(`cose-receipt-${n}`);
  }

  test("append assigns sequential seq and computes leaf hash", async () => {
    const { log } = await makeLog();
    const e0 = await log.append("r-0", receiptBytes(0));
    const e1 = await log.append("r-1", receiptBytes(1));
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(log.size()).toBe(2);
    expect(bytesToHex(e0.leafHash)).toBe(
      bytesToHex(await merkleLeafHash(receiptBytes(0))),
    );
  });

  test("append is idempotent per receipt id", async () => {
    const { log } = await makeLog();
    const first = await log.append("r-0", receiptBytes(0));
    const again = await log.append("r-0", receiptBytes(0));
    expect(again.seq).toBe(first.seq);
    expect(log.size()).toBe(1);
  });

  test("proofs verify against the current head for every entry", async () => {
    const { log } = await makeLog();
    for (let i = 0; i < 5; i++) {
      await log.append(`r-${i}`, receiptBytes(i));
    }
    const head = await log.currentHead();
    for (let i = 0; i < 5; i++) {
      const proof = await log.proofForReceipt(`r-${i}`);
      expect(proof).toBeDefined();
      if (proof === undefined) throw new Error("missing proof");
      const entry = log.entryByReceiptId(`r-${i}`);
      const ok = await verifyInclusionProof(
        head.rootHash,
        entry?.leafHash as Uint8Array,
        proof.leafIndex,
        proof.treeSize,
        proof.nodeHashes.map(hexToBytes),
        merkleNodeHash,
      );
      expect(ok).toBe(true);
    }
  });

  test("sealed head stays valid after more appends", async () => {
    const { log, publicKeyRaw } = await makeLog();
    for (let i = 0; i < 3; i++) await log.append(`r-${i}`, receiptBytes(i));
    const sealed = await log.sealTreeHead();
    expect(sealed.treeSize).toBe(3);
    for (let i = 3; i < 10; i++) await log.append(`r-${i}`, receiptBytes(i));
    // Proof for an old receipt against the SEALED tree size still verifies.
    const proof = await log.proofForReceipt("r-1", sealed.treeSize);
    expect(proof).toBeDefined();
    if (proof === undefined) throw new Error("missing proof");
    expect(proof.treeSize).toBe(3);
    const verified = await verifySignedTreeHead(sealed.coseBytes, publicKeyRaw);
    expect(verified?.treeSize).toBe(3);
    if (verified === undefined) throw new Error("tree head signature invalid");
    const entry = log.entryByReceiptId("r-1");
    const ok = await verifyInclusionProof(
      verified.rootHash,
      entry?.leafHash as Uint8Array,
      proof.leafIndex,
      proof.treeSize,
      proof.nodeHashes.map(hexToBytes),
      merkleNodeHash,
    );
    expect(ok).toBe(true);
    // The extended tree has a different root — history was appended, not rewritten.
    const current = await log.currentHead();
    expect(bytesToHex(current.rootHash)).not.toBe(bytesToHex(verified.rootHash));
  });

  test("proofForReceipt defaults to the latest sealed head size", async () => {
    const { log } = await makeLog();
    for (let i = 0; i < 4; i++) await log.append(`r-${i}`, receiptBytes(i));
    await log.sealTreeHead();
    for (let i = 4; i < 8; i++) await log.append(`r-${i}`, receiptBytes(i));
    const proof = await log.proofForReceipt("r-2");
    expect(proof?.treeSize).toBe(4);
  });

  test("proof for unknown receipt or future size is undefined", async () => {
    const { log } = await makeLog();
    await log.append("r-0", receiptBytes(0));
    expect(await log.proofForReceipt("nope")).toBeUndefined();
    expect(await log.proofForReceipt("r-0", 99)).toBeUndefined();
    // entry appended AFTER the sealed size has no proof for that size
    await log.sealTreeHead(); // size 1
    await log.append("r-1", receiptBytes(1));
    expect(await log.proofForReceipt("r-1", 1)).toBeUndefined();
  });

  test("sink receives every append and sealed head", async () => {
    const appended: ReceiptLogEntry[] = [];
    const heads: SignedTreeHead[] = [];
    const sink: ReceiptLogSink = {
      async append(entry) {
        appended.push(entry);
      },
      async saveTreeHead(head) {
        heads.push(head);
      },
    };
    const { log } = await makeLog(sink);
    await log.append("r-0", receiptBytes(0));
    await log.append("r-0", receiptBytes(0)); // idempotent — no second append
    await log.append("r-1", receiptBytes(1));
    await log.sealTreeHead();
    expect(appended.map((e) => e.receiptId)).toEqual(["r-0", "r-1"]);
    expect(heads.length).toBe(1);
    expect(heads[0]?.treeSize).toBe(2);
  });

  test("hydrate() rebuilds the same tree from the durable sink after a restart", async () => {
    // A sink that keeps rows like receipt_log does, across "restarts".
    const rows: { receiptId: string; coseBytes: Uint8Array }[] = [];
    const sink: ReceiptLogSink = {
      async append(entry) {
        rows.push({ receiptId: entry.receiptId, coseBytes: entry.coseBytes });
      },
      async saveTreeHead() {},
      async loadEntries() {
        return rows.map((r) => ({ ...r }));
      },
    };
    const { log: before } = await makeLog(sink);
    for (let i = 0; i < 5; i++) await before.append(`r-${i}`, receiptBytes(i));
    const rootBefore = bytesToHex((await before.currentHead()).rootHash);
    const proofBefore = await before.proofForReceipt("r-3", 5);

    const { log: after } = await makeLog(sink);
    expect(await after.hydrate()).toBe(5);
    expect(after.entryByReceiptId("r-3")?.seq).toBe(3);
    expect(bytesToHex((await after.currentHead()).rootHash)).toBe(rootBefore);
    expect(await after.proofForReceipt("r-3", 5)).toEqual(proofBefore);
    // New appends continue the log instead of starting again at position 0.
    const next = await after.append("r-5", receiptBytes(5));
    expect(next.seq).toBe(5);
    expect(rows.length).toBe(6);
  });

  test("hydrate() is a no-op without a loading sink and refuses to run after appends", async () => {
    const { log } = await makeLog();
    expect(await log.hydrate()).toBe(0);
    await log.append("r-0", receiptBytes(0));
    await expect(log.hydrate()).rejects.toThrow("before the first append");
  });

  test("empty tree has a stable sentinel root", async () => {
    const { log } = await makeLog();
    const h1 = await log.currentHead();
    const h2 = await log.currentHead();
    expect(bytesToHex(h1.rootHash)).toBe(bytesToHex(h2.rootHash));
    expect(h1.treeSize).toBe(0);
  });
});

describe("verifyReceiptInclusion (offline end-to-end)", () => {
  test("receipt → log → sealed head → offline verification", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const jwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as JsonWebKey & { x: string };
    const publicKeyRaw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
    const log = new InMemoryTransparencyLog(pair.privateKey, "kid-x");

    const receipts: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) {
      const bytes = new TextEncoder().encode(`signed-receipt-${i}`);
      receipts.push(bytes);
      await log.append(`rcpt-${i}`, bytes);
    }
    const sealed = await log.sealTreeHead();

    for (let i = 0; i < 6; i++) {
      const proof = await log.proofForReceipt(`rcpt-${i}`, sealed.treeSize);
      const check = await verifyReceiptInclusion(
        receipts[i] as Uint8Array,
        sealed.coseBytes,
        proof as never,
        publicKeyRaw,
      );
      expect(check).toBeDefined();
      expect(check?.headSignatureValid).toBe(true);
      expect(check?.inclusionValid).toBe(true);
    }
  });

  test("receipt not in the tree → inclusionValid false", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const jwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as JsonWebKey & { x: string };
    const publicKeyRaw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
    const log = new InMemoryTransparencyLog(pair.privateKey, "kid-x");
    for (let i = 0; i < 4; i++) {
      await log.append(`rcpt-${i}`, new TextEncoder().encode(`r-${i}`));
    }
    const sealed = await log.sealTreeHead();
    const proof = await log.proofForReceipt("rcpt-0", sealed.treeSize);
    const check = await verifyReceiptInclusion(
      new TextEncoder().encode("forged-receipt"),
      sealed.coseBytes,
      proof as never,
      publicKeyRaw,
    );
    expect(check?.inclusionValid).toBe(false);
    expect(check?.headSignatureValid).toBe(true);
  });

  test("unsigned / forged head → undefined", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const jwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as JsonWebKey & { x: string };
    const publicKeyRaw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
    const check = await verifyReceiptInclusion(
      new Uint8Array([1]),
      new Uint8Array([2, 3, 4]),
      { leafIndex: 0, treeSize: 1, nodeHashes: [] },
      publicKeyRaw,
    );
    expect(check).toBeUndefined();
  });
});
