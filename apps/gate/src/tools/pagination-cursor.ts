// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import { sign, signaturesMatch, stable } from "../crypto/canonical.ts";

/**
 * HMAC-signed pagination cursors (Req 6.6). A cursor is
 * `base64url(JSON{o,fp,sub}).hmac` where `o` is the offset (or the JSON-encoded
 * keyset values in keyset mode), `fp` is the SHA-256 fingerprint of the
 * canonical call arguments, and `sub` is the authenticated principal. The
 * signature additionally covers the tool name, so a cursor minted for one tool
 * is rejected by every other tool, and a cursor cannot be reused with changed
 * arguments or by a different principal.
 */
export interface PaginationCursorPayload {
  /** Offset (offset mode) or JSON-encoded keyset values (keyset mode). */
  readonly o: number | string;
  /** Fingerprint of the canonical args the cursor was minted with. */
  readonly fp: string;
  /** Authenticated principal the cursor was minted for. */
  readonly sub: string;
  /** Keyset mode marker: the ordered keyset columns. */
  readonly k?: readonly string[];
}

export function argsFingerprint(args: Record<string, unknown>): string {
  return createHash("sha256").update(stable(args)).digest("base64url");
}

/** Mint a signed cursor bound to `tool`, the args fingerprint, and `subject`. */
export function mintPaginationCursor(
  payload: PaginationCursorPayload,
  tool: string,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(cursorSigningData(body, tool), secret)}`;
}

/**
 * Verify and decode a cursor. Throws `Invalid pagination cursor` on any
 * malformed input, a bad signature, or a payload that does not match the
 * current tool / args fingerprint / principal (Req 6.6).
 */
export function verifyPaginationCursor(
  raw: unknown,
  tool: string,
  fingerprint: string,
  subject: string,
  secret: string,
): PaginationCursorPayload {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Invalid pagination cursor");
  }
  const dot = raw.lastIndexOf(".");
  const body = dot > 0 ? raw.slice(0, dot) : "";
  const signature = dot > 0 ? raw.slice(dot + 1) : "";
  if (!body || !signature) throw new Error("Invalid pagination cursor");
  const expected = sign(cursorSigningData(body, tool), secret);
  if (!signaturesMatch(signature, expected)) {
    throw new Error("Invalid pagination cursor");
  }
  let payload: PaginationCursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PaginationCursorPayload;
  } catch {
    throw new Error("Invalid pagination cursor");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.fp !== fingerprint ||
    payload.sub !== subject
  ) {
    throw new Error("Invalid pagination cursor");
  }
  return payload;
}

function cursorSigningData(body: string, tool: string): string {
  return `${tool}.${body}`;
}
