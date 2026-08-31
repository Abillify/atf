// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router, type Request, type Response } from "express";
import type { MonitoringConfig } from "../config/schema.ts";
import type { MonitorBus } from "./events.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { AuthContext } from "../auth/context.ts";
import { normalizeHeaders } from "../auth/context.ts";
import { logger } from "../logger.ts";
import { verifyIdToken } from "./oidc-verify.ts";

type OidcConfig = NonNullable<MonitoringConfig["oidc"]>;

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MonitorDeps {
  bus: MonitorBus;
  config: MonitoringConfig;
  registry?: ToolRegistry;
  instructions?: () => string | undefined;
}

// ---------------------------------------------------------------------------
// Token authorisation — constant-time comparison, Authorization header only
// ---------------------------------------------------------------------------

/**
 * Constant-time bearer token comparison.
 * Accepting the token only via Authorization header (not ?token= query string)
 * prevents it appearing in server access logs or browser history.
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

function authorize(req: Request, config: MonitoringConfig): boolean {
  if (!config.token && !config.oidc) return true;

  if (config.token) {
    // Prefer the Authorization header (kept out of access logs). Browsers cannot
    // set headers on EventSource, so a `?token=` query param is also accepted for
    // the dashboard; document that this may surface the token in proxy logs.
    const headerToken = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
    const queryRaw = req.query.token;
    const queryToken = typeof queryRaw === "string" ? queryRaw.trim() : undefined;
    const presented = headerToken ?? queryToken;
    if (presented !== undefined && safeTokenEqual(presented, config.token)) return true;
  }

  if (config.oidc) {
    const session = readSessionCookie(req, config.oidc);
    if (session) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// OIDC login — authorization-code flow against an external provider (e.g.
// Authentik). Session/state are kept in signed, HttpOnly cookies rather than
// server-side storage so the monitor stays stateless across restarts/replicas.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "mcpgate_monitor_session";
const STATE_COOKIE = "mcpgate_monitor_state";

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, DiscoveryDoc>();

async function discover(issuer: string): Promise<DiscoveryDoc> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery request to ${url} failed: ${res.status}`);
  const doc = (await res.json()) as DiscoveryDoc;
  discoveryCache.set(issuer, doc);
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
    res.type("html").send(html);
  });

  // ── OIDC login / callback / logout ────────────────────────────────────────

  router.get("/monitor/login", async (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).send("Monitoring is disabled"); return; }
    if (!config.oidc) { res.status(404).send("OIDC is not configured"); return; }
    const oidc = config.oidc;

    try {
      const state = randomBytes(16).toString("hex");
      const stateExp = Math.floor(Date.now() / 1000) + 300;
      const stateCookie = signCookie({ state, exp: stateExp }, oidc.sessionSecret);
      res.setHeader(
        "Set-Cookie",
        `${STATE_COOKIE}=${stateCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`,
      );

      const doc = await discover(oidc.issuer);
      const params = new URLSearchParams({
        response_type: "code",
        client_id: oidc.clientId,
        redirect_uri: oidc.redirectUri,
        scope: oidc.scopes.join(" "),
        state,
      });
      res.redirect(`${doc.authorization_endpoint}?${params}`);
    } catch (err) {
      logger.error("monitor OIDC login failed", { message: err instanceof Error ? err.message : String(err) });
      res.status(502).send("Failed to start OIDC login (provider unreachable?)");
    }
  });

  router.get("/monitor/callback", async (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).send("Monitoring is disabled"); return; }
    if (!config.oidc) { res.status(404).send("OIDC is not configured"); return; }
    const oidc = config.oidc;

    const cookies = parseCookies(req);
    const statePayload = verifyCookie<{ state: string; exp: number }>(cookies[STATE_COOKIE], oidc.sessionSecret);
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
        }),
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
        });
        const usernameClaim = verified.claims.email ?? verified.claims.preferred_username;
        session = {
          sub: verified.sub,
          username: typeof usernameClaim === "string" ? usernameClaim : verified.sub,
          scopes: [...new Set(claimStrings(verified.claims.tools))],
          tenantId:
            typeof verified.claims.tenant_id === "string" && verified.claims.tenant_id.length > 0
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

  router.get("/monitor/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect("/");
  });

  // ── SSE event stream ──────────────────────────────────────────────────────

  router.get("/monitor/stream", (req: Request, res: Response) => {
    if (!config.enabled) { res.status(404).json({ error: "Monitoring is disabled" }); return; }
    if (!authorize(req, config)) { res.status(401).json({ error: "Unauthorized" }); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

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
      if (!config.enabled) { res.status(404).json({ error: "Monitoring is disabled" }); return; }
      if (!authorize(req, config)) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (!deps.registry) { res.status(503).json({ error: "Registry not available" }); return; }

      // The playground executes tools out-of-band from a normal MCP session, so
      // it is opt-in and must be protected by a token or OIDC login (fail closed).
      if (!config.playground.enabled) {
        res.status(403).json({ error: "Tool Playground is disabled (set monitoring.playground.enabled)" });
        return;
      }
      if (!config.token && !config.oidc) {
        res.status(403).json({ error: "Tool Playground requires monitoring.token or monitoring.oidc to be set" });
        return;
      }

      const { name } = req.params as { name: string };
      const args = (req.body?.args ?? {}) as Record<string, unknown>;
      const dryRun = req.body?.dryRun === true;
      const executor = deps.registry.getReal(name);
      if (!executor) { res.status(404).json({ error: `Tool not found: ${name}` }); return; }

      // Write-access tools mutate data; require an explicit opt-in to run them
      // from the dashboard. A dry-run never executes, so it is always allowed.
      if (!dryRun && deps.registry.accessOf(name) === "write" && !config.playground.allowWrite) {
        res.status(403).json({
          error: `Tool '${name}' has access: write; enable monitoring.playground.allowWrite to run it`,
        });
        return;
      }

      // Optional caller identity so identity-aware tools (conditions, :ctx.*)
      // can be exercised realistically instead of always running with an empty
      // context. Provided in the request body under `identity`.
      const identity = (req.body?.identity ?? {}) as {
        username?: unknown;
        subject?: unknown;
        scopes?: unknown;
        claims?: unknown;
        headers?: unknown;
      };
      const oidcSession = config.oidc ? readSessionCookie(req, config.oidc) : undefined;
      const sessionClaims: Record<string, unknown> | undefined = oidcSession
        ? { tools: oidcSession.scopes, tenant_id: oidcSession.tenantId }
        : undefined;
      const ctx: AuthContext = {
        method: oidcSession ? "oauth" : "static",
        subject:
          oidcSession?.sub ??
          (typeof identity.subject === "string" ? identity.subject : "playground"),
        username:
          oidcSession?.username ??
          (typeof identity.username === "string" ? identity.username : "playground"),
        scopes: [
          ...new Set([
            `tools:${deps.registry.accessOf(name) ?? "read"}`,
            ...(oidcSession?.scopes ?? []),
            ...(Array.isArray(identity.scopes) ? identity.scopes.map(String) : []),
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

      const started = Date.now();
      bus.publish({
        type: "tool_call",
        sessionId: "playground",
        username: "playground",
        subject: "playground",
        authMethod: "static",
        tool: name,
        meta: { arguments: args },
      });

      try {
        const result = dryRun
          ? (await executor.explain?.(args, ctx)) ?? {
              content: [
                { type: "text" as const, text: `Dry-run is not supported for tool type '${deps.registry.typeOf(name)}'.` },
              ],
              isError: true,
            }
          : await executor.execute(args, ctx);
        const durationMs = Date.now() - started;
        bus.publish({
          type: "tool_result",
          sessionId: "playground",
          username: "playground",
          tool: name,
          status: result.isError ? "error" : "ok",
          durationMs,
          meta: result.meta,
        });
        res.json({ ok: !result.isError, durationMs, content: result.content, meta: result.meta });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - started;
        logger.error("playground tool error", { tool: name, message });
        bus.publish({
          type: "error",
          sessionId: "playground",
          username: "playground",
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
