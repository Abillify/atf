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

function buildConfig(
  monitoring: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return AppConfigSchema.parse({
    server: { port: 3000, rateLimit: { enabled: false } },
    auth: {
      mode: "static",
      static: { tokens: [{ token: "t", username: "dev-user" }] },
    },
    monitoring: { enabled: true, ...monitoring },
    tools: [READ_TOOL, WRITE_TOOL],
    ...extra,
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

function started(): AppHandle {
  if (handle === undefined) throw new Error("start() has not been called");
  return handle;
}

async function start(
  monitoring: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<number> {
  handle = await buildApp(buildConfig(monitoring, extra), {
    db: new FakeDb({ main: [{ id: 1 }] }),
  });
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

const SCOPED_TOOL = {
  name: "admin_report",
  type: "database",
  access: "read",
  database: "main",
  query: "SELECT id FROM orders",
  requiredScopes: ["admin:read"],
  inputSchema: { type: "object", properties: {}, required: [] },
};

describe("Monitor playground · governance pipeline", () => {
  it("enforces a governance policy deny on a playground run", async () => {
    const port = await start(
      { token: MONITOR_TOKEN, playground: { enabled: true } },
      {
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "deny", match: { tool: "list_orders" } }],
        },
      },
    );
    const res = await fetch(runUrl(port, "list_orders"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Policy denied");
  });

  it("enforces required tool scopes on a playground run", async () => {
    const port = await start(
      { token: MONITOR_TOKEN, playground: { enabled: true } },
      { tools: [READ_TOOL, WRITE_TOOL, SCOPED_TOOL] },
    );
    const res = await fetch(runUrl(port, "admin_report"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {} }),
    });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain(
      "Missing required scope(s): admin:read",
    );
  });

  it("lets the static-token operator supply an identity for scope-aware tools", async () => {
    const port = await start(
      { token: MONITOR_TOKEN, playground: { enabled: true } },
      { tools: [READ_TOOL, WRITE_TOOL, SCOPED_TOOL] },
    );
    const res = await fetch(runUrl(port, "admin_report"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {}, identity: { scopes: ["admin:read"] } }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("applies the per-identity rate limiter to playground runs", async () => {
    const port = await start(
      { token: MONITOR_TOKEN, playground: { enabled: true } },
      {
        server: {
          port: 3000,
          rateLimit: {
            enabled: false,
            perIdentity: { enabled: true, windowMs: 60_000, max: 1 },
          },
        },
      },
    );
    const first = await fetch(runUrl(port, "list_orders"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {} }),
    });
    expect((await first.json()).ok).toBe(true);
    const second = await fetch(runUrl(port, "list_orders"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {} }),
    });
    const data = await second.json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Rate limit exceeded");
  });

  it("validates tool arguments through the dispatch pipeline", async () => {
    const port = await start({
      token: MONITOR_TOKEN,
      playground: { enabled: true, allowWrite: true },
    });
    const res = await fetch(runUrl(port, "cancel_order"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: { id: "not-a-number" } }),
    });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Invalid arguments");
  });
});

describe("Monitor playground · dry-run governance", () => {
  const dryRun = (port: number, name: string, body: Record<string, unknown> = {}) =>
    fetch(runUrl(port, name), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: {}, dryRun: true, ...body }),
    });

  it("renders the planned SQL for an allowed dry-run without executing", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true } });
    const res = await dryRun(port, "list_orders");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.content[0].text).toContain("SELECT");
  });

  it("refuses a dry-run that a policy deny covers (no SQL is disclosed)", async () => {
    const port = await start(
      { token: MONITOR_TOKEN, playground: { enabled: true } },
      {
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "deny", match: { tool: "list_orders" } }],
        },
      },
    );
    const data = await (await dryRun(port, "list_orders")).json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Policy denied");
    expect(JSON.stringify(data)).not.toContain("SELECT");
  });

  it("refuses a dry-run without the tool's required scopes (no SQL is disclosed)", async () => {
    const port = await start(
      { token: MONITOR_TOKEN, playground: { enabled: true } },
      { tools: [READ_TOOL, WRITE_TOOL, SCOPED_TOOL] },
    );
    const data = await (await dryRun(port, "admin_report")).json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Missing required scope(s): admin:read");
    expect(JSON.stringify(data)).not.toContain("SELECT");
  });

  it("lets the static-token operator dry-run a scoped tool with a supplied identity", async () => {
    const port = await start(
      { token: MONITOR_TOKEN, playground: { enabled: true } },
      { tools: [READ_TOOL, WRITE_TOOL, SCOPED_TOOL] },
    );
    const data = await (
      await dryRun(port, "admin_report", { identity: { scopes: ["admin:read"] } })
    ).json();
    expect(data.ok).toBe(true);
  });

  it("publishes dry-run events under the same playground-<hex> session scheme as real runs", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true } });
    await dryRun(port, "list_orders");
    const events = started().bus.recent();
    const dry = events.filter(
      (e) => e.type === "tool_call" && (e.meta as { dryRun?: boolean } | undefined)?.dryRun === true,
    );
    expect(dry.length).toBe(1);
    expect(dry[0]?.sessionId).toMatch(/^playground-[0-9a-f]{16}$/);
  });

  it("still blocks a real write-tool run while a write-tool dry-run is allowed", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true } });
    expect((await (await dryRun(port, "cancel_order", { args: { id: 1 } })).json()).ok).toBe(true);
    const real = await fetch(runUrl(port, "cancel_order"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ args: { id: 1 } }),
    });
    expect(real.status).toBe(403);
  });
});

describe("Monitor playground · fail closed without governance wiring", () => {
  it("returns 503 for a run AND for a dry-run when dispatcherDeps is absent", async () => {
    const port = await start({ token: MONITOR_TOKEN, playground: { enabled: true } });
    // Same registry/bus, but a router mounted WITHOUT dispatcherDeps.
    const { createMonitorRouter } = await import("../../src/monitor/routes.ts");
    const express = (await import("express")).default;
    const app = express();
    app.use(
      createMonitorRouter({
        bus: started().bus,
        config: buildConfig({ token: MONITOR_TOKEN, playground: { enabled: true } })
          .monitoring,
        registry: started().registry,
      }),
    );
    const l = await listen(app);
    try {
      for (const body of [{ args: {} }, { args: {}, dryRun: true }]) {
        const res = await fetch(runUrl(l.port, "list_orders"), {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(503);
        expect((await res.json()).error).toContain("governance wiring");
      }
    } finally {
      l.server.close();
    }
    expect(port).toBeGreaterThan(0);
  });
});
