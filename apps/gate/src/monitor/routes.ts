// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { timingSafeEqual, createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router, type Request, type Response } from "express";
import type { MonitoringConfig } from "../config/schema.ts";
import type { MonitorBus, MonitorEvent } from "./events.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { AuthContext } from "../auth/context.ts";
import { normalizeHeaders } from "../auth/context.ts";
import { logger } from "../logger.ts";
import { verifyIdToken } from "./oidc-verify.ts";
import { McpToolDispatcher, type McpServerDeps } from "../mcp/server.ts";

type OidcConfig = NonNullable<MonitoringConfig["oidc"]>;

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MonitorDeps {
  bus: MonitorBus;
  config: MonitoringConfig;
  registry?: ToolRegistry;
  instructions?: () => string | undefined;
  /**
   * Governance wiring for the Tool Playground (everything the MCP dispatch
   * pipeline needs beyond registry/bus/instructions). When present, a
   * playground run goes through `McpToolDispatcher` — the same policy,
   * approval, scope, argument-validation, identity-rate-limit, transaction
   * and audit pipeline a real MCP `tools/call` is subject to. When absent,
   * the playground refuses to execute (fail closed) rather than running
   * tools out-of-band.
   */
  dispatcherDeps?: Omit<McpServerDeps, "registry" | "bus" | "instructions">;
}

// ---------------------------------------------------------------------------
// Token authorisation — constant-time comparison, Authorization header only
// ---------------------------------------------------------------------------

/**
 * Constant-time bearer token comparison.
 * The token is accepted only via the Authorization header — never as a
 * `?token=` query parameter, which would land in access logs, proxy logs and
 * browser history. The dashboard exchanges it once for an HttpOnly session
 * cookie (`POST /monitor/session`), which EventSource sends on its own.
 */
function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Run a dummy comparison to consume constant time even when lengths differ.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function bearerMatches(req: Request, token: string): boolean {
  const presented = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
  return presented !== undefined && safeTokenEqual(presented, token);
}

/**
 * Who got past the monitor's door. `token` is the static operator token (or a
 * dashboard session established with it) — an operator sees every event.
 * `oidc` is a session from the identity provider, which carries a tenant the
 * stream filters on. `open` means neither was configured, so the monitor is
 * unprotected and behaves like `token`.
 */
export type MonitorViewer =
  | { kind: "open" }
  | { kind: "token" }
  | { kind: "oidc"; tenantId: string };

function authorizeViewer(req: Request, config: MonitoringConfig): MonitorViewer | undefined {
  if (!config.token && !config.oidc) return { kind: "open" };

  if (config.token) {
    if (bearerMatches(req, config.token)) return { kind: "token" };
    if (readTokenSessionCookie(req, config.token)) return { kind: "token" };
  }

  if (config.oidc) {
    const session = readSessionCookie(req, config.oidc);
    if (session) return { kind: "oidc", tenantId: session.tenantId };
  }

  return undefined;
}

function authorize(req: Request, config: MonitoringConfig): boolean {
  return authorizeViewer(req, config) !== undefined;
}

/**
 * Whether a viewer may see one event. Operators (token/open) and `all` scope
 * see everything; an OIDC session sees only its own tenant's events, and
 * never an event that carries no tenant at all.
 */
function eventVisibleTo(viewer: MonitorViewer, config: MonitoringConfig, event: MonitorEvent): boolean {
  if (viewer.kind !== "oidc" || config.tenantScope === "all") return true;
  return event.tenantId === viewer.tenantId;
}

/**
 * SHA-256 hex over the JSON form of a value plus its UTF-8 length, used in
 * place of the tool result itself when `includeToolContent` is off.
 */
function contentDigest(content: unknown): { sha256: string; bytes: number } {
  const json = JSON.stringify(content) ?? "null";
  return {
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
    bytes: Buffer.byteLength(json, "utf8"),
  };
}

/**
 * Strip the tool result from an event unless the operator opted in, leaving a
 * digest so the dashboard can still show that and how much came back.
 */
function shapeForViewer(event: MonitorEvent, config: MonitoringConfig): MonitorEvent {
  if (config.includeToolContent || event.meta?.content === undefined) return event;
  const { content, ...rest } = event.meta;
  return { ...event, meta: { ...rest, contentDigest: contentDigest(content) } };
}

// ---------------------------------------------------------------------------
// OIDC login — authorization-code flow against an external provider (e.g.
// Authentik). Session/state are kept in signed, HttpOnly cookies rather than
// server-side storage so the monitor stays stateless across restarts/replicas.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "mcpgate_monitor_session";
const STATE_COOKIE = "mcpgate_monitor_state";
/** Dashboard session established with the static monitoring token. */
const TOKEN_SESSION_COOKIE = "mcpgate_monitor_token_session";
const TOKEN_SESSION_MAX_AGE_S = 8 * 60 * 60;

/**
 * Key for the token-session cookie, derived from the monitoring token itself:
 * rotating the token invalidates every dashboard session issued under it.
 */
function tokenSessionSecret(token: string): string {
  return createHmac("sha256", token).update("mcpgate-monitor-token-session/v1").digest("hex");
}

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** A provider that does not answer must not hold a login request open. */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** A discovery document is trusted for an hour, then fetched again (key/endpoint moves). */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { doc: DiscoveryDoc; fetchedAt: number }>();
async function discover(issuer: string): Promise<DiscoveryDoc> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.doc;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OIDC discovery request to ${url} failed: ${res.status}`);
  const doc = (await res.json()) as DiscoveryDoc & { issuer?: unknown };
  // OIDC Discovery 4.3: the document's `issuer` must equal the issuer it was
  // fetched for, or a different provider could answer for this one.
  if (
    typeof doc.issuer === "string" &&
    doc.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")
  ) {
    throw new Error(`OIDC discovery issuer mismatch: expected ${issuer}, got ${doc.issuer}`);
  }
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[field] !== "string" || doc[field].length === 0) {
      throw new Error(`OIDC discovery document has no ${field}`);
    }
  }
  discoveryCache.set(issuer, { doc, fetchedAt: Date.now() });
  return doc;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function signCookie(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

function verifyCookie<T>(value: string | undefined, secret: string): T | undefined {
  if (!value) return undefined;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return undefined;
  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!safeTokenEqual(mac, sign(body, secret))) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return undefined;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

interface MonitorSession {
  sub: string;
  username: string;
  scopes: string[];
  tenantId: string;
  exp: number;
}

function claimStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function readSessionCookie(req: Request, oidc: OidcConfig): MonitorSession | undefined {
  const cookies = parseCookies(req);
  const session = verifyCookie<Partial<MonitorSession>>(
    cookies[SESSION_COOKIE],
    oidc.sessionSecret,
  );
  if (
    !session ||
    typeof session.sub !== "string" ||
    typeof session.exp !== "number" ||
    session.exp <= Date.now() / 1000
  ) {
    return undefined;
  }
  return {
    sub: session.sub,
    username: typeof session.username === "string" ? session.username : session.sub,
    scopes: Array.isArray(session.scopes) ? session.scopes.map(String) : [],
    tenantId: typeof session.tenantId === "string" ? session.tenantId : "default",
    exp: session.exp,
  };
}

function readTokenSessionCookie(req: Request, token: string): boolean {
  const session = verifyCookie<{ exp?: unknown }>(
    parseCookies(req)[TOKEN_SESSION_COOKIE],
    tokenSessionSecret(token),
  );
  return typeof session?.exp === "number" && session.exp > Date.now() / 1000;
}

function secureAttr(req: Request): string {
  return req.secure || req.headers["x-forwarded-proto"] === "https" ? " Secure;" : "";
}

/**
 * Content-Security-Policy for the dashboard page. Scripts run only with the
 * per-response nonce (the page has no inline event handlers), nothing may
 * frame it, and every request stays on this origin. Inline `style`
 * attributes remain allowed: they cannot execute code.
 */
function dashboardCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 *   GET  /                        monitoring dashboard HTML
 *   GET  /monitor/login           start the OIDC authorization-code flow
 *   GET  /monitor/callback        OIDC redirect target; sets the session cookie
 *   GET  /monitor/logout          clears the session cookie
 *   GET  /monitor/stream          SSE feed of MonitorEvents
 *   GET  /monitor/instructions    current rendered MCP instructions
 *   GET  /monitor/tools           all tool definitions + metadata
 *   POST /monitor/tools/:name/run execute a tool (Tool Playground)
 */
export function createMonitorRouter(deps: MonitorDeps): Router {
  const { bus, config } = deps;
  const router = Router();
  const rawHtml = readFileSync(join(__dirname, "ui.html"), "utf8");
  const html = rawHtml.replace("__MCPGATE_OIDC_ENABLED__", config.oidc ? "true" : "false");

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get("/", (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).send("Monitoring is disabled"); return; }
    // When only OIDC is configured (no token), bounce unauthenticated browsers
    // straight into the login flow instead of showing a dashboard that 401s.
    if (config.oidc && !config.token && !readSessionCookie(req, config.oidc)) {
      res.redirect("/monitor/login");
      return;
    }
    const nonce = randomBytes(16).toString("base64url");
    res.setHeader("Content-Security-Policy", dashboardCsp(nonce));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html.replaceAll("<script>", `<script nonce="${nonce}">`));
  });

  // ── Token session (static monitoring token) ───────────────────────────────
  //
  // The dashboard presents the token ONCE in the Authorization header and gets
  // an HttpOnly, SameSite=Strict cookie back; the token never has to be kept
  // in browser storage or put into a URL.

  router.post("/monitor/session", (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).json({ error: "Monitoring is disabled" }); return; }
    if (!config.token) { res.status(404).json({ error: "No monitoring token is configured" }); return; }
    if (!bearerMatches(req, config.token)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const exp = Math.floor(Date.now() / 1000) + TOKEN_SESSION_MAX_AGE_S;
    const cookie = signCookie({ exp }, tokenSessionSecret(config.token));
    res.setHeader(
      "Set-Cookie",
      `${TOKEN_SESSION_COOKIE}=${cookie}; Path=/;${secureAttr(req)} HttpOnly; SameSite=Strict; Max-Age=${TOKEN_SESSION_MAX_AGE_S}`,
    );
    res.status(204).end();
  });

  // ── OIDC login / callback / logout ────────────────────────────────────────

  router.get("/monitor/login", async (req: Request, res: Response) => {
    if (!config.enabled) {
      res.status(404).send("Monitoring is disabled");
      return;
    }
    if (!config.oidc) {
      res.status(404).send("OIDC is not configured");
      return;
    }
    const oidc = config.oidc;

    try {
      const state = randomBytes(16).toString("hex");
      // PKCE (RFC 7636, S256): the verifier never leaves this service except in
      // the token request, so an authorization code intercepted on the redirect
      // is useless. `nonce` binds the ID token to this login attempt. Both ride
      // in the signed, HttpOnly state cookie.
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const nonce = randomBytes(16).toString("hex");
      const stateExp = Math.floor(Date.now() / 1000) + 300;
      const stateCookie = signCookie(
        { state, nonce, cv: codeVerifier, exp: stateExp },
        oidc.sessionSecret,
      );
      res.setHeader(
        "Set-Cookie",
        `${STATE_COOKIE}=${stateCookie}; Path=/;${secureAttr(req)} HttpOnly; SameSite=Lax; Max-Age=300`,
      );

      const doc = await discover(oidc.issuer);
      const params = new URLSearchParams({
        response_type: "code",
        client_id: oidc.clientId,
        redirect_uri: oidc.redirectUri,
        scope: oidc.scopes.join(" "),
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      res.redirect(`${doc.authorization_endpoint}?${params}`);
    } catch (err) {
      logger.error("monitor OIDC login failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      res
        .status(502)
        .send("Failed to start OIDC login (provider unreachable?)");
    }
  });

  router.get("/monitor/callback", async (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).send("Monitoring is disabled"); return; }
    if (!config.oidc) { res.status(404).send("OIDC is not configured"); return; }
    const oidc = config.oidc;

    const cookies = parseCookies(req);
    const statePayload = verifyCookie<{ state: string; nonce?: string; cv?: string; exp: number }>(
      cookies[STATE_COOKIE],
      oidc.sessionSecret,
    );
    res.setHeader("Set-Cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);

    const queryState = typeof req.query.state === "string" ? req.query.state : undefined;
    if (
      !statePayload ||
      statePayload.exp <= Date.now() / 1000 ||
      !queryState ||
      !safeTokenEqual(queryState, statePayload.state)
    ) {
      res.status(400).send("Invalid or expired login attempt — please try again.");
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    if (!code) { res.status(400).send("Missing authorization code"); return; }

    try {
      const doc = await discover(oidc.issuer);
      const tokenRes = await fetch(doc.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: oidc.redirectUri,
          client_id: oidc.clientId,
          client_secret: oidc.clientSecret,
          ...(statePayload.cv ? { code_verifier: statePayload.cv } : {}),
        }),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!tokenRes.ok) {
        logger.error("monitor OIDC token exchange failed", { status: tokenRes.status });
        res.status(502).send("OIDC token exchange failed");
        return;
      }
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) {
        logger.error("monitor OIDC token response had no id_token");
        res.status(502).send("OIDC provider did not return an id_token");
        return;
      }

      let session: Omit<MonitorSession, "exp">;
      try {
        const verified = await verifyIdToken(tokens.id_token, {
          issuer: oidc.issuer,
          clientId: oidc.clientId,
          jwksUri: doc.jwks_uri,
          ...(statePayload.nonce ? { nonce: statePayload.nonce } : {}),
        });
        const usernameClaim =
          verified.claims.email ?? verified.claims.preferred_username;
        // Group gate: when requiredGroups is configured, only members of at
        // least one listed group get a session — authenticating at the IdP
        // alone must not be enough for a dashboard that shows tool arguments.
        if (oidc.requiredGroups.length > 0) {
          const groups = new Set(claimStrings(verified.claims.groups));
          if (!oidc.requiredGroups.some((group) => groups.has(group))) {
            logger.warn(
              "monitor OIDC login refused: no required group membership",
              {
                sub: verified.sub,
                required: oidc.requiredGroups,
              },
            );
            bus.publish({
              type: "auth_failure",
              sessionId: "monitor",
              message: `OIDC subject lacks any required monitor group (${oidc.requiredGroups.join(", ")})`,
              authMethod: "oidc",
            });
            res
              .status(403)
              .send(
                "You are not a member of a group allowed to access the monitor.",
              );
            return;
          }
        }
        session = {
          sub: verified.sub,
          username:
            typeof usernameClaim === "string" ? usernameClaim : verified.sub,
          scopes: [...new Set(claimStrings(verified.claims.tools))],
          tenantId:
            typeof verified.claims.tenant_id === "string" &&
            verified.claims.tenant_id.length > 0
              ? verified.claims.tenant_id
              : "default",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("monitor OIDC id_token verification failed", { message });
        bus.publish({ type: "auth_failure", sessionId: "monitor", message, authMethod: "oidc" });
        res.status(401).send("ID token verification failed");
        return;
      }

      const exp = Math.floor(Date.now() / 1000) + oidc.sessionMaxAge;
      const sessionCookie = signCookie({ ...session, exp }, oidc.sessionSecret);
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? " Secure;" : "";
      res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${sessionCookie}; Path=/;${secure} HttpOnly; SameSite=Lax; Max-Age=${oidc.sessionMaxAge}`,
      );
      bus.publish({
        type: "auth",
        sessionId: "monitor",
        username: session.username,
        subject: session.sub,
        authMethod: "oidc",
      });
      res.redirect("/");
    } catch (err) {
      logger.error("monitor OIDC callback failed", { message: err instanceof Error ? err.message : String(err) });
      res.status(502).send("Failed to complete OIDC login (provider unreachable?)");
    }
  });

  // Ending a session changes state, so it is a POST: a GET can be triggered by
  // any page that embeds an <img src="/monitor/logout"> (cross-site logout).
  // The cookies are SameSite, which also keeps a cross-site POST from carrying
  // the session — the form in the dashboard is same-origin.
  router.post("/monitor/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", [
      `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
      `${TOKEN_SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
    ]);
    res.redirect(303, "/");
  });
  router.get("/monitor/logout", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).send("Use POST /monitor/logout");
  });

  // ── SSE event stream ──────────────────────────────────────────────────────

  router.get("/monitor/stream", (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).json({ error: "Monitoring is disabled" }); return; }
    const viewer = authorizeViewer(req, config);
    if (!viewer) { res.status(401).json({ error: "Unauthorized" }); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const send = (event: MonitorEvent) => {
      if (!eventVisibleTo(viewer, config, event)) return;
      res.write(`data: ${JSON.stringify(shapeForViewer(event, config))}\n\n`);
    };

    for (const event of bus.recent()) send(event);
    const unsubscribe = bus.subscribe(send);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ── Instructions ──────────────────────────────────────────────────────────

  router.get("/monitor/instructions", (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).json({ error: "Monitoring is disabled" }); return; }
    if (!authorize(req, config)) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.json({ text: deps.instructions?.() ?? null, cachedAt: new Date().toISOString() });
  });

  // ── Tool Playground ───────────────────────────────────────────────────────

  router.get("/monitor/tools", (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).json({ error: "Monitoring is disabled" }); return; }
    if (!authorize(req, config)) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!deps.registry) { res.json([]); return; }
    const tools = deps.registry.realDefinitions().map((def) => ({
      ...def,
      type: deps.registry!.typeOf(def.name),
      access: deps.registry!.accessOf(def.name),
      expose: deps.registry!.isExposed(def.name),
    }));
    res.json(tools);
  });

  router.post(
    "/monitor/tools/:name/run",
    express.json({ limit: "1mb" }),
    async (req: Request, res: Response) => {
      if (!config.enabled) {
        res.status(404).json({ error: "Monitoring is disabled" });
        return;
      }
      if (!authorize(req, config)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!deps.registry) {
        res.status(503).json({ error: "Registry not available" });
        return;
      }

      // The playground executes tools out-of-band from a normal MCP session, so
      // it is opt-in and must be protected by a token or OIDC login (fail closed).
      if (!config.playground.enabled) {
        res
          .status(403)
          .json({
            error:
              "Tool Playground is disabled (set monitoring.playground.enabled)",
          });
        return;
      }
      if (!config.token && !config.oidc) {
        res
          .status(403)
          .json({
            error:
              "Tool Playground requires monitoring.token or monitoring.oidc to be set",
          });
        return;
      }

      const { name } = req.params as { name: string };
      const args = (req.body?.args ?? {}) as Record<string, unknown>;
      const dryRun = req.body?.dryRun === true;
      const executor = deps.registry.getReal(name);
      if (!executor) {
        res.status(404).json({ error: `Tool not found: ${name}` });
        return;
      }

      // Write-access tools mutate data; require an explicit opt-in to run them
      // from the dashboard. A dry-run never executes, so it is always allowed.
      if (
        !dryRun &&
        deps.registry.accessOf(name) === "write" &&
        !config.playground.allowWrite
      ) {
        res.status(403).json({
          error: `Tool '${name}' has access: write; enable monitoring.playground.allowWrite to run it`,
        });
        return;
      }

      // A verified OIDC session is the ONLY identity source in that case: the
      // request body must never add scopes, claims or a subject on top of a
      // login, or every authenticated user could self-grant any scope. The
      // body `identity` object is a convenience for the static-token case
      // only, where the token itself is the root operator credential.
      const oidcSession = config.oidc
        ? readSessionCookie(req, config.oidc)
        : undefined;
      const identity = (oidcSession ? {} : (req.body?.identity ?? {})) as {
        username?: unknown;
        subject?: unknown;
        scopes?: unknown;
        claims?: unknown;
        headers?: unknown;
      };
      const sessionClaims: Record<string, unknown> | undefined = oidcSession
        ? { tools: oidcSession.scopes, tenant_id: oidcSession.tenantId }
        : undefined;
      const ctx: AuthContext = {
        method: oidcSession ? "oauth" : "static",
        subject:
          oidcSession?.sub ??
          (typeof identity.subject === "string"
            ? identity.subject
            : "playground"),
        username:
          oidcSession?.username ??
          (typeof identity.username === "string"
            ? identity.username
            : "playground"),
        // The `tools:<access>` convenience scope is synthesized for the
        // static-token operator only. A verified OIDC session carries exactly
        // the scopes the IdP issued; granting `tools:write` on top would let
        // every logged-in user satisfy a tool that requires it.
        scopes: oidcSession
          ? [...new Set(oidcSession.scopes)]
          : [
              ...new Set([
                `tools:${deps.registry.accessOf(name) ?? "read"}`,
                ...(Array.isArray(identity.scopes)
                  ? identity.scopes.map(String)
                  : []),
              ]),
            ],
        claims:
          sessionClaims ??
          (identity.claims && typeof identity.claims === "object"
            ? (identity.claims as Record<string, unknown>)
            : {}),
        tenantId: oidcSession?.tenantId ?? "default",
        headers:
          identity.headers && typeof identity.headers === "object"
            ? normalizeHeaders(identity.headers as Record<string, unknown>)
            : {},
        rawToken: "",
      };

      // Everything below runs through the governance pipeline. Without the
      // wiring the playground refuses (fail closed) rather than bypassing
      // policy, scopes and audit, for dry-runs as well as real runs.
      if (!deps.dispatcherDeps) {
        res
          .status(503)
          .json({ error: "Tool Playground governance wiring is unavailable" });
        return;
      }
      const playgroundSessionId = `playground-${randomBytes(8).toString("hex")}`;
      const dispatcher = new McpToolDispatcher(ctx, playgroundSessionId, {
        ...deps.dispatcherDeps,
        registry: deps.registry,
        bus,
        ...(deps.instructions !== undefined
          ? { instructions: deps.instructions }
          : {}),
      });

      // A dry-run never executes (planner/explain only) and is therefore not
      // dispatched, but it renders the tool's internals (SQL, bindings, URL,
      // body), so it is subject to the same required scopes and policy deny.
      if (dryRun) {
        const refusal = dispatcher.authorizeExplain(name, args);
        if (refusal) {
          bus.publish({
            type: "error",
            sessionId: playgroundSessionId,
            username: ctx.username,
            tool: name,
            status: "error",
            message:
              refusal.content[0]?.type === "text"
                ? refusal.content[0].text
                : "Dry-run refused",
          });
          res.json({
            ok: false,
            durationMs: 0,
            content: refusal.content,
            ...(refusal.structuredContent !== undefined
              ? { structuredContent: refusal.structuredContent }
              : {}),
          });
          return;
        }
        const started = Date.now();
        bus.publish({
          type: "tool_call",
          sessionId: playgroundSessionId,
          username: ctx.username,
          subject: ctx.subject,
          authMethod: ctx.method,
          tool: name,
          meta: { arguments: args, dryRun: true },
        });
        const result = (await executor.explain?.(args, ctx)) ?? {
          content: [
            {
              type: "text" as const,
              text: `Dry-run is not supported for tool type '${deps.registry.typeOf(name)}'.`,
            },
          ],
          isError: true,
        };
        const durationMs = Date.now() - started;
        bus.publish({
          type: "tool_result",
          sessionId: playgroundSessionId,
          username: ctx.username,
          tool: name,
          status: result.isError ? "error" : "ok",
          durationMs,
          meta: result.meta,
        });
        res.json({
          ok: !result.isError,
          durationMs,
          content: result.content,
          meta: result.meta,
        });
        return;
      }

      // Real execution goes through the SAME dispatch pipeline as an MCP
      // tools/call — policy evaluation, approval tokens, required scopes,
      // argument validation, per-identity rate limiting, transaction fabric
      // and audit events with the real caller identity.
      const started = Date.now();
      try {
        const result = await dispatcher.callTool({ name, arguments: args });
        const durationMs = Date.now() - started;
        res.json({
          ok: !result.isError,
          durationMs,
          content: result.content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - started;
        logger.error("playground tool error", { tool: name, message });
        bus.publish({
          type: "error",
          sessionId: playgroundSessionId,
          username: ctx.username,
          tool: name,
          status: "error",
          durationMs,
          message,
        });
        res.status(500).json({ ok: false, error: message, durationMs });
      }
    },
  );

  return router;
}
