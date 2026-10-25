// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * extract-ddl.ts
 *
 * Schema definition and the forward-only migration runner for the persistent
 * v2 job model. Everything lives under a dedicated `extract` schema so it can
 * share a Postgres cluster with Search without colliding on table names.
 *
 * Design references:
 *   - design.md §5 S0 (intake and jobs)
 *   - design.md §9b.2 (Extract checkpoints: jobs, *_stages, docpass_state,
 *     outboxes, uploads; stages S2–S8; input_hash idempotency; lease/epoch)
 *   - requirements 4.1 (durable job with snapshot, hashes, budget, lease) and
 *     4.2 (per-stage checkpoints addressed by input_hash)
 *
 * Style mirrors apps/search/src/collection-ddl.ts and migrations.ts:
 *   - CREATE TABLE IF NOT EXISTS, idempotent CREATE INDEX IF NOT EXISTS
 *   - a tracked schema version in extract.schema_migrations
 *   - one transaction per migration step
 *   - a cross-instance advisory lock so only one worker migrates at a time
 *
 * The DDL only ever adds; there is no down-migration. A forward-only runner is
 * the right call for a service where every instance must converge on the same
 * schema at rollout and rollbacks are handled by deploying an older image, not
 * by mutating the database backwards.
 */

import type { Pool, PoolClient } from "pg";

/**
 * The schema all extract objects live under. A bare identifier, never derived
 * from user input, so interpolating it into DDL is safe. Changing it is a
 * breaking operational decision, not a per-request value.
 */
export const EXTRACT_SCHEMA = "extract";

/**
 * Current target schema version. Bump by one and append a matching
 * {@link EXTRACT_MIGRATIONS} step for every additive schema change. The runner
 * applies every step whose `toVersion` is greater than the recorded version,
 * in ascending order.
 */
export const EXTRACT_SCHEMA_VERSION = 5;

/**
 * Well-known advisory-lock key for the extract migration runner. Distinct from
 * Search's 0x766d6967 ("vmig") so the two services' migrations never serialise
 * against each other on a shared cluster. 0x78747267 spells "xtrg".
 */
const EXTRACT_MIGRATION_LOCK_KEY = 0x78747267n;
const EXTRACT_MIGRATION_LOCK_TIMEOUT = "30s";
const EXTRACT_MIGRATION_STATEMENT_TIMEOUT = "30min";

/** A single forward-only migration step. */
export interface ExtractMigrationStep {
  /** Version this step brings the schema up to. Must be unique and ascending. */
  toVersion: number;
  /** Human-readable summary, recorded in the migration log. */
  description: string;
  /** Issues the DDL. Runs inside its own transaction with the schema in place. */
  up: (client: MigrationClient) => Promise<void>;
}

/**
 * The narrow slice of a pg client the DDL needs. Declared structurally so the
 * unit tests can drive the migrations with a plain recording mock, exactly as
 * search's collection-ddl tests do.
 */
export interface MigrationClient {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
}

// ─── Migration log ────────────────────────────────────────────────────────────

/**
 * Ensure the schema and its migration log exist. Idempotent, and the only DDL
 * that runs outside a versioned step because every step depends on it.
 */
export async function ensureExtractSchema(client: MigrationClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${EXTRACT_SCHEMA}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.schema_migrations (
      version      INTEGER      PRIMARY KEY,
      description  TEXT         NOT NULL,
      applied_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      duration_ms  INTEGER      NOT NULL
    )
  `);
}

/** The highest recorded schema version, or 0 when nothing has been applied. */
export async function getExtractSchemaVersion(client: MigrationClient): Promise<number> {
  const res = (await client.query(
    `SELECT COALESCE(MAX(version), 0) AS version FROM ${EXTRACT_SCHEMA}.schema_migrations`,
  )) as { rows: Array<{ version: number | string }> };
  const raw = res.rows[0]?.version ?? 0;
  return typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
}

async function recordExtractMigration(
  client: MigrationClient,
  version: number,
  description: string,
  durationMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ${EXTRACT_SCHEMA}.schema_migrations (version, description, duration_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (version) DO NOTHING`,
    [version, description, durationMs],
  );
}

// ─── Schema (version 1) ─────────────────────────────────────────────────────

/**
 * All base tables and indices for the persistent job model.
 *
 * Column vocabularies (status, pause_reason, resume_policy, visibility) match
 * the zod enums exported from `@atf/extract-contract/v2`; the store imports the
 * TypeScript types so DB rows and the wire contract cannot drift. They are
 * stored as TEXT rather than native enums so a contract addition is a code
 * change, not a schema migration.
 */
async function createInitialSchema(client: MigrationClient): Promise<void> {
  // ── jobs ──────────────────────────────────────────────────────────────────
  // One row per persistent job. Carries the config snapshot, the pipeline and
  // prompt hashes the resume policy compares against, the token budget/usage
  // counters, and the lease fields (holder, epoch, expiry, heartbeat) that make
  // takeover and fencing possible.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.jobs (
      id                UUID        PRIMARY KEY,
      reference         TEXT        NOT NULL,
      status            TEXT        NOT NULL DEFAULT 'queued',
      pause_reason      TEXT,
      config            JSONB       NOT NULL DEFAULT '{}'::jsonb,
      pipeline_hash     TEXT,
      prompt_hash       TEXT,
      resume_policy     TEXT        NOT NULL DEFAULT 'pin',
      visibility        TEXT        NOT NULL DEFAULT 'progressive',
      priority          INTEGER     NOT NULL DEFAULT 0,
      token_budget      BIGINT,
      tokens_used       BIGINT      NOT NULL DEFAULT 0,
      cost_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
      page_count        INTEGER,
      source_sha256     TEXT        NOT NULL,
      collection        TEXT,
      revision_id       TEXT,
      callback_url      TEXT,
      warnings          JSONB       NOT NULL DEFAULT '[]'::jsonb,
      lease_holder      TEXT,
      lease_epoch       BIGINT      NOT NULL DEFAULT 0,
      lease_expires_at  TIMESTAMPTZ,
      heartbeat_at      TIMESTAMPTZ,
      next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Worker fetch: claim the next runnable job by status, ordered so due,
  // high-priority, oldest jobs come first. Used with SELECT … FOR UPDATE
  // SKIP LOCKED.
  await client.query(`
    CREATE INDEX IF NOT EXISTS jobs_status_idx
      ON ${EXTRACT_SCHEMA}.jobs (status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS jobs_status_next_attempt_idx
      ON ${EXTRACT_SCHEMA}.jobs (status, next_attempt_at, priority DESC, created_at)
  `);
  // Lease-takeover scan: find jobs whose lease has expired.
  await client.query(`
    CREATE INDEX IF NOT EXISTS jobs_lease_expires_idx
      ON ${EXTRACT_SCHEMA}.jobs (lease_expires_at)
      WHERE lease_expires_at IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS jobs_reference_idx
      ON ${EXTRACT_SCHEMA}.jobs (reference)
  `);

  // ── page_stages ─────────────────────────────────────────────────────────
  // Checkpoint per (job, page, stage). `input_hash` addresses the result so a
  // resume with an identical hash reuses it without a model call. `output`
  // holds the stage result / persisted model raw response.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.page_stages (
      job_id          UUID        NOT NULL REFERENCES ${EXTRACT_SCHEMA}.jobs(id) ON DELETE CASCADE,
      page            INTEGER     NOT NULL,
      stage           TEXT        NOT NULL,
      input_hash      TEXT        NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'pending',
      output          JSONB,
      attempts        INTEGER     NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, page, stage)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS page_stages_status_idx
      ON ${EXTRACT_SCHEMA}.page_stages (status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS page_stages_status_next_attempt_idx
      ON ${EXTRACT_SCHEMA}.page_stages (status, next_attempt_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS page_stages_job_idx
      ON ${EXTRACT_SCHEMA}.page_stages (job_id, page)
  `);

  // ── figure_stages ─────────────────────────────────────────────────────────
  // Pass-2 checkpoint per (job, page, figure_id, stage).
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.figure_stages (
      job_id          UUID        NOT NULL REFERENCES ${EXTRACT_SCHEMA}.jobs(id) ON DELETE CASCADE,
      page            INTEGER     NOT NULL,
      figure_id       TEXT        NOT NULL,
      stage           TEXT        NOT NULL,
      input_hash      TEXT        NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'pending',
      output          JSONB,
      attempts        INTEGER     NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, page, figure_id, stage)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS figure_stages_status_idx
      ON ${EXTRACT_SCHEMA}.figure_stages (status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS figure_stages_status_next_attempt_idx
      ON ${EXTRACT_SCHEMA}.figure_stages (status, next_attempt_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS figure_stages_job_idx
      ON ${EXTRACT_SCHEMA}.figure_stages (job_id, page)
  `);

  // ── tile_stages ─────────────────────────────────────────────────────────
  // Tile-level checkpoint per (job, page, tile_id, stage) for large-format
  // pages split into overlapping tiles.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.tile_stages (
      job_id          UUID        NOT NULL REFERENCES ${EXTRACT_SCHEMA}.jobs(id) ON DELETE CASCADE,
      page            INTEGER     NOT NULL,
      tile_id         TEXT        NOT NULL,
      stage           TEXT        NOT NULL,
      input_hash      TEXT        NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'pending',
      output          JSONB,
      attempts        INTEGER     NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, page, tile_id, stage)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS tile_stages_status_idx
      ON ${EXTRACT_SCHEMA}.tile_stages (status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS tile_stages_status_next_attempt_idx
      ON ${EXTRACT_SCHEMA}.tile_stages (status, next_attempt_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS tile_stages_job_idx
      ON ${EXTRACT_SCHEMA}.tile_stages (job_id, page)
  `);

  // ── docpass_state ─────────────────────────────────────────────────────────
  // The streaming document-pass state persisted AFTER page N.
  // One row per (job, page); a resume restores from the last finished page.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.docpass_state (
      job_id      UUID        NOT NULL REFERENCES ${EXTRACT_SCHEMA}.jobs(id) ON DELETE CASCADE,
      page        INTEGER     NOT NULL,
      state       JSONB       NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, page)
    )
  `);

  // ── emit_outbox ─────────────────────────────────────────────────────────
  // One row per batch to send to Search. `status` moves pending → sent → acked.
  // `payload` may inline the NDJSON batch or hold a reference to it.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.emit_outbox (
      job_id          UUID        NOT NULL REFERENCES ${EXTRACT_SCHEMA}.jobs(id) ON DELETE CASCADE,
      seq             INTEGER     NOT NULL,
      digest          TEXT        NOT NULL,
      page_from       INTEGER     NOT NULL,
      page_to         INTEGER     NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'pending',
      payload         JSONB,
      payload_ref     TEXT,
      attempts        INTEGER     NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, seq)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS emit_outbox_status_idx
      ON ${EXTRACT_SCHEMA}.emit_outbox (status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS emit_outbox_status_next_attempt_idx
      ON ${EXTRACT_SCHEMA}.emit_outbox (status, next_attempt_at)
  `);

  // ── asset_outbox ─────────────────────────────────────────────────────────
  // One row per asset to upload. `status` moves pending → sent → acked.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.asset_outbox (
      job_id          UUID        NOT NULL REFERENCES ${EXTRACT_SCHEMA}.jobs(id) ON DELETE CASCADE,
      asset_id        TEXT        NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'pending',
      checksum        TEXT,
      variant         TEXT,
      mime_type       TEXT,
      attempts        INTEGER     NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, asset_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS asset_outbox_status_idx
      ON ${EXTRACT_SCHEMA}.asset_outbox (status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS asset_outbox_status_next_attempt_idx
      ON ${EXTRACT_SCHEMA}.asset_outbox (status, next_attempt_at)
  `);

  // ── uploads ─────────────────────────────────────────────────────────────
  // Resumable upload sessions. `received_offset` is the last confirmed byte so
  // a PATCH/HEAD can resume after an abort.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.uploads (
      upload_id       UUID        PRIMARY KEY,
      reference       TEXT        NOT NULL,
      expected_sha256 TEXT,
      size            BIGINT,
      received_offset BIGINT      NOT NULL DEFAULT 0,
      status          TEXT        NOT NULL DEFAULT 'open',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS uploads_status_idx
      ON ${EXTRACT_SCHEMA}.uploads (status)
  `);
}

// ─── Schema (version 2) ─────────────────────────────────────────────────────

/**
 * Resume hardening:
 *
 *   - `jobs.tokens_reserved` — atomic budget reservations for in-flight model
 *     calls, so concurrent pages cannot overdraw `token_budget`.
 *   - `jobs.emit_generation` — the emit generation folded into the revision's
 *     Idempotency-Key; bumped when the revision content must be rebuilt.
 *   - `jobs.auto_resume` — a `paused(dependency)` job is re-claimed once its
 *     `next_attempt_at` is due; budget/manual/pin pauses stay manual.
 *   - `asset_outbox.page` — the owning page, so asset resolution needs no scan
 *     over every page payload.
 *   - partial indices for the retry-due filter of the page scheduler and for the
 *     auto-resume claim scan.
 */
async function addResumeHardening(client: MigrationClient): Promise<void> {
  await client.query(`
    ALTER TABLE ${EXTRACT_SCHEMA}.jobs
      ADD COLUMN IF NOT EXISTS tokens_reserved BIGINT  NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS emit_generation INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS auto_resume     BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await client.query(`
    ALTER TABLE ${EXTRACT_SCHEMA}.asset_outbox
      ADD COLUMN IF NOT EXISTS page INTEGER
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS asset_outbox_job_page_idx
      ON ${EXTRACT_SCHEMA}.asset_outbox (job_id, page)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS jobs_auto_resume_idx
      ON ${EXTRACT_SCHEMA}.jobs (next_attempt_at)
      WHERE status = 'paused' AND auto_resume
  `);
  for (const table of ["page_stages", "figure_stages", "tile_stages"]) {
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${table}_retry_due_idx
        ON ${EXTRACT_SCHEMA}.${table} (job_id, page, next_attempt_at)
        WHERE status = 'failed' AND next_attempt_at IS NOT NULL
    `);
  }
}

/**
 * The ordered list of forward-only migrations. Append new steps; never edit or
 * reorder existing ones once shipped.
 */
/**
 * E3 (extract-outpost, requirements 8.7, 8.13): the job's *originator*.
 *
 * Nullable so every pre-existing row stays owner-less — reading such a job
 * keeps requiring `extract.admin`, and no migration has to guess who created
 * it. Only jobs created after this step carry an owner, filled from the
 * authenticated principal at create time (`userId`/`tenantId`).
 */
async function addJobOwnership(client: MigrationClient): Promise<void> {
  await client.query(`
    ALTER TABLE ${EXTRACT_SCHEMA}.jobs
      ADD COLUMN IF NOT EXISTS created_by_subject TEXT,
      ADD COLUMN IF NOT EXISTS created_by_tenant TEXT
  `);
}

/**
 * Task 4.6 (requirements 2.7, 2.12): the idempotency ledger for
 * `POST /v1/erasure`.
 *
 * Mirrors Search's `vs_invocation_ledger` claim/transition protocol: a
 * request's `requestId` is claimed with a fingerprint of its payload, a
 * replay of the same payload returns the committed result, and a different
 * payload under the same id is refused. Deleting twice must never double-
 * count, and a crashed deletion must stay retryable — hence the
 * `pending`/`running` states expire rather than block forever.
 */
async function addErasureLedger(client: MigrationClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.erasure_ledger (
      key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('pending', 'running', 'committed', 'failed', 'outcome_unknown', 'compensated')),
      result JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS erasure_ledger_expires_idx
      ON ${EXTRACT_SCHEMA}.erasure_ledger (expires_at)
  `);
}

/**
 * The per-tenant daily vision-page counter.
 *
 * One row per (tenant, UTC day); the spend is a single atomic upsert
 * (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), so concurrent page stages
 * — across jobs and worker instances — cannot together pass a daily cap the
 * budget only covers once, mirroring the job token reservation. Counting
 * VLM pages rather than tokens is what the requirement names
 * (`VISION_BUDGET_PAGES_PER_DAY`); the per-job token budget stays the
 * separate, finer axis.
 */
async function addVisionDailyBudget(client: MigrationClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EXTRACT_SCHEMA}.vision_daily_usage (
      tenant_id TEXT NOT NULL,
      day DATE NOT NULL,
      pages_used INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, day)
    )
  `);
}

export const EXTRACT_MIGRATIONS: ExtractMigrationStep[] = [
  {
    toVersion: 1,
    description:
      "Initial extract schema: jobs, *_stages, docpass_state, outboxes, uploads",
    up: createInitialSchema,
  },
  {
    toVersion: 2,
    description:
      "Resume hardening: token reservations, emit generation, auto-resume, asset page",
    up: addResumeHardening,
  },
  {
    toVersion: 3,
    description: "Job ownership: created_by_subject, created_by_tenant (E3)",
    up: addJobOwnership,
  },
  {
    toVersion: 4,
    description:
      "Erasure ledger: erasure_ledger (task 4.6, requirements 2.7, 2.12)",
    up: addErasureLedger,
  },
  {
    toVersion: 5,
    description:
      "Vision daily budget: vision_daily_usage (task 7.7, requirement 5.8)",
    up: addVisionDailyBudget,
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

/** Minimal logger surface, so the runner works with pino or a test stub. */
export interface MigrationLogger {
  info: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

/**
 * Apply every pending migration in ascending order, each inside its own
 * transaction. Recorded in `extract.schema_migrations`. Safe to call
 * concurrently from multiple instances — an advisory lock serialises them and
 * the version check makes the losers a no-op.
 *
 * Returns the version the schema is at after the run.
 */
export async function runExtractMigrations(
  pool: Pool,
  logger: MigrationLogger,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = '${EXTRACT_MIGRATION_LOCK_TIMEOUT}'`);
    await client.query(`SET statement_timeout = '${EXTRACT_MIGRATION_STATEMENT_TIMEOUT}'`);
    await client.query(`SELECT pg_advisory_lock($1)`, [
      EXTRACT_MIGRATION_LOCK_KEY.toString(),
    ]);
    try {
      await ensureExtractSchema(client);
      return await applyPendingMigrations(client, logger);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [
        EXTRACT_MIGRATION_LOCK_KEY.toString(),
      ]);
    }
  } finally {
    client.release();
  }
}

/**
 * The version-check + per-step-transaction loop, split out so the unit tests
 * can exercise it against a recording mock without a live pool or advisory
 * lock. Assumes the schema and migration log already exist.
 */
export async function applyPendingMigrations(
  client: PoolClient | MigrationClient,
  logger: MigrationLogger,
): Promise<number> {
  const applied = await getExtractSchemaVersion(client);
  if (applied >= EXTRACT_SCHEMA_VERSION) {
    logger.debug({ version: applied }, "Extract schema up to date");
    return applied;
  }

  const pending = EXTRACT_MIGRATIONS.filter((m) => m.toVersion > applied).sort(
    (a, b) => a.toVersion - b.toVersion,
  );
  logger.info(
    { from: applied, to: EXTRACT_SCHEMA_VERSION, steps: pending.length },
    "Running extract migrations",
  );

  let current = applied;
  for (const step of pending) {
    const started = Date.now();
    await client.query("BEGIN");
    try {
      await step.up(client);
      await recordExtractMigration(
        client,
        step.toVersion,
        step.description,
        Date.now() - started,
      );
      await client.query("COMMIT");
      current = step.toVersion;
      logger.info(
        { version: step.toVersion, description: step.description },
        "Applied extract migration",
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }
  return current;
}
