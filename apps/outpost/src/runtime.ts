// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared wiring of the Outpost runtime (requirements 1.1–1.4, 2.1–2.9,
 * 5.1, 6.17, 12.1): load the configuration (file optional, env wins),
 * fold `_FILE` secrets and register them with the redactor, {@link
 * FileCredentialStore} including secret mounts, AuthManager with the method
 * chosen by {@link selectAuthMethod}, ExtractHttpClient with an optional
 * CA, the four source factories and a store cache per source.
 *
 * The runtime knows no subcommand logic; `daemon`, `once`, `sidecar` …
 * build on it. All I/O dependencies are injectable so tests work without
 * network and without `/data`.
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
  createSharepointSource,
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

/** Default Extract limit until `whoami` reports a different one (5.1). */
export const DEFAULT_MAX_UPLOAD_BYTES = 52_428_800;

/** Configuration error: the CLI exits with 78 (1.4, 1.5). */
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
  /** Configuration file; default `OUTPOST_CONFIG_FILE`, otherwise `/config/outpost.yaml` (optional). */
  configFile?: string;
  /** Version for the User-Agent; default the one from `package.json` (14.9). */
  version?: string;
  /** Runtime for the User-Agent (14.9). */
  runtime?: "docker" | "desktop";
  /** Injected logger (tests); otherwise `createLogger`. */
  logger?: Logger;
  /** Logger target; default stdout. In sidecar mode stderr (stdout is
   *  reserved for the `ready` line and the bridge protocol). */
  logDestination?: NodeJS.WritableStream;
  /** Credential store override (sidecar: keychain bridge instead of a file). */
  credentialStore?: CredentialStore;
  /** Callback on repeated 401s (reauth pause, 4.4). */
  onReauthRequired?: () => void;
  /** Injizierbares fetch (Tests). */
  fetchImpl?: typeof globalThis.fetch;
  /** Override of the credential resolution per source (tests). */
  resolveCredential?: (
    src: SourceConfig,
    store: CredentialStore,
    env: Env,
    rejectedIds: ReadonlySet<string>,
  ) => Promise<SourceCredentialUnion>;
}

export interface Runtime {
  cfg: OutpostConfig;
  /** Environment after `_FILE` folding (secrets are here, but redacted). */
  env: Record<string, string>;
  logger: Logger;
  redactor: SecretRedactor;
  credentialStore: CredentialStore;
  authManager: AuthManager;
  client: ExtractHttpClient;
  needsAuth: NeedsAuthTracker;
  stateDir: string;
  /** Configuration file, when one was loaded (Control API PUT, 13.9). */
  configFile?: string;
  /** Runs exactly one sync run (scheduler callback). */
  runSource: (src: SourceConfig, signal: AbortSignal) => Promise<RunReport>;
  /** Flushes a source's state (logout sequence, 3.5). */
  flushSource: (sourceId: string) => Promise<void>;
  /** Connection check before the first run (5.1, 5.2). */
  verify: (signal?: AbortSignal) => Promise<ConnectionResult>;
  /** State store of a source (opens on demand; for Control API/CLI). */
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
 * Build the runtime. Throws {@link ConfigLoadError} for an invalid
 * configuration (exit 78) or missing OIDC settings for interactive
 * flows.
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

  // Configuration file: explicitly set paths must exist; the default
  // `/config/outpost.yaml` is optional (design: "optional, ro").
  // Note: OUTPOST_CONFIG_FILE is not a secret and is removed by resolveSecretEnv
  // as a *_FILE key, so the path must be read from rawEnv.
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

  // The env client secret is NOT written to disk: the AuthStore reads it
  // from the environment, all other keys go to the file store.
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
      header: (name: string) => response.headers.get(name) ?? undefined,
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
      case "sharepoint": {
        // Client credentials from files only — the config object never
        // carries the secret itself.
        let clientSecret: string | undefined;
        let certificatePem: string | undefined;
        if (src.clientSecretFile !== undefined) {
          clientSecret = (await fsReadFile(src.clientSecretFile, "utf8")).trim();
          redactor.register(clientSecret);
        } else if (src.certificateFile !== undefined) {
          certificatePem = await fsReadFile(src.certificateFile, "utf8");
        } else {
          throw new Error(
            `sharepoint source ${src.id}: clientSecretFile oder certificateFile fehlt`,
          );
        }
        const store = await openStore(src);
        return createSharepointSource(
          {
            id: src.id,
            tenantId: src.tenantId,
            clientId: src.clientId,
            ...(clientSecret !== undefined && clientSecret !== ""
              ? { clientSecret }
              : {}),
            ...(certificatePem !== undefined ? { certificatePem } : {}),
            ...(src.driveId !== undefined ? { driveId: src.driveId } : {}),
            ...(src.siteUrl !== undefined ? { siteUrl: src.siteUrl } : {}),
            ...(src.library !== undefined ? { library: src.library } : {}),
            aclFromPermissions: src.aclFromPermissions,
            ...(src.aclGroupMap !== undefined ? { aclGroupMap: src.aclGroupMap } : {}),
            ...(src.include !== undefined ? { include: src.include } : {}),
            ...(src.exclude !== undefined ? { exclude: src.exclude } : {}),
            ...(store.state.deltaLink !== undefined
              ? { initialDeltaLink: store.state.deltaLink }
              : {}),
          },
          { fetchImpl: sourceFetch, logger },
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
  /** Sources whose token the provider rejected last (6.18). */
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
    // Update the rejected marker (6.18): rejected until a successful run.
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
