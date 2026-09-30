// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `@atf/outpost-core` — the sync core shared by the Docker runtime and the
 * desktop sidecar. Public surface grows with each task; task 18.4 finalises
 * the export list.
 */

export {
  COLLECTION_PATTERN,
  outpostConfigSchema,
  sourceConfigSchema,
  type OutpostConfig,
  type SourceConfig,
} from "./config/schema.js";
export {
  effectiveCollection,
  isExtractUrlAllowed,
  sourceEnvId,
  validateConfig,
  type ConfigError,
  type Result,
} from "./config/validate.js";
export { loadConfig, serializeConfig, type LoadConfigDeps } from "./config/load.js";
export {
  deepMerge,
  envToConfig,
  ENV_MAP,
  mergeConfig,
  type EnvMapEntry,
  type EnvValueKind,
} from "./config/merge.js";
export {
  isSecretName,
  resolveSecretEnv,
  stripTrailingNewline,
  type Env,
  type ResolvedSecretEnv,
} from "./config/secrets-file.js";
export {
  REDACTION_MARKER,
  REDACT_PATHS,
  SecretRedactor,
} from "./log/redact.js";
export { createLogger, registerSecrets, type OutpostLogger } from "./log/logger.js";
export {
  CredentialStoreError,
  type CredentialStore,
} from "./credentials/store.js";
export { MemoryCredentialStore } from "./credentials/memory-store.js";
export {
  credentialFileHash,
  FileCredentialStore,
  type FileCredentialStoreOptions,
} from "./credentials/file-store.js";
export {
  AUTH_EXTRACT_PREFIX,
  EXTRACT_API_TOKEN_KEY,
  EXTRACT_AUTH_KEYS,
  EXTRACT_CLIENT_SECRET_KEY,
  EXTRACT_REFRESH_TOKEN_KEY,
  isExtractAuthKey,
  sourceGdriveSaKey,
  sourceOauthRefreshKey,
  sourceS3AccessKeyKey,
  sourceS3SecretKeyKey,
} from "./credentials/keys.js";
export {
  selectAuthMethod,
  type AuthMethod,
  type AvailableAuthMethods,
} from "./auth/select.js";
export {
  needsRefresh,
  REFRESH_WINDOW_MS,
  TokenCache,
  expiresAtFromNow,
  type CachedToken,
} from "./auth/token-cache.js";
export {
  codeChallenge,
  generateCodeVerifier,
  generateState,
  LOOPBACK_HOST,
  LOOPBACK_TIMEOUT_MS,
  loopbackRedirectUri,
  statesMatch,
  waitForAuthCode,
  type AuthCodeResult,
  type LoopbackListener,
  type LoopbackRedirect,
} from "./auth/pkce.js";
export {
  AuthError,
  discover,
  interactiveScopes,
  tokenRequest,
  type FetchLike,
  type OidcDiscovery,
  type TokenResponse,
} from "./auth/idp.js";
export {
  requestDeviceCode,
  runDeviceCodeFlow,
  SLOW_DOWN_INCREMENT_SEC,
  type DeviceCodeResponse,
  type DeviceFlowDeps,
  type DeviceFlowResult,
} from "./auth/device-code.js";
export { refreshAccessToken, exchangeCode } from "./auth/refresh.js";
export { clientCredentialsToken } from "./auth/client-credentials.js";
export {
  AuthManager,
  type AuthEvent,
  type AuthManagerOptions,
  type InteractiveTokenSet,
  type OidcSettings,
  type TokenProvider,
} from "./auth/manager.js";
export {
  BASE_BACKOFF_MS,
  isRetryableStatus,
  MAX_BACKOFF_MS,
  MAX_RETRIES,
  parseRetryAfter,
  retryDecision,
  type RetryDecision,
  type RetryOutcome,
} from "./http/retry.js";
export {
  buildUserAgent,
  ExtractHttpClient,
  OriginGuardError,
  ReauthRequiredError,
  TlsFailureError,
  type ExtractHttpClientOptions,
  type HttpRequest,
  type HttpResponse,
  type Runtime,
} from "./http/client.js";
export {
  createTlsAgent,
  extractTlsErrorCode,
  TlsConfigError,
} from "./http/tls.js";
export {
  apiErrorCode,
  apiErrorMessage,
  ExtractApiError,
} from "./extract/api-error.js";
export { whoami } from "./extract/whoami.js";
export {
  ingest,
  INGEST_FIELD,
  readFileBytes,
  type IngestResult,
} from "./extract/ingest.js";
export {
  createJob,
  getJob,
  isTerminalJobStatus,
  pollDelayMs,
  pollJob,
  POLL_INITIAL_MS,
  POLL_MAX_MS,
  TERMINAL_JOB_STATUSES,
  type PollJobDeps,
} from "./extract/jobs.js";
export {
  deleteByReference,
  DeleteForbiddenError,
  type DeleteResult,
} from "./extract/delete.js";
export {
  CHUNK_SIZE_BYTES,
  completeUpload,
  openUpload,
  patchChunk,
  runResumableUpload,
  uploadOffset,
  type ChunkReader,
  type PatchOutcome,
  type PendingUpload,
  type ResumableUploadResult,
  type UploadOffsetInfo,
} from "./extract/uploads.js";
export {
  classifyWhoamiError,
  evaluateConnection,
  verifyConnection,
  type ConnectionConfig,
  type ConnectionFinding,
  type ConnectionResult,
  type FindingCode,
  type WhoamiOutcome,
} from "./extract/connection.js";
export {
  DROPBOX_SCOPE,
  GDRIVE_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  PROVIDERS,
  type ProviderId,
  type ProviderInfo,
} from "./auth/source-oauth/providers.js";
export {
  buildAuthorizeUrl,
  type AuthorizeUrlArgs,
} from "./auth/source-oauth/authorize-url.js";
export {
  buildRedirectUrl,
  parsePastedInput,
  type PasteExpectation,
  type PasteResult,
} from "./auth/source-oauth/paste-input.js";
export {
  classifyTokenResponse,
  exchangeCodeForTokens,
  GDRIVE_CLIENT_SECRET_ENV,
  GDRIVE_CLIENT_SECRET_KEY,
  loadGoogleClientSecret,
  persistRotatedRefreshToken,
  refreshSourceToken,
  SourceTransientError,
  type ExchangeCodeArgs,
  type RefreshArgs,
  type SourceTokenResult,
} from "./auth/source-oauth/exchange.js";
export {
  buildServiceAccountAssertion,
  parseServiceAccountKey,
  SERVICE_ACCOUNT_KEY_MAX_BYTES,
  serviceAccountToken,
  type AssertionDeps,
  type ParseKeyResult,
  type ServiceAccountKey,
} from "./auth/source-oauth/service-account.js";
export {
  gdriveSaKeyFileEnv,
  resolveSourceCredential,
  sourceLoginHint,
  type ResolveDeps,
  type SourceCredential,
} from "./auth/source-oauth/resolve.js";
export {
  requestGdriveDeviceCode,
  startGdriveAuthorization,
  type GdriveAuthPlan,
  type GdriveDeviceCode,
  type GdriveDeviceResult,
} from "./auth/source-oauth/gdrive-device.js";
export {
  collectListing,
  SourceNeedsAuthorizationError,
  SourceRejectedError,
  type ListingResult,
  type SourceAdapter,
  type SourceFetch,
  type SourceItem,
} from "./sources/types.js";
export { isIncluded, normalizeMatchPath } from "./sources/filter.js";
export {
  guardPath,
  isInsideRoot,
  joinWithinRoot,
  type GuardResult,
} from "./sources/path-guard.js";
export { createLocalSource, toQuellId, type LocalSourceOptions } from "./sources/local.js";
export {
  createS3Source,
  parseAwsIni,
  parseListObjectsV2,
  resolveS3Credentials,
  resolveS3Target,
  signS3Get,
  type S3Credentials,
  type S3Deps,
  type S3SourceOptions,
} from "./sources/s3.js";
export {
  createGdriveSource,
  exportMimeType,
  WORKSPACE_EXPORT_MIME,
  type GdriveDeps,
  type GdriveSource,
  type GdriveSourceOptions,
} from "./sources/gdrive.js";
export {
  createDropboxSource,
  type DropboxDeps,
  type DropboxSource,
  type DropboxSourceOptions,
} from "./sources/dropbox.js";
export {
  deriveReference,
  REFERENCE_HASH_LENGTH,
  REFERENCE_SEPARATOR,
} from "./sync/reference.js";
export {
  applyJournalEntry,
  itemStateSchema,
  journalEntrySchema,
  sourceStateSchema,
  type ItemState,
  type JournalEntry,
  type SourceState,
} from "./state/schema.js";
export {
  crc32,
  decodeJournalRecord,
  encodeJournalRecord,
  SyncStateStore,
  type SyncStateStoreOptions,
} from "./state/store.js";
export {
  planAfterHash,
  planItem,
  type PostHashAction,
  type PreAction,
  type UploadLimits,
} from "./sync/planner.js";
export {
  reduce,
  type NowIso,
  type Outcome,
} from "./sync/reducer.js";
export {
  computeCandidateSetHash,
  planDeletes,
  type DeletePlan,
  type DeletePlanArgs,
} from "./sync/delete-planner.js";
export {
  buildIngestHeaders,
  rfc3339Utc,
  sourceLabel,
  toJobRequest,
} from "./sync/headers.js";
export { Semaphore, isAborted } from "./sync/concurrency.js";
export {
  classifyOutcome,
  countOutcome,
  newCounters,
  processedTotal,
  type CounterClass,
  type RunCounters,
} from "./sync/counters.js";
export {
  applyOutcome,
  JournalWriter,
  processItem,
  runCollection,
  type ItemContext,
  type ItemResult,
} from "./sync/executor.js";
export {
  itemReference,
  NeedsAuthTracker,
  runSourceOnce,
  type RunOutcomeKind,
  type RunReport,
  type RunSourceDeps,
  type SourceCredentialUnion,
} from "./sync/run.js";
export {
  emptyCounters,
  performLogout,
  Scheduler,
  type LastRunInfo,
  type SchedulerOptions,
  type SourceStatus,
  type SourceStatusView,
} from "./schedule/scheduler.js";
export {
  startWatcher,
  type WatchBackendFactory,
  type WatchHandle,
  type WatcherOptions,
} from "./schedule/watcher.js";
export {
  chokidarBackend,
  defaultBackendForPlatform,
  fsWatchBackend,
} from "./schedule/watch-backends.js";
export {
  aggregateExitCode,
  EXIT_CONFIG,
  EXIT_EXTRACT_AUTH_OR_CONNECTION,
  EXIT_ITEM_OR_SOURCE_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  resultFromRunReport,
  runOnce,
  type OnceSourceResult,
} from "./schedule/once.js";
