// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import { canonicalHmacInput, WebhookToolExecutor } from "../../src/tools/webhook-tool.ts";
import { WebhookToolSchema } from "../../src/config/schema.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import type { DbProvider } from "../../src/db/manager.ts";
import { MemoryWebhookReplayStore } from "../../src/tools/webhook-replay-store.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const ctx = (tenant = "acme", headers: Record<string, string> = {}): AuthContext => ({
  method: "static", subject: "s", username: "alice", scopes: [], claims: tenant ? { tenant } : {}, tenantId: tenant || "default", headers, rawToken: "t",
});
const runtime = { db: {} as DbProvider, bus: new MonitorBus(), webhookReplayStore: new MemoryWebhookReplayStore() };
const secret = "shhh";

function tool(extra: Record<string, unknown> = {}) {
  return WebhookToolSchema.parse({ name: "w", type: "webhook", path: "/webhooks/w", tenantId: "acme", ttlSeconds: 60, ...extra });
}
function serve(exec: WebhookToolExecutor): Promise<{ url: string; server: Server }> {
  const app = express(); const router = express.Router(); exec.registerReceiver(router, new MonitorBus()); app.use(router);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address(); const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}
function signedHeaders(body: string, nonce = randomUUID(), timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac("sha256", secret)
    .update(canonicalHmacInput("POST", "/webhooks/w", "acme", timestamp, nonce, Buffer.from(body)))
    .digest("hex");
  return { "content-type": "application/json", "x-sig": `sha256=${signature}`, "x-webhook-timestamp": timestamp, "x-webhook-nonce": nonce };
}

describe("WebhookToolExecutor", () => {
  it("fails closed for callers without the configured verified tenant", async () => {
    const exec = new WebhookToolExecutor(tool(), runtime);
    expect((await exec.execute({}, ctx("other"))).isError).toBe(true);
    expect((await exec.execute({}, ctx("", { "x-tenant-id": "acme" }))).isError).toBe(true);
  });

  it("keeps tenant isolation active when business authorization is disabled", async () => {
    const exec = new WebhookToolExecutor(tool({ defaultValue: { idle: true } }), {
      ...runtime,
      authorizationEnabled: false,
    });
    expect((await exec.execute({}, ctx("other"))).isError).toBe(true);
    expect((await exec.execute({}, ctx("acme"))).isError).toBeUndefined();
  });

  it("returns the default only inside the matching tenant partition", async () => {
    const exec = new WebhookToolExecutor(tool({ defaultValue: { idle: true } }), runtime);
    expect(JSON.parse((await exec.execute({}, ctx())).content[0].text)).toEqual({ idle: true });
    expect((await exec.execute({}, ctx("other"))).isError).toBe(true);
  });

  it("binds HMAC to raw body, method/path, trusted tenant, timestamp and nonce", async () => {
    const exec = new WebhookToolExecutor(tool({ authentication: { type: "hmac", secret, header: "x-sig", algorithm: "sha256" } }), runtime);
    const { url, server } = await serve(exec);
    try {
      const body = JSON.stringify({ v: 99 }); const headers = signedHeaders(body, "n-1");
      expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers, body })).status).toBe(200);
      expect(JSON.parse((await exec.execute({}, ctx("acme", { "x-tenant-id": "evil" }))).content[0].text)).toEqual({ v: 99 });
      const changedNonce = { ...headers, "x-webhook-nonce": "n-2" };
      expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers: changedNonce, body })).status).toBe(401);
    } finally { server.close(); }
  });

  it("requires current timestamp and nonce, then rejects replay with 409", async () => {
    const exec = new WebhookToolExecutor(tool({ authentication: { type: "hmac", secret, header: "x-sig" } }), runtime);
    const { url, server } = await serve(exec);
    try {
      const body = "{}";
      expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers: { "content-type": "application/json", "x-sig": "deadbeef" }, body })).status).toBe(401);
      const stale = signedHeaders(body, "old", String(Math.floor(Date.now() / 1000) - 400));
      expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers: stale, body })).status).toBe(401);
      const headers = signedHeaders(body, "once");
      expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers, body })).status).toBe(200);
      expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers, body })).status).toBe(409);
    } finally { server.close(); }
  });

  it("retains every live nonce until its TTL instead of evicting", async () => {
    const exec = new WebhookToolExecutor(tool({ authentication: { type: "hmac", secret, header: "x-sig" } }), runtime);
    const { url, server } = await serve(exec);
    try {
      const body = "{}";
      for (const nonce of ["one", "two", "three"]) {
        expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers: signedHeaders(body, nonce), body })).status).toBe(200);
      }
      // A still-live nonce is never evicted by newer reservations.
      expect((await fetch(`${url}/webhooks/w`, { method: "POST", headers: signedHeaders(body, "one"), body })).status).toBe(409);
    } finally { server.close(); }
  });

  it("treats a payload older than ttlSeconds as stale", async () => {
    const exec = new WebhookToolExecutor(tool({ ttlSeconds: 0.05 }), runtime);
    const { url, server } = await serve(exec);
    try {
      await fetch(`${url}/webhooks/w`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: 1 }) });
      expect((await exec.execute({}, ctx())).isError).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect((await exec.execute({}, ctx())).isError).toBe(true);
    } finally { server.close(); }
  });
});
