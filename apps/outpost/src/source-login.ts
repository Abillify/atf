// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Subcommand `source-login <sourceId>` (requirements 6.13–6.20, 15.2).
 *
 * Autorisiert eine Cloud-Quelle im Terminal. Ohne TTY ist interaktive
 * Eingabe unmöglich → Exit 64 (6.19); unbekannte Quelle, falscher Typ oder
 * GDrive mit `auth: service-account` ebenfalls 64. Dropbox nutzt den
 * No-Redirect-Flow (Code auf der Anbieterseite, `redirect_uri` entfaellt),
 * GDrive einen Loopback-Redirect auf einem zufaelligen Port — die
 * Weiterleitung schlaegt fehl, der Benutzer kopiert die vollstaendige URL
 * aus der Adresszeile (6.14). `deviceFlow: true` prueft zuerst den
 * Device-Endpunkt und faellt bei `invalid_scope` auf Code-Paste zurueck
 * (6.15). Eingaben werden mit {@link parsePastedInput} bis zu 3-mal
 * akzeptiert; der Code-Tausch laeuft mit PKCE, Fehlermeldungen enthalten
 * niemals Token-Inhalte (6.19). Erfolg speichert das Refresh-Token unter
 * `source:<id>:oauth-refresh` (0600 ueber den FileCredentialStore, 6.16).
 */

import { createInterface } from "node:readline";
import {
  buildAuthorizeUrl,
  codeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateState,
  loadGoogleClientSecret,
  loopbackRedirectUri,
  parsePastedInput,
  sourceOauthRefreshKey,
  startGdriveAuthorization,
  type CredentialStore,
  type Env,
  type FetchLike,
  type OutpostConfig,
  type ProviderId,
  type SecretRedactor,
  type SourceConfig,
} from "@atf/outpost-core";
import { EXIT_CONFIG, EXIT_OK, EXIT_USAGE } from "@atf/outpost-core";

/** Maximal drei Eingabeversuche, danach Exit 1 (6.19). */
export const MAX_PASTE_ATTEMPTS = 3;

/** Dynamischer Portbereich fuer den Loopback-Redirect (6.14). */
export const LOOPBACK_PORT_MIN = 49152;
export const LOOPBACK_PORT_MAX = 65535;

export const randomLoopbackPort = (rand: () => number = Math.random): number =>
  LOOPBACK_PORT_MIN + Math.floor(rand() * (LOOPBACK_PORT_MAX - LOOPBACK_PORT_MIN + 1));

export interface SourceLoginIo {
  isTTY: boolean;
  /** Eine Zeile von stdin (nach Prompt). */
  readLine(prompt: string): Promise<string>;
  out(message: string): void;
  err(message: string): void;
}

/** Io ueber den echten Prozess. */
export function processIo(
  stdin: NodeJS.ReadStream & { isTTY?: boolean } = process.stdin,
  stdout: { write: (s: string) => void } = process.stdout,
  stderr: { write: (s: string) => void } = process.stderr,
): SourceLoginIo {
  const rl = createInterface({ input: stdin, terminal: false });
  return {
    isTTY: Boolean(stdin.isTTY),
    readLine: (prompt: string) =>
      new Promise<string>((resolve) => {
        rl.question(prompt, resolve);
      }),
    out: (m) => stdout.write(`${m}\n`),
    err: (m) => stderr.write(`${m}\n`),
  };
}

export interface SourceLoginDeps {
  io: SourceLoginIo;
  store: CredentialStore;
  cfg: OutpostConfig;
  env: Env;
  fetchImpl: FetchLike;
  redactor?: SecretRedactor;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

/** Exit-Codes des Subcommands (design.md). */
export const SOURCE_LOGIN_OK = EXIT_OK;
export const SOURCE_LOGIN_FAILED = 1;

function findSource(cfg: OutpostConfig, sourceId: string): SourceConfig | undefined {
  return cfg.sources.find((s) => s.id === sourceId);
}

/**
 * Fuehre `source-login` aus. Liefert den Exit-Code; schreibt Meldungen ohne
 * Token-Inhalte (6.19).
 */
export async function runSourceLogin(
  sourceId: string | undefined,
  deps: SourceLoginDeps,
): Promise<number> {
  const { io } = deps;
  if (sourceId === undefined || sourceId === "") {
    io.err("Verwendung: atf-outpost source-login <sourceId>");
    return EXIT_USAGE;
  }
  if (!io.isTTY) {
    io.err("source-login benoetigt ein interaktives Terminal (kein TTY).");
    return EXIT_USAGE;
  }
  const src = findSource(deps.cfg, sourceId);
  if (src === undefined) {
    io.err(`Unbekannte Source "${sourceId}".`);
    return EXIT_USAGE;
  }
  if (src.type === "gdrive" && src.auth === "service-account") {
    io.err(
      `Source "${sourceId}" nutzt ein Dienstkonto — eine Benutzer-Autorisierung ist nicht vorgesehen.`,
    );
    return EXIT_USAGE;
  }
  if (src.type !== "gdrive" && src.type !== "dropbox") {
    io.err(`Source "${sourceId}" (Typ ${src.type}) benoetigt keine Benutzer-Autorisierung.`);
    return EXIT_USAGE;
  }

  const provider: ProviderId = src.type;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (provider === "dropbox") {
    const appKey = deps.cfg.cloudOAuth.dropbox?.appKey;
    if (appKey === undefined) {
      io.err("cloudOAuth.dropbox.appKey (oder OUTPOST_DROPBOX_APP_KEY) fehlt in der Konfiguration.");
      return EXIT_CONFIG;
    }
    return loginCodePaste("dropbox", sourceId, appKey, undefined, deps);
  }

  // ── gdrive (oauth) ────────────────────────────────────────────────────────
  const clientId = deps.cfg.cloudOAuth.gdrive?.clientId;
  if (clientId === undefined) {
    io.err("cloudOAuth.gdrive.clientId (oder OUTPOST_GDRIVE_CLIENT_ID) fehlt in der Konfiguration.");
    return EXIT_CONFIG;
  }
  const clientSecret = await loadGoogleClientSecret(deps.env, deps.store, deps.redactor);

  const plan = await startGdriveAuthorization({
    clientId,
    deviceFlow: src.type === "gdrive" && src.deviceFlow === true,
    fetchImpl: deps.fetchImpl,
    log: (message) => io.out(message),
  });

  if (plan.kind === "device-flow") {
    const device = plan.device;
    io.out(
      `Bitte oeffnen Sie: ${device.verificationUriComplete ?? device.verificationUri}\n` +
        `Und bestaetigen Sie den Code: ${device.userCode}`,
    );
    return pollDeviceToken(sourceId, clientId, clientSecret, device, deps, sleep);
  }

  return loginCodePaste("gdrive", sourceId, clientId, clientSecret, deps);
}

/**
 * Code-Paste-Flow (6.13, 6.14): URL bauen, Benutzer fuellt ein, bis zu 3
 * Versuche, Tausch mit PKCE.
 */
async function loginCodePaste(
  provider: ProviderId,
  sourceId: string,
  clientId: string,
  clientSecret: string | undefined,
  deps: SourceLoginDeps,
): Promise<number> {
  const { io } = deps;
  const verifier = generateCodeVerifier();
  const state = generateState();
  const redirectUri = provider === "gdrive" ? loopbackRedirectUri(randomLoopbackPort(deps.rand)) : undefined;
  const url = buildAuthorizeUrl(provider, {
    clientId,
    codeChallenge: codeChallenge(verifier),
    state,
    ...(redirectUri !== undefined ? { redirectUri } : {}),
  });

  if (provider === "gdrive") {
    io.out(
      `Bitte oeffnen Sie die folgende URL und stimmen Sie dem Lesezugriff zu:\n\n  ${url.toString()}\n\n` +
        `Nach der Zustimmung leitet der Browser zu einer nicht erreichbaren ` +
        `127.0.0.1-Adresse weiter. Das ist erwartet: Kopieren Sie die VOLLSTAENDIGE ` +
        `URL aus der Adresszeile und fuigen Sie sie hier ein.`,
    );
  } else {
    io.out(
      `Bitte oeffnen Sie die folgende URL und stimmen Sie dem Lesezugriff zu:\n\n  ${url.toString()}\n\n` +
        `Nach der Zustimmung zeigt Dropbox einen Code an. Fuigen Sie ihn hier ein.`,
    );
  }

  for (let attempt = 1; attempt <= MAX_PASTE_ATTEMPTS; attempt++) {
    const input = await io.readLine(`Eingabe (Versuch ${attempt}/${MAX_PASTE_ATTEMPTS}): `);
    const expectation =
      provider === "gdrive"
        ? { state, redirectUri: redirectUri ?? "", allowBareCode: true }
        : { state, allowBareCode: true };
    const parsed = parsePastedInput(input, expectation);
    if (parsed.kind === "error") {
      io.err(`Eingabe verworfen (${parsed.reason}${parsed.detail !== undefined ? `: ${parsed.detail}` : ""}).`);
      continue;
    }
    let result: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
    try {
      result = await exchangeCodeForTokens(
        provider,
        {
          clientId,
          ...(clientSecret !== undefined ? { clientSecret } : {}),
          code: parsed.code,
          codeVerifier: verifier,
          ...(redirectUri !== undefined ? { redirectUri } : {}),
        },
        deps.fetchImpl,
      );
    } catch {
      // Transienter Provider-/Transportfehler — Meldung ohne Token-Inhalte.
      io.err("Der Code-Tausch schlug fehl (Netzwerk oder Anbieter). Bitte erneut versuchen.");
      return SOURCE_LOGIN_FAILED;
    }
    return storeRefreshToken(sourceId, result.kind === "ok" ? result.refreshToken : undefined, result.kind, deps);
  }
  io.err("Zu viele fehlerhafte Eingaben. Abbrochen.");
  return SOURCE_LOGIN_FAILED;
}

/** Poll den GDrive-Token-Endpunkt im Device-Flow bis zum Erfolg. */
async function pollDeviceToken(
  sourceId: string,
  clientId: string,
  clientSecret: string | undefined,
  device: { deviceCode: string; expiresInSec: number; intervalSec: number },
  deps: SourceLoginDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  let intervalMs = device.intervalSec * 1000;
  const deadline = Date.now() + device.expiresInSec * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      deps.io.err("Device-Code abgelaufen. Bitte erneut versuchen.");
      return SOURCE_LOGIN_FAILED;
    }
    await sleep(intervalMs);
    const params: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
      client_id: clientId,
    };
    if (clientSecret !== undefined) params["client_secret"] = clientSecret;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await deps.fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(params).toString(),
      });
    } catch {
      deps.io.err("Google-Token-Endpunkt nicht erreichbar. Abbrochen.");
      return SOURCE_LOGIN_FAILED;
    }
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // Status-Klassifikation unten.
    }
    if (response.ok) {
      const refreshToken = typeof parsed["refresh_token"] === "string" ? parsed["refresh_token"] : undefined;
      return storeRefreshToken(sourceId, refreshToken, "ok", deps);
    }
    const error = typeof parsed["error"] === "string" ? parsed["error"] : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    deps.io.err(`Autorisierung abgelehnt (${error || `http_${response.status}`}).`);
    return SOURCE_LOGIN_FAILED;
  }
}

/** Ergebnis speichern; Fehlermeldungen ohne Token-Inhalte (6.19). */
async function storeRefreshToken(
  sourceId: string,
  refreshToken: string | undefined,
  kind: "ok" | "rejected",
  deps: SourceLoginDeps,
): Promise<number> {
  if (kind !== "ok") {
    deps.io.err("Der Code-Tausch wurde vom Anbieter abgelehnt. Bitte erneut versuchen.");
    return SOURCE_LOGIN_FAILED;
  }
  if (refreshToken === undefined || refreshToken === "") {
    deps.io.err("Der Anbieter hat kein Refresh-Token ausgestellt. Bitte erneut versuchen.");
    return SOURCE_LOGIN_FAILED;
  }
  deps.redactor?.register(refreshToken);
  await deps.store.set(sourceOauthRefreshKey(sourceId), refreshToken);
  deps.io.out(`Source "${sourceId}" autorisiert. Ein laufender Daemon uebernimmt das Token.`);
  return SOURCE_LOGIN_OK;
}
