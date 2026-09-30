// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Gemeinsames Wiring des Outpost-Runtimes (requirements 1.1–1.4, 2.1–2.9,
 * 5.1, 6.17, 12.1): Konfiguration laden (Datei optional, Env gewinnt),
 * `_FILE`-Secrets falten und im Redaktor registrieren, {@link
 * FileCredentialStore} inkl. Secret-Mounts, AuthManager mit der per
 * {@link selectAuthMethod} gewaehlten Methode, ExtractHttpClient mit
 * optionaler CA, die vier Quellen-Fabriken und ein Store-Cache je Quelle.
 *
 * Der Runtime kennt keine Subcommand-Logik — `daemon`, `once`, `sidecar` …
 * bauen darauf auf. Alle I/O-Abhaengigkeiten sind injizierbar, damit Tests
 * ohne Netzwerk und ohne `/data` auskommen.
 */

import { access, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  AuthManager,
  createLogger,
  createLocalSource,
  createDropboxSource,
  createGdriveSource,
  createS3Source,
  createTlsAgent,
  EXTRACT_API_TOKEN_KEY,
  EXTRACT_CLIENT_SECRET_KEY,
  ExtractHttpClient,
  FileCredentialStore,
  loadConfig,
  loadGoogleClientSecret,
  NeedsAuthTracker,
  registerSecrets,
  resolveSecretEnv,
  runDeviceCodeFlow,
  runSourceOnce,
  SecretRedactor,
  selectAuthMethod,
  SyncStateStore,
  verifyConnection,
  type ConnectionResult,
  type CredentialStore,
  type Env,
  type ExtractHttpClientOptions,
  type FetchLike,
  type OutpostConfig,
  type RunReport,
  type SourceAdapter,
  type SourceConfig,
  type SourceCredentialUnion,
  type SourceFetch,
  type UploadLimits,
} from "@atf/outpost-core";
import { confirmForSource } from "./confirm.js";
import pkgJson from "../package.json";

/** Default-Extract-Limit, bis `whoami` ein anderes meldet (5.1). */
export const DEFAULT_MAX_UPLOAD_BYTES = 52_428_800;

/** Konfigurationsfehler — der CLI beendet mit Exit 78 (1.4, 1.5). */
export class ConfigLoadError extends Error {
  constructor(
    readonly errors: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(
      `Konfiguration ungueltig:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`,
    );
    this.name = "ConfigLoadError";
  }
}

export interface RuntimeOptions {
  /** Umgebungsvariablen; Default `process.env`. */
  env?: Env;
  /** Datenverzeichnis (State + Credentials); Default `/data` (`OUTPOST_DATA_DIR`). */
  dataDir?: string;
  /** Konfigurationsdatei; Default `OUTPOST_CONFIG_FILE`, sonst `/config/outpost.yaml` (optional). */
  configFile?: string;
  /** Version fuer den User-Agent; Default die aus `package.json` (14.9). */
  version?: string;
  /** Laufzeit fuer den User-Agent (14.9). */
  runtime?: "docker" | "desktop";
  /** Injizierter Logger (Tests); sonst `createLogger`. */
  logger?: Logger;
  /** Logger-Ziel; Default stdout. Im Sidecar-Modus stderr (stdout ist fuer
   *  die `ready`-Zeile und das Bridge-Protokoll reserviert). */
  logDestination?: NodeJS.WritableStream;
  /** Credential-Store-Override (Sidecar: Keychain-Bridge statt Datei). */
  credentialStore?: CredentialStore;
  /** Callback bei wiederholter 401 (Reauth-Pause, 4.4). */
  onReauthRequired?: () => void;
  /** Injizierbares fetch (Tests). */
  fetchImpl?: typeof globalThis.fetch;
  /** Override der Credential-Auflösung je Quelle (Tests). */
  resolveCredential?: (
    src: SourceConfig,
    store: CredentialStore,
    env: Env,
    rejectedIds: ReadonlySet<string>,
  ) => Promise<SourceCredentialUnion>;
}

export interface Runtime {
  cfg: OutpostConfig;
  /** Umgebung nach `_FILE`-Faltung (Secrets sind hier, aber redigiert). */
  env: Record<string, string>;
  logger: Logger;
  redactor: SecretRedactor;
  credentialStore: CredentialStore;
  authManager: AuthManager;
  client: ExtractHttpClient;
  needsAuth: NeedsAuthTracker;
  stateDir: string;
  /** Konfigurationsdatei, wenn eine geladen wurde (Control-API PUT, 13.9). */
  configFile?: string;
  /** Fuehrt genau einen Sync-Lauf aus (Scheduler-Callback). */
  runSource: (src: SourceConfig, signal: AbortSignal) => Promise<RunReport>;
  /** Flusht den State einer Quelle (Logout-Sequenz, 3.5). */
  flushSource: (sourceId: string) => Promise<void>;
  /** Verbindungsprüfung vor dem ersten Lauf (5.1, 5.2). */
  verify: (signal?: AbortSignal) => Promise<ConnectionResult>;
  /** State-Store einer Quelle (oeffnet bei Bedarf; fuer Control-API/CLI). */
  storeFor: (src: SourceConfig) => Promise<SyncStateStore>;
  /** Alle Stores schliessen. */
  close: () => Promise<void>;
}

const DEFAULT_CONFIG_FILE = "/config/outpost.yaml";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Baue den Runtime. Wirft {@link ConfigLoadError} bei ungueltiger
 * Konfiguration (Exit 78) oder fehlender OIDC-Angaben fuer interaktive
 * Verfahren.
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const rawEnv: Env = options.env ?? (process.env as Env);
  const { logger, redactor } =
    options.logger !== undefined
      ? { logger: options.logger, redactor: new SecretRedactor() }
      : createLogger(rawEnv.OUTPOST_LOG_LEVEL ?? "info", options.logDestination);

  const { env, secretValues } = await resolveSecretEnv(rawEnv, (p) =>
    fsReadFile(p, "utf8"),
  );
  registerSecrets(redactor, secretValues);

  // Konfigurationsdatei: explizit gesetzte Pfade muessen existieren; der
  // Default `/config/outpost.yaml` ist optional (Design: "optional, ro").
  // Achtung: OUTPOST_CONFIG_FILE ist kein Secret und wird von resolveSecretEnv
  // als *_FILE-Schluessel entfernt — der Pfad muss aus rawEnv gelesen werden.
  const explicitFile = options.configFile ?? rawEnv.OUTPOST_CONFIG_FILE;
  const configFile =
    explicitFile ??
    ((await fileExists(DEFAULT_CONFIG_FILE)) ? DEFAULT_CONFIG_FILE : undefined);
  const warnings: string[] = [];
  const loaded = await loadConfig(configFile, env, {
    onWarn: (m) => warnings.push(m),
  });
  for (const w of warnings) logger.warn({ event: "config.warn", message: w });
  if (!loaded.ok) throw new ConfigLoadError(loaded.errors);
  const cfg = loaded.value;

  const dataDir = options.dataDir ?? env.OUTPOST_DATA_DIR ?? "/data";
  const stateDir = join(dataDir, "state");
  const version = options.version ?? pkgJson.version;
  const runtimeKind = options.runtime ?? "docker";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const extraCredentialDirs = splitList(env.OUTPOST_CREDENTIAL_DIRS);
  const credentialStore: CredentialStore =
    options.credentialStore ??
    new FileCredentialStore({
      dataDir,
      ...(extraCredentialDirs !== undefined ? { extraReadDirs: extraCredentialDirs } : {}),
      redactor,
      logger,
    });

  // ── Auth-Verfahren (2.1–2.7): API-Token > Client-Credentials > Device ────
  const apiToken = nonEmpty(env.OUTPOST_API_TOKEN);
  const clientSecretFromEnv = nonEmpty(env.OUTPOST_CLIENT_SECRET);
  const clientSecretStored =
    !clientSecretFromEnv && (await credentialStore.get(EXTRACT_CLIENT_SECRET_KEY)) !== null;
  const method = selectAuthMethod({
    apiToken: apiToken !== undefined,
    clientCredentials: clientSecretFromEnv !== undefined || clientSecretStored,
    interactive: "device",
  });
  if (method !== "api-token" && cfg.oidc === undefined) {
    throw new ConfigLoadError([
      {
        path: "oidc",
        message:
          "oidc.issuer und oidc.clientId sind erforderlich, wenn kein API-Token konfiguriert ist",
      },
    ]);
  }
  const oidc = cfg.oidc ?? { issuer: "", clientId: "", scopes: [] };

  // Env-Client-Secret wird NICHT auf Platte geschrieben: der AuthStore liest
  // es aus der Umgebung, alle anderen Schluessel gehen an den File-Store.
  const authStore: CredentialStore =
    clientSecretFromEnv !== undefined
      ? {
          get: async (key: string) =>
            key === EXTRACT_CLIENT_SECRET_KEY
              ? clientSecretFromEnv
              : credentialStore.get(key),
          set: (key, value) => credentialStore.set(key, value),
          delete: (key) => credentialStore.delete(key),
        }
      : credentialStore;

  const authFetch = fetchImpl as unknown as FetchLike;
  const authManager = new AuthManager({
    method,
    oidc: {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      ...(oidc.audience !== undefined ? { audience: oidc.audience } : {}),
      scopes: oidc.scopes,
    },
    store: authStore,
    logger,
    fetchImpl: authFetch,
    readApiToken: async () => apiToken ?? (await credentialStore.get(EXTRACT_API_TOKEN_KEY)),
    interactive: async () => {
      const result = await runDeviceCodeFlow(
        oidc.issuer,
        oidc.clientId,
        oidc.scopes,
        oidc.audience,
        {
          fetchImpl: authFetch,
          store: authStore,
          logger,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
        },
      );
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresInSec: result.expiresInSec,
      };
    },
  });

  const clientOptions: ExtractHttpClientOptions = {
    extractUrl: cfg.extractUrl,
    tokenProvider: authManager,
    version,
    runtime: runtimeKind,
    fetchImpl,
    ...(cfg.caCertPath !== undefined ? { dispatcher: createTlsAgent(cfg.caCertPath) } : {}),
    ...(options.onReauthRequired !== undefined
      ? { onReauthRequired: options.onReauthRequired }
      : {}),
  };
  const client = new ExtractHttpClient(clientOptions);

  const sourceFetch: SourceFetch = async (url, init) => {
    const response = await fetchImpl(url, init as RequestInit);
    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
      arrayBuffer: () => response.arrayBuffer(),
    };
  };

  const makeAdapter = async (
    src: SourceConfig,
    credential: Exclude<SourceCredentialUnion, { kind: "needs-authorization" }>,
  ): Promise<SourceAdapter> => {
    switch (src.type) {
      case "local":
        return createLocalSource({
          root: src.path,
          ...(src.include !== undefined ? { include: src.include } : {}),
          ...(src.exclude !== undefined ? { exclude: src.exclude } : {}),
        });
      case "s3":
        return createS3Source(
          {
            id: src.id,
            bucket: src.bucket,
            ...(src.prefix !== undefined ? { prefix: src.prefix } : {}),
            ...(src.region !== undefined ? { region: src.region } : {}),
            ...(src.endpoint !== undefined ? { endpoint: src.endpoint } : {}),
            ...(src.forcePathStyle !== undefined ? { forcePathStyle: src.forcePathStyle } : {}),
            credentials: src.credentials,
            ...(src.include !== undefined ? { include: src.include } : {}),
            ...(src.exclude !== undefined ? { exclude: src.exclude } : {}),
          },
          { fetchImpl: sourceFetch, store: credentialStore, env },
        );
      case "gdrive": {
        if (credential.kind === "static") {
          throw new Error(`gdrive source ${src.id}: ungueltige statische Zugangsdaten`);
        }
        const clientId = cfg.cloudOAuth.gdrive?.clientId;
        if (credential.kind === "refresh-token" && clientId === undefined) {
          throw new Error(
            `gdrive source ${src.id}: cloudOAuth.gdrive.clientId (oder OUTPOST_GDRIVE_CLIENT_ID) fehlt`,
          );
        }
        const clientSecret = await loadGoogleClientSecret(env, credentialStore, redactor);
        return createGdriveSource(
          {
            id: src.id,
            folderId: src.folderId,
            exportFormat: src.exportFormat,
            ...(src.include !== undefined ? { include: src.include } : {}),
            ...(src.exclude !== undefined ? { exclude: src.exclude } : {}),
          },
          {
            fetchImpl: sourceFetch,
            credential,
            ...(clientId !== undefined ? { clientId } : {}),
            ...(clientSecret !== undefined ? { clientSecret } : {}),
          },
        );
      }
      case "dropbox": {
        if (credential.kind !== "refresh-token") {
          throw new Error(`dropbox source ${src.id}: oauth-refresh erforderlich`);
        }
        const appKey = cfg.cloudOAuth.dropbox?.appKey;
        if (appKey === undefined) {
          throw new Error(
            `dropbox source ${src.id}: cloudOAuth.dropbox.appKey (oder OUTPOST_DROPBOX_APP_KEY) fehlt`,
          );
        }
        return createDropboxSource(
          {
            id: src.id,
            path: src.path,
            ...(src.include !== undefined ? { include: src.include } : {}),
            ...(src.exclude !== undefined ? { exclude: src.exclude } : {}),
          },
          { fetchImpl: sourceFetch, credential, clientId: appKey },
        );
      }
    }
  };

  const stores = new Map<string, Promise<SyncStateStore>>();
  const openStore = (src: SourceConfig): Promise<SyncStateStore> => {
    let store = stores.get(src.id);
    if (store === undefined) {
      store = SyncStateStore.open({
        dir: stateDir,
        sourceId: src.id,
        collection: src.collection ?? cfg.collection,
      });
      stores.set(src.id, store);
    }
    return store;
  };

  const needsAuth = new NeedsAuthTracker();
  /** Quellen, deren Token der Anbieter zuletzt ablehnte (6.18). */
  const rejectedIds = new Set<string>();
  let maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;

  const runSource = async (src: SourceConfig, signal: AbortSignal): Promise<RunReport> => {
    const store = await openStore(src);
    const deleteConfirmation = await confirmForSource(env, stateDir, src.id);
    const limits: UploadLimits = {
      resumableThresholdBytes: cfg.resumableThresholdBytes,
      maxUploadBytes,
    };
    const report = await runSourceOnce({
      src,
      cfg,
      store,
      client,
      credentialStore,
      env,
      rejectedIds,
      makeAdapter,
      limits,
      logger,
      needsAuth,
      signal,
      ...(deleteConfirmation !== undefined ? { deleteConfirmation } : {}),
      ...(options.resolveCredential !== undefined
        ? { resolveCredential: options.resolveCredential }
        : {}),
    });
    // rejected-Merkur aktualisieren (6.18): abgelehnt bis erfolgreicher Lauf.
    if (report.outcome === "needs-authorization" && report.reason === "rejected") {
      rejectedIds.add(src.id);
    } else if (report.outcome === "ok") {
      rejectedIds.delete(src.id);
    }
    return report;
  };

  const verify = async (signal?: AbortSignal): Promise<ConnectionResult> => {
    const result = await verifyConnection(client, { mirrorDelete: cfg.mirrorDelete }, signal);
    if (result.maxUploadBytes !== undefined) maxUploadBytes = result.maxUploadBytes;
    return result;
  };

  return {
    cfg,
    env,
    logger,
    redactor,
    credentialStore,
    authManager,
    client,
    needsAuth,
    stateDir,
    ...(configFile !== undefined ? { configFile } : {}),
    runSource,
    flushSource: async (sourceId: string) => {
      const store = stores.get(sourceId);
      if (store !== undefined) await (await store).flush();
    },
    verify,
    storeFor: openStore,
    close: async () => {
      for (const store of stores.values()) (await store).close();
      stores.clear();
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
