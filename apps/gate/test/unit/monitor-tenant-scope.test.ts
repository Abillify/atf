// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { AppConfigSchema, type MonitoringConfig } from "../../src/config/schema.ts";
import { MonitorBus, type MonitorEvent, type MonitorEventInput } from "../../src/monitor/events.ts";
import { createMonitorRouter } from "../../src/monitor/routes.ts";

const SESSION_SECRET = "s".repeat(40);
const MONITOR_TOKEN = "m-secret";

function config(over: Record<string, unknown> = {}): MonitoringConfig {
  const parsed = AppConfigSchema.parse({
    server: { port: 3000, rateLimit: { enabled: false } },
    auth: { mode: "static", static: { tokens: [{ token: "t", username: "dev" }] } },
    monitoring: {
      enabled: true,
      token: MONITOR_TOKEN,
      oidc: {
        issuer: "https://id.example.com/",
        clientId: "mcpgate-monitor",
        clientSecret: "c".repeat(40),
        redirectUri: "https://mcpgate.internal/monitor/callback",
        sessionSecret: SESSION_SECRET,
      },
      ...over,
    },
  });
  return parsed.monitoring;
}

/** Forge a signed monitor OIDC session cookie for a tenant. */
function oidcCookie(tenantId: string): string {
  const payload = {
    sub: "user-1",
    username: "user-1",
    scopes: [],
    tenantId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `mcpgate_monitor_session=${body}.${mac}`;
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function start(bus: MonitorBus, cfg: MonitoringConfig): Promise<number> {
  const app = express();
  app.use(createMonitorRouter({ bus, config: cfg }));
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
    server = srv;
  });
}

/**
 * Open the SSE stream, collect the replayed `data:` events, then abort. The
 * bus replays its ring buffer synchronously on connect, so a short read gets
 * the whole replay without waiting for live traffic.
 */
async function readStream(
  port: number,
  cookie: string | undefined,
  token = false,
): Promise<MonitorEvent[]> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${MONITOR_TOKEN}`;
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/monitor/stream`, {
    headers,
    signal: controller.signal,
  });
  const body = res.body;
  if (!body) throw new Error("stream response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: MonitorEvent[] = [];
  try {
    for (;;) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 150)),
      ]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx < 0) break;
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice("data: ".length)) as MonitorEvent);
      }
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }
  return events;
}

function seed(bus: MonitorBus): void {
  const inputs: MonitorEventInput[] = [
    { type: "tool_call", tenantId: "t1", tool: "a" },
    { type: "tool_call", tenantId: "t2", tool: "b" },
    { type: "tool_call", tool: "no-tenant" },
  ];
  for (const i of inputs) bus.publish(i);
}

describe("monitor stream tenant scope", () => {
  it("an OIDC session sees only its own tenant's events", async () => {
    const bus = new MonitorBus(50);
    seed(bus);
    const port = await start(bus, config());
    const events = await readStream(port, oidcCookie("t1"));
    expect(events.map((e) => e.tool)).toEqual(["a"]);
  });

  it("tenantScope: all shows an OIDC session every event", async () => {
    const bus = new MonitorBus(50);
    seed(bus);
    const port = await start(bus, config({ tenantScope: "all" }));
    const events = await readStream(port, oidcCookie("t1"));
    expect(events.map((e) => e.tool).sort()).toEqual(["a", "b", "no-tenant"]);
  });

  it("a token viewer sees every event regardless of tenant", async () => {
    const bus = new MonitorBus(50);
    seed(bus);
    const port = await start(bus, config());
    const events = await readStream(port, undefined, true);
    expect(events.map((e) => e.tool).sort()).toEqual(["a", "b", "no-tenant"]);
  });
});

describe("monitor stream tool content digest", () => {
  function seedResult(bus: MonitorBus): void {
    bus.publish({
      type: "tool_result",
      tenantId: "t1",
      tool: "list_orders",
      status: "ok",
      meta: { content: [{ type: "text", text: "secret rows" }] },
    });
  }

  it("replaces tool content with a digest by default", async () => {
    const bus = new MonitorBus(50);
    seedResult(bus);
    const port = await start(bus, config());
    const events = await readStream(port, undefined, true);
    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, unknown>;
    expect(meta.content).toBeUndefined();
    const digest = meta.contentDigest as { sha256: string; bytes: number };
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof digest.bytes).toBe("number");
    expect(digest.bytes).toBe(Buffer.byteLength(JSON.stringify([{ type: "text", text: "secret rows" }]), "utf8"));
  });

  it("keeps tool content when includeToolContent is true", async () => {
    const bus = new MonitorBus(50);
    seedResult(bus);
    const port = await start(bus, config({ includeToolContent: true }));
    const events = await readStream(port, undefined, true);
    const meta = events[0].meta as Record<string, unknown>;
    expect(meta.content).toEqual([{ type: "text", text: "secret rows" }]);
    expect(meta.contentDigest).toBeUndefined();
  });
});
