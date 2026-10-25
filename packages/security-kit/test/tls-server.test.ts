// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Optional TLS termination for the service HTTP servers.
 *
 * A real HTTPS server is started from ephemeral certificates generated with
 * `openssl` into a temp directory: plain TLS must serve, mTLS must reject a
 * client without a certificate and accept one signed by the configured
 * client CA, and unreadable files must raise `TlsServerConfigError`.
 * Skipped when `openssl` is not available.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  createServerWithOptionalTls,
  TlsServerConfigError,
} from "../src/index.js";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dir = hasOpenssl() ? mkdtempSync(join(tmpdir(), "atf-tls-server-")) : "";
afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

/** Generate a CA plus server and client certificates signed by it. */
function generateFixtures(): void {
  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { stdio: "ignore" });
  };
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=atf-test-ca", "-keyout", join(dir, "ca-key.pem"),
    "-out", join(dir, "ca.pem")]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes",
    "-subj", "/CN=localhost", "-keyout", join(dir, "server-key.pem"),
    "-out", join(dir, "server.csr")]);
  // A SAN is needed for the client to validate `localhost` against.
  const ext = join(dir, "server-ext.cnf");
  writeFileSync(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  execFileSync("openssl", ["x509", "-req", "-in", join(dir, "server.csr"),
    "-CA", join(dir, "ca.pem"), "-CAkey", join(dir, "ca-key.pem"),
    "-CAcreateserial", "-days", "1", "-extfile", ext,
    "-out", join(dir, "server.pem")], { stdio: "ignore" });
  openssl(["req", "-newkey", "rsa:2048", "-nodes",
    "-subj", "/CN=atf-test-client", "-keyout", join(dir, "client-key.pem"),
    "-out", join(dir, "client.csr")]);
  openssl(["x509", "-req", "-in", join(dir, "client.csr"), "-CA", join(dir, "ca.pem"),
    "-CAkey", join(dir, "ca-key.pem"), "-CAcreateserial", "-days", "1",
    "-out", join(dir, "client.pem")]);
}

if (dir !== "") generateFixtures();

const fixture = (name: string): string => join(dir, name);

async function listen(
  tls: Parameters<typeof createServerWithOptionalTls>[1],
): Promise<{ url: string; close: () => void }> {
  const server = createServerWithOptionalTls((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  }, tls);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port assigned");
  return {
    url: `https://localhost:${address.port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe.skipIf(dir === "")("createServerWithOptionalTls", () => {
  test("serves plain HTTPS when no client CA is configured", async () => {
    const { url, close } = await listen({
      certFile: fixture("server.pem"),
      keyFile: fixture("server-key.pem"),
    });
    try {
      const response = await fetch(url, {
        tls: { ca: Bun.file(fixture("ca.pem")) },
      } as RequestInit);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      close();
    }
  });

  test("rejects a client without a certificate when a client CA is set", async () => {
    const { url, close } = await listen({
      certFile: fixture("server.pem"),
      keyFile: fixture("server-key.pem"),
      clientCaFile: fixture("ca.pem"),
    });
    try {
      // The server aborts the handshake without a client certificate; the
      // wording differs per runtime (Bun: socket closed, Node: alert), so the
      // assertion is that the request fails at all — never that it succeeds.
      expect(
        await fetch(url, {
          tls: { ca: Bun.file(fixture("ca.pem")) },
        } as RequestInit).catch((error: unknown) => String(error)),
      ).toMatch(/closed|certificate|required|ssl|tls|alert|ECONN/i);
    } finally {
      close();
    }
  });

  test("accepts a client certificate signed by the client CA (mTLS)", async () => {
    const { url, close } = await listen({
      certFile: fixture("server.pem"),
      keyFile: fixture("server-key.pem"),
      clientCaFile: fixture("ca.pem"),
    });
    try {
      const response = await fetch(url, {
        tls: {
          ca: Bun.file(fixture("ca.pem")),
          cert: Bun.file(fixture("client.pem")),
          key: Bun.file(fixture("client-key.pem")),
        },
      } as RequestInit);
      expect(response.status).toBe(200);
    } finally {
      close();
    }
  });

  test("an unreadable certificate file raises TlsServerConfigError", () => {
    expect(() =>
      createServerWithOptionalTls((_req, res) => res.end(), {
        certFile: join(dir, "does-not-exist.pem"),
        keyFile: fixture("server-key.pem"),
      }),
    ).toThrow(TlsServerConfigError);
  });
});

describe("createServerWithOptionalTls (plain)", () => {
  test("null TLS yields a plain HTTP server", async () => {
    const server = createServerWithOptionalTls((_req, res) => {
      res.writeHead(200);
      res.end("plain");
    }, null);
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port assigned");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("plain");
    } finally {
      server.close();
    }
  });
});
