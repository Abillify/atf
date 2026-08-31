// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as cryptoSign, type JsonWebKey } from "node:crypto";
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

const KEY_ID = "test-key-1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk: JsonWebKey = { ...publicKey.export({ format: "jwk" }), kid: KEY_ID, alg: "RS256", use: "sig" };

function signIdToken(claims: Record<string, unknown>, signingKey = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KEY_ID })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = cryptoSign("sha256", Buffer.from(data), signingKey).toString("base64url");
  return `${data}.${signature}`;
}

interface FakeIdpOpts {
  /** Sign the id_token with a different (attacker) key than the one published in JWKS. */
  badSignature?: boolean;
  wrongAud?: string;
  expired?: boolean;
}

/** Minimal OIDC provider stub: discovery + JWKS + token endpoint. */
function startFakeIdp(
  clientId: string,
  opts: FakeIdpOpts = {},
): Promise<{ server: Server; port: number; issuer: string }> {
  const forgedKeyPair = opts.badSignature ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : undefined;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
            token_endpoint: `http://127.0.0.1:${port}/token`,
            jwks_uri: `http://127.0.0.1:${port}/jwks`,
          }),
        );
        return;
      }
      if (req.url === "/jwks") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url === "/token" && req.method === "POST") {
        res.setHeader("content-type", "application/json");
        const now = Math.floor(Date.now() / 1000);
        const idToken = signIdToken(
          {
            sub: "alice",
            iss: `http://127.0.0.1:${port}`,
            aud: opts.wrongAud ?? clientId,
            iat: now,
            exp: now + (opts.expired ? -60 : 3600),
          },
          forgedKeyPair?.privateKey ?? privateKey,
        );
        res.end(JSON.stringify({ id_token: idToken, access_token: "at" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    let port = 0;
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, issuer: `http://127.0.0.1:${port}` });
    });
  });
}

const READ_TOOL = {
  name: "list_orders",
  type: "database",
  access: "read",
  database: "main",
  query: "SELECT id FROM orders",
  inputSchema: { type: "object", properties: {}, required: [] },
};

function buildConfig(monitoring: Record<string, unknown>) {
  return AppConfigSchema.parse({
    server: { port: 3000, rateLimit: { enabled: false } },
    auth: { mode: "static", static: { tokens: [{ token: "t", username: "dev-user" }] } },
    monitoring: { enabled: true, ...monitoring },
    tools: [READ_TOOL],
  });
}

let handle: AppHandle | undefined;
let server: Server | undefined;
let idp: { server: Server; port: number; issuer: string } | undefined;

afterEach(async () => {
  server?.close();
  idp?.server.close();
  if (handle) await handle.shutdown();
  handle = undefined;
  server = undefined;
  idp = undefined;
});

const CLIENT_ID = "client";

async function start(oidcExtra: Record<string, unknown> = {}, idpOpts: FakeIdpOpts = {}): Promise<number> {
  idp = await startFakeIdp(CLIENT_ID, idpOpts);
  handle = await buildApp(
    buildConfig({
      oidc: {
        issuer: idp.issuer,
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://127.0.0.1:1/monitor/callback", // overwritten per-request via host header below
        sessionSecret: "test-session-secret",
        ...oidcExtra,
      },
    }),
  );
  const l = await listen(handle.app);
  server = l.server;
  return l.port;
}

function getCookie(res: Response, name: string): string | undefined {
  const raw = res.headers.get("set-cookie");
  if (!raw) return undefined;
  const match = new RegExp(`${name}=([^;]+)`).exec(raw);
  return match?.[1];
}

/** Drives /monitor/login -> /monitor/callback and returns the callback response. */
async function loginAndCallback(port: number): Promise<Response> {
  const loginRes = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
  const stateCookie = getCookie(loginRes, "mcpgate_monitor_state")!;
  const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
  return fetch(`http://127.0.0.1:${port}/monitor/callback?code=fake-code&state=${state}`, {
    redirect: "manual",
    headers: { cookie: `mcpgate_monitor_state=${stateCookie}` },
  });
}

describe("Monitor OIDC login", () => {
  it("redirects unauthenticated dashboard requests to /monitor/login", async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/monitor/login");
  });

  it("/monitor/login sets a state cookie and redirects to the provider's authorization endpoint", async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`http://127.0.0.1:${idp!.port}/authorize`);
    expect(getCookie(res, "mcpgate_monitor_state")).toBeDefined();
  });

  it("completes the callback, sets a session cookie, and authorizes the stream", async () => {
    const port = await start();

    const loginRes = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
    const stateCookie = getCookie(loginRes, "mcpgate_monitor_state")!;
    const authUrl = new URL(loginRes.headers.get("location")!);
    const state = authUrl.searchParams.get("state")!;

    const callbackRes = await fetch(
      `http://127.0.0.1:${port}/monitor/callback?code=fake-code&state=${state}`,
      { redirect: "manual", headers: { cookie: `mcpgate_monitor_state=${stateCookie}` } },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("/");
    const sessionCookie = getCookie(callbackRes, "mcpgate_monitor_session");
    expect(sessionCookie).toBeDefined();

    // Stream is unauthorized without the cookie...
    const unauth = await fetch(`http://127.0.0.1:${port}/monitor/stream`);
    expect(unauth.status).toBe(401);

    // ...and authorized with it.
    const authed = await fetch(`http://127.0.0.1:${port}/monitor/stream`, {
      headers: { cookie: `mcpgate_monitor_session=${sessionCookie}` },
    });
    expect(authed.status).toBe(200);
    authed.body?.cancel();
  });

  it("rejects a callback with a mismatched state", async () => {
    const port = await start();
    const loginRes = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
    const stateCookie = getCookie(loginRes, "mcpgate_monitor_state")!;

    const res = await fetch(`http://127.0.0.1:${port}/monitor/callback?code=fake-code&state=wrong`, {
      headers: { cookie: `mcpgate_monitor_state=${stateCookie}` },
    });
    expect(res.status).toBe(400);
  });

  it("logout clears the session and re-locks the stream", async () => {
    const port = await start();
    const callbackRes = await loginAndCallback(port);
    const sessionCookie = getCookie(callbackRes, "mcpgate_monitor_session")!;

    const logoutRes = await fetch(`http://127.0.0.1:${port}/monitor/logout`, {
      redirect: "manual",
      headers: { cookie: `mcpgate_monitor_session=${sessionCookie}` },
    });
    expect(logoutRes.status).toBe(302);
    const setCookie = logoutRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("mcpgate_monitor_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });
});

describe("Monitor OIDC id_token verification", () => {
  it("rejects an id_token signed with a key not in the provider's JWKS", async () => {
    const port = await start({}, { badSignature: true });
    const res = await loginAndCallback(port);
    expect(res.status).toBe(401);
    expect(getCookie(res, "mcpgate_monitor_session")).toBeUndefined();
  });

  it("rejects an id_token whose aud does not match the configured clientId", async () => {
    const port = await start({}, { wrongAud: "someone-elses-client" });
    const res = await loginAndCallback(port);
    expect(res.status).toBe(401);
    expect(getCookie(res, "mcpgate_monitor_session")).toBeUndefined();
  });

  it("rejects an expired id_token", async () => {
    const port = await start({}, { expired: true });
    const res = await loginAndCallback(port);
    expect(res.status).toBe(401);
    expect(getCookie(res, "mcpgate_monitor_session")).toBeUndefined();
  });
});
