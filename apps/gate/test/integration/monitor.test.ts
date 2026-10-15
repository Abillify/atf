// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const MONITOR_TOKEN = "m-secret";

const READ_TOOL = {
  name: "list_orders",
  type: "database",
  access: "read",
  database: "main",
  query: "SELECT id FROM orders",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const WRITE_TOOL = {
  name: "cancel_order",
  type: "database",
  access: "write",
  database: "main",
  query: "DELETE FROM orders WHERE id = :param.id",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
};

function buildConfig(monitoring: Record<string, unknown>) {
  return AppConfigSchema.parse({
    server: { port: 3000, rateLimit: { enabled: false } },
    auth: { mode: "static", static: { tokens: [{ token: "t", username: "dev-user" }] } },
    monitoring: { enabled: true, ...monitoring },
    tools: [READ_TOOL, WRITE_TOOL],
  });
}

let handle: AppHandle | undefined;
let server: Server | undefined;

afterEach(async () => {
  server?.close();
  if (handle) await handle.shutdown();
  handle = undefined;
  server = undefined;
});

async function start(monitoring: Record<string, unknown>): Promise<number> {
  handle = await buildApp(buildConfig(monitoring), { db: new FakeDb({ main: [{ id: 1 }] }) });
  const l = await listen(handle.app);
  server = l.server;
  return l.port;
}

function runUrl(port: number, name: string): string {
  return `http://127.0.0.1:${port}/monitor/tools/${name}/run`;
}

function jsonHeaders(token = MONITOR_TOKEN): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

describe("Monitor playground · gating", () => {
  it("returns 403 when the playground is disabled (default)", async () => {
    const port = await start({ token: MONITOR_TOKEN });
    const res = await fetch(runUrl(port, "list_orders"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("disabled");
  });

  it("returns 403 when enabled but no monitoring.token is set (fail closed)", async () => {
    const port = await start({ playground: { enabled: true } });
    const res = await fetch(`http://127.0.0.1:${port}/monitor/tools/list_orders/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("monitoring.token");
  });

  it("runs a read tool when enabled and token-authorized", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true } });
    const res = await fetch(runUrl(port, "list_orders"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("blocks a write tool unless allowWrite is set", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true } });
    const res = await fetch(runUrl(port, "cancel_order"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: { id: 1 } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("allowWrite");
  });

  it("runs a write tool when allowWrite is enabled", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true, allowWrite: true } });
    const res = await fetch(runUrl(port, "cancel_order"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: { id: 1 } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("rejects an unauthorized run with a wrong token", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true } });
    const res = await fetch(runUrl(port, "list_orders"), {
      method: "POST",
      headers: jsonHeaders("wrong"),
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Monitor dashboard · token session and CSP", () => {
  it("never accepts the token as a ?token= query parameter", async () => {
    const port = await start({ token: MONITOR_TOKEN });
    const res = await fetch(
      `http://127.0.0.1:${port}/monitor/tools?token=${encodeURIComponent(MONITOR_TOKEN)}`,
    );
    expect(res.status).toBe(401);
  });

  it("exchanges the bearer token for an HttpOnly SameSite=Strict cookie that authorizes later requests", async () => {
    const port = await start({ token: MONITOR_TOKEN });
    const base = `http://127.0.0.1:${port}`;
    const rejected = await fetch(`${base}/monitor/session`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toBeNull();

    const res = await fetch(`${base}/monitor/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${MONITOR_TOKEN}` },
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(MONITOR_TOKEN);

    const pair = cookie.split(";")[0] ?? "";
    const tools = await fetch(`${base}/monitor/tools`, { headers: { cookie: pair } });
    expect(tools.status).toBe(200);
    // A forged cookie value is rejected.
    const forged = await fetch(`${base}/monitor/tools`, {
      headers: { cookie: `${pair.split("=")[0]}=e30.forged` },
    });
    expect(forged.status).toBe(401);
  });

  it("serves the dashboard with a nonce CSP that covers every script and no inline handler", async () => {
    const port = await start({ token: MONITOR_TOKEN });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]{16,})'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const html = await res.text();
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\son[a-z]+=["']/);
    expect(html).not.toContain("localStorage.setItem");
  });
});

describe("Metrics endpoint", () => {
  it("exposes Prometheus text at /metrics", async () => {
    const port = await start({ token: MONITOR_TOKEN });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("mcpgate_connections_total");
    expect(body).toContain("mcpgate_tool_calls_total");
  });
});
