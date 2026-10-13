// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for the RFC 6962 Merkle tree (Property 15, Req 15.3):
 * an inclusion proof generated for a leaf must verify against the signed
 * tree head, and must NOT verify for tampered leaves, indices, roots, or
 * proof paths.
 */

import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  bytesToHex,
  hexToBytes,
  inclusionProof,
  merkleLeafHash,
  merkleNodeHash,
  signTreeHead,
  subtreeRoot,
  verifyInclusionProof,
  verifySignedTreeHead,
} from "../transparency-log.js";

async function generateEd25519() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const publicKeyRaw = new Uint8Array(
    Buffer.from(jwk.x as string, "base64url"),
  );
  return { privateKey: pair.privateKey, publicKeyRaw };
}

/** Arbitrary list of distinct leaf DATA (pre-hash), 1..24 entries. */
const leafDataArb = fc
  .array(fc.uint8Array({ minLength: 1, maxLength: 48 }), {
    minLength: 1,
    maxLength: 24,
  })
  .map((rows) => rows.map((r) => new Uint8Array(r)));

describe("Property 15: Merkle inclusion proofs", () => {
  test("proof for any leaf verifies against the tree root", async () => {
    await fc.assert(
      fc.asyncProperty(leafDataArb, fc.nat(), async (dataRows, idxSeed) => {
        const leaves = await Promise.all(dataRows.map(merkleLeafHash));
        const index = idxSeed % leaves.length;
        const root = await subtreeRoot(leaves, merkleNodeHash);
        const proof = await inclusionProof(leaves, index, merkleNodeHash);
        return verifyInclusionProof(
          root,
          leaves[index] as Uint8Array,
          index,
          leaves.length,
          proof,
          merkleNodeHash,
        );
      }),
      { numRuns: 120 },
    );
  });

  test("every index of the same tree verifies (all-indices sweep)", async () => {
    await fc.assert(
      fc.asyncProperty(leafDataArb, async (dataRows) => {
        const leaves = await Promise.all(dataRows.map(merkleLeafHash));
        const root = await subtreeRoot(leaves, merkleNodeHash);
        for (let i = 0; i < leaves.length; i++) {
          const proof = await inclusionProof(leaves, i, merkleNodeHash);
          const ok = await verifyInclusionProof(
            root,
            leaves[i] as Uint8Array,
            i,
            leaves.length,
            proof,
            merkleNodeHash,
          );
          if (!ok) return false;
        }
        return true;
      }),
      { numRuns: 60 },
    );
  });

  test("tampered leaf data never verifies", async () => {
    await fc.assert(
      fc.asyncProperty(leafDataArb, fc.nat(), async (dataRows, idxSeed) => {
        const leaves = await Promise.all(dataRows.map(merkleLeafHash));
        const index = idxSeed % leaves.length;
        const root = await subtreeRoot(leaves, merkleNodeHash);
        const proof = await inclusionProof(leaves, index, merkleNodeHash);
        const tampered = (leaves[index] as Uint8Array).slice();
        tampered[0] = (tampered[0] ?? 0) ^ 0xff;
        return !(await verifyInclusionProof(
          root,
          tampered,
          index,
          leaves.length,
          proof,
          merkleNodeHash,
        ));
      }),
      { numRuns: 120 },
    );
  });

  test("wrong index never verifies (different leaf position)", async () => {
    await fc.assert(
      fc.asyncProperty(
        leafDataArb.filter((rows) => rows.length >= 2),
        fc.nat(),
        fc.nat(),
        async (dataRows, aSeed, bSeed) => {
          const leaves = await Promise.all(dataRows.map(merkleLeafHash));
          const root = await subtreeRoot(leaves, merkleNodeHash);
          const proven = aSeed % leaves.length;
          const claimed = bSeed % leaves.length;
          if (proven === claimed) return true; // vacuous, skip
          const proof = await inclusionProof(leaves, proven, merkleNodeHash);
          return !(await verifyInclusionProof(
            root,
            leaves[claimed] as Uint8Array,
            claimed,
            leaves.length,
            proof,
            merkleNodeHash,
          ));
        },
      ),
      { numRuns: 120 },
    );
  });

  test("a proof from tree size N never verifies against the root of an extended tree (size N+1)", async () => {
    await fc.assert(
      fc.asyncProperty(
        leafDataArb,
        fc.uint8Array({ minLength: 1, maxLength: 48 }),
        fc.nat(),
        async (dataRows, extraRow, idxSeed) => {
          const leaves = await Promise.all(dataRows.map(merkleLeafHash));
          const index = idxSeed % leaves.length;
          const rootA = await subtreeRoot(leaves, merkleNodeHash);
          const proof = await inclusionProof(leaves, index, merkleNodeHash);
          // Same tree: verifies.
          const okSame = await verifyInclusionProof(
            rootA,
            leaves[index] as Uint8Array,
            index,
            leaves.length,
            proof,
            merkleNodeHash,
          );
          if (!okSame) return false;
          // Extended tree: the new root differs, and the old proof must not
          // recompute to it at the new tree size. (A proof claimed at a
          // LARGER size against the OLD root can coincide structurally —
          // that is exactly why verifiers must pin the tree size from the
          // signed head, covered by the signed-head property below.)
          const extraLeaf = await merkleLeafHash(new Uint8Array(extraRow));
          const extended = [...leaves, extraLeaf];
          const rootB = await subtreeRoot(extended, merkleNodeHash);
          const okExtended = await verifyInclusionProof(
            rootB,
            leaves[index] as Uint8Array,
            index,
            extended.length,
            proof,
            merkleNodeHash,
          );
          return !okExtended;
        },
      ),
      { numRuns: 120 },
    );
  });

  test("truncated or extended proof paths never verify", async () => {
    await fc.assert(
      fc.asyncProperty(
        leafDataArb.filter((rows) => rows.length >= 2),
        fc.nat(),
        async (dataRows, idxSeed) => {
          const leaves = await Promise.all(dataRows.map(merkleLeafHash));
          const index = idxSeed % leaves.length;
          const root = await subtreeRoot(leaves, merkleNodeHash);
          const proof = await inclusionProof(leaves, index, merkleNodeHash);
          if (proof.length === 0) return true;
          const truncated = proof.slice(0, proof.length - 1);
          const extra = [...proof, await merkleLeafHash(new Uint8Array([99]))];
          const okTrunc = await verifyInclusionProof(
            root,
            leaves[index] as Uint8Array,
            index,
            leaves.length,
            truncated,
            merkleNodeHash,
          );
          const okExtra = await verifyInclusionProof(
            root,
            leaves[index] as Uint8Array,
            index,
            leaves.length,
            extra,
            merkleNodeHash,
          );
          return !okTrunc && !okExtra;
        },
      ),
      { numRuns: 120 },
    );
  });

  test("signed tree head: proof verifies against the SIGNED head (Req 15.3 anchor)", async () => {
    const { privateKey, publicKeyRaw } = await generateEd25519();
    await fc.assert(
      fc.asyncProperty(leafDataArb, fc.nat(), async (dataRows, idxSeed) => {
        const leaves = await Promise.all(dataRows.map(merkleLeafHash));
        const index = idxSeed % leaves.length;
        const rootHash = await subtreeRoot(leaves, merkleNodeHash);
        const head = {
          treeSize: leaves.length,
          rootHash,
          timestamp: new Date().toISOString(),
        };
        const coseBytes = await signTreeHead(head, privateKey, "test-kid");
        const verified = await verifySignedTreeHead(coseBytes, publicKeyRaw);
        if (verified === undefined) return false;
        if (verified.treeSize !== leaves.length) return false;
        if (bytesToHex(verified.rootHash) !== bytesToHex(rootHash)) return false;
        const proof = await inclusionProof(leaves, index, merkleNodeHash);
        return verifyInclusionProof(
          verified.rootHash,
          leaves[index] as Uint8Array,
          index,
          verified.treeSize,
          proof,
          merkleNodeHash,
        );
      }),
      { numRuns: 80 },
    );
  });

  test("hex round-trip for arbitrary byte sequences", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 64 }),
        (bytes) => bytesToHex(hexToBytes(bytesToHex(bytes))) === bytesToHex(bytes),
      ),
      { numRuns: 200 },
    );
  });
});
