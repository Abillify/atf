// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * test/cose.test.ts
 *
 * COSE_Sign1 (Ed25519 / WebCrypto) tests for decision receipts (Req 15.3),
 * including Property 5: verify(sign(receipt)) is always true and flipping
 * ANY single bit in payload, signature or protected header makes
 * verification fail.
 */

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  cborDecodeSign1,
  cborEncodeSign1,
  COSE_ALG_EDDSA,
  type CoseSign1,
  coseSign1,
  coseSign1Verify,
  decodeProtectedHeader,
  ed25519RawKeyToJwk,
  ED25519_PUB_KEY_BYTES,
  ED25519_SIG_BYTES,
  exportEd25519RawPublicKey,
  importEd25519PrivateKeySeed,
  jwkToEd25519RawKey,
} from "../src/cose/index.ts";

async function generateKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicKey = await exportEd25519RawPublicKey(pair.privateKey);
  return { privateKey: pair.privateKey, publicKey };
}

function randomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/** Flip a single bit at a deterministic position. */
function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice();
  const i = index % out.length;
  out[i] = (out[i] ?? 0) ^ 0x01;
  return out;
}

describe("COSE_Sign1 (Ed25519, RFC 9052 §4.2)", () => {
  test("sign/verify round-trip succeeds", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const payload = new TextEncoder().encode("decision receipt payload");
    const msg = await coseSign1(privateKey, payload, { kid: "key-1" });
    expect(msg.signature.length).toBe(ED25519_SIG_BYTES);
    expect(msg.payload).toEqual(payload);
    expect(await coseSign1Verify(msg, publicKey)).toBe(true);
  });

  test("protected header carries alg=-8 and kid", async () => {
    const { privateKey } = await generateKeyPair();
    const msg = await coseSign1(privateKey, new Uint8Array([1, 2, 3]), {
      kid: "k-42",
    });
    const header = decodeProtectedHeader(msg.protectedBytes);
    expect(header.alg).toBe(COSE_ALG_EDDSA);
    expect(header.kid).toBe("k-42");
    expect(header.rest.length).toBe(0);
  });

  test("wire encoding round-trips through CBOR", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const msg = await coseSign1(privateKey, new Uint8Array([9, 8, 7]), {
      kid: "wire",
    });
    const bytes = cborEncodeSign1(msg);
    const decoded = cborDecodeSign1(bytes);
    expect(decoded.protectedBytes).toEqual(msg.protectedBytes);
    expect(decoded.payload).toEqual(msg.payload);
    expect(decoded.signature).toEqual(msg.signature);
    expect(await coseSign1Verify(decoded, publicKey)).toBe(true);
    // Encoding is deterministic: re-encoding the decoded message yields
    // exactly the same bytes.
    expect(cborEncodeSign1(decoded)).toEqual(bytes);
  });

  test("wrong key fails verification", async () => {
    const { privateKey } = await generateKeyPair();
    const other = await generateKeyPair();
    const msg = await coseSign1(privateKey, new Uint8Array([42]));
    expect(await coseSign1Verify(msg, other.publicKey)).toBe(false);
  });

  test("external AAD is bound into the signature", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const aad = new TextEncoder().encode("context");
    const msg = await coseSign1(privateKey, new Uint8Array([1]), {
      externalAad: aad,
    });
    expect(await coseSign1Verify(msg, publicKey, aad)).toBe(true);
    expect(
      await coseSign1Verify(msg, publicKey, new TextEncoder().encode("other")),
    ).toBe(false);
    expect(await coseSign1Verify(msg, publicKey)).toBe(false);
  });

  test("malformed messages verify false without throwing", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const msg = await coseSign1(privateKey, new Uint8Array([1]));
    const truncated: CoseSign1 = {
      ...msg,
      signature: msg.signature.slice(0, 63),
    };
    expect(await coseSign1Verify(truncated, publicKey)).toBe(false);
    expect(
      await coseSign1Verify(msg, new Uint8Array(ED25519_PUB_KEY_BYTES - 1)),
    ).toBe(false);
  });

  test("signatures are deterministic for the same key and payload", async () => {
    const seed = randomSeed();
    const privateKey = await importEd25519PrivateKeySeed(seed);
    const payload = new TextEncoder().encode("deterministic");
    const a = await coseSign1(privateKey, payload, { kid: "d" });
    const b = await coseSign1(privateKey, payload, { kid: "d" });
    expect(a.signature).toEqual(b.signature);
    expect(cborEncodeSign1(a)).toEqual(cborEncodeSign1(b));
  });

  test("seed import/export round-trips via JWK", async () => {
    const { publicKey } = await generateKeyPair();
    const jwk = ed25519RawKeyToJwk(publicKey, "jwks-1");
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(jwk.alg).toBe("EdDSA");
    expect((jwk as JsonWebKey & { kid?: string }).kid).toBe("jwks-1");
    expect(jwkToEd25519RawKey(jwk)).toEqual(publicKey);
  });

  test("rejects non-OKP JWKs", () => {
    expect(() =>
      jwkToEd25519RawKey({ kty: "EC", crv: "P-256", x: "AAAA" }),
    ).toThrow();
  });
});

describe("Property 5: receipt signature integrity (Req 15.3, 15.5)", () => {
  const keyPairPromise = generateKeyPair();

  test("verify(sign(payload)) is true for arbitrary payloads", async () => {
    const { privateKey, publicKey } = await keyPairPromise;
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (payload) => {
        const msg = await coseSign1(privateKey, payload, { kid: "p5" });
        expect(await coseSign1Verify(msg, publicKey)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  test("any single-bit flip in payload, signature or header fails", async () => {
    const { privateKey, publicKey } = await keyPairPromise;
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 256 }),
        fc.nat(),
        fc.integer({ min: 0, max: 2 }),
        async (payload, bitIndex, part) => {
          const msg = await coseSign1(privateKey, payload, { kid: "p5" });
          const mutated: CoseSign1 =
            part === 0
              ? { ...msg, payload: flipBit(msg.payload, bitIndex) }
              : part === 1
                ? { ...msg, signature: flipBit(msg.signature, bitIndex) }
                : { ...msg, protectedBytes: flipBit(msg.protectedBytes, bitIndex) };
          expect(await coseSign1Verify(mutated, publicKey)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("mutated wire bytes fail decode or verification", async () => {
    const { privateKey, publicKey } = await keyPairPromise;
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 256 }),
        fc.nat(),
        async (payload, bitIndex) => {
          const msg = await coseSign1(privateKey, payload, { kid: "p5" });
          const bytes = cborEncodeSign1(msg);
          const mutated = flipBit(bytes, bitIndex);
          let verified = false;
          try {
            verified = await coseSign1Verify(
              cborDecodeSign1(mutated),
              publicKey,
            );
          } catch {
            verified = false;
          }
          expect(verified).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
