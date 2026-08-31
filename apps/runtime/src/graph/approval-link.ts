// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Approval-link capability tokens (`src/graph/approval-link.ts`)
 *
 * The human-in-the-loop approval widget is embedded in the Open WebUI chat as
 * an `<iframe>` (and clickable Approve/Deny links) pointing at the operator
 * plane (`/monitoring/approvals/:id/{widget,decide}`). Those endpoints require
 * the `approvals:write` permission, which the operator authorizer resolves ONLY
 * from an `Authorization: Bearer` header or a `?token=` query parameter.
 *
 * A browser loading an iframe (or following a link) cannot attach a bearer
 * header, and the operator session lives in an HttpOnly cookie the authorizer
 * never reads — so under `MONITORING_AUTH=true` the end user could never
 * authenticate the in-chat approval.
 *
 * This module mints a small HMAC-signed capability token that is:
 *   - bound to ONE specific approval id (cannot approve any other request), and
 *   - time-limited (auto-expires), so it is not a durable operator credential.
 *
 * The token is appended to the widget/decide URLs as `?token=<cap>`. The control
 * routes verify it against the same secret and, when valid, authorize that one
 * approval — without granting any broader operator access. It is deliberately
 * NOT a JWT, so it can never be mistaken for (or replayed as) an operator
 * session token by the JWT-based operator verifier.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";

/** Separator between the payload and signature segments. */
const SEP = ".";

interface ApprovalLinkPayload {
  /** Approval id this token authorizes. */
  id: string;
  /** Absolute expiry (epoch ms). */
  exp: number;
}

/**
 * Mints a capability token authorizing decisions on a single approval `id`,
 * valid until `expiresAtMs`. Signed with HMAC-SHA256 over the (base64url)
 * payload using `secret`. URL-safe (base64url, no padding).
 */
export function signApprovalLinkToken(
  approvalId: string,
  secret: string,
  expiresAtMs: number,
): string {
  const payload: ApprovalLinkPayload = {
    id: approvalId,
    exp: Math.floor(expiresAtMs),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}${SEP}${sig}`;
}

/**
 * Verifies a capability token: checks the HMAC signature (constant-time),
 * that it is bound to `approvalId`, and that it has not expired. Returns true
 * only when all checks pass.
 */
export function verifyApprovalLinkToken(
  token: string | undefined,
  approvalId: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (token === undefined || token === "") return false;
  const idx = token.indexOf(SEP);
  if (idx <= 0 || idx >= token.length - 1) return false;
  const payloadB64 = token.slice(0, idx);
  const sigB64 = token.slice(idx + 1);

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sigB64, "base64url");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(provided, expected)) return false;

  let payload: ApprovalLinkPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as ApprovalLinkPayload;
  } catch {
    return false;
  }
  if (typeof payload.id !== "string" || payload.id !== approvalId) return false;
  if (typeof payload.exp !== "number" || now > payload.exp) return false;
  return true;
}
