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
 * This module wraps an `ExplainCard` into a **signed** bundle using the SAME
 * HMAC-over-a-secret-held-outside-the-database primitive the audit-chain
 * anchoring service already uses (`audit-anchor.ts`, `signAuditAnchor` /
 * `verifyAuditAnchor`) — deliberately not a new cryptographic primitive, a new
 * key-management story, or a PKI. A bundle recipient (or the bundled
 * `verify-bundle` CLI command) with the shared secret can confirm the bundle's
 * content has not been altered since it was generated, entirely offline — no
 * call back to the issuing server, no trust in whoever is showing them the
 * file.
 *
 * What is and is not proven:
 *   - Proven: the bundle's CONTENT (the card, plus the optional embedded audit
 *     anchor) is byte-for-byte what the signing party produced, at the time it
 *     was signed. This is integrity, the same guarantee `verifyAuditAnchor`
 *     gives the audit chain.
 *   - NOT proven: that the underlying execution history itself is accurate —
 *     the bundle can only attest to what the platform's stores reported at
 *     generation time. If the audit-anchor service is active, the bundle
 *     embeds the anchor status so a reader also gets that chain's
 *     tamper-evidence — one signed artefact instead of two things to check.
 *
 * No `any` at module boundaries.
 */

import { createHash, createHmac } from "node:crypto";
import type { ExplainCard } from "./explain.js";
import { renderExplainCardMarkdown } from "./explain.js";
import type { AuditAnchorStatus } from "./audit-anchor.js";

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
   * service (`AUDIT_ANCHOR_SECRET`) is active. Embedding it means a reader
   * gets the chain's own tamper-evidence bundled into the same signed
   * artefact, rather than a second thing to separately fetch and trust.
   */
  auditAnchor?: AuditAnchorStatus;
}

export interface SignedEvidenceBundle {
  bundle: EvidenceBundle;
  /** SHA-256 hex digest of the bundle's canonical serialization. */
  contentHash: string;
  /** HMAC-SHA256 of `contentHash`, base64url, under the signing secret. */
  signature: string;
  algorithm: "hmac-sha256";
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
 */
export function canonicalizeForBundleHash(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

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
 * Signs a bundle: hashes its canonical form (SHA-256) and HMACs that hash
 * under `secret`. Mirrors `signAuditAnchor`'s shape exactly (`hmac-sha256`
 * algorithm, base64url signature) so a reader already familiar with the audit
 * anchor format has nothing new to learn.
 */
export function signEvidenceBundle(
  bundle: EvidenceBundle,
  secret: string,
): SignedEvidenceBundle {
  const contentHash = createHash("sha256")
    .update(canonicalizeForBundleHash(bundle))
    .digest("hex");
  const signature = createHmac("sha256", secret)
    .update(contentHash)
    .digest("base64url");
  return { bundle, contentHash, signature, algorithm: "hmac-sha256" };
}

/**
 * Verifies a signed bundle against `secret`, entirely offline: recomputes the
 * content hash from the embedded bundle and checks both the hash and the
 * signature. This is the exact function the `verify-bundle` CLI command
 * calls — it never needs network access, only the bundle file and the shared
 * secret.
 */
export function verifyEvidenceBundle(
  signed: SignedEvidenceBundle,
  secret: string,
): EvidenceVerification {
  const recomputedHash = createHash("sha256")
    .update(canonicalizeForBundleHash(signed.bundle))
    .digest("hex");
  if (recomputedHash !== signed.contentHash) {
    return { valid: false, reason: "content_hash_mismatch" };
  }
  const expectedSignature = createHmac("sha256", secret)
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
    `- **Signature (HMAC-SHA256, base64url):** \`${signed.signature}\``,
    "",
    "To verify this bundle has not been altered since it was signed, run:",
    "",
    "```",
    "bun run scripts/cli.ts verify-bundle <bundle.json> --secret <the-signing-secret>",
    "```",
    "",
    "The command recomputes the content hash from the embedded bundle and the",
    "signature from that hash, and reports whether both still match. It never",
    "makes a network call — only the bundle file and the shared secret are",
    "needed.",
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
