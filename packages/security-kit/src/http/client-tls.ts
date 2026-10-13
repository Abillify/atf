// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { readFileSync } from "node:fs";
import nodeTls from "node:tls";
import { Agent } from "undici";

/**
 * Optional mTLS/TLS options for outbound service-to-service calls.
 *
 * All fields are optional file paths; when none are set the helper returns
 * `undefined` and callers keep the platform default trust store. SPIFFE
 * SVIDs are supported implicitly: they are ordinary X.509 certificates and
 * work via `caCertFile` chain trust (URI SAN validation is performed by the
 * runtime and cannot be disabled here).
 */
export interface ClientTlsOptions {
  /** PEM file with additional trusted CA certificates (roots + intermediates). */
  caCertFile?: string | null;
  /** PEM file with the client certificate for mTLS. */
  clientCertFile?: string | null;
  /** PEM file with the client private key for mTLS. */
  clientKeyFile?: string | null;
}

/** Raised when a configured PEM file cannot be read. */
export class ClientTlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientTlsConfigError";
  }
}

function nonEmpty(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.length > 0;
}

function readPem(filePath: string, label: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new ClientTlsConfigError(`Unable to read ${label} from ${filePath}`);
  }
}

/**
 * Build a `RequestInit` fragment that enables custom TLS trust / mTLS for
 * `fetch()` on both Bun and Node.
 *
 * Bun consumes the `tls` init extension, Node's global fetch consumes the
 * undici `dispatcher`; each runtime ignores the other's key, so the fragment
 * carries both. Returns `undefined` when no TLS option is set, so callers can
 * spread it unconditionally.
 */
export function createClientTlsInit(
  options: ClientTlsOptions | null | undefined,
): RequestInit | undefined {
  const caPath = options?.caCertFile;
  const certPath = options?.clientCertFile;
  const keyPath = options?.clientKeyFile;
  if (!nonEmpty(caPath) && !nonEmpty(certPath) && !nonEmpty(keyPath)) {
    return undefined;
  }

  // `ca` replaces the default trust store, so the bundled roots are added
  // back explicitly to keep public CAs working (mirrors outpost-core).
  const ca = nonEmpty(caPath)
    ? [...nodeTls.rootCertificates, readPem(caPath, "CA certificate")]
    : undefined;
  const cert = nonEmpty(certPath)
    ? readPem(certPath, "client certificate")
    : undefined;
  const key = nonEmpty(keyPath) ? readPem(keyPath, "client key") : undefined;

  const connect: { ca?: string[]; cert?: string; key?: string } = {};
  if (ca !== undefined) connect.ca = ca;
  if (cert !== undefined) connect.cert = cert;
  if (key !== undefined) connect.key = key;

  // The cast is needed because neither extension is part of the standard
  // `RequestInit` type.
  return {
    dispatcher: new Agent({ connect }),
    tls: connect,
  } as unknown as RequestInit;
}
