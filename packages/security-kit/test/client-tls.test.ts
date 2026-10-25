// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Client-side TLS options for service-to-service fetch.
 *
 * Unit level: no options means no fragment (platform trust store stays in
 * place), unreadable files raise `ClientTlsConfigError`. Integration level
 * (Bun runtime — Bun consumes the `tls` init key): a self-signed HTTPS
 * server is unreachable without the CA and reachable with it. The Node side
 * (undici `dispatcher`) is covered by `client-tls.node.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ClientTlsConfigError, createClientTlsInit } from "../src/index.js";

describe("createClientTlsInit (unit)", () => {
  test("returns undefined when nothing is configured", () => {
    expect(createClientTlsInit(null)).toBeUndefined();
    expect(createClientTlsInit(undefined)).toBeUndefined();
    expect(createClientTlsInit({})).toBeUndefined();
    expect(
      createClientTlsInit({ caCertFile: null, clientCertFile: null, clientKeyFile: null }),
    ).toBeUndefined();
  });

  test("an unreadable CA file raises ClientTlsConfigError", () => {
    expect(() =>
      createClientTlsInit({ caCertFile: "/nonexistent/ca.pem" }),
    ).toThrow(ClientTlsConfigError);
  });

  test("an unreadable client certificate raises ClientTlsConfigError", () => {
    expect(() =>
      createClientTlsInit({ clientCertFile: "/nonexistent/client.pem" }),
    ).toThrow(ClientTlsConfigError);
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dir = hasOpenssl() ? mkdtempSync(join(tmpdir(), "atf-client-tls-")) : "";
afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

if (dir !== "") {
  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { stdio: "ignore" });
  };
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=atf-test-ca", "-keyout", join(dir, "ca-key.pem"),
    "-out", join(dir, "ca.pem")]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes",
    "-subj", "/CN=localhost", "-keyout", join(dir, "server-key.pem"),
    "-out", join(dir, "server.csr")]);
  const ext = join(dir, "server-ext.cnf");
  writeFileSync(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  openssl(["x509", "-req", "-in", join(dir, "server.csr"), "-CA", join(dir, "ca.pem"),
    "-CAkey", join(dir, "ca-key.pem"), "-CAcreateserial", "-days", "1",
    "-extfile", ext, "-out", join(dir, "server.pem")]);
}

const fixture = (name: string): string => join(dir, name);

describe.skipIf(dir === "")("createClientTlsInit (integration, Bun fetch)", () => {
  test("a self-signed server fails without the CA and succeeds with it", async () => {
    const { createServer } = await import("node:https");
    const { readFileSync } = await import("node:fs");
    const server = createServer(
      {
        cert: readFileSync(fixture("server.pem")),
        key: readFileSync(fixture("server-key.pem")),
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    );
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port assigned");
    const url = `https://localhost:${address.port}`;
    try {
      // Without the custom CA the self-signed certificate must be rejected.
      let rejected = false;
      try {
        await fetch(url);
      } catch (error) {
        rejected = true;
        expect(String(error)).toMatch(/certificate|ssl|tls|closed|alert/i);
      }
      expect(rejected).toBe(true);

      const tlsInit = createClientTlsInit({ caCertFile: fixture("ca.pem") });
      expect(tlsInit).toBeDefined();
      const response = await fetch(url, tlsInit);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
