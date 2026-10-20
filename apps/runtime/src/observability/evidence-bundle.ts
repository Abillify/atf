// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Verifiable Evidence Bundle (`src/observability/evidence-bundle.ts`)
 *
 * The Decision-Provenance {@link ExplainCard} (ADR-0017) answers "why did the
 * agent answer this way", but as plain JSON/Markdown it is just a claim: an
 * operator could hand-edit it before sharing it with an auditor, a customer,
 * or a regulator, and nothing about the artefact itself would reveal that.
 *
 * This module wraps an `ExplainCard` into a **signed** bundle. Signing uses
 * the shared Ed25519 evidence key (`EVIDENCE_SIGNING_KEY`, ADR 0030) when
 * configured: the bundle is then stamped `algorithm: "ed25519"` + `kid` and a
 * recipient — auditor, customer, regulator — verifies it offline against the
 * published public key (`GET /.well-known/atf-evidence-jwks.json`) with **no
 * shared secret**, which HMAC fundamentally cannot provide (handing a third
 * party the HMAC secret to let them verify destroys the signature's meaning).
 * When no asymmetric key is configured, the bundle falls back to the
 * HMAC-over-a-secret form the audit-chain anchoring service historically used
 * (`hmac-sha256`); such bundles remain verifiable by secret holders, and
 * `verifyEvidenceBundle` checks both algorithms by the envelope's `algorithm`
 * field.
 *
 * What is and is not proven:
 *   - Proven: the bundle's CONTENT (the card, plus the optional embedded audit
 *     anchor) is byte-for-byte what the signing party produced, at the time it
 *     was signed. With `ed25519` this also binds the artefact to a specific
 *     published key (non-repudiation), which HMAC cannot offer.
 *   - NOT proven: that the underlying execution history itself is accurate —
 *     the bundle can only attest to what the platform's stores reported at
 *     generation time. If the audit-anchor service is active, the bundle
 *     embeds the anchor status so a reader also gets that chain's
 *     tamper-evidence — one signed artefact instead of two things to check.
 *
 * No `any` at module boundaries.
 */

import { createHash, createHmac } from "node:crypto";
import { canonicalJson } from "@atf/canonical-json";
import type { ExplainCard } from "./explain.js";
import { renderExplainCardMarkdown } from "./explain.js";
import type { AuditAnchorStatus } from "./audit-anchor.js";
import {
  signEvidenceBytes,
  verifyEvidenceBytes,
  type Ed25519EvidenceKey,
} from "./evidence-key.js";

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

/** Current bundle format version. Bump on any breaking shape change. */
export const EVIDENCE_BUNDLE_VERSION = 1 as const;

export interface EvidenceBundle {
  version: typeof EVIDENCE_BUNDLE_VERSION;
  executionId: string;
  generatedAt: string;
  card: ExplainCard;
  /**
   * The audit-chain anchor status at generation time, when the anchoring
   * service (`EVIDENCE_SIGNING_KEY` or `AUDIT_ANCHOR_SECRET`) is active.
   * Embedding it means a reader gets the chain's own tamper-evidence bundled
   * into the same signed artefact, rather than a second thing to separately
   * fetch and trust.
   */
  auditAnchor?: AuditAnchorStatus;
}

export interface SignedEvidenceBundle {
  bundle: EvidenceBundle;
  /** SHA-256 hex digest of the bundle's canonical serialization. */
  contentHash: string;
  /**
   * Signature over `contentHash`, base64url. HMAC-SHA256 under the signing
   * secret when {@link algorithm} is `"hmac-sha256"`; an Ed25519 signature
   * under the evidence key when it is `"ed25519"` (ADR 0030).
   */
  signature: string;
  algorithm: "hmac-sha256" | "ed25519";
  /**
   * Key id (base64url SHA-256 thumbprint) of the Ed25519 evidence key that
   * produced {@link signature}. Only set when {@link algorithm} is
   * `"ed25519"`; a verifier resolves it against the published evidence JWKS.
   */
  kid?: string;
}

export type EvidenceVerification =
  | { valid: true }
  | {
      valid: false;
      reason: "content_hash_mismatch" | "signature_mismatch";
    };

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 *
 * `ExplainCard` is always constructed by `buildExplainCard` with a stable key
 * order, so a plain `JSON.stringify` would happen to work today — but the hash
 * this feeds is a security property, not an implementation detail, and it
 * must not silently start producing different signatures if a future refactor
 * reorders how the card's fields are assembled. Sorting keys recursively makes
 * the serialization depend only on the VALUES, matching the same reasoning
 * `canonicalizeForHash` in `audit-log.ts` already applies to one audit record.
 *
 * The implementation is `@atf/canonical-json`'s default mode (stringify
 * family, code-unit key order, `undefined` dropped) — byte-identical to the
 * former local `sortKeysDeep` (proven by
 * `packages/canonical-json/test/differential.test.ts`), because these bytes
 * back the bundle's content hash and signature.
 */
export const canonicalizeForBundleHash = canonicalJson;

// ---------------------------------------------------------------------------
// Build / sign / verify
// ---------------------------------------------------------------------------

/** Assembles the (unsigned) bundle from an already-built {@link ExplainCard}. */
export function buildEvidenceBundle(
  card: ExplainCard,
  opts?: { auditAnchor?: AuditAnchorStatus; now?: () => number },
): EvidenceBundle {
  const now = opts?.now ?? (() => Date.now());
  return {
    version: EVIDENCE_BUNDLE_VERSION,
    executionId: card.executionId,
    generatedAt: new Date(now()).toISOString(),
    card,
    ...(opts?.auditAnchor !== undefined ? { auditAnchor: opts.auditAnchor } : {}),
  };
}

/**
 * Signs a bundle: hashes its canonical form (SHA-256) and signs that hash.
 * With an {@link Ed25519EvidenceKey} the signature is Ed25519 and the envelope
 * carries `algorithm: "ed25519"` + `kid` (independently verifiable via the
 * published JWKS, ADR 0030); with a plain secret it is HMAC-SHA256 (legacy
 * form, kept for deployments without an asymmetric key). Both share the same
 * `contentHash` computation, so the integrity guarantee is identical — only
 * WHO can verify differs.
 */
export function signEvidenceBundle(
  bundle: EvidenceBundle,
  secretOrKey: string | Ed25519EvidenceKey,
): SignedEvidenceBundle {
  const contentHash = createHash("sha256")
    .update(canonicalizeForBundleHash(bundle))
    .digest("hex");
  if (typeof secretOrKey === "string") {
    const signature = createHmac("sha256", secretOrKey)
      .update(contentHash)
      .digest("base64url");
    return { bundle, contentHash, signature, algorithm: "hmac-sha256" };
  }
  return {
    bundle,
    contentHash,
    signature: signEvidenceBytes(secretOrKey, contentHash),
    algorithm: "ed25519",
    kid: secretOrKey.kid,
  };
}

/**
 * Verifies a signed bundle entirely offline: recomputes the content hash from
 * the embedded bundle and checks both the hash and the signature according to
 * the envelope's `algorithm`. This is the exact function the `verify-bundle`
 * CLI command calls — it never needs network access. For `"ed25519"` bundles
 * the verifier needs only the 32-byte public key (from the evidence JWKS); for
 * legacy `"hmac-sha256"` bundles, the shared secret. Key material that cannot
 * check the envelope's algorithm (secret for an Ed25519 bundle, public key for
 * an HMAC bundle) fails as `signature_mismatch`.
 */
export function verifyEvidenceBundle(
  signed: SignedEvidenceBundle,
  secretOrKey: string | Ed25519EvidenceKey | Uint8Array,
): EvidenceVerification {
  const recomputedHash = createHash("sha256")
    .update(canonicalizeForBundleHash(signed.bundle))
    .digest("hex");
  if (recomputedHash !== signed.contentHash) {
    return { valid: false, reason: "content_hash_mismatch" };
  }
  if (signed.algorithm === "ed25519") {
    const publicKey =
      typeof secretOrKey === "string"
        ? undefined
        : secretOrKey instanceof Uint8Array
          ? secretOrKey
          : secretOrKey.publicKeyRaw;
    if (publicKey === undefined) {
      return { valid: false, reason: "signature_mismatch" };
    }
    if (
      signed.kid !== undefined &&
      typeof secretOrKey !== "string" &&
      !(secretOrKey instanceof Uint8Array) &&
      secretOrKey.kid !== signed.kid
    ) {
      return { valid: false, reason: "signature_mismatch" };
    }
    if (!verifyEvidenceBytes(publicKey, signed.contentHash, signed.signature)) {
      return { valid: false, reason: "signature_mismatch" };
    }
    return { valid: true };
  }
  if (typeof secretOrKey !== "string") {
    return { valid: false, reason: "signature_mismatch" };
  }
  const expectedSignature = createHmac("sha256", secretOrKey)
    .update(signed.contentHash)
    .digest("base64url");
  if (expectedSignature !== signed.signature) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Renders a signed bundle as a downloadable Markdown document: the
 * `ExplainCard` rendering (same as the unsigned card) plus a verification
 * section stating the content hash, signature, and how to check them.
 */
export function renderEvidenceBundleMarkdown(signed: SignedEvidenceBundle): string {
  const { bundle } = signed;
  const asymmetric = signed.algorithm === "ed25519";
  const lines: string[] = [
    `# Verifiable Evidence Bundle — ${bundle.executionId}`,
    "",
    `- **Bundle version:** ${bundle.version}`,
    `- **Generated:** ${bundle.generatedAt}`,
    "",
    renderExplainCardMarkdown(bundle.card),
    "",
    "## Verification",
    "",
    `- **Content hash (SHA-256):** \`${signed.contentHash}\``,
    asymmetric
      ? `- **Signature (Ed25519, base64url, key \`${signed.kid ?? "unknown"}\`):** \`${signed.signature}\``
      : `- **Signature (HMAC-SHA256, base64url):** \`${signed.signature}\``,
    "",
    "To verify this bundle has not been altered since it was signed, run:",
    "",
    "```",
    asymmetric
      ? "bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <jwks.json|https://…/.well-known/atf-evidence-jwks.json>"
      : "bun run scripts/cli.ts verify-bundle <bundle.json> --secret <the-signing-secret>",
    "```",
    "",
    "The command recomputes the content hash from the embedded bundle and the",
    "signature from that hash, and reports whether both still match. It never",
    asymmetric
      ? "makes a request to the issuing server — only the bundle file and the\npublished public key (a JWKS file or URL) are needed, so anyone,\nincluding an independent auditor, can check this artefact."
      : "makes a network call — only the bundle file and the shared secret are\nneeded. Note: verifying an HMAC bundle requires the operator's shared\nsigning secret; ask the operator for an Ed25519-signed bundle\n(EVIDENCE_SIGNING_KEY) if you need to verify independently.",
  ];
  if (bundle.auditAnchor !== undefined) {
    lines.push(
      "",
      "## Embedded audit-chain anchor status",
      "",
      bundle.auditAnchor.active
        ? `Audit-chain anchoring was active at generation time. Latest anchor verified: **${bundle.auditAnchor.verified ?? "unknown"}**.`
        : "Audit-chain anchoring was not configured at generation time.",
    );
  }
  return lines.join("\n");
}
