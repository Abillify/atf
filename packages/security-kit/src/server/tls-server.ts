// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Optional TLS (and mTLS) termination for the ATF service HTTP servers
 *
 * Services listen on plain HTTP by default — in Kubernetes the mesh or the
 * ingress terminates TLS, and a sidecar-less deployment would otherwise have
 * to proxy to itself. When a deployment does want service-terminated TLS,
 * `TLS_CERT_FILE`/`TLS_KEY_FILE` switch the listener to `https`; adding
 * `TLS_CLIENT_CA_FILE` additionally requests and verifies client
 * certificates (mTLS). The client CA is free to be a workload-identity CA:
 * verification is chain-based, and SPIFFE SVIDs carry their identity in a
 * URI SAN, which Node validates as part of ordinary X.509 chain trust — no
 * SPIFFE-specific parsing is required to accept them.
 *
 * Certificate validation is always on; there is deliberately no
 * "skip verification" switch.
 */

import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

/** Request listener shape accepted by both `http` and `https` servers. */
type RequestListener = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

/** The TLS material a service was configured with; `null` means plain HTTP. */
export interface ServerTlsConfig {
  /** TLS_CERT_FILE — PEM-encoded server certificate (chain). */
  certFile: string;
  /** TLS_KEY_FILE — PEM-encoded private key for the certificate. */
  keyFile: string;
  /**
   * TLS_CLIENT_CA_FILE — PEM CA bundle used to verify client certificates.
   * When set, the server requests and requires a client certificate (mTLS);
   * SPIFFE-compatible SVIDs are accepted through ordinary chain trust.
   */
  clientCaFile?: string | null;
}

/** Raised when a configured TLS file cannot be read. */
export class TlsServerConfigError extends Error {
  /** Parameter properties are avoided on purpose: Node's strip-only
   * type-stripping (used by `node --test`) does not support them. */
  readonly options?: { cause?: unknown };

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TlsServerConfigError";
    this.options = options;
  }
}

function readPem(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new TlsServerConfigError(
      `${label} could not be read: ${path}`,
      { cause },
    );
  }
}

/**
 * Create the HTTP(S) server for `app`: a plain `http.Server` when `tls` is
 * `null`, an `https.Server` otherwise. The returned server supports the same
 * `listen`/`close`/timeout properties either way, so call sites stay uniform.
 */
export function createServerWithOptionalTls(
  app: RequestListener,
  tls: ServerTlsConfig | null,
): http.Server | https.Server {
  if (tls === null) return http.createServer(app);
  const cert = readPem(tls.certFile, "TLS certificate");
  const key = readPem(tls.keyFile, "TLS private key");
  const clientCa =
    tls.clientCaFile !== null && tls.clientCaFile !== undefined
      ? readPem(tls.clientCaFile, "TLS client CA")
      : undefined;
  return https.createServer(
    {
      cert,
      key,
      ...(clientCa !== undefined
        ? {
            // mTLS: the client must present a certificate chaining to the
            // configured CA; handshakes without one are rejected.
            ca: clientCa,
            requestCert: true,
            rejectUnauthorized: true,
          }
        : {}),
    },
    app,
  );
}
