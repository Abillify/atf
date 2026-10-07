// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dual-runtime smoke test (task 1.3): the security-kit must run unchanged
 * under Bun AND Node 26 (native type-stripping, `node --test`). This file
 * uses only node:test/node:assert and imports the TypeScript sources
 * directly, so it proves the sources are erasable and Node-compatible —
 * in particular the Egress Guard's node:http pinned-lookup path.
 *
 * Run: bun run --filter @atf/security-kit test:node
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  createEgressGuard,
  createMemoryRateLimitBackend,
  createProdGate,
  EgressError,
  gcraCheck,
  isAlwaysForbiddenAddress,
  isForbiddenAddress,
  reportProdGate,
  safeEqual,
  safeEqualBytes,
} from "../src/index.ts";

const openServers: http.Server[] = [];
after(() => {
  for (const server of openServers) {
    server.closeAllConnections?.();
    server.close();
  }
});

test("node: safeEqual / safeEqualBytes", () => {
  assert.equal(safeEqual("token-value", "token-value"), true);
  assert.equal(safeEqual("token-value", "token-valuE"), false);
  assert.equal(safeEqual("short", "much-longer-value"), false);
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 4]);
  const c = new Uint8Array([1, 2, 3, 5]);
  assert.equal(safeEqualBytes(a, b), true);
  assert.equal(safeEqualBytes(a, c), false);
});

test("node: base64url round-trip", () => {
  for (let length = 0; length <= 64; length++) {
    const bytes = new Uint8Array(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff));
    assert.deepEqual(base64UrlDecode(base64UrlEncode(bytes)), bytes, `length ${length}`);
  }
  assert.equal(base64UrlEncode(new TextEncoder().encode("Man")), "TWFu");
  assert.throws(() => base64UrlDecode("TWFu="));
  assert.throws(() => base64UrlDecode("a+b/c"));
});

test("node: address classification", () => {
  for (const forbidden of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.100.100.200",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "2002:7f00:1::",
    "garbage",
  ]) {
    assert.equal(isForbiddenAddress(forbidden), true, forbidden);
  }
  for (const allowed of ["93.184.216.34", "8.8.8.8", "2001:4860:4860::8888"]) {
    assert.equal(isForbiddenAddress(allowed), false, allowed);
  }
  assert.equal(isAlwaysForbiddenAddress("::ffff:169.254.169.254"), true);
  assert.equal(isAlwaysForbiddenAddress("10.0.0.1"), false);
});

test("node: egress guard static validation", () => {
  const guard = createEgressGuard();
  assert.equal(guard.validateUrl("https://example.com/x").hostname, "example.com");
  assert.throws(() => guard.validateUrl("file:///etc/passwd"), (err: unknown) => {
    return err instanceof EgressError && err.reason === "invalid_url";
  });
  assert.throws(() => guard.validateUrl("http://127.0.0.1/"), (err: unknown) => {
    return err instanceof EgressError && err.reason === "forbidden_address";
  });
  assert.throws(() => guard.validateUrl("http://169.254.169.254/"), (err: unknown) => {
    return err instanceof EgressError && err.reason === "forbidden_host";
  });
});

async function startNodeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("node: egress guard fetches through the pinned-lookup path", async () => {
  const srv = await startNodeServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("node-ok");
  });
  const guard = createEgressGuard({ allowPrivateHosts: true });
  const response = await guard.fetch(`${srv.base}/redirect`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "node-ok");
  assert.equal(response.url, `${srv.base}/final`);

  const strict = createEgressGuard();
  await assert.rejects(
    () => strict.fetch(srv.base),
    (err: unknown) => err instanceof EgressError && err.reason === "forbidden_address",
  );
  await srv.close();
});

test("node: GCRA core and memory backend", async () => {
  const config = { limit: 3, burstMs: 1000 };
  let nowUs = 0;
  const backend = createMemoryRateLimitBackend({ nowUs: () => nowUs });
  for (let i = 0; i < 3; i++) {
    const result = await backend.take("k", config, 1);
    assert.equal(result.allowed, true, `backend request ${i}`);
  }
  const backendDenied = await backend.take("k", config, 1);
  assert.equal(backendDenied.allowed, false);

  // Pure core: burst of 3, then denied, then refilled after one emission.
  let state = null;
  for (let i = 0; i < 3; i++) {
    const decision = gcraCheck(config, state, nowUs, 1);
    assert.equal(decision.allowed, true, `core request ${i}`);
    state = decision.state;
  }
  const denied = gcraCheck(config, state, nowUs, 1);
  assert.equal(denied.allowed, false);
  nowUs += 400_000; // one emission interval (1000ms/3 ≈ 333ms)
  const refilled = gcraCheck(config, state, nowUs, 1);
  assert.equal(refilled.allowed, true);
});

test("node: prod gate and reporter", () => {
  const prod = createProdGate("production");
  prod.flag("wildcard cors");
  assert.equal(prod.fatalFindings.length, 1);
  const lines: string[] = [];
  const outcome = reportProdGate(prod, "node-service", {
    error: (l) => lines.push(`error:${l}`),
    warn: (l) => lines.push(`warn:${l}`),
    info: (l) => lines.push(`info:${l}`),
  });
  assert.equal(outcome.abort, true);
  assert.ok(lines.some((l) => l.startsWith("error:[node-service] production-readiness")));

  const dev = createProdGate("development");
  dev.flag("wildcard cors");
  assert.equal(dev.warnings.length, 1);
});
