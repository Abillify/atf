// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Short-lived monitoring tickets (`src/monitoring/monitoring-ticket.ts`)
 *
 * The monitoring SSE / WebSocket stream cannot send an `Authorization` header
 * (browsers forbid custom headers on `EventSource`/`WebSocket`), so the
 * dashboard historically passed the long-lived operator token as `?token=` in
 * the URL — where it lands in access logs, proxy logs and browser history.
 *
 * A ticket fixes that: the dashboard authenticates ONCE with its operator token
 * over a normal `POST` (header-based, never in a URL) and receives a
 * short-lived, HMAC-signed ticket. That ticket — not the operator token — is
 * what travels in the `?token=` query of the stream URL. It expires in seconds,
 * so a leaked log line is worthless minutes later, and it carries only the
 * granted role, not the reusable credential.
 *
 * Tickets are stateless (HMAC over `role.exp.nonce`), so they validate on any
 * replica that shares the signing secret — no server-side session store. The
 * feature is opt-in: with no signing secret configured, the ticket endpoint is
 * inert and the legacy token-in-URL path is unchanged.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { OperatorRole } from "../middleware/operator-rbac.js";

/** Decoded, verified ticket payload. */
export interface MonitoringTicket {
  role: OperatorRole;
  /** Expiry as a Unix epoch in seconds. */
  exp: number;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function hmac(secret: string, data: string): string {
  return base64url(crypto.createHmac("sha256", secret).update(data).digest());
}

/**
 * Issues a signed ticket for `role`, valid for `ttlSeconds` (default 60).
 * Format: `<role>.<exp>.<nonce>.<sig>` where sig = HMAC-SHA256 over the first
 * three segments. The nonce defends against trivial replay-by-collision and
 * makes two tickets issued in the same second distinct.
 */
export function signMonitoringTicket(
  secret: string,
  role: OperatorRole,
  ttlSeconds = 60,
): { ticket: string; expiresIn: number } {
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
  const nonce = base64url(crypto.randomBytes(9));
  const head = `${role}.${exp}.${nonce}`;
  const sig = hmac(secret, head);
  return {
    ticket: `${head}.${sig}`,
    expiresIn: exp - Math.floor(Date.now() / 1000),
  };
}

/**
 * Verifies a ticket against the secret and current time. Returns the decoded
 * ticket on success, or undefined when the format, signature or expiry fails.
 * Uses a constant-time signature comparison.
 */
export function verifyMonitoringTicket(
  secret: string,
  token: string | undefined,
  nowMs: number = Date.now(),
): MonitoringTicket | undefined {
  if (token === undefined || token.length === 0) return undefined;
  const parts = token.split(".");
  if (parts.length !== 4) return undefined;
  const [role, expStr, nonce, sig] = parts as [string, string, string, string];
  const head = `${role}.${expStr}.${nonce}`;
  const expected = hmac(secret, head);
  // Constant-time compare (lengths must match first).
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return undefined;
  }
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return undefined;
  if (role !== "viewer" && role !== "operator" && role !== "admin") {
    return undefined;
  }
  return { role, exp };
}
