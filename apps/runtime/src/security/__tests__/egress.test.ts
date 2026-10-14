// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntimeEgress } from "../egress.js";
import { createLlmTransportFetch } from "../../graph/llm-transport.js";

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
    const srv = await startServer((_req, _res) => {
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

describe("createRuntimeEgress keep-alive variants", () => {
  /** Loopback server that counts accepted TCP connections. */
  async function startCountingServer(body = "ok") {
    let connections = 0;
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      connections: () => connections,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  async function sequentialPosts(f: typeof fetch, baseUrl: string, n: number) {
    for (let i = 0; i < n; i += 1) {
      const res = await f(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ i }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
  }

  test("default fetch reuses the connection (unchanged behaviour)", async () => {
    const srv = await startCountingServer();
    try {
      await sequentialPosts(loopbackEgress(srv.baseUrl).fetch, srv.baseUrl, 5);
      expect(srv.connections()).toBe(1);
    } finally {
      await srv.close();
    }
  });

  test("fetchWithoutKeepAlive opens a fresh connection per request", async () => {
    const srv = await startCountingServer();
    try {
      await sequentialPosts(
        loopbackEgress(srv.baseUrl).fetchWithoutKeepAlive,
        srv.baseUrl,
        5,
      );
      expect(srv.connections()).toBe(5);
    } finally {
      await srv.close();
    }
  });

  test("fetchWithoutKeepAlive keeps the egress policy and response limit", async () => {
    const srv = await startCountingServer("x".repeat(4096));
    try {
      await expect(
        createRuntimeEgress({}).fetchWithoutKeepAlive(`${srv.baseUrl}/x`),
      ).rejects.toThrow(/outbound (address|host) not allowed/);
      await expect(
        createRuntimeEgress({ allowLoopback: true }).fetchWithoutKeepAlive(
          "http://169.254.169.254/latest/meta-data/",
        ),
      ).rejects.toThrow(/outbound address not allowed/);
      const limited = loopbackEgress(srv.baseUrl, { maxResponseBytes: 1024 });
      // Depending on content-length the limit trips on the headers or while
      // streaming the body; either way the caller sees the egress error.
      await expect(
        limited
          .fetchWithoutKeepAlive(`${srv.baseUrl}/x`)
          .then((res) => res.arrayBuffer()),
      ).rejects.toThrow(/egress limit/);
      expect(srv.connections()).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

describe("createRuntimeEgress abort before / after response headers", () => {
  /** Loopback server: answers the first `answerFirst` requests, then hangs. */
  async function startHangingServer(options: { answerFirst?: number; bodyThenHang?: boolean } = {}) {
    let requests = 0;
    const server: Server = createServer((req, res) => {
      requests += 1;
      req.resume();
      if (options.bodyThenHang === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: first\n\n");
        return; // never ends the body
      }
      if (requests <= (options.answerFirst ?? 0)) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      }
      // otherwise: never send headers
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      requests: () => requests,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  const elapsedRejection = async (p: Promise<unknown>): Promise<{ ms: number; error: unknown }> => {
    const started = Date.now();
    const error = await p.then(
      () => undefined,
      (err: unknown) => err,
    );
    return { ms: Date.now() - started, error };
  };

  test.each(["fetch", "fetchWithoutKeepAlive"] as const)(
    "%s: AbortSignal.timeout rejects a POST whose response headers never arrive",
    async (variant) => {
      const srv = await startHangingServer();
      try {
        const egress = loopbackEgress(srv.baseUrl);
        const { ms, error } = await elapsedRejection(
          egress[variant](`${srv.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: 1 }),
            signal: AbortSignal.timeout(150),
          }),
        );
        expect(error).toBeInstanceOf(Error);
        expect(ms).toBeLessThan(2000);
      } finally {
        await srv.close();
      }
    },
  );

  test("keep-alive: a request hanging on a reused socket before headers is aborted", async () => {
    const srv = await startHangingServer({ answerFirst: 1 });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const first = await egress.fetch(`${srv.baseUrl}/v1/chat/completions`, {
        method: "POST",
        body: "{}",
      });
      expect(await first.text()).toBe("ok");
      const { ms, error } = await elapsedRejection(
        egress.fetch(`${srv.baseUrl}/v1/chat/completions`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(150),
        }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(ms).toBeLessThan(2000);
      expect(srv.requests()).toBe(2);
    } finally {
      await srv.close();
    }
  });

  test("through createLlmTransportFetch the signal reaches the real egress unchanged", async () => {
    const srv = await startHangingServer();
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const transport = createLlmTransportFetch({
        primary: egress.fetch,
        fresh: egress.fetchWithoutKeepAlive,
        provider: "llm1",
        model: "m",
        keepAlive: true,
      });
      const { ms, error } = await elapsedRejection(
        transport(`${srv.baseUrl}/v1/chat/completions`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(150),
        }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(ms).toBeLessThan(2000);
      // An abort is never retried on a fresh connection.
      expect(srv.requests()).toBe(1);
    } finally {
      await srv.close();
    }
  });

  test("an abort after the headers cancels the streaming body", async () => {
    const srv = await startHangingServer({ bodyThenHang: true });
    try {
      const egress = loopbackEgress(srv.baseUrl);
      const controller = new AbortController();
      const res = await egress.fetch(`${srv.baseUrl}/stream`, {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      setTimeout(() => controller.abort(), 50);
      const { ms, error } = await elapsedRejection(
        (async () => {
          for (;;) {
            const next = await reader.read();
            if (next.done) throw new Error("body ended without abort error");
          }
        })(),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toBe("body ended without abort error");
      expect(ms).toBeLessThan(2000);
    } finally {
      await srv.close();
    }
  });
});
