// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Verifiable Evidence Bundle
 * (`src/observability/evidence-bundle.ts`).
 */

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildEvidenceBundle,
  signEvidenceBundle,
  verifyEvidenceBundle,
  renderEvidenceBundleMarkdown,
  canonicalizeForBundleHash,
  EVIDENCE_BUNDLE_VERSION,
  type EvidenceBundle,
} from "../evidence-bundle.js";
import type { ExplainCard } from "../explain.js";
import { parseEvidenceSigningKey } from "../evidence-key.js";

const SECRET = "a-shared-signing-secret-at-least-16-chars";

/** base64-encoded 32-byte Ed25519 seed for the asymmetric tests. */
const SEED_B64 = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i + 1),
).toString("base64");

function baseCard(over: Partial<ExplainCard> = {}): ExplainCard {
  return {
    executionId: "exec-1",
    flowId: "my-flow",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    totalLatencyMs: 2000,
    totalCost: 0.001,
    userName: "alice",
    userPrompt: "hello",
    steps: [
      {
        nodeId: "responder",
        kind: "node",
        status: "completed",
        latencyMs: 1000,
        model: "openai/gpt-4o-mini",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.001,
      },
    ],
    modelsUsed: [
      {
        model: "openai/gpt-4o-mini",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.001,
        callCount: 1,
      },
    ],
    routingDecisions: [],
    auditEntries: [],
    degraded: [],
    ...over,
  };
}

describe("buildEvidenceBundle", () => {
  it("wraps the card with a version, execution id, and generation timestamp", () => {
    const card = baseCard();
    const now = () => Date.parse("2026-06-01T12:00:00.000Z");
    const bundle = buildEvidenceBundle(card, { now });
    expect(bundle.version).toBe(EVIDENCE_BUNDLE_VERSION);
    expect(bundle.executionId).toBe("exec-1");
    expect(bundle.generatedAt).toBe("2026-06-01T12:00:00.000Z");
    expect(bundle.card).toEqual(card);
    expect(bundle.auditAnchor).toBeUndefined();
  });

  it("embeds the audit-anchor status when supplied", () => {
    const card = baseCard();
    const bundle = buildEvidenceBundle(card, {
      auditAnchor: { active: true, verified: true },
    });
    expect(bundle.auditAnchor).toEqual({ active: true, verified: true });
  });
});

describe("signEvidenceBundle / verifyEvidenceBundle", () => {
  it("round-trips: a freshly signed bundle verifies successfully", () => {
    const bundle = buildEvidenceBundle(baseCard());
    const signed = signEvidenceBundle(bundle, SECRET);
    expect(signed.algorithm).toBe("hmac-sha256");
    expect(signed.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const result = verifyEvidenceBundle(signed, SECRET);
    expect(result.valid).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const bundle = buildEvidenceBundle(baseCard());
    const signed = signEvidenceBundle(bundle, SECRET);
    const result = verifyEvidenceBundle(signed, "a-completely-different-secret!!");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected verification to fail");
    expect(result.reason).toBe("signature_mismatch");
  });

  it("detects tampering with the bundle content (e.g. an edited card field)", () => {
    const bundle = buildEvidenceBundle(baseCard());
    const signed = signEvidenceBundle(bundle, SECRET);
    // Simulate someone hand-editing the exported JSON before sharing it —
    // e.g. inflating the reported cost or changing the user prompt.
    const tampered = {
      ...signed,
      bundle: {
        ...signed.bundle,
        card: { ...signed.bundle.card, totalCost: 999 },
      },
    };
    const result = verifyEvidenceBundle(tampered, SECRET);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected verification to fail");
    expect(result.reason).toBe("content_hash_mismatch");
  });

  it("detects a forged signature paired with a re-hashed (also-tampered) bundle", () => {
    // A more sophisticated tamper attempt: recompute contentHash to match the
    // edited bundle, but without knowing the secret the signature cannot be
    // forged to match the new hash.
    const bundle = buildEvidenceBundle(baseCard());
    const signed = signEvidenceBundle(bundle, SECRET);
    const editedBundle: EvidenceBundle = {
      ...signed.bundle,
      card: { ...signed.bundle.card, userPrompt: "a different prompt" },
    };
    const forgedHash = createHash("sha256")
      .update(canonicalizeForBundleHash(editedBundle))
      .digest("hex");
    const forged = {
      ...signed,
      bundle: editedBundle,
      contentHash: forgedHash,
      // Signature still belongs to the ORIGINAL content hash — the attacker
      // does not know the secret and cannot re-sign the new hash.
    };
    const result = verifyEvidenceBundle(forged, SECRET);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected verification to fail");
    expect(result.reason).toBe("signature_mismatch");
  });

  it("is insensitive to key order (canonical serialization)", () => {
    const bundle = buildEvidenceBundle(baseCard());
    const signed = signEvidenceBundle(bundle, SECRET);
    // Rebuild the same logical bundle with keys inserted in a different order.
    const reordered: EvidenceBundle = JSON.parse(
      JSON.stringify(signed.bundle),
      undefined,
    );
    const reorderedSigned = { ...signed, bundle: reordered };
    expect(verifyEvidenceBundle(reorderedSigned, SECRET).valid).toBe(true);
  });

  it("signs with the Ed25519 evidence key (algorithm + kid stamped)", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const bundle = buildEvidenceBundle(baseCard());
    const signed = signEvidenceBundle(bundle, key);
    expect(signed.algorithm).toBe("ed25519");
    expect(signed.kid).toBe(key.kid);
    expect(signed.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEvidenceBundle(signed, key).valid).toBe(true);
  });

  it("verifies an Ed25519 bundle with the PUBLIC key only — no secret", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const signed = signEvidenceBundle(buildEvidenceBundle(baseCard()), key);
    // An independent auditor holds only the raw 32-byte public key.
    expect(verifyEvidenceBundle(signed, key.publicKeyRaw).valid).toBe(true);
  });

  it("rejects an Ed25519 bundle under a foreign public key", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    const other = parseEvidenceSigningKey(
      Buffer.alloc(32, 9).toString("base64"),
    );
    if (key === undefined || other === undefined)
      throw new Error("expected keys");
    const signed = signEvidenceBundle(buildEvidenceBundle(baseCard()), key);
    expect(verifyEvidenceBundle(signed, other.publicKeyRaw).valid).toBe(false);
  });

  it("rejects an Ed25519 bundle verified with only an HMAC secret", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const signed = signEvidenceBundle(buildEvidenceBundle(baseCard()), key);
    const result = verifyEvidenceBundle(signed, SECRET);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected verification to fail");
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects a legacy HMAC bundle verified with Ed25519 key material", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const signed = signEvidenceBundle(buildEvidenceBundle(baseCard()), SECRET);
    const result = verifyEvidenceBundle(signed, key);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected verification to fail");
    expect(result.reason).toBe("signature_mismatch");
  });

  it("detects tampering with an Ed25519-signed bundle's content", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const signed = signEvidenceBundle(buildEvidenceBundle(baseCard()), key);
    const tampered = {
      ...signed,
      bundle: {
        ...signed.bundle,
        card: { ...signed.bundle.card, totalCost: 999 },
      },
    };
    const result = verifyEvidenceBundle(tampered, key.publicKeyRaw);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected verification to fail");
    expect(result.reason).toBe("content_hash_mismatch");
  });
});

describe("canonicalizeForBundleHash", () => {
  it("produces identical output for objects with differently-ordered keys", () => {
    const a = canonicalizeForBundleHash({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalizeForBundleHash({ a: 2, c: { y: 2, z: 1 }, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order (arrays are not sorted, only object keys)", () => {
    const a = canonicalizeForBundleHash({ list: [1, 2, 3] });
    const b = canonicalizeForBundleHash({ list: [3, 2, 1] });
    expect(a).not.toBe(b);
  });
});

describe("renderEvidenceBundleMarkdown", () => {
  it("includes the underlying explain card, the content hash, signature, and verify command", () => {
    const bundle = buildEvidenceBundle(baseCard());
    const signed = signEvidenceBundle(bundle, SECRET);
    const md = renderEvidenceBundleMarkdown(signed);
    expect(md).toContain("# Verifiable Evidence Bundle — exec-1");
    expect(md).toContain("# Decision-Provenance Card — exec-1");
    expect(md).toContain(signed.contentHash);
    expect(md).toContain(signed.signature);
    expect(md).toContain("verify-bundle");
  });

  it("renders an Ed25519 bundle with the JWKS-based verify command", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const signed = signEvidenceBundle(buildEvidenceBundle(baseCard()), key);
    const md = renderEvidenceBundleMarkdown(signed);
    expect(md).toContain("Ed25519");
    expect(md).toContain(key.kid);
    expect(md).toContain("--jwks");
    expect(md).toContain("atf-evidence-jwks.json");
  });

  it("mentions the embedded audit-anchor status when present", () => {
    const bundle = buildEvidenceBundle(baseCard(), {
      auditAnchor: { active: true, verified: true },
    });
    const signed = signEvidenceBundle(bundle, SECRET);
    const md = renderEvidenceBundleMarkdown(signed);
    expect(md).toContain("Audit-chain anchoring was active");
  });

  it("states clearly when no audit anchor was configured", () => {
    const bundle = buildEvidenceBundle(baseCard(), {
      auditAnchor: { active: false },
    });
    const signed = signEvidenceBundle(bundle, SECRET);
    const md = renderEvidenceBundleMarkdown(signed);
    expect(md).toContain("Audit-chain anchoring was not configured");
  });
});
