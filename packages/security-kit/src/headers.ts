// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * headers.ts
 *
 * Request-header reading shared by the ATF HTTP services (Req 11.1/11.2).
 *
 * Any header value may be sent base64-encoded by prefixing it with `base64:`.
 * That is not a nicety: document titles and links routinely contain umlauts
 * and em dashes, which are not legal in an HTTP header value and either throw
 * or arrive latin1-mangled.
 *
 *   X-Title: base64:UGZsaWNodGVuaGVmdCBXTVM=
 *
 * The prefix is case-insensitive (`BASE64:` also works).
 */

import type { IncomingMessage } from "node:http";

const BASE64_PREFIX = "base64:";

/**
 * Parse a boolean-valued header.
 *
 * Three-way plus null so a caller can distinguish "absent, use the default"
 * from "present but nonsense, return 400". Collapsing those loses the ability
 * to tell an operator their header was ignored.
 *
 *   undefined — absent or empty → use the default
 *   true/false — recognised value
 *   null      — unrecognised → the caller should return HTTP 400
 */
export function parseBooleanHeader(
  header: string | undefined,
): boolean | null | undefined {
  if (header === undefined) return undefined;
  const v = header.trim().toLowerCase();
  if (v === "") return undefined;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

/** Read a single-value header, decoding a `base64:` prefix. */
export function readHeader(
  req: Pick<IncomingMessage, "headers">,
  name: string,
): string | undefined {
  const raw = req.headers[name];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  return decodeIfBase64(value);
}

/** Read a comma-separated header into a trimmed, non-empty list. */
export function readListHeader(
  req: Pick<IncomingMessage, "headers">,
  name: string,
): string[] {
  const raw = readHeader(req, name);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Decode a header value carrying the `base64:` prefix.
 * Throws a TypeError with a descriptive (truncated) message on invalid base64.
 */
export function decodeIfBase64(value: string): string {
  if (value.toLowerCase().startsWith(BASE64_PREFIX)) {
    const encoded = value.slice(BASE64_PREFIX.length);
    try {
      return Buffer.from(encoded, "base64").toString("utf-8");
    } catch {
      throw new TypeError(
        `Invalid base64 value: "${encoded.slice(0, 20)}${encoded.length > 20 ? "…" : ""}"`,
      );
    }
  }
  return value;
}

/**
 * Strip control characters from a value before it goes back out as a header.
 *
 * Node throws `ERR_INVALID_CHAR` on CR/LF in a header value, and a value that
 * originated from a client-supplied filename or request id is exactly where
 * those show up.
 */
export function sanitizeHeaderValue(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}
