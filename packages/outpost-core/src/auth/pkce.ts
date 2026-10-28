// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PKCE primitives (requirements 3.1, 3.2, 3.3, 3.7, 15.2).
 *
 * Reusable by both the desktop Extract login and the cloud source
 * authorization in `auth/source-oauth/`. The verifier uses the RFC 7636
 * unreserved alphabet; the challenge is the S256 transformation; `state` is
 * compared in constant time. The loopback listener is an injected interface
 * so the desktop host (Rust) can supply it while tests use a fake.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Loopback host for the redirect — always `127.0.0.1` (3.1). */
export const LOOPBACK_HOST = "127.0.0.1";

/** Redirect wait timeout in milliseconds (3.7). */
export const LOOPBACK_TIMEOUT_MS = 300_000;

/** RFC 7636 §4.1 unreserved character set. */
const VERIFIER_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * Generate a `code_verifier` of `length` characters from the RFC 7636
 * alphabet. Default 43 (the length of base64url(32 bytes)); valid range is
 * 43–128.
 */
export function generateCodeVerifier(length = 43): string {
  if (length < 43 || length > 128) {
    throw new RangeError("code_verifier length must be between 43 and 128");
  }
  // randomInt draws uniformly; `byte % 66` would favour the first 58 characters.
  let out = "";
  for (let i = 0; i < length; i++) {
    out += VERIFIER_CHARSET[randomInt(VERIFIER_CHARSET.length)];
  }
  return out;
}

/** base64url without padding. */
const base64url = (buf: Buffer): string =>
  buf.toString("base64url").replace(/=+$/, "");

/** `code_challenge = BASE64URL(SHA256(code_verifier))` (S256). */
export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** Generate a 32-byte random `state` (base64url-encoded). */
export function generateState(): string {
  return base64url(randomBytes(32));
}

/**
 * Constant-time comparison of two strings. Hashing both sides first keeps the
 * comparison independent of the input lengths (a plain `timingSafeEqual`
 * throws on differing lengths, which would leak length through a throw).
 */
export function statesMatch(sent: string, received: string): boolean {
  const a = createHash("sha256").update(sent, "utf8").digest();
  const b = createHash("sha256").update(received, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Build the loopback redirect URI for a bound port (3.1). */
export const loopbackRedirectUri = (port: number): string =>
  `http://${LOOPBACK_HOST}:${port}/callback`;

/** A redirect captured by the loopback listener. */
export interface LoopbackRedirect {
  /** The `state` query parameter, or null when absent. */
  state: string | null;
  /** The `code` query parameter, or null when absent. */
  code: string | null;
  /** The `error` query parameter, or null on success. */
  error: string | null;
}

/**
 * Abstraction over the loopback HTTP listener. On desktop the Rust host binds
 * `127.0.0.1:0` and forwards the captured redirect; tests provide an
 * in-memory fake.
 */
export interface LoopbackListener {
  /** Start listening; resolves with the bound port. */
  start(): Promise<number>;
  /** Resolve with the next redirect, or reject after `timeoutMs`. */
  waitForRedirect(timeoutMs: number): Promise<LoopbackRedirect>;
  /** Stop listening and release the port. */
  stop(): Promise<void>;
}

export type AuthCodeResult =
  | { kind: "code"; code: string }
  | { kind: "error"; reason: "state-mismatch" | "provider-error" | "missing-code" | "timeout"; detail?: string };

/**
 * Wait for the loopback redirect and validate it against the expected
 * `state`. A mismatched or missing `state` discards the code (3.3). On
 * success returns the authorization code for the PKCE token exchange.
 */
export async function waitForAuthCode(
  listener: LoopbackListener,
  expectedState: string,
  timeoutMs: number = LOOPBACK_TIMEOUT_MS,
): Promise<AuthCodeResult> {
  let redirect: LoopbackRedirect;
  try {
    redirect = await listener.waitForRedirect(timeoutMs);
  } catch {
    return { kind: "error", reason: "timeout" };
  }
  if (redirect.state === null || !statesMatch(expectedState, redirect.state)) {
    return { kind: "error", reason: "state-mismatch" };
  }
  if (redirect.error !== null) {
    return { kind: "error", reason: "provider-error", detail: redirect.error };
  }
  if (redirect.code === null || redirect.code.length === 0) {
    return { kind: "error", reason: "missing-code" };
  }
  return { kind: "code", code: redirect.code };
}
