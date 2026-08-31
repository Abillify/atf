// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";
import { connectMcpStreamable } from "../helpers/mcp-client.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const TOKEN = "backend-token";

function baseConfig(extra: Record<string, unknown>) {
  return AppConfigSchema.parse({
    server: { port: 3000, ...((extra.server as object) ?? {}) },
    tenantIsolation: {
      enabled: true,
      defaultTenantId: "default",
      claimNames: ["tenant", "tid", "client_id"],
    },
    auth: {
      mode: "static",
      static: { tokens: [{ token: TOKEN, username: "dev-user", scopes: ["tools:read"], claims: { tenant: "acme" } }] },
    },
    monitoring: { enabled: true, token: "m" },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Webhook: inbound POST is cached and returned via an MCP tool call
// ---------------------------------------------------------------------------

describe("Webhook backend · receive then read over MCP", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const config = baseConfig({
      tools: [
        {
          name: "latest_reading",
          type: "webhook",
          path: "/webhooks/reading",
          tenantId: "acme",
          ttlSeconds: 60,
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    handle = await buildApp(config, { db: new FakeDb() });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("returns the most recently posted payload", async () => {
    const post = await fetch(`http://127.0.0.1:${port}/webhooks/reading`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sensor: "A", value: 7 }),
    });
    expect(post.status).toBe(200);

    const client = await connectMcpStreamable(`http://127.0.0.1:${port}`, TOKEN);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("latest_reading");

    const res = await client.callTool({ name: "latest_reading", arguments: {} });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(payload).toEqual({ sensor: "A", value: 7 });
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// MCP proxy: forwards a call to a downstream mcpgate instance
// ---------------------------------------------------------------------------

describe("MCP proxy backend · forwards to a downstream server", () => {
  let downstream: AppHandle;
  let downstreamServer: Server;
  let upstream: AppHandle;
  let upstreamServer: Server;
  let upstreamPort: number;

  const DOWNSTREAM_TOKEN = "downstream-token";

  beforeAll(async () => {
    // Downstream mcpgate exposes a simple inline calculator tool.
    const downstreamConfig = AppConfigSchema.parse({
      server: { port: 3000 },
      auth: { mode: "static", static: { tokens: [{ token: DOWNSTREAM_TOKEN, username: "ds", scopes: ["tools:read"] }] } },
      monitoring: { enabled: false },
      tools: [
        {
          name: "calc",
          type: "inline",
          handler: "calculate",
          inputSchema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
        },
      ],
    });
    downstream = await buildApp(downstreamConfig, { db: new FakeDb() });
    const dl = await listen(downstream.app);
    downstreamServer = dl.server;

    // Upstream mcpgate proxies "remote_calc" → downstream "calc".
    const upstreamConfig = baseConfig({
      tools: [
        {
          name: "remote_calc",
          type: "mcp",
          server: { url: `http://127.0.0.1:${dl.port}/mcp`, token: DOWNSTREAM_TOKEN },
          targetTool: "calc",
          inputSchema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
        },
      ],
    });
    upstream = await buildApp(upstreamConfig, { db: new FakeDb() });
    const ul = await listen(upstream.app);
    upstreamServer = ul.server;
    upstreamPort = ul.port;
  });

  afterAll(async () => {
    upstreamServer.close();
    downstreamServer.close();
    await upstream.shutdown();
    await downstream.shutdown();
  });

  it("refuses a downstream loopback target even when it is configured", async () => {
    const client = await connectMcpStreamable(`http://127.0.0.1:${upstreamPort}`, TOKEN);
    const res = await client.callTool({ name: "remote_calc", arguments: { input: "6 * 7" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("outbound address not allowed");
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Edge middleware: DNS-rebinding allow-list and rate limiting
// ---------------------------------------------------------------------------

describe("Edge middleware · allowedHosts and rate limiting", () => {
  it("rejects a request whose Host is not in allowedHosts", async () => {
    const config = baseConfig({
      server: { port: 3000, allowedHosts: ["allowed.example"] },
      tools: [],
    });
    const handle = await buildApp(config, { db: new FakeDb() });
    const { server, port } = await listen(handle.app);
    try {
      const blocked = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { host: "evil.example" },
      });
      expect(blocked.status).toBe(403);

      const allowed = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { host: "allowed.example" },
      });
      expect(allowed.status).toBe(200);
    } finally {
      server.close();
      await handle.shutdown();
    }
  });

  it("enforces the rate limit and returns 429 past the cap", async () => {
    const config = baseConfig({
      server: { port: 3000, rateLimit: { enabled: true, windowMs: 60_000, max: 3 } },
      tools: [],
    });
    const handle = await buildApp(config, { db: new FakeDb() });
    const { server, port } = await listen(handle.app);
    try {
      // /healthz is registered before the limiter, so hit an MCP path instead.
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: "{}",
        });
        codes.push(r.status);
      }
      // First few are processed (401 unauth), later ones are rate-limited (429).
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    } finally {
      server.close();
      await handle.shutdown();
    }
  });

  it("sets CORS headers when cors is enabled", async () => {
    const config = baseConfig({
      server: { port: 3000, cors: { enabled: true, origins: ["*"] } },
      tools: [],
    });
    const handle = await buildApp(config, { db: new FakeDb() });
    const { server, port } = await listen(handle.app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { Origin: "https://app.example.com" },
      });
      // With origins ["*"] + credentials, the cors layer reflects the request
      // origin (literal "*" is invalid alongside credentials).
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    } finally {
      server.close();
      await handle.shutdown();
    }
  });
});
