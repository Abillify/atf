// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Parser for pasted authorization input (requirements 3.3, 6.13, 6.14).
 *
 * The user either pastes the full redirect URL from the browser address bar
 * (GDrive: the loopback connection fails but the URL carries `code` and
 * `state`) or a bare code (Dropbox no-redirect shows the code on the page).
 * A URL is only accepted when its origin AND path equal the expected
 * `redirectUri` — a code sent to a foreign location is worthless, but the
 * check keeps the flow honest. `state` is compared in constant time; a
 * mismatch discards the code. A bare code has no `state`, which is
 * acceptable because PKCE binds the exchange to the locally generated
 * `code_verifier` (15.2).
 */

import { timingSafeEqual } from "node:crypto";

export type PasteResult =
  | { kind: "code"; code: string }
  | {
      kind: "error";
      reason: "state-mismatch" | "provider-error" | "missing-code" | "malformed";
      detail?: string;
    };

export interface PasteExpectation {
  state: string;
  /** Set → URL input must match this origin AND path exactly. */
  redirectUri?: string;
  /** Accept a bare code without URL wrapper (both providers: true). */
  allowBareCode: boolean;
}

/** Strip surrounding whitespace and one layer of matching quotes. */
function clean(input: string): string {
  let value = input.trim();
  for (const quote of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
      value = value.slice(1, -1).trim();
    }
  }
  return value;
}

/** Constant-time string equality (length-independent via sha256, like pkce). */
function statesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) {
    // Still touch both buffers to keep timing roughly uniform.
    const zero = Buffer.alloc(32);
    timingSafeEqual(zero, zero);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Printable ASCII without any whitespace (0x21–0x7E). */
const BARE_CODE = /^[\x21-\x7E]+$/;

/** Parse a URL-shaped input against the expectation. */
function parseUrlInput(value: string, expected: PasteExpectation): PasteResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "error", reason: "malformed", detail: "URL konnte nicht geparst werden" };
  }
  if (expected.redirectUri === undefined) {
    return {
      kind: "error",
      reason: "malformed",
      detail: "URL-Eingabe ohne erwartete Redirect-URI",
    };
  }
  let want: URL;
  try {
    want = new URL(expected.redirectUri);
  } catch {
    return { kind: "error", reason: "malformed", detail: "erwartete Redirect-URI ist ungültig" };
  }
  if (url.origin !== want.origin || url.pathname !== want.pathname) {
    return {
      kind: "error",
      reason: "malformed",
      detail: `Origin/Pfad weichen von der erwarteten Redirect-URI ab`,
    };
  }
  const providerError = url.searchParams.get("error");
  if (providerError !== null) {
    return {
      kind: "error",
      reason: "provider-error",
      detail: providerError === "" ? undefined : providerError,
    };
  }
  const state = url.searchParams.get("state");
  if (state === null || !statesMatch(expected.state, state)) {
    // A wrong or missing state discards the code entirely.
    return { kind: "error", reason: "state-mismatch" };
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    return { kind: "error", reason: "missing-code" };
  }
  return { kind: "code", code };
}

/**
 * Parse the pasted input. Whitespace/quotes around the value are removed.
 * Inputs starting with `http://`/`https://` are treated as redirect URLs;
 * anything else is a bare code when `allowBareCode` is set and the value is
 * printable ASCII without whitespace.
 */
export function parsePastedInput(input: string, expected: PasteExpectation): PasteResult {
  const value = clean(input);
  if (value === "") {
    return { kind: "error", reason: "missing-code", detail: "leere Eingabe" };
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return parseUrlInput(value, expected);
  }
  if (!expected.allowBareCode) {
    return {
      kind: "error",
      reason: "malformed",
      detail: "erwartet eine Redirect-URL",
    };
  }
  if (!BARE_CODE.test(value)) {
    return {
      kind: "error",
      reason: "malformed",
      detail: "nackter Code darf nur aus druckbarem ASCII ohne Leerraum bestehen",
    };
  }
  return { kind: "code", code: value };
}

/**
 * Test helper (Property 33): build the redirect URL a provider would send to
 * `redirectUri` with `code` and `state` as query parameters.
 */
export function buildRedirectUrl(redirectUri: string, code: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}
