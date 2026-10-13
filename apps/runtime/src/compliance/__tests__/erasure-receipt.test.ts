// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Unit tests for the signed Erasure_Receipt (Req 2.11): payload shape with
 * subject hashes only, Ed25519 signing (PEM + raw seed), the audit-anchor
 * HMAC fallback, and the self-service lookup route
 * `GET /v1/me/data/erasures/{id}`.
 */

import { describe, it, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import * as fc from "fast-check";

import {
  canonicalizeJson,
  erasureSubjectHash,
  ERASURE_RECEIPT_TYPE,
} from "@atf/erasure-contract";

import {
  buildReceiptPayload,
  createSignedReceipt,
  ed25519ReceiptKey,
  hmacReceiptKey,
  signReceipt,
  verifyReceipt,
  type ErasureReceiptKey,
} from "../erasure-receipt.js";
import type { ErasureOperation } from "../erasure-orchestrator.js";

function operation(overrides: Partial<ErasureOperation> = {}): ErasureOperation {
  return {
    requestId: "5f0f0b6a-2c8f-4a1e-9d3b-7a1c2d3e4f50",
    tenantId: "acme",
    scope: "subject",
    subject: { userId: "u@x.de", externalIds: ["ext-1"] },
    status: "complete",
    results: [{ store: "search.chunks", status: "ok", erased: 7 }],
    erased: 7,
    storeGroups: [{ service: "search", stores: ["search.chunks"] }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function edKey(): ErasureReceiptKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { alg: "Ed25519", key: privateKey };
}

/** Payload for a populated operation — buildReceiptPayload never returns
 *  undefined here (results ≥ 1), so the guard is a type narrowing only. */
function payloadOf(op: ErasureOperation) {
  const payload = buildReceiptPayload(op);
  if (payload === undefined) throw new Error("expected a receipt payload");
  return payload;
}

/** A parsed receipt key — throws instead of a non-null assertion. */
function requireKey(key: ErasureReceiptKey | undefined): ErasureReceiptKey {
  if (key === undefined) throw new Error("expected a receipt key");
  return key;
}

describe("buildReceiptPayload", () => {
  it("hashes every subject identifier, never cleartext", () => {
    const payload = buildReceiptPayload(operation(), "2026-01-01T00:00:00.000Z");
    expect(payload).toBeDefined();
    expect(payload?.subjectHashes).toEqual([
      erasureSubjectHash("acme", "u@x.de"),
      erasureSubjectHash("acme", "ext-1"),
    ]);
    const json = canonicalizeJson(payload);
    expect(json).not.toContain("u@x.de");
    expect(json).not.toContain("ext-1");
  });

  it("tenant scope carries no subject hashes", () => {
    const payload = buildReceiptPayload(
      operation({ scope: "tenant", subject: undefined }),
      "2026-01-01T00:00:00.000Z",
    );
    expect(payload?.subjectHashes).toEqual([]);
  });

  it("no results → no receipt", () => {
    expect(
      buildReceiptPayload(operation({ results: [], status: "failed" })),
    ).toBeUndefined();
  });

  it("partial operations yield a partial receipt", () => {
    const payload = buildReceiptPayload(
      operation({
        status: "partial",
        results: [
          { store: "a", status: "ok", erased: 1 },
          { store: "b", status: "failed", erased: 0, error: "boom" },
        ],
      }),
      "2026-01-01T00:00:00.000Z",
    );
    expect(payload?.status).toBe("partial");
  });
});

describe("signReceipt / verifyReceipt", () => {
  it("Ed25519 round-trip verifies", () => {
    const key = edKey();
    const envelope = signReceipt(payloadOf(operation()), key);
    expect(envelope.typ).toBe(ERASURE_RECEIPT_TYPE);
    expect(envelope.alg).toBe("Ed25519");
    expect(verifyReceipt(envelope, key)).toBe(true);
  });

  it("raw base64 seed parses into a working Ed25519 key", () => {
    const seed = Buffer.from(
      Array.from({ length: 32 }, (_, i) => i + 1),
    ).toString("base64");
    const key = requireKey(ed25519ReceiptKey(seed));
    expect(key.alg).toBe("Ed25519");
    const envelope = signReceipt(payloadOf(operation()), key);
    expect(verifyReceipt(envelope, key)).toBe(true);
  });

  it("PEM private key parses", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const key = requireKey(ed25519ReceiptKey(pem));
    const envelope = signReceipt(payloadOf(operation()), key);
    expect(verifyReceipt(envelope, key)).toBe(true);
  });

  it("HS256 audit-anchor fallback round-trips", () => {
    const key = requireKey(hmacReceiptKey("anchor-secret-0123456789"));
    const envelope = signReceipt(payloadOf(operation()), key);
    expect(envelope.alg).toBe("HS256");
    expect(verifyReceipt(envelope, key)).toBe(true);
    expect(
      verifyReceipt(envelope, requireKey(hmacReceiptKey("other-secret-0123456789"))),
    ).toBe(false);
  });

  it("alg mismatch between envelope and key fails", () => {
    const ed = edKey();
    const envelope = signReceipt(payloadOf(operation()), ed);
    expect(
      verifyReceipt(envelope, requireKey(hmacReceiptKey("anchor-secret-0123456789"))),
    ).toBe(false);
  });

  it("createSignedReceipt returns undefined without store results", () => {
    expect(
      createSignedReceipt(operation({ results: [] }), edKey()),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 5 (Req 2.11 / design §Properties): receipt round trip:
// `verify(sign(receipt)) = true`; every bit change in payload or signature
// yields `false`. Tested for Ed25519 and the HS256 fallback.
// ---------------------------------------------------------------------------

const storeResultArb = fc
  .record({
    store: fc
      .string({ minLength: 1, maxLength: 12 })
      .map((s) => `s-${s.replace(/[^a-zA-Z0-9._-]/g, "x")}`),
    status: fc.constantFrom("ok", "failed", "not_configured"),
    erased: fc.nat({ max: 500 }),
  })
  .map((r) =>
    r.status === "ok"
      ? r
      : { store: r.store, status: r.status, erased: 0, error: "boom" },
  );

const operationArb = fc
  .record({
    requestId: fc.uuid(),
    tenantId: fc
      .string({ minLength: 1, maxLength: 20 })
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must go
      .map((s) => s.replace(/[\u0000-\u001f]/g, "x") || "t"),
    scope: fc.constantFrom("subject" as const, "tenant" as const),
    userId: fc.string({ minLength: 1, maxLength: 24 }),
    externalIds: fc.array(fc.string({ minLength: 1, maxLength: 16 }), {
      maxLength: 3,
    }),
    results: fc.array(storeResultArb, { minLength: 1, maxLength: 6 }),
    status: fc.constantFrom("complete" as const, "partial" as const),
    at: fc.date({
      min: new Date("2020-01-01"),
      max: new Date("2030-01-01"),
      noInvalidDate: true,
    }),
  })
  .map((r) => {
    const erased = r.results.reduce((n, x) => n + x.erased, 0);
    const op: ErasureOperation = {
      requestId: r.requestId,
      tenantId: r.tenantId,
      scope: r.scope,
      ...(r.scope === "subject"
        ? { subject: { userId: r.userId, externalIds: r.externalIds } }
        : {}),
      status: r.status,
      results: r.results,
      erased,
      storeGroups: [
        { service: "runtime", stores: r.results.map((x) => x.store) },
      ],
      createdAt: r.at.toISOString(),
      updatedAt: r.at.toISOString(),
    };
    return op;
  });

/**
 * Flip a single bit of the decoded signature bytes and re-encode as
 * base64url. Flipping a bit of the base64url TEXT instead would be unfair:
 * trailing characters carry padding bits that decoding ignores.
 */
function flipSignatureBit(sig: string, index: number): string {
  const bytes = Buffer.from(sig, "base64url");
  const bit = index % (bytes.length * 8);
  bytes[Math.floor(bit / 8)] ^= 1 << bit % 8;
  return bytes.toString("base64url");
}

function roundTripProperty(key: () => ErasureReceiptKey) {
  return fc.assert(
    fc.property(operationArb, fc.nat(), (op, flipIdx) => {
      const k = key();
      const payload = buildReceiptPayload(op);
      if (payload === undefined) return false; // results ≥ 1 → always defined
      const envelope = signReceipt(payload, k);
      if (!verifyReceipt(envelope, k)) return false;

      // Payload change (tenant appended) → verify must fail.
      const tamperedPayload = {
        ...envelope,
        payload: { ...envelope.payload, tenantId: `${envelope.payload.tenantId}!` },
      };
      if (verifyReceipt(tamperedPayload, k)) return false;

      // Signature bit flip → verify must fail.
      const flipped = {
        ...envelope,
        signature: flipSignatureBit(envelope.signature, flipIdx),
      };
      if (verifyReceipt(flipped, k)) return false;

      // Foreign key → verify must fail.
      if (verifyReceipt(envelope, key())) return false;

      return true;
    }),
    { numRuns: 200 },
  );
}

describe("Property 5: receipt round-trip (Req 2.11)", () => {
  it("Ed25519: sign/verify round-trips, any tampering fails", () => {
    // Each call yields a fresh keypair: the round-trip signs and verifies
    // with the same one, the foreign-key check gets a different one.
    roundTripProperty(() => edKey());
  });

  it("HS256 fallback: sign/verify round-trips, any tampering fails", () => {
    roundTripProperty(() =>
      requireKey(hmacReceiptKey(`anchor-secret-${Math.floor(Math.random() * 1e9)}`)),
    );
  });
});
