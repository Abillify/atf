// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Access control on the Prometheus endpoint.
 *
 * The exposition enumerates tool names and per-tool call/error counts, so it is
 * a usage profile and a capability inventory — not neutral data. It used to be
 * served openly by default. These tests pin the three configurations and, in
 * particular, that a REMOTE scrape without a token is refused.
 */

import { afterAll, describe, expect, test } from "bun:test";
import express, { type Express } from "express";
import type { Server } from "node:http";
import {
  createMetricsAuthMiddleware,
  isLoopbackRequest,
} from "../../src/server/metrics-auth.ts";
import { AppConfigSchema } from "../../src/config/schema.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/**
 * Build a tiny app around the middleware and bind it.
 *
 * `trust proxy` is set to 1 exactly as the real app does, so an
 * `X-Forwarded-For` header is what `req.ip` resolves to — that is how these
 * tests simulate a remote client while still connecting over loopback.
 */
async function mkServer(cfg: {
  token?: string;
  allowUnauthenticated?: boolean;
}): Promise<number> {
  const app = express();
  app.set("trust proxy", 1);
  app.get(
    "/metrics",
    createMetricsAuthMiddleware({
      ...(cfg.token !== undefined ? { token: cfg.token } : {}),
      allowUnauthenticated: cfg.allowUnauthenticated ?? false,
    }),
    (_req, res) => {
      res.type("text/plain").send("mcpgate_tool_calls_total 1\n");
    },
  );
  const { server, port } = await listen(app);
  servers.push(server);
  return port;
}

const REMOTE = "203.0.113.7";

describe("metrics endpoint · loopback-only default", () => {
  test("allows a loopback scrape without any credential", async () => {
    const port = await mkServer({});
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mcpgate_tool_calls_total");
  });

  test("refuses a remote scrape without a credential", async () => {
    const port = await mkServer({});
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { "X-Forwarded-For": REMOTE },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.text()).not.toContain("mcpgate_tool_calls_total");
  });
});

describe("metrics endpoint · token mode", () => {
  test("accepts the configured bearer token", async () => {
    const port = await mkServer({ token: "scrape-secret" });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: {
        "X-Forwarded-For": REMOTE,
        Authorization: "Bearer scrape-secret",
      },
    });
    expect(res.status).toBe(200);
  });

  test("rejects a wrong token", async () => {
    const port = await mkServer({ token: "scrape-secret" });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects a missing Authorization header even from loopback", async () => {
    // With a token configured, loopback is no longer a free pass — the operator
    // asked for a credential, so requiring it everywhere is the honest reading.
    const port = await mkServer({ token: "scrape-secret" });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(401);
  });

  test("rejects a non-Bearer scheme", async () => {
    const port = await mkServer({ token: "scrape-secret" });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: "Basic c2NyYXBlLXNlY3JldA==" },
    });
    expect(res.status).toBe(401);
  });

  test("token comparison is length-safe (a prefix is not accepted)", async () => {
    const port = await mkServer({ token: "scrape-secret" });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: "Bearer scrape" },
    });
    expect(res.status).toBe(401);
  });
});

describe("metrics endpoint · explicit opt-out", () => {
  test("allowUnauthenticated serves a remote scrape", async () => {
    const port = await mkServer({ allowUnauthenticated: true });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { "X-Forwarded-For": REMOTE },
    });
    expect(res.status).toBe(200);
  });
});

describe("isLoopbackRequest", () => {
  test("recognises the loopback forms", () => {
    for (const ip of ["127.0.0.1", "127.0.1.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackRequest({ ip } as never)).toBe(true);
    }
  });

  test("rejects routable addresses", () => {
    for (const ip of ["203.0.113.7", "10.0.0.5", "::ffff:203.0.113.7", ""]) {
      expect(isLoopbackRequest({ ip } as never)).toBe(false);
    }
  });

  test("falls back to the socket address when req.ip is unset", () => {
    expect(
      isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } } as never),
    ).toBe(true);
  });
});

describe("metrics config defaults", () => {
  test("metrics are enabled but NOT unauthenticated by default", () => {
    const parsed = AppConfigSchema.shape.server.parse({});
    expect(parsed.metrics.enabled).toBe(true);
    expect(parsed.metrics.allowUnauthenticated).toBe(false);
    expect(parsed.metrics.token).toBeUndefined();
  });

  test("session bounds are on by default", () => {
    const parsed = AppConfigSchema.shape.server.parse({});
    expect(parsed.sessions.idleTimeoutMs).toBeGreaterThan(0);
    expect(parsed.sessions.max).toBeGreaterThan(0);
  });
});
