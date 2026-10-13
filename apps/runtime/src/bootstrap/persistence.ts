// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Persistence builder (`src/bootstrap/persistence.ts`)
 *
 * Creates and migrates the optional PostgreSQL database connection, then
 * constructs all durable-or-in-memory stores that depend on it:
 *   - Database (Bun native SQL, optional)
 *   - StoreFactory (central store abstraction — Redis > Postgres > Memory)
 *   - ExecutionStore (audit history)
 *   - TenantStore + UsageMeter
 *   - BYOK provider-key store + resolver
 *   - Idempotency store
 *   - Job store
 *   - FlowStore (for the online flow editor)
 *
 * The {@link StoreFactory} is the SINGLE place where the backing for all
 * recurring store patterns (rate-limit, semaphore, approval-log,
 * monitoring-history, semantic-cache) is selected. No duplicated store-pattern
 * should exist in more than one file (Requirement 1.3).
 *
 * Keeping these together avoids the "did I pass the right database instance?"
 * problem when wiring up downstream services — every consumer gets a reference
 * from one coherent object rather than hunting through index.ts.
 */

import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { createDatabase, type Database } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import {
  PostgresExecutionStore,
  type ExecutionStore,
} from "../monitoring/execution-store.js";
import {
  InMemoryTenantStore,
  PostgresTenantStore,
  type TenantStore,
} from "../graph/tenant-manager.js";
import { createUsageMeter, type UsageMeter } from "../observability/billing.js";
import {
  InMemoryTenantProviderKeyStore,
  PostgresTenantProviderKeyStore,
  ByokResolver,
  type TenantProviderKeyStore,
} from "../graph/tenant-provider-keys.js";
import { createSecretCipher } from "../graph/secret-cipher.js";
import {
  InMemoryIdempotencyStore,
  createRedisIdempotencyStore,
  type IdempotencyStore,
} from "../graph/idempotency-store.js";
import {
  InMemoryJobStore,
  createRedisJobStore,
  type JobStore,
} from "../graph/job-store.js";
import {
  InMemoryFlowStore,
  PostgresFlowStore,
  type FlowStore,
} from "../graph/flow-store.js";
import {
  InMemoryAnalysisArtifactStore,
  PostgresAnalysisArtifactStore,
  type AnalysisArtifactStore,
} from "../artifacts/analysis-artifacts.js";
import type { StoreFactory } from "../db/store/index.js";
import { RedisStoreFactory } from "../db/store/index.js";
import { PostgresStoreFactory } from "../db/store/index.js";
import { MemoryStoreFactory } from "../db/store/index.js";
import {
  InMemoryPiiVaultStore,
  PostgresPiiVaultStore,
  createPiiVault,
  type PiiVault,
  type PiiVaultStore,
} from "../graph/pii-vault.js";
import type { PiiType } from "../graph/output-guardrails.js";
import {
  PiiDetectorRegistry,
  type PiiDetectorFactory,
} from "../graph/pii-detector.js";
import { RegexPiiDetector } from "../graph/pii-detector-regex.js";
import { BertNerDetector } from "../graph/pii-detector-ner.js";
import { RemotePiiDetector } from "../graph/pii-detector-remote.js";

export interface PersistenceResult {
  database: Database | undefined;
  storeFactory: StoreFactory;
  executionStore: ExecutionStore | undefined;
  tenantStore: TenantStore;
  usageMeter: UsageMeter;
  providerKeyStore: TenantProviderKeyStore | undefined;
  byokResolver: ByokResolver | undefined;
  idempotencyStore: IdempotencyStore | undefined;
  jobStore: JobStore | undefined;
  flowStore: FlowStore | undefined;
  analysisArtifactStore: AnalysisArtifactStore;
  piiVault: PiiVault | undefined;
  piiVaultStore: PiiVaultStore | undefined;
  /**
   * Factory that builds a PII detector registry from a list of detector names
   * (ADR-0015). Exposed so the composition root can construct the per-flow
   * {@link PiiDetectorResolver} once the guardrail policy is available, then
   * inject it via `piiVault.setDetectorResolver`. Undefined when the vault is off.
   */
  piiDetectorFactory: PiiDetectorFactory | undefined;
  rlsVerified: boolean;
  /**
   * Row count in the `tenants` table, when determinable. Purely informational
   * — passed through to the production-readiness gate so an unverified-RLS
   * message can state concretely how many tenants are exposed, without
   * changing whether the check is fatal. `undefined` when tenant management
   * is not in use or the count could not be read.
   */
  tenantCount: number | undefined;
}

/**
 * Tables that MUST have RLS enabled and enforced in production. The setup and
 * status commands use the canonical list in `db/rls-onboarding.ts`.
 */
const RLS_TENANT_TABLES = [
  "cost_ledger",
  "token_usage_log",
  "billing_usage",
  "executions",
  "execution_snapshots",
  "tenant_provider_keys",
  "pii_vault_entries",
  "assistant_rocketchat_bindings",
  "assistant_rocketchat_outbox",
  "rocketchat_connect_requests",
  "analysis_artifacts",
] as const;

/**
 * Verifies that Row Level Security is active for all tenant-scoped tables.
 * Queries `pg_class` to check `relrowsecurity` and `relforcerowsecurity` are
 * both true for every table in {@link RLS_TENANT_TABLES}.
 *
 * @returns `true` when all tables have both flags active, `false` otherwise.
 */
export async function verifyRls(
  database: Database,
  logger: Logger,
): Promise<boolean> {
  const rows = await database.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public'
       AND c.relname IN (${RLS_TENANT_TABLES.map((_, i) => `$${i + 1}`).join(", ")})`,
    [...RLS_TENANT_TABLES],
  );

  const verified = new Map(
    rows.map((r) => [r.relname, r.relrowsecurity && r.relforcerowsecurity]),
  );

  let allActive = true;
  for (const table of RLS_TENANT_TABLES) {
    const active = verified.get(table);
    if (active !== true) {
      allActive = false;
      if (active === undefined) {
        logger.warn("RLS verification: table not found in pg_class", { table });
      } else {
        logger.warn("RLS verification: table missing RLS enforcement", {
          table,
          relrowsecurity: rows.find((r) => r.relname === table)?.relrowsecurity,
          relforcerowsecurity: rows.find((r) => r.relname === table)
            ?.relforcerowsecurity,
        });
      }
    }
  }

  if (allActive) {
    logger.info(
      "RLS verification passed: all tenant tables have RLS active and forced",
    );
  }

  return allActive;
}

// ---------------------------------------------------------------------------
// PII Detector factory (ADR-0015)
// ---------------------------------------------------------------------------

/**
 * Builds a {@link PiiDetectorFactory} — a function that turns a list of
 * detector names (regex/ner/remote) into a configured {@link PiiDetectorRegistry}.
 *
 * The factory (not a single pre-built registry) is what the vault's per-flow
 * resolver needs: a regulated flow and an internal flow may request different
 * detector sets, so registries are built on demand and cached by the resolver.
 * Unknown names are skipped with a warning; "remote" without an endpoint is
 * skipped. Fail-mode + timeout come from the global config and apply to every
 * built registry.
 */
export function buildPiiDetectorFactory(
  config: AppConfig,
  logger: Logger,
): PiiDetectorFactory {
  return (names: readonly string[]): PiiDetectorRegistry => {
    const registry = new PiiDetectorRegistry({
      failMode: config.piiDetectorFailMode ?? "open",
      timeoutMs: config.piiDetectorTimeoutMs ?? 5_000,
    });

    for (const name of names) {
      switch (name) {
        case "regex":
          registry.add(new RegexPiiDetector());
          break;
        case "ner":
          registry.add(
            new BertNerDetector({
              model: config.piiNerModel,
              confidenceThreshold: config.piiNerConfidence,
              cacheDir: config.piiNerCacheDir,
              logger,
            }),
          );
          break;
        case "remote":
          if (config.piiRemoteEndpoint !== undefined) {
            registry.add(
              new RemotePiiDetector({
                endpoint: config.piiRemoteEndpoint,
                apiKey: config.piiRemoteApiKey,
                timeoutMs: config.piiRemoteTimeoutMs,
                language: config.piiRemoteLanguage,
                logger,
              }),
            );
          } else {
            logger.warn(
              "PII detector 'remote' requested but PII_REMOTE_ENDPOINT is not set — remote detector skipped",
            );
          }
          break;
        default:
          logger.warn("Unknown PII detector name — skipped", { detector: name });
      }
    }

    return registry;
  };
}

export async function buildPersistence(
  config: AppConfig,
  logger: Logger,
): Promise<PersistenceResult> {
  // ── Database ──────────────────────────────────────────────────────────────
  let database: Database | undefined;
  if (config.databaseUrl !== undefined) {
    try {
      database = await createDatabase(config.databaseUrl, logger, {
        poolMax: config.databasePoolMax,
        tenantScoping: config.tenantRlsEnabled === true,
        operatorUrl: config.databaseOperatorUrl,
      });
      if (database !== undefined) {
        // Requirement 12.4: production defaults to dedicated migration Jobs
        // (`bun run migrate`); the advisory lock inside the migrator keeps
        // both paths safe to overlap. `loadConfig()` always fills the flag —
        // an unset value (hand-built config) keeps the legacy always-migrate
        // behaviour.
        if (config.migrateOnStart !== false) {
          const result = await runMigrations(database, logger);
          logger.info("Schema migration complete", {
            version: result.toVersion,
            applied: result.applied,
          });
        } else {
          logger.info(
            "MIGRATE_ON_START is disabled — schema migrations are not applied " +
              "at boot; run `bun run migrate` (or the migration Job) first",
          );
        }
      }
    } catch (err) {
      logger.error("Failed to initialise PostgreSQL persistence", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  }

  // ── Store Factory (central backing selection — Req 1.3, 2.1) ─────────────
  // Priority: Redis (cluster-wide, best for rate-limit/semaphore/cache) >
  // Postgres (durable, cluster-wide) > Memory (non-production only).
  let storeFactory: StoreFactory;
  if (config.redisUrl !== undefined) {
    try {
      storeFactory = new RedisStoreFactory({ url: config.redisUrl, logger });
      logger.info("StoreFactory: Redis-backed (cluster-wide)");
    } catch (err) {
      logger.warn("StoreFactory: Redis unavailable, falling back", {
        error: err instanceof Error ? err.message : String(err),
      });
      storeFactory =
        database !== undefined
          ? new PostgresStoreFactory({ db: database, logger })
          : new MemoryStoreFactory();
      logger.info(`StoreFactory: ${storeFactory.backing()}-backed`);
    }
  } else if (database !== undefined) {
    storeFactory = new PostgresStoreFactory({ db: database, logger });
    logger.info("StoreFactory: Postgres-backed (cluster-wide)");
  } else {
    storeFactory = new MemoryStoreFactory();
    logger.info("StoreFactory: in-memory (non-production, per-replica only)");
  }

  // ── Execution store ───────────────────────────────────────────────────────
  const executionStore: ExecutionStore | undefined =
    database !== undefined
      ? new PostgresExecutionStore(database, logger)
      : undefined;

  // ── Tenant store + usage meter ─────────────────────────────────────────────
  // API_KEY_PEPPER (Req 7.9): when set, keys hash as HMAC-SHA-256(pepper,
  // rawKey) and legacy SHA-256 rows migrate lazily on lookup.
  const tenantStore: TenantStore =
    config.tenantManagementEnabled === true
      ? database !== undefined
        ? new PostgresTenantStore(database, logger, {
            pepper: config.apiKeyPepper,
          })
        : new InMemoryTenantStore({ pepper: config.apiKeyPepper })
      : new InMemoryTenantStore({ pepper: config.apiKeyPepper });
  const usageMeter: UsageMeter = createUsageMeter(
    config.tenantManagementEnabled === true ? database : undefined,
    logger,
  );

  // ── BYOK provider-key store ───────────────────────────────────────────────
  let providerKeyStore: TenantProviderKeyStore | undefined;
  let byokResolver: ByokResolver | undefined;
  if (config.byokEnabled === true) {
    let cipher: ReturnType<typeof createSecretCipher> | undefined;
    try {
      cipher = createSecretCipher(config.byokEncryptionKey);
    } catch (err) {
      logger.error("Invalid BYOK_ENCRYPTION_KEY — BYOK disabled", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (database !== undefined && cipher !== undefined) {
      providerKeyStore = new PostgresTenantProviderKeyStore(
        database,
        cipher,
        logger,
      );
      logger.info("BYOK enabled (durable, encrypted at rest)");
    } else {
      providerKeyStore = new InMemoryTenantProviderKeyStore();
      logger.warn(
        "BYOK enabled with an in-memory store (keys are per-replica and lost on " +
          "restart). Set DATABASE_URL + BYOK_ENCRYPTION_KEY for durable, encrypted BYOK.",
      );
    }
    byokResolver = new ByokResolver(providerKeyStore, {
      ttlSeconds: config.byokCacheTtlSeconds ?? 60,
    });
  }

  // ── Reversible PII tokenization vault ─────────────────────────────────────
  let piiVault: PiiVault | undefined;
  let piiVaultStore: PiiVaultStore | undefined;
  let piiDetectorFactory: PiiDetectorFactory | undefined;
  if (config.piiVaultEnabled === true) {
    let vaultCipher: ReturnType<typeof createSecretCipher> | undefined;
    try {
      vaultCipher = createSecretCipher(config.piiVaultEncryptionKey);
    } catch (err) {
      logger.error("Invalid PII_VAULT_ENCRYPTION_KEY — PII vault disabled", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const vaultStore =
      database !== undefined && vaultCipher !== undefined
        ? new PostgresPiiVaultStore(database, vaultCipher, logger)
        : new InMemoryPiiVaultStore();
    piiVaultStore = vaultStore;
    if (database !== undefined && vaultCipher !== undefined) {
      logger.info("Reversible PII vault enabled (durable, encrypted at rest)");
    } else {
      logger.warn(
        "PII_VAULT_ENABLED is set with an in-memory store (mappings are per-replica " +
          "and lost on restart — fine for the vault's own lifecycle, but not durable " +
          "across a crash mid-stream). Set DATABASE_URL + PII_VAULT_ENCRYPTION_KEY for " +
          "durable, encrypted vault storage.",
      );
    }
    piiVault = createPiiVault(
      vaultStore,
      {
        enabled: true,
        ...(config.piiVaultTypes !== undefined &&
        config.piiVaultTypes.length > 0
          ? { piiTypes: config.piiVaultTypes as PiiType[] }
          : {}),
      },
      logger,
    );
    // Expose the detector factory so the composition root can build the
    // per-flow resolver once the guardrail policy exists (ADR-0015). The
    // resolver is injected via piiVault.setDetectorResolver in index.ts.
    piiDetectorFactory = buildPiiDetectorFactory(config, logger);
  }

  // ── Idempotency store ─────────────────────────────────────────────────────
  let idempotencyStore: IdempotencyStore | undefined;
  if (config.idempotencyEnabled === true) {
    if (config.redisUrl !== undefined) {
      idempotencyStore = createRedisIdempotencyStore(config.redisUrl, logger, {
        ttlSeconds: config.idempotencyTtlSeconds ?? 86_400,
      });
    }
    if (idempotencyStore === undefined) {
      idempotencyStore = new InMemoryIdempotencyStore({
        ttlSeconds: config.idempotencyTtlSeconds ?? 86_400,
        maxEntries: config.idempotencyMaxEntries ?? 10_000,
      });
    }
    logger.info("Request idempotency enabled", {
      ttlSeconds: config.idempotencyTtlSeconds ?? 86_400,
      scope:
        config.redisUrl !== undefined &&
        !(idempotencyStore instanceof InMemoryIdempotencyStore)
          ? "cluster-wide (redis)"
          : "per-replica (in-memory)",
    });
  }

  // ── Job store ─────────────────────────────────────────────────────────────
  let jobStore: JobStore | undefined;
  if (config.jobsEnabled === true) {
    if (config.redisUrl !== undefined) {
      jobStore = createRedisJobStore(config.redisUrl, logger, {
        ttlSeconds: config.jobsTtlSeconds ?? 3600,
      });
    }
    if (jobStore === undefined) {
      jobStore = new InMemoryJobStore({
        ttlSeconds: config.jobsTtlSeconds ?? 3600,
        maxEntries: config.jobsMaxEntries ?? 1000,
      });
    }
    logger.info("Async/batch job mode enabled", {
      ttlSeconds: config.jobsTtlSeconds ?? 3600,
      scope:
        config.redisUrl !== undefined && !(jobStore instanceof InMemoryJobStore)
          ? "cluster-wide (redis)"
          : "per-replica (in-memory)",
    });
  }

  // ── Online flow store ─────────────────────────────────────────────────────
  let flowStore: FlowStore | undefined;
  if (config.flowEditorEnabled === true) {
    flowStore =
      database !== undefined
        ? new PostgresFlowStore(database)
        : new InMemoryFlowStore();
    logger.info("Online flow editing enabled", {
      persistence: database !== undefined ? "postgres" : "in-memory",
    });
  }

  // Analysis artifacts are always available. Without PostgreSQL the adapter is
  // intentionally process-local, matching the runtime's other development fallbacks.
  const analysisArtifactStore: AnalysisArtifactStore =
    database !== undefined
      ? new PostgresAnalysisArtifactStore(database, logger)
      : new InMemoryAnalysisArtifactStore();
  logger.info("Analysis artifact store initialised", {
    persistence: database !== undefined ? "postgres" : "in-memory",
  });

  // ── RLS Verification (Req 3.1, 3.5) ────────────────────────────────────────
  // When a database is available AND tenantRlsEnabled is true, verify that RLS
  // is active on all tenant tables. If no database, rlsVerified follows the
  // tenantRlsEnabled flag: false when RLS is expected but can't be verified,
  // true when RLS is not expected.
  let rlsVerified: boolean;
  if (database !== undefined && config.tenantRlsEnabled === true) {
    try {
      rlsVerified = await verifyRls(database, logger);
    } catch (err) {
      logger.error("RLS verification query failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      rlsVerified = false;
    }
  } else if (config.tenantRlsEnabled === true) {
    // RLS expected but no database available — can't verify.
    rlsVerified = false;
  } else {
    // RLS not expected — nothing to verify.
    rlsVerified = true;
  }

  // Best-effort tenant count — purely informational (see PersistenceResult
  // doc comment). Never fails startup; a query error just leaves it undefined.
  let tenantCount: number | undefined;
  if (database !== undefined) {
    try {
      const existsRows = await database.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'tenants'
         ) AS exists`,
      );
      if (existsRows[0]?.exists === true) {
        const countRows = await database.query<{ count: number | string }>(
          `SELECT COUNT(*)::int AS count FROM public.tenants`,
        );
        tenantCount = Number(countRows[0]?.count ?? 0);
      }
    } catch {
      // Best-effort — leave undefined.
    }
  }

  return {
    database,
    storeFactory,
    executionStore,
    tenantStore,
    usageMeter,
    providerKeyStore,
    byokResolver,
    idempotencyStore,
    jobStore,
    flowStore,
    analysisArtifactStore,
    piiVault,
    piiVaultStore,
    piiDetectorFactory,
    rlsVerified,
    tenantCount,
  };
}
