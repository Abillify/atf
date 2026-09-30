// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * TLS integration tests (task 10.6, requirements 5.3, 5.4). A real HTTPS
 * server is started with test certificates; the client must abort on an
 * expired certificate, an unknown CA and a hostname mismatch — reporting the
 * concrete TLS error code and the checked URL — and must succeed when the
 * additional CA is configured.
 *
 * The certificate/key fixtures are not part of this repository. Point
 * `OUTPOST_TLS_FIXTURES` at a directory containing `ca.pem`,
 * `server-localhost.pem`/`server-key.pem`, `expired.pem`/`expired-key.pem`,
 * `wronghost.pem`/`wronghost-key.pem` and `selfsigned.pem`/`selfsigned-key.pem`;
 * without it the server-backed cases are skipped.
 */

import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetch as undiciFetch } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTlsAgent,
  ExtractHttpClient,
  TlsFailureError,
} from "../../src/index.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";

const FIXTURES = process.env.OUTPOST_TLS_FIXTURES ?? "";
const hasFixtures = FIXTURES !== "";
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

/** Start an HTTPS server with the given cert/key; return its base URL. */
async function startTlsServer(cert: string, key: string): Promise<string> {
  const server = createServer({ cert: read(cert), key: read(key) }, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `https://localhost:${port}`;
}

function clientFor(baseUrl: string, caCertPath?: string): ExtractHttpClient {
  // The dispatcher is an undici Agent, so the matching undici `fetch` must be
  // used: Node's bundled global fetch expects its own (differently versioned)
  // undici dispatcher implementation.
  return new ExtractHttpClient({
    extractUrl: baseUrl,
    tokenProvider: new FakeTokenProvider(),
    version: "0.1.0",
    runtime: "docker",
    fetchImpl: undiciFetch as unknown as typeof globalThis.fetch,
    dispatcher: createTlsAgent(caCertPath),
  });
}

afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe.skipIf(!hasFixtures)("TLS validation (5.3, 5.4)", () => {
  it("accepts a server signed by the configured additional CA", async () => {
    const base = await startTlsServer("server-localhost.pem", "server-key.pem");
    // The test CA is not a system root, so only the extra CA makes this work.
    const client = clientFor(base, join(FIXTURES, "ca.pem"));
    const response = await client.request({ url: "/v1/whoami" });
    expect(response.status).toBe(200);
  });

  it("rejects an unknown CA and reports the concrete code (5.3)", async () => {
    const base = await startTlsServer("server-localhost.pem", "server-key.pem");
    const client = clientFor(base); // no extra CA → the signing CA is unknown
    const error = await client.request({ url: "/v1/whoami" }).catch((e) => e);
    expect(error).toBeInstanceOf(TlsFailureError);
    if (error instanceof TlsFailureError) {
      expect(error.checkedUrl).toBe(`${base}/v1/whoami`);
      expect(error.code).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT/);
    }
  });

  it("rejects an expired certificate with CERT_HAS_EXPIRED (5.3)", async () => {
    const base = await startTlsServer("expired.pem", "expired-key.pem");
    const client = clientFor(base, join(FIXTURES, "ca.pem"));
    const error = await client.request({ url: "/v1/whoami" }).catch((e) => e);
    expect(error).toBeInstanceOf(TlsFailureError);
    if (error instanceof TlsFailureError) {
      expect(error.code).toBe("CERT_HAS_EXPIRED");
      expect(error.checkedUrl).toContain("localhost");
    }
  });

  it("rejects a hostname mismatch with a concrete code (5.3)", async () => {
    // Certificate is valid for wrong.example.com, but we connect to localhost.
    const base = await startTlsServer("wronghost.pem", "wronghost-key.pem");
    const client = clientFor(base, join(FIXTURES, "ca.pem"));
    const error = await client.request({ url: "/v1/whoami" }).catch((e) => e);
    expect(error).toBeInstanceOf(TlsFailureError);
    if (error instanceof TlsFailureError) {
      expect(error.code).toMatch(/ALTNAME|HOSTNAME_MISMATCH|CERT_UNTRUSTED/);
    }
  });

  it("rejects a self-signed certificate not in the trust store", async () => {
    const base = await startTlsServer("selfsigned.pem", "selfsigned-key.pem");
    const client = clientFor(base);
    const error = await client.request({ url: "/v1/whoami" }).catch((e) => e);
    expect(error).toBeInstanceOf(TlsFailureError);
  });
});

describe("TLS agent configuration (5.4)", () => {
  it("createTlsAgent reports an unreadable CA file (5.4)", async () => {
    expect(() => createTlsAgent(join(tmpdir(), "definitely-missing-ca.pem"))).toThrow(
      /CA-Zertifikat/,
    );
  });
});
