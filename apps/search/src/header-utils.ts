// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * header-utils.ts
 *
 * Utility for reading HTTP request headers with optional base64 encoding.
 *
 * Any header value can be sent as base64 by prefixing it with "base64:".
 * This is useful for values that contain characters not allowed in HTTP
 * headers (e.g. newlines, non-ASCII characters in titles or links).
 *
 * Example:
 *   X-Title: base64:QXc6IFRheGZpeCBTRSBnZWdlbiBQZWdneQ==
 *
 * The prefix is case-insensitive ("BASE64:" also works).
 */

import type { IncomingMessage } from "node:http";

const BASE64_PREFIX = "base64:";

/**
 * Parse a boolean-valued HTTP header (shared by search and ingest handlers).
 *
 * Return values:
 *   undefined — header absent or empty string → caller should use its default
 *   true      — recognised truthy value (1 / true / yes / on)
 *   false     — recognised falsy value  (0 / false / no / off)
 *   null      — unrecognised value → caller should return HTTP 400
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

/**
 * Read a single-value header, decoding it if it starts with "base64:".
 * Returns undefined if the header is absent.
 */
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

/**
 * Decode a header value if it starts with the "base64:" prefix.
 * Throws a TypeError with a descriptive message on invalid base64.
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
