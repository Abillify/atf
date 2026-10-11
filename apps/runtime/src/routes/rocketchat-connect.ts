// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import { Hono } from "hono";
import { SignJWT, createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { createDiscoveryClient } from "@atf/security-kit";
import type { Database } from "../db/database.js";
import type { AssistantRuntime } from "../assistants/assistant-runtime.js";
import type { RocketChatChannel } from "../assistants/rocketchat-channel.js";
import type { RocketChatDelegationBridge } from "../assistants/rocketchat-delegation.js";
import { isValidAssistantIdentifier } from "../assistants/types.js";
import { egressFetch } from "../security/egress.js";

export interface RocketChatConnectConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  /** Public origin that serves this route, e.g. https://aiperator.example. */
  publicUrl: string;
  defaultFlowId: string;
  scopes?: string;
  tenantId?: string;
  requestTtlSeconds?: number;
}
type Pending = { id: string; rocket_user_id: string; room_id: string; verified_email: string };
type Metadata = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
const COOKIE = "aiperator_rc_connect";
const COMPLETE_COOKIE = "aiperator_rc_connect_complete";
const CONNECT_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const b64 = (v: Uint8Array) => Buffer.from(v).toString("base64url");
const random = () => b64(crypto.randomBytes(32));
const email = (v: string) => v.trim().toLowerCase();
const assistantIdentifier = (value: string): string =>
  value
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
const readCookie = (header: string | undefined, name: string) =>
  header
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** Public, end-user OIDC connection flow. It deliberately has no operator role/session dependency. */
export function createRocketChatConnectRouter(params: {
  db: Database;
  channel: RocketChatChannel;
  runtime: AssistantRuntime;
  delegation: RocketChatDelegationBridge;
  config: RocketChatConnectConfig;
  /** Outbound fetch (default: process-wide Egress_Guard, SSRF-safe). */
  fetchFn?: typeof fetch;
  logger?: {
    warn(message: string, attributes?: Record<string, unknown>): void;
  };
}): Hono {
  const app = new Hono();
  const cfg = params.config;
  const fetchFn = params.fetchFn ?? egressFetch;
  // Request only the standard OIDC scopes plus the scopes configured by the
  // deployment. Application-specific permissions remain opaque to Aiperator:
  // the original access token is forwarded to MCP servers, which enforce them.
  const requestedScopes = new Set(
    (cfg.scopes ?? "openid profile email offline_access")
      .split(/\s+/)
      .filter(Boolean),
  );
  for (const required of ["openid", "profile", "email", "offline_access"]) {
    requestedScopes.add(required);
  }
  const authorizationScope = [...requestedScopes].join(" ");
  const key = new TextEncoder().encode(cfg.sessionSecret);
  // Shared Security_Kit discovery (Req 11.2): single-flight, cached, exact
  // issuer match and jwks_uri validation (Req 7.3) instead of a bespoke fetch.
  const discoveryClient = createDiscoveryClient(cfg.issuer, {
    fetchImpl: (url, init) =>
      fetchFn(url, {
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      }),
  });
  const metadata = async (): Promise<Metadata> => {
    const value = (await discoveryClient.getMetadata()) as Partial<Metadata>;
    if (
      !value.authorization_endpoint ||
      !value.token_endpoint ||
      !value.jwks_uri
    )
      throw new Error("OIDC discovery is incomplete");
    return value as Metadata;
  };
  // Req 7.1/7.2: the JWKS download must go through the same (guarded) fetch —
  // a bare createRemoteJWKSet would bypass the Egress_Guard.
  const jwksFor = (jwksUri: string): ReturnType<typeof createRemoteJWKSet> =>
    createRemoteJWKSet(new URL(jwksUri), {
      [customFetch]: (input, init) => fetchFn(input, init as RequestInit),
    });
  const pending = async (id: string): Promise<Pending | undefined> =>
    (
      await params.db.withOperator((db) =>
        db.query<Pending>(
          `SELECT id,rocket_user_id,room_id,verified_email FROM rocketchat_connect_requests WHERE id=$1::uuid AND consumed_at IS NULL AND expires_at>now()`,
          [id],
        ),
      )
    )[0];
  type PageTone = "form" | "error" | "warning" | "success";
  const page = (body: string, tone: PageTone = "error") => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Connect Rocket.Chat · Aiperator</title>
  <style>
    :root {
      color-scheme: light;
      --background: 0 0% 100%;
      --foreground: 222 47% 11%;
      --card: 0 0% 100%;
      --muted: 210 40% 96%;
      --muted-foreground: 215 20% 40%;
      --accent: 221 83% 53%;
      --accent-foreground: 210 40% 98%;
      --border: 214 32% 91%;
      --ring: 221 83% 53%;
      --success: 160 84% 32%;
      --success-surface: 152 81% 96%;
      --warning: 32 95% 35%;
      --warning-surface: 48 96% 95%;
      --error: 0 72% 45%;
      --error-surface: 0 86% 97%;
      --radius: .5rem;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html { min-width: 320px; background: hsl(var(--muted)); }
    body {
      min-height: 100vh;
      margin: 0;
      background: hsl(var(--muted));
      color: hsl(var(--foreground));
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .site-header {
      border-bottom: 1px solid hsl(var(--border));
      background: hsl(var(--card));
      box-shadow: 0 1px 2px rgb(15 23 42 / .04);
    }
    .header-inner, .page-shell {
      width: min(100%, 704px);
      margin-inline: auto;
      padding-inline: 24px;
    }
    .header-inner {
      display: flex;
      min-height: 60px;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: hsl(var(--foreground));
      font-size: 17px;
      font-weight: 650;
      letter-spacing: -.02em;
    }
    .brand-mark {
      display: grid;
      width: 30px;
      height: 30px;
      place-items: center;
      border-radius: 7px;
      background: hsl(var(--foreground));
      color: hsl(var(--card));
      font-size: 12px;
      font-weight: 750;
      letter-spacing: -.04em;
    }
    .product-label {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      font-weight: 500;
    }
    .page-shell { padding-block: 48px; }
    .card {
      overflow: hidden;
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      background: hsl(var(--card));
      box-shadow: 0 1px 3px rgb(15 23 42 / .07), 0 8px 24px rgb(15 23 42 / .04);
    }
    .card-header { padding: 28px 32px 24px; border-bottom: 1px solid hsl(var(--border)); }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 10px;
      color: hsl(var(--muted-foreground));
      font-size: 11px;
      font-weight: 650;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .eyebrow::before {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: hsl(var(--success));
      content: "";
    }
    h1 { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -.025em; line-height: 1.25; }
    .subtitle { max-width: 52ch; margin: 8px 0 0; color: hsl(var(--muted-foreground)); }
    .content { padding: 28px 32px 32px; }
    .content > p { margin: 0; }
    .tone-error > p, .tone-warning > p, .tone-success > p {
      position: relative;
      padding: 14px 16px 14px 46px;
      border: 1px solid;
      border-radius: calc(var(--radius) - 2px);
      font-weight: 500;
    }
    .tone-error > p::before, .tone-warning > p::before, .tone-success > p::before {
      position: absolute;
      top: 13px;
      left: 16px;
      display: grid;
      width: 20px;
      height: 20px;
      place-items: center;
      border: 1px solid currentColor;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 750;
      line-height: 1;
    }
    .tone-error > p { border-color: hsl(var(--error) / .25); background: hsl(var(--error-surface)); color: hsl(var(--error)); }
    .tone-error > p::before { content: "!"; }
    .tone-warning > p { border-color: hsl(var(--warning) / .3); background: hsl(var(--warning-surface)); color: hsl(var(--warning)); }
    .tone-warning > p::before { content: "!"; }
    .tone-success > p { border-color: hsl(var(--success) / .25); background: hsl(var(--success-surface)); color: hsl(var(--success)); }
    .tone-success > p::before { content: "✓"; }
    .identity {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
      padding: 12px 14px;
      border-radius: calc(var(--radius) - 2px);
      background: hsl(var(--muted));
    }
    .identity-label { color: hsl(var(--muted-foreground)); font-size: 12px; font-weight: 550; }
    .identity-value { min-width: 0; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    form { display: grid; gap: 20px; }
    .field { display: grid; gap: 7px; }
    .label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    label { font-size: 13px; font-weight: 600; }
    .optional { color: hsl(var(--muted-foreground)); font-size: 11px; font-weight: 450; }
    input, select {
      width: 100%;
      min-height: 42px;
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) - 2px);
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      font: inherit;
      padding: 9px 12px;
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    input::placeholder { color: hsl(var(--muted-foreground) / .75); }
    input:hover, select:hover { border-color: hsl(var(--muted-foreground) / .55); }
    input:focus-visible, select:focus-visible, button:focus-visible {
      outline: 2px solid hsl(var(--ring));
      outline-offset: 2px;
    }
    .help { margin: 0; color: hsl(var(--muted-foreground)); font-size: 12px; }
    .connection-note {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding-top: 4px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }
    .connection-note svg { flex: 0 0 auto; margin-top: 1px; }
    .actions { display: flex; justify-content: flex-end; padding-top: 4px; }
    button {
      display: inline-flex;
      min-height: 42px;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: calc(var(--radius) - 2px);
      background: hsl(var(--accent));
      color: hsl(var(--accent-foreground));
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      padding: 10px 20px;
      transition: opacity 150ms ease, transform 150ms ease;
    }
    button:hover { opacity: .9; }
    button:active { opacity: .82; transform: translateY(1px); }
    .card-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 32px;
      border-top: 1px solid hsl(var(--border));
      background: hsl(var(--muted) / .55);
      color: hsl(var(--muted-foreground));
      font-size: 11px;
    }
    .card-footer svg { flex: 0 0 auto; }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --background: 222 47% 11%;
        --foreground: 210 40% 98%;
        --card: 223 47% 13%;
        --muted: 217 33% 17%;
        --muted-foreground: 215 20% 65%;
        --accent: 224 76% 48%;
        --border: 217 33% 23%;
        --ring: 224 76% 58%;
        --success: 158 64% 52%;
        --success-surface: 160 84% 8%;
        --warning: 43 96% 64%;
        --warning-surface: 32 81% 9%;
        --error: 0 91% 71%;
        --error-surface: 0 63% 10%;
      }
      .brand-mark { background: hsl(var(--foreground)); color: hsl(var(--background)); }
      .card { box-shadow: 0 1px 3px rgb(0 0 0 / .25), 0 10px 28px rgb(0 0 0 / .18); }
    }
    @media (max-width: 639px) {
      .header-inner, .page-shell { padding-inline: 16px; }
      .header-inner { min-height: 56px; }
      .product-label { display: none; }
      .page-shell { padding-block: 24px; }
      .card-header, .content { padding: 22px 20px; }
      .card-footer { padding-inline: 20px; }
      h1 { font-size: 21px; }
      .identity { align-items: flex-start; flex-direction: column; gap: 2px; }
      .identity-value { max-width: 100%; }
      .actions button { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <div class="brand"><span class="brand-mark" aria-hidden="true">AI</span><span>Aiperator</span></div>
      <span class="product-label">Secure assistant connection</span>
    </div>
  </header>
  <main class="page-shell">
    <section class="card" aria-labelledby="page-title">
      <div class="card-header">
        <div class="eyebrow">Verified connection</div>
        <h1 id="page-title">Connect Rocket.Chat</h1>
        <p class="subtitle">Choose the assistant that should respond in this conversation.</p>
      </div>
      <div class="content tone-${tone}"${tone === "error" ? ' role="alert"' : tone === "success" ? ' role="status"' : ""}>${body}</div>
      <footer class="card-footer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Your verified identity is used only to authorize this connection.
      </footer>
    </section>
  </main>
</body>
</html>`;

  app.get("/connect/rocketchat/:requestId{[0-9a-fA-F-]+}", async (ctx) => {
    const requestId = ctx.req.param("requestId");
    if (!CONNECT_REQUEST_ID.test(requestId)) {
      return ctx.html(page("<p>This connect link is invalid.</p>"), 400);
    }
    const request = await pending(requestId);
    if (!request)
      return ctx.html(
        page("<p>This connect link has expired or was already used.</p>"),
        410,
      );
    const state = random(),
      nonce = random(),
      verifier = random();
    const challenge = b64(
      crypto.createHash("sha256").update(verifier).digest(),
    );
    const flow = await new SignJWT({
      requestId: request.id,
      state,
      nonce,
      verifier,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .sign(key);
    ctx.header("Set-Cookie", cookie(COOKIE, flow, 600));
    const meta = await metadata();
    const redirect = `${cfg.publicUrl.replace(/\/$/, "")}/connect/rocketchat/callback`;
    return ctx.redirect(
      `${meta.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: redirect, scope: authorizationScope, prompt: "consent", state, nonce, code_challenge: challenge, code_challenge_method: "S256" })}`,
    );
  });

  app.get("/connect/rocketchat/callback", async (ctx) => {
    const packed = readCookie(ctx.req.header("Cookie"), COOKIE);
    ctx.header("Set-Cookie", cookie(COOKIE, "", 0));
    if (!packed)
      return ctx.html(
        page(
          "<p>Login session expired. Return to Rocket.Chat and use a new link.</p>",
        ),
        400,
      );
    let flow: {
      requestId: string;
      state: string;
      nonce: string;
      verifier: string;
    };
    try {
      flow = (await jwtVerify(decodeURIComponent(packed), key))
        .payload as unknown as typeof flow;
    } catch {
      return ctx.html(page("<p>Login session expired.</p>"), 400);
    }
    if (ctx.req.query("state") !== flow.state || !ctx.req.query("code"))
      return ctx.html(page("<p>Login could not be verified.</p>"), 400);
    const request = await pending(flow.requestId);
    if (!request)
      return ctx.html(page("<p>This connect link has expired.</p>"), 410);
    try {
      const meta = await metadata();
      const redirect = `${cfg.publicUrl.replace(/\/$/, "")}/connect/rocketchat/callback`;
      const tokens = await fetchFn(meta.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: ctx.req.query("code") as string,
          redirect_uri: redirect,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code_verifier: flow.verifier,
        }),
      });
      const token = (await tokens.json()) as {
        id_token?: string;
        refresh_token?: string;
        scope?: string;
      };
      if (!tokens.ok || !token.id_token)
        throw new Error("token exchange failed");
      const claims = (
        await jwtVerify(token.id_token, jwksFor(meta.jwks_uri), {
          issuer: cfg.issuer,
          audience: cfg.clientId,
        })
      ).payload;
      if (
        claims.nonce !== flow.nonce ||
        claims.email_verified !== true ||
        typeof claims.email !== "string" ||
        email(claims.email) !== email(request.verified_email) ||
        typeof claims.sub !== "string"
      )
        throw new Error("email verification failed");
      if (
        typeof token.refresh_token !== "string" ||
        token.refresh_token.trim().length === 0
      ) {
        return ctx.html(
          page(
            "<p>The identity provider did not grant durable access. Please allow offline access and open a new connection link.</p>",
          ),
          403,
        );
      }
      await params.delegation.stage({
        requestId: request.id,
        subject: claims.sub,
        refreshToken: token.refresh_token,
        consentedScope:
          typeof token.scope === "string" && token.scope.trim().length > 0
            ? token.scope
            : authorizationScope,
      });
      const assistants = await params.runtime.stores.assistants.listForUser(
        cfg.tenantId ?? "_",
        claims.sub,
      );
      const options = assistants
        .filter((a) => a.status === "active")
        .map(
          (a) =>
            `<option value="${escapeHtml(a.scope.assistantId)}">${escapeHtml(a.displayName)}</option>`,
        )
        .join("");
      const complete = await new SignJWT({
        requestId: request.id,
        sub: claims.sub,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("10m")
        .sign(key);
      ctx.header("Set-Cookie", cookie(COMPLETE_COOKIE, complete, 600));
      return ctx.html(
        page(
          `<div class="identity"><span class="identity-label">Signed in as</span><strong class="identity-value">${escapeHtml(claims.email)}</strong></div>
<form method="post" action="/connect/rocketchat/complete">
  <input type="hidden" name="requestId" value="${request.id}">
  <input type="hidden" name="flowId" value="${escapeHtml(cfg.defaultFlowId)}">
  <div class="field">
    <div class="label-row"><label for="assistantId">Assistant</label><span class="optional">Required</span></div>
    <select id="assistantId" name="assistantId" aria-describedby="assistant-help" required>${options}<option value="new">Create a new assistant</option></select>
    <p class="help" id="assistant-help">Select an existing assistant or create one specifically for this conversation.</p>
  </div>
  <div class="field">
    <div class="label-row"><label for="newAssistantName">New assistant name</label><span class="optional">Only when creating</span></div>
    <input id="newAssistantName" name="newAssistantName" maxlength="64" placeholder="e.g. Research assistant" aria-describedby="name-help" autocomplete="off">
    <p class="help" id="name-help">Spaces and capitalization are converted to a safe internal identifier.</p>
  </div>
  <div class="connection-note">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>
    <span>This assistant will be bound only to the Rocket.Chat conversation that opened this link.</span>
  </div>
  <div class="actions"><button type="submit">Connect assistant</button></div>
</form>`,
          "form",
        ),
      );
    } catch {
      return ctx.html(
        page(
          "<p>Login failed. Your verified identity did not match the Rocket.Chat account.</p>",
        ),
        403,
      );
    }
  });

  app.post("/connect/rocketchat/complete", async (ctx) => {
    const form = await ctx.req.formData();
    const requestId = String(form.get("requestId") ?? "");
    const packed = readCookie(ctx.req.header("Cookie"), COMPLETE_COOKIE);
    if (packed === undefined) {
      return ctx.html(
        page(
          "<p>Your connection session has expired. Return to Rocket.Chat and use a new link.</p>",
        ),
        400,
      );
    }
    let sub: string;
    try {
      const verified = await jwtVerify(decodeURIComponent(packed), key);
      if (
        typeof verified.payload.sub !== "string" ||
        verified.payload.sub.length === 0 ||
        verified.payload.requestId !== requestId
      ) {
        return ctx.html(
          page("<p>The connection session does not match this request.</p>"),
          400,
        );
      }
      sub = verified.payload.sub;
    } catch {
      return ctx.html(
        page(
          "<p>Your connection session has expired. Return to Rocket.Chat and use a new link.</p>",
        ),
        400,
      );
    }
    // The callback signs the OIDC subject into an HttpOnly completion cookie; browser form fields are never trusted for ownership.
    const selectedAssistantId = String(form.get("assistantId") ?? "");
    const createNew = selectedAssistantId === "new";
    const newAssistantName = String(
      form.get("newAssistantName") ?? form.get("newAssistantId") ?? "",
    ).trim();
    const assistantId = createNew
      ? assistantIdentifier(newAssistantName)
      : selectedAssistantId;
    if (!isValidAssistantIdentifier(assistantId)) {
      return ctx.html(
        page(
          createNew
            ? "<p>Enter a valid name for the new assistant.</p>"
            : "<p>The selected assistant is invalid.</p>",
        ),
        400,
      );
    }
    const flowId = String(form.get("flowId") ?? cfg.defaultFlowId).trim();
    if (flowId.length === 0) {
      return ctx.html(page("<p>Select a non-empty flow.</p>"), 400);
    }
    const request = await pending(requestId);
    if (!request) {
      ctx.header("Set-Cookie", cookie(COMPLETE_COOKIE, "", 0));
      return ctx.html(page("<p>This connect link has expired.</p>"), 410);
    }
    const scope = { tenantId: cfg.tenantId ?? "_", userId: sub, assistantId };
    await params.runtime.stores.assistants.ensure({
      scope,
      displayName: createNew ? newAssistantName : assistantId,
    });
    try {
      await params.delegation.consumeAndActivate({
        requestId,
        subject: sub,
        scope,
        serverUrl: params.channel.bindings.serverUrl,
        flowId,
      });
    } catch (error) {
      params.logger?.warn("Rocket.Chat delegated access activation failed", {
        requestId,
        tenantId: scope.tenantId,
        assistantId: scope.assistantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return ctx.html(
        page(
          "<p>Delegated access could not be activated. Return to Rocket.Chat and authorize a new connection link.</p>",
        ),
        409,
      );
    }
    ctx.header("Set-Cookie", cookie(COMPLETE_COOKIE, "", 0));
    return ctx.html(
      page("<p>Connected. You can return to Rocket.Chat.</p>", "success"),
    );
  });
  return app;
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
