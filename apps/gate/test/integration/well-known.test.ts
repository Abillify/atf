// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";
import { PROTECTED_RESOURCE_PATH } from "../../src/auth/well-known.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
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

async function start(extra: Record<string, unknown>): Promise<number> {
  handle = await buildApp(
    AppConfigSchema.parse({
      server: { port: 3000, rateLimit: { enabled: false }, ...extra.server },
      auth: extra.auth,
      monitoring: { enabled: false },
    }),
    { db: new FakeDb({}) },
  );
  const l = await listen(handle.app);
  server = l.server;
  return l.port;
}

describe("/.well-known/oauth-protected-resource", () => {
  it("404s when auth.mode is static (no oauth configured)", async () => {
    const port = await start({
      server: { publicUrl: "http://127.0.0.1:3000" },
      auth: { mode: "static", static: { tokens: [{ token: "t" }] } },
    });
    const res = await fetch(`http://127.0.0.1:${port}${PROTECTED_RESOURCE_PATH}`);
    expect(res.status).toBe(404);
  });

  it("404s when oauth is configured but server.publicUrl is unset", async () => {
    const port = await start({
      auth: { mode: "oauth", oauth: { jwksUri: "https://id.example.com/jwks", issuer: "https://id.example.com/", audience: "mcpgate" } },
    });
    const res = await fetch(`http://127.0.0.1:${port}${PROTECTED_RESOURCE_PATH}`);
    expect(res.status).toBe(404);
  });

  it("returns metadata for oauth mode with a public URL", async () => {
    const port = await start({
      server: { publicUrl: "http://127.0.0.1:9" },
      auth: {
        mode: "oauth",
        oauth: { jwksUri: "https://id.example.com/jwks", issuer: "https://id.example.com/", audience: "mcpgate" },
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}${PROTECTED_RESOURCE_PATH}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("http://127.0.0.1:9");
    expect(body.authorization_servers).toEqual(["https://id.example.com/"]);
  });

  it("is never rate-limited (mounted alongside /healthz)", async () => {
    const port = await start({
      server: { publicUrl: "http://127.0.0.1:9", rateLimit: { enabled: true, max: 1, windowMs: 60_000 } },
      auth: { mode: "oauth", oauth: { jwksUri: "https://id.example.com/jwks", issuer: "https://id.example.com/", audience: "mcpgate" } },
    });
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${port}${PROTECTED_RESOURCE_PATH}`);
      expect(res.status).toBe(200);
    }
  });
});

describe("WWW-Authenticate on 401 (oauth mode)", () => {
  it("points at the protected-resource metadata for /mcp", async () => {
    const port = await start({
      server: { publicUrl: "http://127.0.0.1:9" },
      auth: { mode: "oauth", oauth: { jwksUri: "https://id.example.com/jwks", issuer: "https://id.example.com/", audience: "mcpgate" } },
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="http://127.0.0.1:9${PROTECTED_RESOURCE_PATH}", error="invalid_token", error_description="Missing bearer token"`,
    );
  });

  it("points at the protected-resource metadata for /sse", async () => {
    const port = await start({
      server: { publicUrl: "http://127.0.0.1:9" },
      auth: { mode: "oauth", oauth: { jwksUri: "https://id.example.com/jwks", issuer: "https://id.example.com/", audience: "mcpgate" } },
    });
    const res = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="http://127.0.0.1:9${PROTECTED_RESOURCE_PATH}"`,
    );
  });

  it("falls back to a plain Bearer challenge without server.publicUrl", async () => {
    const port = await start({
      auth: { mode: "oauth", oauth: { jwksUri: "https://id.example.com/jwks", issuer: "https://id.example.com/", audience: "mcpgate" } },
    });
    const res = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("falls back to a plain Bearer challenge for static-mode 401s", async () => {
    const port = await start({
      auth: { mode: "static", static: { tokens: [{ token: "t" }] } },
    });
    const res = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });
});
