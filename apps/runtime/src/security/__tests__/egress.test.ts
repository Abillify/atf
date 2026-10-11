// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntimeEgress } from "../egress.js";

/** Start a loopback server and hand back its base URL plus a closer. */
async function startServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function loopbackEgress(baseUrl: string, extra: object = {}) {
  const host = new URL(baseUrl).hostname;
  return createRuntimeEgress({
    allowedPrivateHosts: [host],
    allowLoopback: true,
    ...extra,
  });
}

describe("createRuntimeEgress", () => {
  test("GETs through an allow-listed loopback host (pinned lookup)", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "X-Test": "yes" });
      res.end("hello");
    });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const res = await egress.fetch(`${srv.baseUrl}/x`);
      expect(res.status).toBe(200);
      expect(res.statusText).toBe("OK");
      expect(res.headers.get("x-test")).toBe("yes");
      expect(await res.text()).toBe("hello");
    } finally {
      await srv.close();
    }
  });

  test("blocks loopback when the host is not allow-listed", async () => {
    const srv = await startServer((_req, res) => res.end("nope"));
    try {
      const egress = createRuntimeEgress({});
      await expect(egress.fetch(`${srv.baseUrl}/x`)).rejects.toThrow(
        /outbound (address|host) not allowed/,
      );
    } finally {
      await srv.close();
    }
  });

  test("blocks cloud-metadata addresses even for allow-listed hosts", async () => {
    const egress = createRuntimeEgress({
      allowedPrivateHosts: ["metadata.example"],
      allowLoopback: true,
    });
    // 169.254.169.254 is always forbidden (link-local + metadata).
    await expect(egress.fetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /outbound address not allowed/,
    );
    await expect(egress.fetch("http://metadata.google.internal/x")).rejects.toThrow(
      /outbound host not allowed/,
    );
  });

  test("blocks non-http schemes and URL credentials", async () => {
    const egress = createRuntimeEgress({});
    await expect(egress.fetch("file:///etc/passwd")).rejects.toThrow(
      /outbound protocol not allowed/,
    );
    await expect(egress.fetch("http://user:pw@127.0.0.1/")).rejects.toThrow(
      /URL credentials are not allowed/,
    );
  });

  test("POSTs a buffered body and reads a streamed response", async () => {
    const srv = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ got: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const res = await egress.fetch(`${srv.baseUrl}/echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ got: '{"a":1}' });
    } finally {
      await srv.close();
    }
  });

  test("accepts URLSearchParams bodies", async () => {
    const srv = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(Buffer.concat(chunks).toString("utf8"));
      });
    });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const res = await egress.fetch(`${srv.baseUrl}/form`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });
      expect(await res.text()).toBe("grant_type=client_credentials");
    } finally {
      await srv.close();
    }
  });

  test("follows redirects and re-validates every hop", async () => {
    const srv = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/final" });
        res.end();
        return;
      }
      if (req.url === "/evil") {
        // Redirect towards a host the guard must refuse.
        res.writeHead(302, { Location: "http://169.254.169.254/" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("arrived");
    });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const res = await egress.fetch(`${srv.baseUrl}/start`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("arrived");

      await expect(egress.fetch(`${srv.baseUrl}/evil`)).rejects.toThrow(
        /outbound address not allowed/,
      );
    } finally {
      await srv.close();
    }
  });

  test("redirect mode error refuses 3xx", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    });
    try {
      const egress = loopbackEgress(srv.baseUrl, { redirect: "error" });
      await expect(egress.fetch(`${srv.baseUrl}/start`)).rejects.toThrow(
        /outbound redirects are disabled/,
      );
    } finally {
      await srv.close();
    }
  });

  test("redirect mode manual returns the 3xx without following", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const res = await egress.fetch(`${srv.baseUrl}/start`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/elsewhere");
    } finally {
      await srv.close();
    }
  });

  test("enforces the response size limit while streaming", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      // Stream far more than the limit without a content-length header.
      const chunk = Buffer.alloc(64 * 1024, 1);
      let written = 0;
      const timer = setInterval(() => {
        if (written++ > 40) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunk);
      }, 1);
    });
    try {
      const egress = loopbackEgress(srv.baseUrl, { maxResponseBytes: 128 * 1024 });
      const res = await egress.fetch(`${srv.baseUrl}/big`);
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow(/egress limit/);
    } finally {
      await srv.close();
    }
  });

  test("honours a caller-provided AbortSignal", async () => {
    const srv = await startServer((_req, res) => {
      // never respond
      void _req;
    });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const controller = new AbortController();
      const p = egress.fetch(`${srv.baseUrl}/hang`, { signal: controller.signal });
      controller.abort();
      await expect(p).rejects.toThrow();
    } finally {
      await srv.close();
    }
  });

  test("checkUrl validates scheme and allow-list synchronously", async () => {
    const egress = createRuntimeEgress({ allowedHosts: [".example.test"] });
    expect(egress.checkUrl("https://api.example.test/x")).toBeNull();
    expect(egress.checkUrl("https://evil.test/x")).toMatch(/not allowed/);
    expect(egress.checkUrl("ftp://api.example.test")).toMatch(/protocol/);
  });
});
