// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Google service-account credentials (requirements 6.10, 6.20, 15.1).
 *
 * A service account needs no user authorization: a self-signed JWT
 * (RS256, scope `drive.readonly`) is exchanged at the FIXED Google token
 * endpoint via the `jwt-bearer` grant. The `token_uri` inside the key file is
 * ignored on purpose — a key must never redirect the assertion to a third
 * party (15.1). The parser is pure so the Control API (20.7) and the Docker
 * `_FILE` path can validate input before storing it.
 */

import { createSign } from "node:crypto";
import type { FetchLike } from "../idp.js";
import { GOOGLE_TOKEN_ENDPOINT, GDRIVE_SCOPE } from "./providers.js";
import { classifyTokenResponse, SourceTransientError, type SourceTokenResult } from "./exchange.js";

/** Hard size cap for a key file: 64 KiB (6.10). */
export const SERVICE_ACCOUNT_KEY_MAX_BYTES = 64 * 1024;

/** PKCS#8 PEM label of a Google service-account key. */
const PEM_LABEL = "PRIVATE KEY";
const PEM_MARKER = `-----BEGIN ${PEM_LABEL}-----`;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKeyPem: string;
}

export type ParseKeyResult =
  | { ok: true; key: ServiceAccountKey }
  | { ok: false; reason: "too-large" | "not-json" | "not-object" | "wrong-type" | "missing-client-email" | "missing-private-key" };

/**
 * Pure validation of a service-account key JSON (6.10). Never echoes key
 * material in the result — only a reason code.
 */
export function parseServiceAccountKey(json: string): ParseKeyResult {
  if (Buffer.byteLength(json, "utf8") > SERVICE_ACCOUNT_KEY_MAX_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["type"] !== "service_account") {
    return { ok: false, reason: "wrong-type" };
  }
  const clientEmail = obj["client_email"];
  if (typeof clientEmail !== "string" || clientEmail.trim() === "") {
    return { ok: false, reason: "missing-client-email" };
  }
  const privateKey = obj["private_key"];
  if (typeof privateKey !== "string" || !privateKey.includes(PEM_MARKER)) {
    return { ok: false, reason: "missing-private-key" };
  }
  return { ok: true, key: { clientEmail, privateKeyPem: privateKey } };
}

/** base64url without padding. */
const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url").replace(/=+$/, "");

export interface AssertionDeps {
  /** Seconds since epoch (injected for tests). */
  now: () => number;
  /** Assertion lifetime in seconds, default 3600. */
  lifetimeSec?: number;
}

/**
 * Build the signed JWT assertion. `token_uri` from the key is never used —
 * the audience is always {@link GOOGLE_TOKEN_ENDPOINT} (15.1).
 */
export function buildServiceAccountAssertion(
  key: ServiceAccountKey,
  deps: AssertionDeps,
): string {
  const issuedAt = Math.floor(deps.now() / 1000);
  const expiresAt = issuedAt + (deps.lifetimeSec ?? 3600);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: GDRIVE_SCOPE,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: expiresAt,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput, "ascii");
  const signature = sign.sign(key.privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Exchange a service-account key for an access token (jwt-bearer grant,
 * fixed endpoint). Rejection/transient classification matches the user
 * flows (6.12). The result never carries a refresh token — service accounts
 * get short-lived access tokens only.
 */
export async function serviceAccountToken(
  key: ServiceAccountKey,
  fetchImpl: FetchLike,
  deps: AssertionDeps,
): Promise<SourceTokenResult> {
  const assertion = buildServiceAccountAssertion(key, deps);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
  } catch (cause) {
    throw new SourceTransientError("Google-Token-Endpunkt nicht erreichbar", { cause });
  }
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // fall through to status classification
  }
  return classifyTokenResponse(response.status, parsed);
}
