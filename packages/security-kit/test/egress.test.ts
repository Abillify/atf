// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Egress Guard: static URL validation, resolution pinning, and the request
 * path (redirects, byte limits, timeouts) exercised against a local HTTP
 * server with an injected resolver so no real DNS is involved.
 */

import { afterAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createEgressGuard,
  EgressError,
  type EgressGuard,
  type HostResolver,
} from "../src/index.js";

function reasonOf(fn: () => unknown | Promise<unknown>): Promise<string> {
  return Promise.resolve()
    .then(fn)
    .then(() => "no-error")
    .catch((err: unknown) => (err instanceof EgressError ? err.reason : `other:${String(err)}`));
}

describe("validateUrl", () => {
  const guard = createEgressGuard({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });

  test("accepts plain http/https URLs", () => {
    expect(guard.validateUrl("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(guard.validateUrl("http://example.com").protocol).toBe("http:");
  });

  test("rejects non-http schemes", async () => {
    expect(await reasonOf(() => guard.validateUrl("file:///etc/passwd"))).toBe("invalid_url");
    expect(await reasonOf(() => guard.validateUrl("ftp://example.com"))).toBe("invalid_url");
    expect(await reasonOf(() => guard.validateUrl("gopher://example.com"))).toBe("invalid_url");
    expect(await reasonOf(() => guard.validateUrl("not a url"))).toBe("invalid_url");
  });

  test("rejects credentials in the URL", async () => {
    expect(await reasonOf(() => guard.validateUrl("https://user:pw@example.com"))).toBe("invalid_url");
    expect(await reasonOf(() => guard.validateUrl("https://user@example.com"))).toBe("invalid_url");
  });

  test("rejects metadata host patterns", async () => {
    expect(await reasonOf(() => guard.validateUrl("http://169.254.169.254/latest/meta-data"))).toBe("forbidden_host");
    expect(await reasonOf(() => guard.validateUrl("http://metadata.google.internal/"))).toBe("forbidden_host");
    expect(await reasonOf(() => guard.validateUrl("http://[fe80::1]/"))).toBe("forbidden_host");
  });

  test("rejects literal private/loopback/reserved IPs", async () => {
    expect(await reasonOf(() => guard.validateUrl("http://127.0.0.1:8080/x"))).toBe("forbidden_address");
    expect(await reasonOf(() => guard.validateUrl("http://[::1]/"))).toBe("forbidden_address");
    expect(await reasonOf(() => guard.validateUrl("http://10.0.0.5/"))).toBe("forbidden_address");
    expect(await reasonOf(() => guard.validateUrl("http://[::ffff:127.0.0.1]/"))).toBe("forbidden_address");
  });

  test("allowlist enforcement", async () => {
    const strict = createEgressGuard({
      allowedHosts: [".example.com", "api.trusted.io"],
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
    });
    expect(strict.validateUrl("https://api.example.com/x").hostname).toBe("api.example.com");
    expect(strict.validateUrl("https://api.trusted.io/").hostname).toBe("api.trusted.io");
    expect(await reasonOf(() => strict.validateUrl("https://evil.com/"))).toBe("host_not_allowed");
    expect(await reasonOf(() => strict.validateUrl("https://notexample.com/"))).toBe("host_not_allowed");
  });

  test("allowPrivateHosts relaxes loopback but never metadata space", () => {
    const dev = createEgressGuard({ allowPrivateHosts: true });
    expect(dev.validateUrl("http://127.0.0.1:9/").hostname).toBe("127.0.0.1");
    expect(dev.validateUrl("http://10.0.0.1/").hostname).toBe("10.0.0.1");
  });
  test("allowPrivateHosts still refuses link-local via host pattern", async () => {
    const dev = createEgressGuard({ allowPrivateHosts: true });
    expect(await reasonOf(() => dev.validateUrl("http://169.254.169.254/"))).toBe("forbidden_host");
    expect(await reasonOf(() => dev.validateUrl("http://100.100.100.200/"))).toBe("forbidden_address");
  });
});

describe("resolvePinned", () => {
  const resolverReturning =
    (...addresses: Array<[string, 4 | 6]>): HostResolver =>
    () =>
      Promise.resolve(addresses.map(([address, family]) => ({ address, family })));

  test("pins the first validated record", async () => {
    const guard = createEgressGuard({ resolver: resolverReturning(["93.184.216.34", 4], ["93.184.216.35", 4]) });
    const pinned = await guard.resolvePinned(new URL("https://example.com/"));
    expect(pinned.address).toBe("93.184.216.34");
  });

  test("refuses a host where ANY record is private", async () => {
    const guard = createEgressGuard({ resolver: resolverReturning(["93.184.216.34", 4], ["127.0.0.1", 4]) });
    expect(await reasonOf(() => guard.resolvePinned(new URL("https://example.com/")))).toBe("forbidden_address");
  });

  test("refuses a host where ANY record is metadata space", async () => {
    const guard = createEgressGuard({ resolver: resolverReturning(["8.8.8.8", 4], ["169.254.169.254", 4]) });
    expect(await reasonOf(() => guard.resolvePinned(new URL("https://example.com/")))).toBe("forbidden_address");
  });

  test("empty answers and resolver errors are resolution_failed", async () => {
    const empty = createEgressGuard({ resolver: () => Promise.resolve([]) });
    expect(await reasonOf(() => empty.resolvePinned(new URL("https://example.com/")))).toBe("resolution_failed");
    const broken = createEgressGuard({ resolver: () => Promise.reject(new Error("ENOTFOUND")) });
    expect(await reasonOf(() => broken.resolvePinned(new URL("https://example.com/")))).toBe("resolution_failed");
  });

  test("allowPrivateHosts still refuses metadata records", async () => {
    const guard = createEgressGuard({
      allowPrivateHosts: true,
      resolver: resolverReturning(["127.0.0.1", 4], ["169.254.169.254", 4]),
    });
    expect(await reasonOf(() => guard.resolvePinned(new URL("http://svc.internal/")))).toBe("forbidden_address");
  });

  test("literal IPs bypass the resolver", async () => {
    let resolverCalls = 0;
    const guard = createEgressGuard({
      allowPrivateHosts: true,
      resolver: () => {
        resolverCalls++;
        return Promise.resolve([{ address: "1.2.3.4", family: 4 }]);
      },
    });
    const pinned = await guard.resolvePinned(new URL("http://127.0.0.1:9/"));
    expect(pinned).toEqual({ address: "127.0.0.1", family: 4 });
    expect(resolverCalls).toBe(0);
  });
});

// ── Request path against a local server ─────────────────────────────────────

interface TestServer {
  server: http.Server;
  port: number;
  base: string;
  close(): Promise<void>;
}

const openServers: http.Server[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  const server = http.createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

afterAll(async () => {
  await Promise.all(
    openServers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Guard for talking to the local test server: private space relaxed. */
function devGuard(options: Parameters<typeof createEgressGuard>[0] = {}): EgressGuard {
  return createEgressGuard({ allowPrivateHosts: true, ...options });
}

describe("fetch (local server)", () => {
  test("GET returns status, headers and body", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-test": "yes" });
      res.end("hello world");
    });
    const guard = devGuard();
    const response = await guard.fetch(`${srv.base}/x`);
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(await response.text()).toBe("hello world");
    await srv.close();
  });

  test("POST body is forwarded", async () => {
    const srv = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    const guard = devGuard();
    const response = await guard.fetch(srv.base, { method: "POST", body: "payload-42" });
    expect(await response.json()).toEqual({ method: "POST", body: "payload-42" });
    await srv.close();
  });

  test("redirects are followed and the final URL reported", async () => {
    const srv = await startServer((req, res) => {
      if (req.url === "/one") {
        res.writeHead(302, { location: "/two" });
        res.end();
      } else if (req.url === "/two") {
        res.writeHead(301, { location: `${srv.base}/three` });
        res.end();
      } else {
        res.writeHead(200);
        res.end("arrived");
      }
    });
    const guard = devGuard();
    const response = await guard.fetch(`${srv.base}/one`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("arrived");
    expect(response.url).toBe(`${srv.base}/three`);
    await srv.close();
  });

  test("redirect limit exceeded", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });
    const guard = devGuard({ maxRedirects: 2 });
    expect(await reasonOf(() => guard.fetch(`${srv.base}/again`))).toBe("redirect_limit");
    await srv.close();
  });

  test("a redirect to a forbidden target is refused (re-validation per hop)", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    const guard = devGuard();
    expect(await reasonOf(() => guard.fetch(srv.base))).toBe("forbidden_host");
    await srv.close();
  });

  test("a redirect to a non-allowlisted host is refused", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, { location: "https://evil.example.org/steal" });
      res.end();
    });
    const guard = createEgressGuard({
      allowPrivateHosts: true,
      allowedHosts: ["127.0.0.1"],
      resolver: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    });
    expect(await reasonOf(() => guard.fetch(srv.base))).toBe("host_not_allowed");
    await srv.close();
  });

  test("maxBytes truncates and reports too_large", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(5000));
    });
    const guard = devGuard({ maxBytes: 1000 });
    expect(await reasonOf(() => guard.fetch(srv.base))).toBe("too_large");
    await srv.close();
  });

  test("body under the limit passes through intact", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("y".repeat(900));
    });
    const guard = devGuard({ maxBytes: 1000 });
    const response = await guard.fetch(srv.base);
    const text = await response.text();
    expect(text.length).toBe(900);
    await srv.close();
  });

  test("per-hop timeout", async () => {
    const srv = await startServer((_req, res) => {
      // Never respond — the guard must give up.
      res.on("close", () => {});
    });
    const guard = devGuard({ timeoutMs: 150 });
    expect(await reasonOf(() => guard.fetch(srv.base))).toBe("timeout");
    await srv.close();
  });

  test("connection refused maps to network", async () => {
    // Bind and close a port so it is (almost certainly) unused.
    const srv = await startServer((_req, res) => res.end());
    const dead = srv.port;
    await srv.close();
    const guard = devGuard();
    expect(await reasonOf(() => guard.fetch(`http://127.0.0.1:${dead}/`))).toBe("network");
  });

  test("external guard refuses the local test server (loopback blocked)", async () => {
    const srv = await startServer((_req, res) => res.end("secret"));
    const guard = createEgressGuard(); // default: private space forbidden
    expect(await reasonOf(() => guard.fetch(srv.base))).toBe("forbidden_address");
    await srv.close();
  });

  test("abort signal cancels an in-flight request", async () => {
    const srv = await startServer(() => {
      // hold the request open
    });
    const guard = devGuard({ timeoutMs: 0 });
    const controller = new AbortController();
    const pending = guard.fetch(srv.base, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const reason = await reasonOf(() => pending);
    expect(reason).toBe("network"); // an outer abort is reported as a cancelled request
    await srv.close();
  });
});
