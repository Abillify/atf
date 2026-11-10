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
 * Grace added on top of the approval's own auto-deny timeout when minting a
 * capability token. The token lives in a URL (chat history, access logs,
 * Referer), so the point is to keep it as short as possible while still
 * letting a reviewer who opens the widget just before the deadline reload it
 * and read the outcome — the widget itself reloads one second after the
 * timeout fires.
 */
export const APPROVAL_LINK_GRACE_MS = 60_000;

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
 * Outcome of {@link checkApprovalLinkToken}.
 *
 * `expired` is deliberately distinguished from `invalid`: an expired token is
 * genuine (correct signature, correct approval id) and its approval has by
 * definition reached a terminal state — the auto-deny fired. That is enough to
 * show the reviewer the outcome of THE approval they were shown, which is what
 * a reload of the in-chat widget needs, while a forged or foreign token stays a
 * plain rejection. It never grants a decision.
 */
export type ApprovalLinkTokenStatus = "valid" | "expired" | "invalid";

/**
 * Verifies a capability token and reports WHY it failed: signature and
 * approval-id binding first (constant-time), then expiry. See
 * {@link ApprovalLinkTokenStatus}.
 */
export function checkApprovalLinkToken(
  token: string | undefined,
  approvalId: string,
  secret: string,
  now: number = Date.now(),
): ApprovalLinkTokenStatus {
  if (token === undefined || token === "") return "invalid";
  const idx = token.indexOf(SEP);
  if (idx <= 0 || idx >= token.length - 1) return "invalid";
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
    return "invalid";
  }
  if (provided.length !== expected.length) return "invalid";
  if (!crypto.timingSafeEqual(provided, expected)) return "invalid";

  let payload: ApprovalLinkPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as ApprovalLinkPayload;
  } catch {
    return "invalid";
  }
  if (typeof payload.id !== "string" || payload.id !== approvalId) {
    return "invalid";
  }
  if (typeof payload.exp !== "number") return "invalid";
  return now > payload.exp ? "expired" : "valid";
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
  return checkApprovalLinkToken(token, approvalId, secret, now) === "valid";
}

// ---------------------------------------------------------------------------
// Second-step confirmation tokens (`confirm=`)
// ---------------------------------------------------------------------------

/**
 * How long a minted confirmation stays valid. Deliberately much shorter than
 * the capability token: it only has to cover the seconds between rendering the
 * confirmation page and the click on it.
 */
export const APPROVAL_CONFIRM_TTL_MS = 120_000;

/** Purpose marker so a confirm token can never be parsed as a link token. */
const CONFIRM_PREFIX = "c1:";

export type ApprovalDecision = "approved" | "denied";

/**
 * Canonical string signed by a confirmation token: the approval id, the
 * decision it was minted for, its own absolute expiry and the expiry of the
 * capability token it belongs to. Binding the decision means an
 * `approved` confirmation cannot be replayed as `denied`; binding the link
 * expiry means it cannot be carried over to a re-minted link.
 */
function confirmPayload(
  approvalId: string,
  decision: ApprovalDecision,
  expiresAtMs: number,
  linkExpiresAtMs: number,
): string {
  return (
    `${CONFIRM_PREFIX}${approvalId}:${decision}:` +
    `${Math.floor(expiresAtMs)}:${Math.floor(linkExpiresAtMs)}`
  );
}

/**
 * Mints the second-step confirmation for a two-click approval link: an
 * HMAC-SHA256 over `APPROVAL_CONFIRM_TTL_MS` worth of validity, keyed with the
 * same secret as the capability token. URL-safe (base64url, no padding).
 */
export function signApprovalConfirmToken(
  approvalId: string,
  decision: ApprovalDecision,
  linkExpiresAtMs: number,
  secret: string,
  now: number = Date.now(),
): string {
  const payload = confirmPayload(
    approvalId,
    decision,
    now + APPROVAL_CONFIRM_TTL_MS,
    linkExpiresAtMs,
  );
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}${SEP}${sig}`;
}

/**
 * Verifies a confirmation token: constant-time HMAC check, then the bound
 * approval id, decision and link expiry, then its own 120 s validity. Returns
 * true only when every check passes; malformed input is rejected, never thrown.
 */
export function verifyApprovalConfirmToken(
  token: string | undefined,
  approvalId: string,
  decision: ApprovalDecision,
  linkExpiresAtMs: number,
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

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return false;
  }
  if (!payload.startsWith(CONFIRM_PREFIX)) return false;
  const parts = payload.slice(CONFIRM_PREFIX.length).split(":");
  if (parts.length !== 4) return false;
  const [id, signedDecision, expRaw, linkExpRaw] = parts as [
    string,
    string,
    string,
    string,
  ];
  const exp = Number(expRaw);
  const linkExp = Number(linkExpRaw);
  if (!Number.isFinite(exp) || !Number.isFinite(linkExp)) return false;
  if (id !== approvalId) return false;
  if (signedDecision !== decision) return false;
  if (linkExp !== Math.floor(linkExpiresAtMs)) return false;
  if (now > exp) return false;
  return true;
}

/**
 * Reads the absolute expiry embedded in a capability token WITHOUT verifying
 * the signature. Only safe after {@link verifyApprovalLinkToken} succeeded (or
 * when the value is used for rendering, never for authorization) — it exists
 * so the decide handler can bind a confirmation token to the same link expiry
 * it was minted against. Returns undefined for a malformed token.
 */
export function readApprovalLinkExpiry(
  token: string | undefined,
): number | undefined {
  if (token === undefined || token === "") return undefined;
  const idx = token.indexOf(SEP);
  if (idx <= 0 || idx >= token.length - 1) return undefined;
  let payload: ApprovalLinkPayload;
  try {
    payload = JSON.parse(
      Buffer.from(token.slice(0, idx), "base64url").toString("utf8"),
    ) as ApprovalLinkPayload;
  } catch {
    return undefined;
  }
  return typeof payload.exp === "number" ? payload.exp : undefined;
}
