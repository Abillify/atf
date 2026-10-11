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

export {
  parseBooleanHeader,
  readHeader,
  readListHeader,
  decodeIfBase64,
  sanitizeHeaderValue,
} from "@atf/security-kit";
