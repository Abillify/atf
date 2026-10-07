// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/security-kit/browser
 *
 * Browser-safe surface: only the base64url codec, which uses nothing beyond
 * TextEncoder/TextDecoder. Deliberately does NOT re-export the Node-only
 * modules (compare, egress, jwt, rate-limit, prod-gate) so a bundler can never
 * pull `node:crypto` into a client bundle through this entry point.
 */

export {
  base64UrlEncode,
  base64UrlEncodePadded,
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncodeString,
} from "./base64url.ts";
