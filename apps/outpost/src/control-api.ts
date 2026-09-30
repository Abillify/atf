// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Control-API des Sidecars (design.md, Desktop_App; requirements 1.3, 3.5,
 * 3.8, 3.9, 5.1, 6.4, 6.9, 6.10, 6.18, 9.5, 10.3, 10.6, 11.5, 13.4, 13.5,
 * 15.3, 15.4).
 *
 * Bindet ausschliesslich auf `127.0.0.1:0`. Jede Anfrage braucht
 * `Authorization: Bearer <ipc-token>` (Konstantzeitvergleich über SHA-256-
 * Digeste, damit die Laenge nicht durchhaengt) und einen `Host` exakt
 * `127.0.0.1:<port>` (Schutz vor DNS-Rebinding aus dem WebView). Fehler:
 * `401` ohne/mit falschem Token, `403` bei falschem Host — ohne jede Aktion.
 *
 * Secrets werden nie zurueckgegeben: `GET /status` meldet je Source nur
 * `credentials: {configured}`; der Body der Credentials-Route wird nie
 * geloggt; uebernommene Werte werden im Redaktor registriert.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  buildAuthorizeUrl,
  codeChallenge,
  exchangeCodeForTokens,
  ExtractHttpClient,
  generateCodeVerifier,
  generateState,
  loadGoogleClientSecret,
  LOOPBACK_TIMEOUT_MS,
  loopbackRedirectUri,
  parseServiceAccountKey,
  performLogout,
  registerSecrets,
  runDeviceCodeFlow,
  type Scheduler,
  serializeConfig,
  sourceGdriveSaKey,
  sourceOauthRefreshKey,
  sourceS3AccessKeyKey,
  sourceS3SecretKeyKey,
  validateConfig,
  verifyConnection,
  waitForAuthCode,
  type CredentialStore,
  type FetchLike,
  type LoopbackListener,
  type OutpostConfig,
  type SourceConfig,
} from "@atf/outpost-core";
import type { Runtime } from "./runtime.js";
import type { KeychainBridgeStore } from "./keychain-bridge.js";
import { confirmFilePath } from "./confirm.js";

/** Maximale Groesse eines JSON-Bodies (Config-PUT; SEA-Keys sind 64 KiB). */
export const MAX_BODY_BYTES = 1_048_576;

export interface ControlApiOptions {
  rt: Runtime;
  scheduler: Scheduler;
  bridge: KeychainBridgeStore;
  ipcToken: string;
  logger: Logger;
  /** Pfad, auf den `PUT /config` die validierte Konfiguration schreibt. */
  configPath?: string;
  /** Beenden nach `POST /shutdown`; Default `process.exit`. */
  exit?: (code: number) => void;
  /** Grace in Sekunden fuer `POST /shutdown` (Design: 30). */
  shutdownGraceSec?: number;
  /** Injizierbares fetch fuer Token-Tausch/Verbindungspruefung (Tests). */
  fetchImpl?: FetchLike;
}

export interface ControlApiHandle {
  /** Startet den Server auf `127.0.0.1:0`; liefert den Port. */
  listen(): Promise<number>;
  close(): Promise<void>;
  /** Der gebundene Port (nach `listen()`). */
  port(): number;
}

/** Konstantzeitvergleich zweier Tokens ueber Digeste (15.3). */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Host-Header muss exakt `127.0.0.1:<port>` sein (15.3). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}`;
}

class JsonError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
    this.name = "JsonError";
  }
}

function httpError(status: number, body: unknown): JsonError {
  return new JsonError(status, body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw httpError(413, { code: "BODY_TOO_LARGE" });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw httpError(400, { code: "INVALID_JSON" });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/**
 * Loopback-Listener, der den Redirect ueber die Keychain-Bridge vom
 * Rust-Host bezieht (6.9): der Host bindet den Port und oeffnet den
 * Browser; das Sidecar kennt weder Tokens noch den Verifier-Transport.
 */
export function bridgeLoopbackListener(bridge: KeychainBridgeStore): LoopbackListener {
  return {
    start: () => bridge.openLoopback(),
    async waitForRedirect(_timeoutMs: number) {
      const query = await bridge.loopbackResult();
      return {
        state: query.state ?? null,
        code: query.code ?? null,
        error: query.error ?? null,
      };
    },
    stop: async () => undefined,
  };
}

/** Statische Zugangsdaten je Source: welche Schluessel gelten (6.4, 6.10). */
function staticCredentialKeys(src: SourceConfig): string[] {
  if (src.type === "gdrive") return [sourceGdriveSaKey(src.id)];
  if (src.type === "s3") return [sourceS3AccessKeyKey(src.id), sourceS3SecretKeyKey(src.id)];
  return [];
}

/** Sind die statischen Zugangsdaten der Source hinterlegt? (nur boolean) */
export async function credentialsConfigured(
  store: CredentialStore,
  src: SourceConfig,
): Promise<boolean> {
  const keys = staticCredentialKeys(src);
  if (keys.length === 0) {
    // OAuth-Quellen: konfigurierter Zustand = vorhandener Refresh-Token.
    if (src.type === "dropbox" || (src.type === "gdrive" && src.auth === "oauth")) {
      return (await store.get(sourceOauthRefreshKey(src.id))) !== null;
    }
    return false;
  }
  for (const key of keys) {
    if ((await store.get(key)) === null) return false;
  }
  return true;
}

/** SSE-Broadcast-Hub fuer Sidecar-Ereignisse. */
class EventHub {
  private readonly clients = new Set<ServerResponse>();

  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  emit(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  closeAll(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}

/**
 * Startet die Control-API. Der Handler ist als Funktion gekapselt, damit
 * Tests ihn ohne echten Server aufrufen koennen (`handle(request)`).
 */
export function createControlApi(options: ControlApiOptions): ControlApiHandle {
  const { rt, scheduler, bridge, ipcToken, logger } = options;
  const hub = new EventHub();
  /** laufende Autorisierungen je Source (409 bei Doppel-Trigger). */
  const authInFlight = new Set<string>();
  let boundPort = 0;

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceSec = options.shutdownGraceSec ?? 30;

  const sourceById = (id: string): SourceConfig | undefined =>
    rt.cfg.sources.find((s) => s.id === id);

  // ── Einzelrouten ──────────────────────────────────────────────────────────

  async function handleStatus(): Promise<unknown> {
    const sources = [];
    for (const view of scheduler.status()) {
      const src = sourceById(view.sourceId);
      sources.push({
        ...view,
        ...(src !== undefined ? { type: src.type } : {}),
        ...(src?.type === "gdrive" ? { auth: src.auth } : {}),
        credentials: { configured: src !== undefined ? await credentialsConfigured(rt.credentialStore, src) : false },
      });
    }
    return { paused: scheduler.isPaused(), sources };
  }

  async function handleFailures(sourceId: string): Promise<unknown> {
    const src = sourceById(sourceId);
    if (src === undefined) throw httpError(404, { code: "UNKNOWN_SOURCE" });
    const store = await rt.storeFor(src);
    const failures = Object.entries(store.state.items)
      .filter(([, item]) => item.lastError !== undefined)
      .map(([quellId, item]) => ({ quellId, status: item.status, error: item.lastError }));
    return { sourceId, failures };
  }

  async function handleConfigPut(body: unknown): Promise<unknown> {
    const validated = validateConfig(body);
    if (!validated.ok) {
      throw httpError(400, { code: "INVALID_CONFIG", errors: validated.errors });
    }
    // Erneute Verbindungspruefung gegen die neue Konfiguration (5.1).
    const probe = new ExtractHttpClient({
      extractUrl: validated.value.extractUrl,
      tokenProvider: rt.authManager,
      version: "control-api",
      runtime: "desktop",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });
    const connection = await verifyConnection(probe, { mirrorDelete: validated.value.mirrorDelete });
    if (!connection.ok) {
      throw httpError(400, { code: "CONNECTION_FAILED", findings: connection.findings });
    }
    if (options.configPath !== undefined) {
      await writeFile(options.configPath, serializeConfig(validated.value), { mode: 0o600 });
    }
    hub.emit("config.updated", { restartRequired: true });
    return undefined;
  }

  async function handleAuthorize(sourceId: string): Promise<void> {
    const src = sourceById(sourceId);
    if (src === undefined || src.type === undefined) return;
    try {
    const providerId = src.type === "gdrive" ? "gdrive" : "dropbox";
      const clientId =
        src.type === "gdrive" ? rt.cfg.cloudOAuth.gdrive?.clientId : rt.cfg.cloudOAuth.dropbox?.appKey;
      if (clientId === undefined) {
        hub.emit("source.authorization_failed", { sourceId, reason: "missing-client-id" });
        return;
      }
      const verifier = generateCodeVerifier();
      const challenge = await codeChallenge(verifier);
      const state = generateState();
      const port = await bridge.openLoopback();
      const redirectUri = loopbackRedirectUri(port);
      const url = buildAuthorizeUrl(providerId, {
        clientId,
        codeChallenge: challenge,
        state,
        redirectUri,
      });
      await bridge.openBrowser(url.toString());
      const authResult = await waitForAuthCode(
        bridgeLoopbackListener(bridge),
        state,
        LOOPBACK_TIMEOUT_MS,
      );
      if (authResult.kind !== "code") {
        hub.emit("source.authorization_failed", { sourceId, reason: authResult.reason });
        return;
      }
      const clientSecret =
        src.type === "gdrive"
          ? await loadGoogleClientSecret(rt.env, rt.credentialStore, rt.redactor)
          : undefined;
      let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
      try {
        tokens = await exchangeCodeForTokens(
          providerId,
          {
            clientId,
            ...(clientSecret !== undefined ? { clientSecret } : {}),
            code: authResult.code,
            codeVerifier: verifier,
            redirectUri,
          },
          fetchImpl,
        );
      } catch {
        // Netzwerk-/Anbieterfehler: Meldung ohne Token-Inhalte.
        hub.emit("source.authorization_failed", { sourceId, reason: "exchange-failed" });
        return;
      }
      if (tokens.kind !== "ok" || tokens.refreshToken === undefined) {
        hub.emit("source.authorization_failed", { sourceId, reason: "no-refresh-token" });
        return;
      }
      registerSecrets(rt.redactor, [tokens.refreshToken]);
      await rt.credentialStore.set(sourceOauthRefreshKey(sourceId), tokens.refreshToken);
      scheduler.credentialChanged(sourceId);
      hub.emit("source.authorized", { sourceId });
    } catch (error) {
      logger.warn({ event: "authorize.failed", sourceId, err: error instanceof Error ? error.message : "?" });
      hub.emit("source.authorization_failed", { sourceId, reason: "bridge-error" });
    } finally {
      authInFlight.delete(sourceId);
    }
  }

  async function handleCredentialsPut(sourceId: string, body: unknown): Promise<void> {
    const src = sourceById(sourceId);
    if (src === undefined) throw httpError(404, { code: "UNKNOWN_SOURCE" });
    const record = (body ?? {}) as Record<string, unknown>;
    const store = rt.credentialStore;
    const kind = record.kind;
    try {
      if (kind === "gdrive-service-account") {
        if (src.type !== "gdrive" || src.auth !== "service-account") {
          throw httpError(400, { code: "INVALID_CREDENTIAL", field: "kind", reason: "passt nicht zum Source-Typ" });
        }
        const keyJson = record.keyJson;
        if (typeof keyJson !== "string") {
          throw httpError(400, { code: "INVALID_CREDENTIAL", field: "keyJson", reason: "Pflichtfeld" });
        }
        const parsed = parseServiceAccountKey(keyJson);
        if (!parsed.ok) {
          throw httpError(400, { code: "INVALID_CREDENTIAL", field: "keyJson", reason: parsed.reason });
        }
        registerSecrets(rt.redactor, [keyJson]);
        await store.set(sourceGdriveSaKey(sourceId), keyJson);
      } else if (kind === "s3-access-key") {
        if (src.type !== "s3") {
          throw httpError(400, { code: "INVALID_CREDENTIAL", field: "kind", reason: "passt nicht zum Source-Typ" });
        }
        const accessKeyId = record.accessKeyId;
        const secretAccessKey = record.secretAccessKey;
        for (const [field, value] of [
          ["accessKeyId", accessKeyId],
          ["secretAccessKey", secretAccessKey],
        ] as const) {
          if (typeof value !== "string" || value === "" || !/^[\x21-\x7e]+$/.test(value)) {
            throw httpError(400, { code: "INVALID_CREDENTIAL", field, reason: "druckbares ASCII ohne Leerraum, Pflicht" });
          }
        }
        registerSecrets(rt.redactor, [accessKeyId as string, secretAccessKey as string]);
        // Zweiter Schreibfehler → ersten Schluessel zurueckrollen (6.10).
        await store.set(sourceS3AccessKeyKey(sourceId), accessKeyId as string);
        try {
          await store.set(sourceS3SecretKeyKey(sourceId), secretAccessKey as string);
        } catch (error) {
          await store.delete(sourceS3AccessKeyKey(sourceId)).catch(() => undefined);
          throw error;
        }
      } else {
        throw httpError(400, { code: "INVALID_CREDENTIAL", field: "kind", reason: "unbekanntes kind" });
      }
    } catch (error) {
      if (error instanceof JsonError) throw error;
      // Keychain-Fehler: 502 ohne Fallback, ohne Werte (15.4).
      throw httpError(502, { code: "CREDENTIAL_STORE" });
    }
    scheduler.credentialChanged(sourceId);
  }

  async function handleCredentialsDelete(sourceId: string): Promise<void> {
    const src = sourceById(sourceId);
    if (src === undefined) throw httpError(404, { code: "UNKNOWN_SOURCE" });
    const keys = staticCredentialKeys(src);
    if (keys.length === 0) {
      throw httpError(400, { code: "INVALID_CREDENTIAL", field: "kind", reason: "Source ohne statische Zugangsdaten" });
    }
    try {
      for (const key of keys) await rt.credentialStore.delete(key);
    } catch {
      throw httpError(502, { code: "CREDENTIAL_STORE" });
    }
    scheduler.credentialChanged(sourceId);
  }

  async function handleDeletesConfirm(sourceId: string): Promise<void> {
    const src = sourceById(sourceId);
    if (src === undefined) throw httpError(404, { code: "UNKNOWN_SOURCE" });
    const store = await rt.storeFor(src);
    const hash = store.state.candidateSetHash;
    if (hash === undefined) throw httpError(409, { code: "NO_PENDING_DELETE" });
    await writeFile(confirmFilePath(rt.stateDir, sourceId), `${hash}\n`, { mode: 0o600 });
  }

  function startAuthLogin(): void {
    void (async () => {
      const oidc = rt.cfg.oidc;
      if (oidc === undefined) {
        hub.emit("auth.authorization_failed", { reason: "oidc-not-configured" });
        return;
      }
      try {
        await runDeviceCodeFlow(oidc.issuer, oidc.clientId, oidc.scopes, oidc.audience, {
          fetchImpl,
          store: rt.credentialStore,
          logger,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
        });
        scheduler.resume();
        hub.emit("auth.authorized", {});
      } catch {
        hub.emit("auth.authorization_failed", { reason: "device-flow-failed" });
      }
    })();
  }

  function startShutdown(): void {
    void (async () => {
      scheduler.beginShutdown();
      // Grace: hochstens `shutdownGraceSec` auf laufende Läufe warten (10.7).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceSec * 1000);
        timer.unref?.();
      });
      await Promise.race([scheduler.awaitIdle(), grace]);
      if (timer !== undefined) clearTimeout(timer);
      await scheduler.stopAll("shutdown");
      exit(0);
    })();
  }

  // ── Router ────────────────────────────────────────────────────────────────

  async function route(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const param = (re: RegExp): string[] | undefined => {
      const m = re.exec(pathname);
      return m === null ? undefined : m.slice(1);
    };

    if (method === "GET" && pathname === "/status") {
      sendJson(res, 200, await handleStatus());
      return;
    }
    if (method === "GET" && pathname === "/config") {
      sendJson(res, 200, rt.cfg);
      return;
    }
    let m = param(/^\/sources\/([^/]+)\/failures$/);
    if (m !== undefined && method === "GET") {
      sendJson(res, 200, await handleFailures(decodeURIComponent(m[0] as string)));
      return;
    }
    if (pathname === "/config" && method === "PUT") {
      await handleConfigPut(await readJsonBody(req));
      sendNoContent(res);
      return;
    }
    m = param(/^\/sources\/([^/]+)\/sync$/);
    if (m !== undefined && method === "POST") {
      const id = decodeURIComponent(m[0] as string);
      if (sourceById(id) === undefined) throw httpError(404, { code: "UNKNOWN_SOURCE" });
      scheduler.trigger(id);
      sendNoContent(res);
      return;
    }
    m = param(/^\/sources\/([^/]+)\/authorize$/);
    if (m !== undefined && method === "POST") {
      const id = decodeURIComponent(m[0] as string);
      const src = sourceById(id);
      if (src === undefined) throw httpError(404, { code: "UNKNOWN_SOURCE" });
      if (src.type !== "gdrive" && src.type !== "dropbox") {
        throw httpError(400, { code: "NOT_AUTHORIZABLE" });
      }
      if (src.type === "gdrive" && src.auth === "service-account") {
        throw httpError(400, { code: "NOT_AUTHORIZABLE" });
      }
      if (authInFlight.has(id)) throw httpError(409, { code: "ALREADY_RUNNING" });
      authInFlight.add(id);
      void handleAuthorize(id);
      sendJson(res, 202, { status: "pending" });
      return;
    }
    m = param(/^\/sources\/([^/]+)\/credentials$/);
    if (m !== undefined) {
      const id = decodeURIComponent(m[0] as string);
      if (method === "PUT") {
        // Body nie loggen (15.4) — diese Route schreibt den Logger nicht an.
        await handleCredentialsPut(id, await readJsonBody(req));
        sendNoContent(res);
        return;
      }
      if (method === "DELETE") {
        await handleCredentialsDelete(id);
        sendNoContent(res);
        return;
      }
    }
    if (pathname === "/pause" && method === "POST") {
      scheduler.pauseAll();
      sendNoContent(res);
      return;
    }
    if (pathname === "/resume" && method === "POST") {
      scheduler.resumeAll();
      sendNoContent(res);
      return;
    }
    if (pathname === "/auth/login" && method === "POST") {
      startAuthLogin();
      sendJson(res, 202, { status: "pending" });
      return;
    }
    if (pathname === "/auth/logout" && method === "POST") {
      await performLogout(scheduler, rt.authManager);
      sendNoContent(res);
      return;
    }
    m = param(/^\/deletes\/([^/]+)\/confirm$/);
    if (m !== undefined && method === "POST") {
      await handleDeletesConfirm(decodeURIComponent(m[0] as string));
      sendNoContent(res);
      return;
    }
    if (pathname === "/shutdown" && method === "POST") {
      startShutdown();
      sendJson(res, 202, { status: "shutting_down" });
      return;
    }
    throw httpError(404, { code: "NOT_FOUND" });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    // Authentifizierung vor jeder Route (15.3).
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (token === undefined || !tokenMatches(token, ipcToken)) {
      sendJson(res, 401, { code: "UNAUTHORIZED" });
      return;
    }
    if (!hostAllowed(req.headers.host, boundPort)) {
      sendJson(res, 403, { code: "FORBIDDEN_HOST" });
      return;
    }

    if (pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Header sofort senden und Stream mit SSE-Kommentar anstossen, damit
      // Clients nicht auf das erste Ereignis warten muessen.
      res.flushHeaders();
      res.write(":ok\n\n");
      hub.add(res);
      return;
    }

    void route(req.method ?? "GET", pathname, req, res)
      .catch((error: unknown) => {
        if (error instanceof JsonError) {
          sendJson(res, error.status, error.body);
          return;
        }
        logger.error({ event: "control-api.error", message: error instanceof Error ? error.message : "?" });
        sendJson(res, 500, { code: "INTERNAL" });
      });
  });

  return {
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("control-api: kein TCP-Port gebunden");
      }
      boundPort = address.port;
      return boundPort;
    },
    async close(): Promise<void> {
      hub.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    port(): number {
      return boundPort;
    },
  };
}

/** Typ-Export fuer Konsumenten, die die Config-Struktur validieren wollen. */
export type { OutpostConfig };
