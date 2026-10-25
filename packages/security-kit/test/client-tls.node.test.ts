// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dual-runtime proof for the client TLS fragment: Node's
 * global fetch consumes the undici `dispatcher` key that
 * `createClientTlsInit` produces, so a self-signed HTTPS server becomes
 * reachable only once the CA is configured. Runs under `node --test`
 * (native type-stripping), mirroring `egress.node.test.ts`.
 *
 * Run: bun run --filter @atf/security-kit test:node
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// Imported directly from the module (not ../src/index.ts): the barrel
// re-exports code that uses TypeScript parameter properties, which Node's
// strip-only type-stripping cannot parse.
import { createClientTlsInit } from "../src/http/client-tls.ts";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dir = hasOpenssl() ? mkdtempSync(join(tmpdir(), "atf-client-tls-node-")) : "";
after(() => {
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

test(
  "Node fetch reaches a self-signed server only with the configured CA",
  { skip: dir === "" },
  async () => {
    const server = createServer(
      {
        cert: readFileSync(join(dir, "server.pem")),
        key: readFileSync(join(dir, "server-key.pem")),
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    );
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    const url = `https://localhost:${address.port}`;
    try {
      // Node wraps TLS failures in a generic "fetch failed" TypeError; the
      // real reason lives on the cause chain.
      await assert.rejects(
        () => fetch(url),
        (error: unknown) => {
          const text =
            String(error) +
            " " +
            String((error as { cause?: unknown }).cause);
          assert.match(text, /certificate|ssl|tls|ECONN/i);
          return true;
        },
      );

      const tlsInit = createClientTlsInit({
        caCertFile: join(dir, "ca.pem"),
      });
      assert.ok(tlsInit !== undefined);
      const response = await fetch(url, tlsInit);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  },
);
