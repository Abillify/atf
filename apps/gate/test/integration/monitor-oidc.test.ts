// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, sign as cryptoSign, type JsonWebKey } from "node:crypto";
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
  /** Value of the `groups` claim added to the signed id_token. */
  groups?: string[];
  /** Value of the `tools` claim (the scopes the session is granted). */
  tools?: string[];
  /** Leave the `nonce` claim out of the id_token. */
  omitNonce?: boolean;
  /** Put this nonce into the id_token instead of the one from the login. */
  forceNonce?: string;
  /** `iat` / `nbf` offsets in seconds from now (positive = future). */
  iatOffset?: number;
  nbfOffset?: number;
  /** Publish this `issuer` in the discovery document. */
  discoveryIssuer?: string;
  /** Add this value as a second audience (and set `azp` as given). */
  extraAudience?: string;
  azp?: string;
}

/** Requests the fake provider's token endpoint received, newest last. */
const tokenRequests: Array<Record<string, string>> = [];

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
            ...(opts.discoveryIssuer !== undefined ? { issuer: opts.discoveryIssuer } : {}),
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
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const form = Object.fromEntries(
            new URLSearchParams(Buffer.concat(chunks).toString()).entries(),
          );
          tokenRequests.push(form);
          // The test drives the login: `code` carries the nonce the browser
          // was sent ("nonce:<value>"), which a real provider keeps server-side.
          const issued = form["code"]?.startsWith("nonce:") ? form["code"].slice(6) : undefined;
          const nonce = opts.forceNonce ?? issued;
          res.setHeader("content-type", "application/json");
          const now = Math.floor(Date.now() / 1000);
          const idToken = signIdToken(
            {
              sub: "alice",
              iss: `http://127.0.0.1:${port}`,
              aud:
                opts.extraAudience !== undefined
                  ? [opts.wrongAud ?? clientId, opts.extraAudience]
                  : (opts.wrongAud ?? clientId),
              ...(opts.azp !== undefined ? { azp: opts.azp } : {}),
              iat: now + (opts.iatOffset ?? 0),
              ...(opts.nbfOffset !== undefined ? { nbf: now + opts.nbfOffset } : {}),
              exp: now + (opts.expired ? -60 : 3600),
              ...(nonce !== undefined && !opts.omitNonce ? { nonce } : {}),
              ...(opts.groups !== undefined ? { groups: opts.groups } : {}),
              ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
            },
            forgedKeyPair?.privateKey ?? privateKey,
          );
          res.end(JSON.stringify({ id_token: idToken, access_token: "at" }));
        });
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
    tools: [READ_TOOL],
    ...extra,
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

interface StartOpts {
  /** Merged into `monitoring` next to the oidc block (e.g. playground). */
  monitoring?: Record<string, unknown>;
  /** Top-level config overrides (e.g. policies, server.trustProxy). */
  extra?: Record<string, unknown>;
}

async function start(
  oidcExtra: Record<string, unknown> = {},
  idpOpts: FakeIdpOpts = {},
  opts: StartOpts = {},
): Promise<number> {
  idp = await startFakeIdp(CLIENT_ID, idpOpts);
  handle = await buildApp(
    buildConfig(
      {
        oidc: {
          issuer: idp.issuer,
          clientId: "client",
          clientSecret: "secret",
          redirectUri: "http://127.0.0.1:1/monitor/callback", // overwritten per-request via host header below
          sessionSecret: "test-session-secret",
          ...oidcExtra,
        },
        ...opts.monitoring,
      },
      opts.extra,
    ),
    { db: new FakeDb({ main: [{ id: 1 }] }) },
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
  const stateCookie = getCookie(loginRes, "mcpgate_monitor_state");
  const authorize = new URL(loginRes.headers.get("location"));
  const state = authorize.searchParams.get("state");
  const nonce = authorize.searchParams.get("nonce");
  return fetch(`http://127.0.0.1:${port}/monitor/callback?code=nonce:${nonce}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: `mcpgate_monitor_state=${stateCookie}` },
  });
}

/** Completes the callback for a login redirect that was already fetched. */
async function loginAndCallbackFrom(port: number, loginRes: Response): Promise<Response> {
  const stateCookie = getCookie(loginRes, "mcpgate_monitor_state");
  const authorize = new URL(loginRes.headers.get("location"));
  return fetch(
    `http://127.0.0.1:${port}/monitor/callback?code=nonce:${authorize.searchParams.get("nonce")}&state=${authorize.searchParams.get("state")}`,
    { redirect: "manual", headers: { cookie: `mcpgate_monitor_state=${stateCookie}` } },
  );
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
    expect(location).toContain(`http://127.0.0.1:${idp.port}/authorize`);
    expect(getCookie(res, "mcpgate_monitor_state")).toBeDefined();
  });

  it("completes the callback, sets a session cookie, and authorizes the stream", async () => {
    const port = await start();

    const loginRes = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
    const stateCookie = getCookie(loginRes, "mcpgate_monitor_state");
    const authUrl = new URL(loginRes.headers.get("location"));
    const state = authUrl.searchParams.get("state");
    const nonce = authUrl.searchParams.get("nonce");
    const callbackRes = await fetch(
      `http://127.0.0.1:${port}/monitor/callback?code=nonce:${nonce}&state=${state}`,
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
    const stateCookie = getCookie(loginRes, "mcpgate_monitor_state");

    const res = await fetch(`http://127.0.0.1:${port}/monitor/callback?code=fake-code&state=wrong`, {
      headers: { cookie: `mcpgate_monitor_state=${stateCookie}` },
    });
    expect(res.status).toBe(400);
  });

  it("logout clears the session and re-locks the stream", async () => {
    const port = await start();
    const callbackRes = await loginAndCallback(port);
    const sessionCookie = getCookie(callbackRes, "mcpgate_monitor_session");

    const logoutRes = await fetch(`http://127.0.0.1:${port}/monitor/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: `mcpgate_monitor_session=${sessionCookie}` },
    });
    expect(logoutRes.status).toBe(303);
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

describe("Monitor OIDC requiredGroups", () => {
  it("refuses a login whose id_token lacks every required group", async () => {
    const port = await start(
      { requiredGroups: ["monitors"] },
      { groups: ["devs"] },
    );
    const res = await loginAndCallback(port);
    expect(res.status).toBe(403);
    expect(getCookie(res, "mcpgate_monitor_session")).toBeUndefined();
  });

  it("accepts a login that is a member of a required group", async () => {
    const port = await start(
      { requiredGroups: ["monitors"] },
      { groups: ["devs", "monitors"] },
    );
    const res = await loginAndCallback(port);
    expect(res.status).toBe(302);
    expect(getCookie(res, "mcpgate_monitor_session")).toBeDefined();
  });

  it("lets any authenticated user in when requiredGroups is empty (default)", async () => {
    const port = await start({}, { groups: ["devs"] });
    const res = await loginAndCallback(port);
    expect(res.status).toBe(302);
    expect(getCookie(res, "mcpgate_monitor_session")).toBeDefined();
  });
});

describe("Monitor OIDC transport security", () => {
  it("marks the state cookie Secure behind a TLS-terminating proxy", async () => {
    const port = await start(
      {},
      {},
      {
        extra: {
          server: {
            port: 3000,
            rateLimit: { enabled: false },
            trustProxy: true,
          },
        },
      },
    );
    const res = await fetch(`http://127.0.0.1:${port}/monitor/login`, {
      redirect: "manual",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("omits the Secure attribute on a plain-HTTP login", async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/monitor/login`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });
});

describe("Monitor playground under an OIDC session", () => {
  it("runs a tool through the governance pipeline with the session identity", async () => {
    const port = await start(
      {},
      {},
      { monitoring: { playground: { enabled: true } } },
    );
    const callbackRes = await loginAndCallback(port);
    const sessionCookie = getCookie(callbackRes, "mcpgate_monitor_session");
    expect(sessionCookie).toBeDefined();

    const res = await fetch(
      `http://127.0.0.1:${port}/monitor/tools/list_orders/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `mcpgate_monitor_session=${sessionCookie}`,
        },
        body: JSON.stringify({ args: {} }),
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("ignores a body identity that tries to grant itself scopes past a policy deny", async () => {
    const port = await start(
      {},
      {},
      {
        monitoring: { playground: { enabled: true } },
        extra: {
          policies: {
            defaultEffect: "allow",
            // Deny the tool for the session subject "alice" only — an
            // attacker who swaps in another subject via the body would slip
            // past this rule; the fix must keep the session subject.
            rules: [
              {
                effect: "deny",
                match: { tool: "list_orders", subjects: ["alice"] },
              },
            ],
          },
        },
      },
    );
    const callbackRes = await loginAndCallback(port);
    const sessionCookie = getCookie(callbackRes, "mcpgate_monitor_session");
    expect(sessionCookie).toBeDefined();

    const res = await fetch(
      `http://127.0.0.1:${port}/monitor/tools/list_orders/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `mcpgate_monitor_session=${sessionCookie}`,
        },
        body: JSON.stringify({
          args: {},
          identity: {
            subject: "operator-9000",
            scopes: ["admin:*", "tools:write"],
          },
        }),
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    // The deny rule matches the SESSION subject (alice), proving the body
    // identity was ignored rather than used to escape governance.
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Policy denied");
  });
});

const SCOPED_READ_TOOL = {
  name: "scoped_read",
  type: "database",
  access: "read",
  database: "main",
  query: "SELECT id FROM orders",
  requiredScopes: ["tools:read"],
  inputSchema: { type: "object", properties: {}, required: [] },
};

async function sessionCookieFor(port: number): Promise<string> {
  const callbackRes = await loginAndCallback(port);
  const sessionCookie = getCookie(callbackRes, "mcpgate_monitor_session");
  expect(sessionCookie).toBeDefined();
  return sessionCookie as string;
}

function runAs(
  port: number,
  cookie: string,
  tool: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/monitor/tools/${tool}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `mcpgate_monitor_session=${cookie}`,
    },
    body: JSON.stringify(body),
  });
}

describe("Monitor playground under an OIDC session · scopes", () => {
  const opts = {
    monitoring: { playground: { enabled: true } },
    extra: { tools: [READ_TOOL, SCOPED_READ_TOOL] },
  };

  it("does NOT synthesize tools:<access> for the session: only IdP-issued scopes count", async () => {
    const port = await start({}, {}, opts);
    const cookie = await sessionCookieFor(port);
    const data = await (await runAs(port, cookie, "scoped_read", { args: {} })).json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Missing required scope(s): tools:read");
  });

  it("a body identity cannot add the missing scope to an OIDC session", async () => {
    const port = await start({}, {}, opts);
    const cookie = await sessionCookieFor(port);
    const data = await (
      await runAs(port, cookie, "scoped_read", {
        args: {},
        identity: { scopes: ["tools:read"] },
      })
    ).json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Missing required scope(s)");
  });

  it("accepts the scope when the IdP issued it in the tools claim", async () => {
    const port = await start({}, { tools: ["tools:read"] }, opts);
    const cookie = await sessionCookieFor(port);
    const data = await (await runAs(port, cookie, "scoped_read", { args: {} })).json();
    expect(data.ok).toBe(true);
  });
});

describe("Monitor playground under an OIDC session · dry-run", () => {
  it("applies required scopes to a dry-run as well", async () => {
    const port = await start({}, {}, {
      monitoring: { playground: { enabled: true } },
      extra: { tools: [READ_TOOL, SCOPED_READ_TOOL] },
    });
    const cookie = await sessionCookieFor(port);
    const data = await (
      await runAs(port, cookie, "scoped_read", { args: {}, dryRun: true })
    ).json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Missing required scope(s)");
    expect(JSON.stringify(data)).not.toContain("SELECT");
  });

  it("applies a subject-specific policy deny to a dry-run", async () => {
    const port = await start({}, {}, {
      monitoring: { playground: { enabled: true } },
      extra: {
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "deny", match: { tool: "list_orders", subjects: ["alice"] } }],
        },
      },
    });
    const cookie = await sessionCookieFor(port);
    const data = await (
      await runAs(port, cookie, "list_orders", { args: {}, dryRun: true })
    ).json();
    expect(data.ok).toBe(false);
    expect(data.content[0].text).toContain("Policy denied");
  });

  it("allows a dry-run for a session that passes scopes and policy", async () => {
    const port = await start({}, {}, {
      monitoring: { playground: { enabled: true } },
    });
    const cookie = await sessionCookieFor(port);
    const data = await (
      await runAs(port, cookie, "list_orders", { args: {}, dryRun: true })
    ).json();
    expect(data.ok).toBe(true);
    expect(data.content[0].text).toContain("SELECT");
  });
});

describe("Monitor OIDC · PKCE, nonce and token checks (P1-G5)", () => {
  it("sends a PKCE S256 challenge and a nonce to the authorization endpoint", async () => {
    const port = await start();
    const loginRes = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
    const url = new URL(loginRes.headers.get("location"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("redeems the code with the verifier whose S256 hash was the challenge", async () => {
    tokenRequests.length = 0;
    const port = await start();
    const loginRes = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
    const challenge = new URL(loginRes.headers.get("location")).searchParams.get("code_challenge");
    const callbackRes = await loginAndCallbackFrom(port, loginRes);
    expect(callbackRes.status).toBe(302);
    const sent = tokenRequests.at(-1);
    expect(sent?.["code_verifier"]).toBeDefined();
    expect(createHash("sha256").update(sent?.["code_verifier"] ?? "").digest("base64url")).toBe(challenge);
  });

  it("every login attempt gets its own state, nonce and verifier", async () => {
    const port = await start();
    const params = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
      params.push(new URL(res.headers.get("location")).searchParams);
    }
    for (const key of ["state", "nonce", "code_challenge"]) {
      expect(params[0]?.get(key)).not.toBe(params[1]?.get(key));
    }
  });

  it("refuses an id_token that carries no nonce", async () => {
    const port = await start({}, { omitNonce: true });
    expect((await loginAndCallback(port)).status).toBe(401);
  });

  it("refuses an id_token whose nonce belongs to another login attempt", async () => {
    const port = await start({}, { forceNonce: "0".repeat(32) });
    const res = await loginAndCallback(port);
    expect(res.status).toBe(401);
    expect(getCookie(res, "mcpgate_monitor_session")).toBeUndefined();
  });

  it("refuses a token issued in the future (iat) or not yet valid (nbf)", async () => {
    const future = await start({}, { iatOffset: 600 });
    expect((await loginAndCallback(future)).status).toBe(401);
    // a fresh IdP / app for the second case
    await handle?.shutdown();
    server?.close();
    idp?.server.close();
    const notYet = await start({}, { nbfOffset: 600 });
    expect((await loginAndCallback(notYet)).status).toBe(401);
  });

  it("tolerates a little clock skew on iat", async () => {
    const port = await start({}, { iatOffset: 20 });
    expect((await loginAndCallback(port)).status).toBe(302);
  });

  it("with several audiences the authorized party must be this client (azp)", async () => {
    const bad = await start({}, { extraAudience: "other-app" });
    expect((await loginAndCallback(bad)).status).toBe(401);
    await handle?.shutdown();
    server?.close();
    idp?.server.close();
    const ok = await start({}, { extraAudience: "other-app", azp: CLIENT_ID });
    expect((await loginAndCallback(ok)).status).toBe(302);
  });

  it("refuses a discovery document that names a different issuer", async () => {
    const port = await start({}, { discoveryIssuer: "https://evil.example" });
    const res = await fetch(`http://127.0.0.1:${port}/monitor/login`, { redirect: "manual" });
    expect(res.status).toBe(502);
  });

  it("GET /monitor/logout no longer ends the session (405); POST does", async () => {
    const port = await start();
    const callbackRes = await loginAndCallback(port);
    const cookie = getCookie(callbackRes, "mcpgate_monitor_session");
    const get = await fetch(`http://127.0.0.1:${port}/monitor/logout`, {
      redirect: "manual",
      headers: { cookie: `mcpgate_monitor_session=${cookie}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(get.headers.get("set-cookie")).toBeNull();
  });
});
