// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Audit pseudonyms (`src/compliance/audit-pseudonym.ts`).
 *
 * The audit log is append-only, so writing an erasure subject (user id,
 * e-mail, external ids, issuer) into it would undo the subject redaction the
 * erasure orchestrator performs. Audit entries therefore carry a one-way
 * pseudonym instead of the identifier itself.
 *
 * With a configured pepper (`AUDIT_PSEUDONYM_PEPPER`) the pseudonym is keyed:
 * only someone who knows the secret can recompute it from a known identifier.
 * Without a pepper the pseudonym falls back to an unkeyed SHA-256, which is
 * still one-way but recomputable by anyone who guesses the identifier — the
 * production readiness gate warns about that configuration.
 */

import { createHmac, createHash } from "node:crypto";

/** Prefix that identifies a value in the audit log as a pseudonym. */
const PSEUDONYM_PREFIX = "psn_";

/** Number of hex characters taken from the digest (128 bits of output). */
const PSEUDONYM_HEX_LENGTH = 32;

/**
 * Derive a stable pseudonym for `value`.
 *
 * @param value   Identifier to pseudonymise (e.g. `"<tenantId>|<userId>"`).
 * @param pepper  Optional secret (`AUDIT_PSEUDONYM_PEPPER`). When present the
 *                pseudonym is `HMAC-SHA256(pepper, value)`, otherwise plain
 *                `SHA-256(value)`.
 * @returns `"psn_"` followed by the first 32 hex characters of the digest
 *          (36 characters in total).
 */
export function auditPseudonym(value: string, pepper?: string): string {
  const digest =
    pepper !== undefined
      ? createHmac("sha256", pepper).update(value, "utf8").digest("hex")
      : createHash("sha256").update(value, "utf8").digest("hex");
  return `${PSEUDONYM_PREFIX}${digest.slice(0, PSEUDONYM_HEX_LENGTH)}`;
}
