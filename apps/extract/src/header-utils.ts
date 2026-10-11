// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * header-utils.ts
 *
 * Reading request headers with the same `base64:` convention Search uses, so a
 * caller can pass one set of `X-…` headers straight through this service to
 * Search without re-encoding anything.
 *
 * Any header value may be sent base64-encoded by prefixing it with `base64:`.
 * That is not a nicety: document titles and links routinely contain umlauts and
 * em dashes, which are not legal in an HTTP header value and either throw or
 * arrive latin1-mangled.
 *
 *   X-Title: base64:UGZsaWNodGVuaGVmdCBXTVM=
 */

export {
  parseBooleanHeader,
  readHeader,
  readListHeader,
  decodeIfBase64,
  sanitizeHeaderValue,
} from "@atf/security-kit";
