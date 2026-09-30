// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * TLS setup for the Extract HTTP client (requirements 5.3, 5.4, 15.1).
 *
 * An `undici.Agent` is built from the system root CAs plus an optional
 * additional CA (`caCertPath`). `rejectUnauthorized` is deliberately not
 * configurable — certificate validation is always on. TLS failure codes
 * (`CERT_HAS_EXPIRED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
 * `ERR_TLS_CERT_ALTNAME_INVALID`, …) are surfaced unchanged so the caller can
 * report the concrete reason together with the checked URL.
 */

import { readFileSync } from "node:fs";
import * as nodeTls from "node:tls";
import { Agent } from "undici";

/** Raised when the additional CA file cannot be read. */
export class TlsConfigError extends Error {
  constructor(message: string, readonly options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TlsConfigError";
  }
}

/**
 * Build a dispatcher: system CAs plus the configured additional CA. When no
 * `caCertPath` is given, `undefined` is returned so the runtime default
 * (system trust store) applies unchanged.
 */
export function createTlsAgent(caCertPath?: string): Agent | undefined {
  if (caCertPath === undefined || caCertPath.length === 0) return undefined;
  let extra: string;
  try {
    extra = readFileSync(caCertPath, "utf8");
  } catch (cause) {
    throw new TlsConfigError(`CA-Zertifikat konnte nicht gelesen werden: ${caCertPath}`, {
      cause,
    });
  }
  // Setting `ca` replaces the defaults, so the bundled roots must be added
  // explicitly to keep the system CAs in the trust chain (5.4).
  const ca = [...nodeTls.rootCertificates, extra];
  return new Agent({ connect: { ca } });
}

/**
 * Extract a TLS/transport error code from a thrown error, following the
 * `cause` chain that `fetch` uses to wrap connection failures. Returns
 * `undefined` when no code is present.
 */
export function extractTlsErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && isTlsCode(code)) return code;
    }
    current =
      current instanceof Error && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

const TLS_CODE_PREFIXES = [
  "CERT_",
  "UNABLE_TO_",
  "DEPTH_",
  "SELF_",
  "ERR_TLS_",
  "ERR_SSL",
  "HOSTNAME_",
  "WRONG_ISSUE",
];

const isTlsCode = (code: string): boolean =>
  TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
