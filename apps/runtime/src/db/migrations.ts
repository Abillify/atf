// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Schema migrations (`src/db/migrations.ts`)
 *
 * Ordered, append-only list of schema migrations. Each migration has a unique,
 * monotonically increasing integer `version`. The migrator applies every
 * migration whose version is greater than the highest version recorded in the
 * `schema_migrations` table, in ascending order, then records the new version.
 *
 * RULES for adding a migration:
 *   - NEVER edit or reorder an existing migration once it has shipped.
 *   - ALWAYS append a new entry with the next version number.
 *   - Prefer idempotent DDL (`IF NOT EXISTS`) so a partially-applied migration
 *     can be safely retried.
 *
 * Targeted at PostgreSQL 18 (uses built-in `gen_random_uuid()`).
 */

export interface Migration {
  /** Unique, monotonically increasing version number. */
  version: number;
  /** Human-readable description (recorded in schema_migrations). */
  name: string;
  /** SQL statements executed in order for this migration. */
  statements: string[];
}

/**
 * The full migration set. The deployed schema version is the max applied
 * `version`; on startup the migrator brings the database up to
 * `LATEST_SCHEMA_VERSION`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema — executions, node_events, cost_ledger",
    statements: [
      `CREATE TABLE IF NOT EXISTS executions (
         execution_id    UUID PRIMARY KEY,
         flow_id         TEXT NOT NULL,
         tenant_id       TEXT,
         status          TEXT NOT NULL DEFAULT 'running',
         node_count      INTEGER NOT NULL DEFAULT 0,
         error_count     INTEGER NOT NULL DEFAULT 0,
         total_latency_ms INTEGER,
         started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
         finished_at     TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS executions_started_at_idx
         ON executions (started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS executions_tenant_idx
         ON executions (tenant_id, started_at DESC)`,
      `CREATE TABLE IF NOT EXISTS node_events (
         id            BIGSERIAL PRIMARY KEY,
         execution_id  UUID NOT NULL,
         node_id       TEXT NOT NULL,
         status        TEXT NOT NULL,
         start_time    TIMESTAMPTZ,
         end_time      TIMESTAMPTZ,
         latency_ms    INTEGER,
         error_message TEXT,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS node_events_execution_idx
         ON node_events (execution_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS cost_ledger (
         id               BIGSERIAL PRIMARY KEY,
         tenant_id        TEXT NOT NULL DEFAULT 'default',
         provider         TEXT,
         model            TEXT,
         prompt_tokens    INTEGER NOT NULL DEFAULT 0,
         completion_tokens INTEGER NOT NULL DEFAULT 0,
         cost_usd         NUMERIC(14,6) NOT NULL DEFAULT 0,
         created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS cost_ledger_tenant_window_idx
         ON cost_ledger (tenant_id, created_at DESC)`,
    ],
  },
  {
    version: 2,
    name: "langgraph checkpoint persistence",
    statements: [
      `CREATE TABLE IF NOT EXISTS checkpoints (
         thread_id            TEXT NOT NULL,
         checkpoint_ns        TEXT NOT NULL DEFAULT '',
         checkpoint_id        TEXT NOT NULL,
         parent_checkpoint_id TEXT,
         type                 TEXT,
         checkpoint           BYTEA NOT NULL,
         metadata             BYTEA NOT NULL,
         created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
       )`,
      `CREATE INDEX IF NOT EXISTS checkpoints_thread_idx
         ON checkpoints (thread_id, checkpoint_ns, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS checkpoint_writes (
         thread_id     TEXT NOT NULL,
         checkpoint_ns TEXT NOT NULL DEFAULT '',
         checkpoint_id TEXT NOT NULL,
         task_id       TEXT NOT NULL,
         idx           INTEGER NOT NULL,
         channel       TEXT NOT NULL,
         type          TEXT,
         value         BYTEA,
         PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
       )`,
    ],
  },
  {
    version: 3,
    name: "checkpoint monotonic sequence for deterministic ordering",
    statements: [
      // A monotonic insertion sequence guarantees a total order for "latest"
      // and pagination, independent of created_at ties (multiple checkpoints in
      // the same millisecond) or non-sortable checkpoint IDs.
      `ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
      `CREATE INDEX IF NOT EXISTS checkpoints_thread_seq_idx
         ON checkpoints (thread_id, checkpoint_ns, seq DESC)`,
    ],
  },
  {
    version: 4,
    name: "execution snapshots for time-travel replay",
    statements: [
      // Captures the input + final answer of a completed run so it can be
      // replayed later (optionally edited or against a different flow version).
      `CREATE TABLE IF NOT EXISTS execution_snapshots (
         execution_id  UUID PRIMARY KEY,
         flow_id       TEXT NOT NULL,
         messages      JSONB NOT NULL,
         metadata      JSONB,
         response_text TEXT NOT NULL DEFAULT '',
         created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS execution_snapshots_created_idx
         ON execution_snapshots (created_at DESC)`,
    ],
  },
  {
    version: 5,
    name: "online flow store (draft/publish + version history)",
    statements: [
      // Online-authored flows with a draft/publish lifecycle. `published` is
      // what the composite registry serves; `draft` is the editor's working
      // copy. Coexists with file-based flows (DB overrides a same-id file flow).
      `CREATE TABLE IF NOT EXISTS flows (
         id          TEXT PRIMARY KEY,
         name        TEXT NOT NULL DEFAULT '',
         draft       JSONB,
         published   JSONB,
         version     INTEGER NOT NULL DEFAULT 0,
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by  TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS flows_updated_idx ON flows (updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS flow_versions (
         flow_id      TEXT NOT NULL,
         version      INTEGER NOT NULL,
         definition   JSONB NOT NULL,
         published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         published_by TEXT,
         PRIMARY KEY (flow_id, version)
       )`,
    ],
  },
  {
    version: 6,
    name: "operator audit log",
    statements: [
      // Durable trail of operator-plane mutations (who did what, when, outcome).
      // Append-only; read by GET /monitoring/audit.
      `CREATE TABLE IF NOT EXISTS audit_log (
         id          BIGSERIAL PRIMARY KEY,
         actor       TEXT NOT NULL,
         role        TEXT,
         action      TEXT NOT NULL,
         target      TEXT,
         outcome     TEXT NOT NULL DEFAULT 'success',
         details     JSONB,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS audit_log_created_idx
         ON audit_log (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS audit_log_actor_idx
         ON audit_log (actor, created_at DESC)`,
    ],
  },
  {
    version: 7,
    name: "tenant and API key management + billing usage records",
    statements: [
      // Tenants — the billing/identity unit. One tenant maps to many API keys.
      `CREATE TABLE IF NOT EXISTS tenants (
         id                TEXT PRIMARY KEY,
         name              TEXT NOT NULL,
         plan              TEXT NOT NULL DEFAULT 'free',
         daily_budget_usd  NUMERIC(14,6),
         metadata          JSONB,
         created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      // API keys — the raw key is never stored; only a SHA-256 hash (hex) +
      // a display prefix (first 8 chars).
      `CREATE TABLE IF NOT EXISTS api_keys (
         id           TEXT PRIMARY KEY,
         tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
         name         TEXT NOT NULL,
         key_prefix   TEXT NOT NULL,
         key_hash     TEXT NOT NULL UNIQUE,
         status       TEXT NOT NULL DEFAULT 'active',
         last_used_at TIMESTAMPTZ,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         revoked_at   TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id)`,
      `CREATE INDEX IF NOT EXISTS api_keys_hash_idx   ON api_keys (key_hash)`,
      // Billing usage aggregations — one row per (tenant, day, provider, model).
      `CREATE TABLE IF NOT EXISTS billing_usage (
         id                BIGSERIAL PRIMARY KEY,
         tenant_id         TEXT NOT NULL,
         period_start      DATE NOT NULL,
         provider          TEXT,
         model             TEXT,
         prompt_tokens     BIGINT NOT NULL DEFAULT 0,
         completion_tokens BIGINT NOT NULL DEFAULT 0,
         cost_usd          NUMERIC(14,6) NOT NULL DEFAULT 0,
         request_count     INTEGER NOT NULL DEFAULT 0,
         UNIQUE (tenant_id, period_start, provider, model)
       )`,
      `CREATE INDEX IF NOT EXISTS billing_usage_tenant_period_idx
         ON billing_usage (tenant_id, period_start DESC)`,
    ],
  },
  {
    version: 8,
    name: "tenant BYOK provider keys (encrypted at rest)",
    statements: [
      // Per-tenant "bring your own key" provider credentials. The key is stored
      // ENCRYPTED (AES-256-GCM, see SecretCipher) — never plaintext — keyed by
      // (tenant, provider). One row per provider per tenant (upsert).
      `CREATE TABLE IF NOT EXISTS tenant_provider_keys (
         tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
         provider      TEXT NOT NULL,
         encrypted_key TEXT NOT NULL,
         updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (tenant_id, provider)
       )`,
    ],
  },
  {
    version: 9,
    name: "execution user attribution (user_name, user_prompt)",
    statements: [
      // Attribute each run to the end user and capture their prompt so the
      // dashboard request list can show who asked what. Populated from the
      // `__request__` boundary event.
      `ALTER TABLE executions ADD COLUMN IF NOT EXISTS user_name TEXT`,
      `ALTER TABLE executions ADD COLUMN IF NOT EXISTS user_prompt TEXT`,
    ],
  },
  {
    version: 10,
    name: "node_events detail columns (sequence, model, tokens, tool_calls, prompt/response, user attribution)",
    statements: [
      // Persist the full per-node detail the dashboard shows when a node is
      // selected. Without these, a run reloaded from the durable store had only
      // timing — no execution order (sequence), prompt/response, model/tokens,
      // tool calls, or the request boundary's user identity/prompt. `sequence`
      // also restores deterministic node ordering (the `__request__` boundary
      // node is sequence 0 and must lead the graph).
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS sequence INTEGER`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS model TEXT`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS input_tokens INTEGER`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS output_tokens INTEGER`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS tool_calls JSONB`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS prompt TEXT`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS response TEXT`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS user_name TEXT`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS user_prompt TEXT`,
    ],
  },
  {
    version: 11,
    name: "execution cost accounting (per-node + per-execution USD cost)",
    statements: [
      // Persist the estimated USD cost of each LLM call so the dashboard can
      // show per-node cost on reload, and the per-execution rollup so the
      // history list can show the total cost of each flow call. Prices come
      // from the flow's configured per-model pricing (see FlowDefinition.pricing)
      // falling back to the global/built-in pricing table.
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION`,
      `ALTER TABLE executions ADD COLUMN IF NOT EXISTS total_cost_usd DOUBLE PRECISION`,
    ],
  },
  {
    version: 12,
    name: "synthetic tool-call nodes (kind, parent_node_id, label)",
    statements: [
      // Each tool call now also surfaces as its own node in the live graph and
      // history. `kind` discriminates such synthetic nodes from real flow nodes,
      // `parent_node_id` records the node that issued the call (the edge the
      // dashboard draws), and `label` carries the tool name for display.
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS kind TEXT`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS parent_node_id TEXT`,
      `ALTER TABLE node_events ADD COLUMN IF NOT EXISTS label TEXT`,
    ],
  },
  {
    version: 13,
    name: "cost attribution by user + flow (spend breakdowns)",
    statements: [
      // Attribute each spend row to the authenticated user and the flow that
      // produced it, so the dashboard can break spend down per user and per
      // flow in addition to per tenant. All nullable: single-tenant/anonymous
      // deployments and pre-existing rows simply carry NULL.
      //   user_id    — stable identity (JWT `sub` / X-OpenWebUI-User-Id)
      //   user_label — display name/email captured at spend time (denormalised
      //                so the breakdown needs no join and survives user renames)
      //   flow_id    — the flow whose execution issued the LLM call
      `ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS user_id TEXT`,
      `ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS user_label TEXT`,
      `ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS flow_id TEXT`,
      `CREATE INDEX IF NOT EXISTS cost_ledger_user_window_idx
         ON cost_ledger (user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS cost_ledger_flow_window_idx
         ON cost_ledger (flow_id, created_at DESC)`,
    ],
  },
  {
    version: 14,
    name: "permanent per-request token-usage log",
    statements: [
      // Durable, one-row-per-request summary of token spend. Deliberately
      // SEPARATE from `executions`/`node_events` (which the retention purge
      // deletes) so the essential cost record survives indefinitely — only a
      // GDPR erase-by-subject removes rows. Keyed by execution_id and rolled
      // forward as node events arrive (INSERT on first event, accumulate on
      // each terminal node event), mirroring the executions rollup.
      //   flow_id / created_at        — which flow ran and when (request time)
      //   duration_ms                 — summed node wall-clock (like executions)
      //   prompt/completion/total     — token totals across the whole request
      //   model                       — last LLM model used in the request
      //   user_id / user_label        — who triggered it (id + display)
      //   prompt_preview              — first N chars of the user's prompt
      //   cost_usd                    — estimated total cost of the request
      `CREATE TABLE IF NOT EXISTS token_usage_log (
         execution_id      UUID PRIMARY KEY,
         flow_id           TEXT,
         tenant_id         TEXT,
         user_id           TEXT,
         user_label        TEXT,
         model             TEXT,
         prompt_tokens     INTEGER NOT NULL DEFAULT 0,
         completion_tokens INTEGER NOT NULL DEFAULT 0,
         total_tokens      INTEGER NOT NULL DEFAULT 0,
         cost_usd          NUMERIC(14,6) NOT NULL DEFAULT 0,
         duration_ms       INTEGER NOT NULL DEFAULT 0,
         prompt_preview    TEXT,
         created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
         finished_at       TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS token_usage_log_created_idx
         ON token_usage_log (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS token_usage_log_flow_idx
         ON token_usage_log (flow_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS token_usage_log_user_idx
         ON token_usage_log (user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS token_usage_log_tenant_idx
         ON token_usage_log (tenant_id, created_at DESC)`,
    ],
  },
  {
    version: 15,
    name: "configurable token limits (period x scope x model)",
    statements: [
      // Operator-configured token budgets. Each row is one limit rule:
      //   scope_type  — 'global' | 'user' | 'flow'
      //   scope_id    — the user_id / flow_id it applies to (NULL for global)
      //   model       — the model it applies to (NULL = all models)
      //   period      — rolling window the limit is measured over: day/week/month
      //   limit_tokens— max total tokens (prompt+completion) allowed in the window
      // Consumption is computed on demand by summing `cost_ledger` over the
      // matching scope/model within the period window, so no counters to keep.
      `CREATE TABLE IF NOT EXISTS token_limits (
         id           UUID PRIMARY KEY,
         scope_type   TEXT NOT NULL,
         scope_id     TEXT,
         model        TEXT,
         period       TEXT NOT NULL,
         limit_tokens BIGINT NOT NULL,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      // One limit per (scope, model, period) combination. COALESCE folds the
      // nullable scope_id/model so 'global'/'all models' also dedupe correctly.
      `CREATE UNIQUE INDEX IF NOT EXISTS token_limits_combo_idx
         ON token_limits (scope_type, COALESCE(scope_id, ''), COALESCE(model, ''), period)`,
    ],
  },
  {
    version: 16,
    name: "execution_snapshots tenant_id column for RLS enforcement",
    statements: [
      // The RLS policy on execution_snapshots references `tenant_id`; add the
      // column so the tenant isolation policy can be enforced consistently.
      // Nullable so pre-existing rows and anonymous requests continue to work.
      `ALTER TABLE execution_snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT`,
      `CREATE INDEX IF NOT EXISTS execution_snapshots_tenant_idx
         ON execution_snapshots (tenant_id, created_at DESC)`,
    ],
  },
  {
    version: 17,
    name: "durable autopilot run history (drift-guard survives restarts)",
    statements: [
      // Persists every Continuous Safety & Quality Autopilot cycle so the
      // drift-guard's "automatic promotions per flow within the window" count
      // is not lost on a process restart (see autopilot-run-history.ts).
      `CREATE TABLE IF NOT EXISTS autopilot_runs (
         id                     TEXT PRIMARY KEY,
         flow_id                TEXT NOT NULL,
         trigger                TEXT NOT NULL,
         started_at             TIMESTAMPTZ NOT NULL,
         finished_at            TIMESTAMPTZ,
         status                 TEXT NOT NULL,
         bypass_rate            DOUBLE PRECISION,
         optimizer_run_id       TEXT,
         canary_registered      BOOLEAN,
         promoted_version       INTEGER,
         optimization_goal      TEXT,
         trigger_signal         TEXT,
         measured_error_rate    DOUBLE PRECISION,
         measured_p95_ms        DOUBLE PRECISION,
         measured_quality_score DOUBLE PRECISION,
         error                  TEXT,
         created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS autopilot_runs_flow_started_idx
         ON autopilot_runs (flow_id, started_at DESC)`,
    ],
  },
  {
    version: 18,
    name: "tamper-evident audit log hash chain",
    statements: [
      // Each audit_log row now carries `hash` (a digest over the row's own
      // fields plus `prev_hash`) and `prev_hash` (the previous row's `hash`),
      // forming a linear hash chain. Tampering with, deleting, or reordering
      // any historical row breaks the chain from that point forward, which
      // `verifyChain()` detects. See src/observability/audit-log.ts.
      `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash TEXT`,
      `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT`,
      `CREATE INDEX IF NOT EXISTS audit_log_hash_idx ON audit_log (hash)`,
    ],
  },
  {
    version: 19,
    name: "reversible PII tokenization vault",
    statements: [
      // Holds the token→plaintext mapping the PII vault creates when it
      // tokenizes user-supplied PII before it reaches an LLM provider (see
      // src/graph/pii-vault.ts). `encrypted_value` is AES-256-GCM ciphertext
      // (SecretCipher) — never plaintext. Scoped by `execution_id` (one run)
      // and, when known, `tenant_id` (for right-to-be-forgotten erasure).
      // Entries are purged as soon as their run finishes streaming (best
      // effort); `created_at` backs an age-based purge as a safety net for
      // orphaned entries from a crashed/abandoned run.
      `CREATE TABLE IF NOT EXISTS pii_vault_entries (
         token           TEXT PRIMARY KEY,
         execution_id    UUID NOT NULL,
         tenant_id       TEXT,
         pii_type        TEXT NOT NULL,
         encrypted_value TEXT NOT NULL,
         created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS pii_vault_entries_execution_idx
         ON pii_vault_entries (execution_id)`,
      `CREATE INDEX IF NOT EXISTS pii_vault_entries_tenant_idx
         ON pii_vault_entries (tenant_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS pii_vault_entries_created_idx
         ON pii_vault_entries (created_at DESC)`,
    ],
  },
  {
    version: 20,
    name: "eval run history (compliance dossier evidence)",
    statements: [
      // Durable home for completed eval runs (see src/eval/eval-run-history.ts).
      // The eval CLI (see src/eval/run.ts, typically run from a scheduled CI
      // job) has no durable store of its own; recording a run here lets the
      // compliance dossier cite "this flow/dataset was last evaluated on
      // <date> with pass rate <x>%" as quality-assurance evidence.
      `CREATE TABLE IF NOT EXISTS eval_runs (
         id           TEXT PRIMARY KEY,
         name         TEXT NOT NULL,
         source       TEXT NOT NULL DEFAULT 'manual',
         recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
         report       JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS eval_runs_name_recorded_idx
         ON eval_runs (name, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS eval_runs_recorded_idx
         ON eval_runs (recorded_at DESC)`,
    ],
  },
  {
    version: 21,
    name: "currency-neutral cost/budget column naming (drop _usd suffix)",
    statements: [
      // Naming hygiene only — values are unchanged, still the same currency
      // as before (USD by convention). Column renames are cheap metadata-only
      // operations in Postgres (no table rewrite), but MUST land in the same
      // deploy as the matching code change (src/monitoring/execution-store.ts,
      // src/observability/{cost,billing}.ts, src/graph/tenant-manager.ts) —
      // this is a synchronous rename, not a dual-write migration.
      `ALTER TABLE cost_ledger RENAME COLUMN cost_usd TO cost`,
      `ALTER TABLE executions RENAME COLUMN total_cost_usd TO total_cost`,
      `ALTER TABLE node_events RENAME COLUMN cost_usd TO cost`,
      `ALTER TABLE tenants RENAME COLUMN daily_budget_usd TO daily_budget`,
      `ALTER TABLE billing_usage RENAME COLUMN cost_usd TO cost`,
      `ALTER TABLE token_usage_log RENAME COLUMN cost_usd TO cost`,
      // eval_runs.report is a JSONB blob (src/eval/eval-runner.ts's EvalReport),
      // not a column — rewrite the embedded keys in place: top-level
      // totalCostUsd -> totalCost, and costUsd -> cost inside every element of
      // the cases array. jsonb_strip_nulls cleans up a stray null key on rows
      // where the source key was already absent (defensive; every row is
      // expected to have both keys per EvalReport's TS shape).
      `UPDATE eval_runs
         SET report = jsonb_strip_nulls(
           (report - 'totalCostUsd')
           || jsonb_build_object('totalCost', report->'totalCostUsd')
           || CASE
                -- Legacy or manually imported reports can contain cases as a
                -- scalar (for example JSON null or an object). Only arrays can be
                -- expanded; preserving every other shape keeps this upgrade
                -- lossless and prevents a scalar extraction error.
              WHEN jsonb_typeof(report->'cases') = 'array' THEN jsonb_build_object(
                  'cases',
                  COALESCE(
                    (
                      SELECT jsonb_agg(
                        jsonb_strip_nulls(
                          (elem - 'costUsd')
                          || jsonb_build_object('cost', elem->'costUsd')
                        )
                      )
                      FROM jsonb_array_elements(report->'cases') AS elem
                    ),
                    report->'cases'
                  )
                )
                ELSE '{}'::jsonb
              END
         )
       WHERE report ? 'totalCostUsd' OR report ? 'cases'`,
    ],
  },
  {
    version: 22,
    name: "PII vault detector provenance (ADR-0015)",
    statements: [
      // Records WHICH detector produced each tokenized PII span (regex, an NER
      // model, or an external service). Nullable: entries written by the legacy
      // regex-only path before this column existed, or by callers that do not
      // supply provenance, leave it NULL. Feeds per-detector audit/compliance
      // reporting (which model version flagged which value). See
      // src/graph/pii-detector.ts and docs/adr/0015-extensible-pii-detector-pipeline.md.
      `ALTER TABLE pii_vault_entries ADD COLUMN IF NOT EXISTS detector TEXT`,
    ],
  },
  {
    version: 23,
    name: "per-user assistants — identity axis, soul, skills, workspace, delegation, messaging",
    statements: [
      // -----------------------------------------------------------------------
      // assistants — the identity axis
      // -----------------------------------------------------------------------
      // An assistant is a durable ENTITY, not a request. Everything that makes
      // one individual (soul, memory, skills, workspace, credentials) hangs off
      // this row, so provisioning a new assistant is "insert a row + create a
      // directory" and never "author a new flow". One generic flow serves every
      // assistant; per-assistant behaviour is state, never configuration.
      //
      // The (tenant_id, user_id, assistant_id) triple is the isolation boundary
      // enforced everywhere downstream. `tenant_id` uses the '_' sentinel rather
      // than NULL because it participates in the primary key and in RLS
      // predicates: a NULL there would make two single-tenant assistants of the
      // same user non-distinct under SQL NULL semantics.
      `CREATE TABLE IF NOT EXISTS assistants (
         tenant_id      TEXT NOT NULL DEFAULT '_',
         user_id        TEXT NOT NULL,
         assistant_id   TEXT NOT NULL,
         display_name   TEXT NOT NULL DEFAULT '',
         status         TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'archived')),
         flow_id        TEXT,
         workspace_path TEXT NOT NULL,
         autonomy       TEXT NOT NULL DEFAULT 'supervised'
                        CHECK (autonomy IN ('supervised', 'assisted', 'autonomous')),
         created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
         last_active_at TIMESTAMPTZ,
         PRIMARY KEY (tenant_id, user_id, assistant_id)
       )`,
      `CREATE INDEX IF NOT EXISTS assistants_user_idx
         ON assistants (tenant_id, user_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS assistants_active_idx
         ON assistants (status, last_active_at DESC)`,

      // -----------------------------------------------------------------------
      // assistant_souls — three write classes in one document
      // -----------------------------------------------------------------------
      // `identity` is agent-writable (it may rename itself, change its vibe).
      // `directives` is user-writable only. `constraints` is operator-writable
      // only. Keeping them as three columns instead of one blob is what makes
      // the write-class boundary enforceable in SQL rather than by convention:
      // an agent-initiated update statement literally cannot name the other
      // two columns (see soul-store.ts).
      //
      // `revision` + `revision_hash` form an optimistic lock: every mutation
      // states the revision it read, and a concurrent writer's mutation is
      // refused instead of silently clobbering. Without this an agent editing
      // its identity while the user edits directives loses one of the writes.
      `CREATE TABLE IF NOT EXISTS assistant_souls (
         tenant_id     TEXT NOT NULL DEFAULT '_',
         user_id       TEXT NOT NULL,
         assistant_id  TEXT NOT NULL,
         identity      JSONB NOT NULL DEFAULT '{}'::jsonb,
         directives    JSONB NOT NULL DEFAULT '{}'::jsonb,
         constraints   JSONB NOT NULL DEFAULT '{}'::jsonb,
         revision      INTEGER NOT NULL DEFAULT 1,
         revision_hash TEXT NOT NULL,
         updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (tenant_id, user_id, assistant_id)
       )`,
      // Append-only revision history. Retains the FULL prior document (not a
      // diff) so a rollback needs no replay and a compliance question — "what
      // was this assistant instructed to do on date X" — is a single row read.
      `CREATE TABLE IF NOT EXISTS assistant_soul_revisions (
         id            BIGSERIAL PRIMARY KEY,
         tenant_id     TEXT NOT NULL DEFAULT '_',
         user_id       TEXT NOT NULL,
         assistant_id  TEXT NOT NULL,
         revision      INTEGER NOT NULL,
         revision_hash TEXT NOT NULL,
         write_class   TEXT NOT NULL
                       CHECK (write_class IN ('identity', 'directives', 'constraints')),
         actor_type    TEXT NOT NULL
                       CHECK (actor_type IN ('agent', 'user', 'operator', 'system')),
         actor_id      TEXT,
         identity      JSONB NOT NULL,
         directives    JSONB NOT NULL,
         constraints   JSONB NOT NULL,
         reason        TEXT,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (tenant_id, user_id, assistant_id, revision)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_soul_revisions_scope_idx
         ON assistant_soul_revisions (tenant_id, user_id, assistant_id, revision DESC)`,

      // -----------------------------------------------------------------------
      // assistant_skills — live, applied procedures
      // -----------------------------------------------------------------------
      // `trigger_line` is the ONLY part injected into every prompt (progressive
      // disclosure); `body` is read on demand through the skill_read tool. That
      // split is the reason a hundred learned skills do not destroy the prompt
      // cache. `sort_key` keeps prompt ordering deterministic across processes:
      // iteration order of a Map or a hash-ordered SELECT would change the
      // cacheable prefix on every restart.
      `CREATE TABLE IF NOT EXISTS assistant_skills (
         id            UUID PRIMARY KEY,
         tenant_id     TEXT NOT NULL DEFAULT '_',
         user_id       TEXT NOT NULL,
         assistant_id  TEXT NOT NULL,
         name          TEXT NOT NULL,
         trigger_line  TEXT NOT NULL,
         body          TEXT NOT NULL,
         body_hash     TEXT NOT NULL,
         version       INTEGER NOT NULL DEFAULT 1,
         sort_key      TEXT NOT NULL,
         status        TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'canary', 'retired')),
         origin        TEXT NOT NULL DEFAULT 'learned'
                       CHECK (origin IN ('learned', 'user', 'operator', 'template')),
         use_count     INTEGER NOT NULL DEFAULT 0,
         last_used_at  TIMESTAMPTZ,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (tenant_id, user_id, assistant_id, name)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_skills_scope_idx
         ON assistant_skills (tenant_id, user_id, assistant_id, status, sort_key)`,

      // -----------------------------------------------------------------------
      // assistant_skill_proposals — the learning state machine
      // -----------------------------------------------------------------------
      // pending → applied | rejected | quarantined | stale
      //
      // Nothing a learning pass produces goes live directly. `revision_hash` is
      // an optimistic lock so a reviewer revising a proposal cannot overwrite a
      // concurrent operator decision. `scan_state` gates apply on a completed
      // safety scan — a proposal whose scan failed can never be applied, which
      // is the boundary that makes autonomous capture acceptable at all.
      `CREATE TABLE IF NOT EXISTS assistant_skill_proposals (
         id             UUID PRIMARY KEY,
         tenant_id      TEXT NOT NULL DEFAULT '_',
         user_id        TEXT NOT NULL,
         assistant_id   TEXT NOT NULL,
         kind           TEXT NOT NULL CHECK (kind IN ('create', 'update')),
         status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'applied', 'rejected', 'quarantined', 'stale')),
         target_skill   TEXT NOT NULL,
         target_skill_id UUID,
         title          TEXT NOT NULL,
         trigger_line   TEXT NOT NULL,
         body           TEXT NOT NULL,
         body_hash      TEXT NOT NULL,
         revision       INTEGER NOT NULL DEFAULT 1,
         revision_hash  TEXT NOT NULL,
         goal           TEXT,
         evidence       TEXT,
         autonomous_capture BOOLEAN NOT NULL DEFAULT false,
         created_by     TEXT NOT NULL DEFAULT 'experience-review'
                        CHECK (created_by IN ('experience-review', 'user', 'operator', 'api')),
         scan_state     TEXT NOT NULL DEFAULT 'pending'
                        CHECK (scan_state IN ('pending', 'clean', 'failed', 'quarantined')),
         scan_findings  JSONB,
         origin_execution_id UUID,
         origin_run_id  TEXT,
         status_reason  TEXT,
         created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
         decided_at     TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_skill_proposals_scope_idx
         ON assistant_skill_proposals (tenant_id, user_id, assistant_id, status, created_at DESC)`,
      // Bounds autonomous capture per assistant: the pending-count check reads
      // this index rather than scanning the table on every learning pass.
      `CREATE INDEX IF NOT EXISTS assistant_skill_proposals_pending_idx
         ON assistant_skill_proposals (tenant_id, user_id, assistant_id)
         WHERE status = 'pending'`,

      // Append-only event log. The proposals table holds current state; this
      // holds how it got there. Separated because state is mutated and history
      // must not be: an audit answer built from a mutable row is not evidence.
      `CREATE TABLE IF NOT EXISTS assistant_skill_proposal_events (
         sequence      BIGSERIAL PRIMARY KEY,
         proposal_id   UUID NOT NULL REFERENCES assistant_skill_proposals(id) ON DELETE CASCADE,
         event_type    TEXT NOT NULL CHECK (event_type IN (
                         'created', 'revised', 'scanned', 'applied',
                         'rejected', 'quarantined', 'stale', 'canary_started',
                         'canary_promoted', 'canary_rolled_back'
                       )),
         revision      INTEGER NOT NULL,
         revision_hash TEXT NOT NULL,
         actor_type    TEXT NOT NULL
                       CHECK (actor_type IN ('agent', 'user', 'operator', 'system')),
         actor_id      TEXT,
         payload       JSONB,
         occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_skill_proposal_events_proposal_idx
         ON assistant_skill_proposal_events (proposal_id, sequence)`,

      // Rollback record written BEFORE a proposal is applied, holding the exact
      // prior skill content. Every apply is therefore reversible without
      // consulting the event log or replaying revisions — the property that
      // makes auto-apply of a learned skill a recoverable decision.
      `CREATE TABLE IF NOT EXISTS assistant_skill_rollbacks (
         proposal_id      UUID PRIMARY KEY REFERENCES assistant_skill_proposals(id) ON DELETE CASCADE,
         skill_id         UUID,
         action           TEXT NOT NULL CHECK (action IN ('create', 'update')),
         previous_name    TEXT,
         previous_trigger TEXT,
         previous_body    TEXT,
         previous_version INTEGER,
         written_at       TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,

      // -----------------------------------------------------------------------
      // assistant_skill_canaries — staged rollout of a learned skill
      // -----------------------------------------------------------------------
      // A newly learned skill is injected into only a fraction of the
      // assistant's turns while outcomes are recorded per arm. The regression
      // decision reuses the same statistics the flow-level CanaryManager uses;
      // only the unit differs (a skill of one assistant, not a flow version for
      // all traffic).
      `CREATE TABLE IF NOT EXISTS assistant_skill_canaries (
         skill_id        UUID PRIMARY KEY REFERENCES assistant_skills(id) ON DELETE CASCADE,
         tenant_id       TEXT NOT NULL DEFAULT '_',
         user_id         TEXT NOT NULL,
         assistant_id    TEXT NOT NULL,
         traffic_percent INTEGER NOT NULL DEFAULT 50
                         CHECK (traffic_percent BETWEEN 0 AND 100),
         treatment_runs  INTEGER NOT NULL DEFAULT 0,
         treatment_errors INTEGER NOT NULL DEFAULT 0,
         treatment_score_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
         control_runs    INTEGER NOT NULL DEFAULT 0,
         control_errors  INTEGER NOT NULL DEFAULT 0,
         control_score_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
         state           TEXT NOT NULL DEFAULT 'running'
                         CHECK (state IN ('running', 'promoted', 'rolled-back')),
         started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
         decided_at      TIMESTAMPTZ,
         decision_reason TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_skill_canaries_scope_idx
         ON assistant_skill_canaries (tenant_id, user_id, assistant_id, state)`,

      // -----------------------------------------------------------------------
      // assistant_credentials — delegated offline grant
      // -----------------------------------------------------------------------
      // An autonomous assistant runs precisely when its user is absent, so the
      // request-scoped SSO token is unavailable. This holds an OIDC refresh
      // token (offline_access) obtained with the user's explicit consent,
      // ENCRYPTED at rest (AES-256-GCM, SecretCipher — same treatment as BYOK
      // provider keys). Access tokens are fetched on demand and never stored.
      //
      // `scope` records what the user actually consented to delegate, so an
      // autonomous run cannot silently gain the full interactive scope set.
      `CREATE TABLE IF NOT EXISTS assistant_credentials (
         tenant_id        TEXT NOT NULL DEFAULT '_',
         user_id          TEXT NOT NULL,
         assistant_id     TEXT NOT NULL,
         issuer           TEXT NOT NULL,
         encrypted_refresh_token TEXT NOT NULL,
         scope            TEXT NOT NULL DEFAULT '',
         subject          TEXT,
         expires_at       TIMESTAMPTZ,
         granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
         granted_by       TEXT,
         revoked_at       TIMESTAMPTZ,
         last_refreshed_at TIMESTAMPTZ,
         refresh_failures INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (tenant_id, user_id, assistant_id, issuer)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_credentials_scope_idx
         ON assistant_credentials (tenant_id, user_id, assistant_id)
         WHERE revoked_at IS NULL`,

      // -----------------------------------------------------------------------
      // assistant_grants + assistant_messages — agent-to-agent exchange
      // -----------------------------------------------------------------------
      // A message between assistants crosses an isolation boundary, so it is
      // NOT a direct call. The sender may only enqueue when a grant exists that
      // the RECEIVING side's user authorised. The receiver then processes the
      // message in its own run, with its own credentials, treating the body as
      // untrusted evidence.
      `CREATE TABLE IF NOT EXISTS assistant_grants (
         id             UUID PRIMARY KEY,
         from_tenant_id TEXT NOT NULL DEFAULT '_',
         from_user_id   TEXT NOT NULL,
         from_assistant_id TEXT NOT NULL,
         to_tenant_id   TEXT NOT NULL DEFAULT '_',
         to_user_id     TEXT NOT NULL,
         to_assistant_id TEXT NOT NULL,
         scope          TEXT NOT NULL DEFAULT 'message'
                        CHECK (scope IN ('message', 'message+read')),
         granted_by     TEXT NOT NULL,
         note           TEXT,
         created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
         expires_at     TIMESTAMPTZ,
         revoked_at     TIMESTAMPTZ,
         UNIQUE (from_tenant_id, from_user_id, from_assistant_id,
                 to_tenant_id, to_user_id, to_assistant_id)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_grants_to_idx
         ON assistant_grants (to_tenant_id, to_user_id, to_assistant_id)
         WHERE revoked_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS assistant_messages (
         id             UUID PRIMARY KEY,
         grant_id       UUID NOT NULL REFERENCES assistant_grants(id) ON DELETE CASCADE,
         from_tenant_id TEXT NOT NULL DEFAULT '_',
         from_user_id   TEXT NOT NULL,
         from_assistant_id TEXT NOT NULL,
         to_tenant_id   TEXT NOT NULL DEFAULT '_',
         to_user_id     TEXT NOT NULL,
         to_assistant_id TEXT NOT NULL,
         subject        TEXT NOT NULL DEFAULT '',
         body           TEXT NOT NULL,
         correlation_id UUID,
         status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'delivered', 'failed', 'expired')),
         delivered_at   TIMESTAMPTZ,
         delivery_error TEXT,
         created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_messages_inbox_idx
         ON assistant_messages (to_tenant_id, to_user_id, to_assistant_id, status, created_at)`,
      `CREATE INDEX IF NOT EXISTS assistant_messages_correlation_idx
         ON assistant_messages (correlation_id)`,

      // -----------------------------------------------------------------------
      // assistant_turns — recorded facts about each turn
      // -----------------------------------------------------------------------
      // The learning pass must decide "was this turn worth learning from" and
      // the canary must attribute an outcome to an arm. Both questions are
      // answered from a fact RECORDED at the turn boundary rather than inferred
      // later by combining node events, token counts and error strings — an
      // inference that rots as soon as a sibling node path changes.
      `CREATE TABLE IF NOT EXISTS assistant_turns (
         execution_id   UUID PRIMARY KEY,
         tenant_id      TEXT NOT NULL DEFAULT '_',
         user_id        TEXT NOT NULL,
         assistant_id   TEXT NOT NULL,
         model_iterations INTEGER NOT NULL DEFAULT 0,
         tool_calls     INTEGER NOT NULL DEFAULT 0,
         succeeded      BOOLEAN NOT NULL DEFAULT true,
         aborted        BOOLEAN NOT NULL DEFAULT false,
         errored        BOOLEAN NOT NULL DEFAULT false,
         trigger        TEXT NOT NULL DEFAULT 'user',
         stop_reason    TEXT,
         canary_skill_ids JSONB,
         reviewed       BOOLEAN NOT NULL DEFAULT false,
         created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_turns_review_idx
         ON assistant_turns (tenant_id, user_id, assistant_id, created_at DESC)
         WHERE reviewed = false`,
    ],
  },
  {
    version: 24,
    name: "api_keys expiry (opt-in TTL for managed API keys)",
    statements: [
      // Nullable: an existing key (or one created without an explicit TTL)
      // never expires, matching the pre-expiry behaviour exactly. Enforcement
      // lives in `TenantManager.lookupByApiKey` (src/graph/tenant-manager.ts),
      // which now treats a key with a past `expires_at` as invalid — the
      // column existed in the schema comments/docs before this migration but
      // was never actually created or checked, so every key was effectively
      // permanent regardless of intent.
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
      // Speeds up an optional periodic sweep that reports/revokes keys past
      // their expiry (operational hygiene; lookupByApiKey does not need it —
      // it already filters by key_hash first).
      `CREATE INDEX IF NOT EXISTS api_keys_expires_at_idx
         ON api_keys (expires_at) WHERE expires_at IS NOT NULL`,
    ],
  },
  {
    version: 25,
    name: "org_skills — tenant-wide curated skill catalog",
    statements: [
      // A CATALOG SNAPSHOT, not a live reference to `assistant_skills`: no FK
      // to that table, deliberately. `SkillRecord` is versioned/canaried per
      // (tenant,user,assistant) scope, and a live reference would mean a
      // rollback of the ORIGIN assistant's skill silently affects every
      // assistant that installed from this entry — not what "install a
      // proven technique" should mean. `source_user_id`/`source_assistant_id`
      // are kept for provenance/attribution only.
      `CREATE TABLE IF NOT EXISTS org_skills (
         id                   UUID PRIMARY KEY,
         tenant_id            TEXT NOT NULL DEFAULT '_',
         name                 TEXT NOT NULL,
         trigger_line         TEXT NOT NULL,
         body                 TEXT NOT NULL,
         body_hash            TEXT NOT NULL,
         visibility           TEXT NOT NULL DEFAULT 'tenant'
                              CHECK (visibility IN ('tenant')),
         status               TEXT NOT NULL DEFAULT 'published'
                              CHECK (status IN ('published', 'deprecated')),
         source_user_id       TEXT NOT NULL,
         source_assistant_id  TEXT NOT NULL,
         published_by         TEXT NOT NULL,
         summary              TEXT,
         evidence             TEXT,
         install_count        INTEGER NOT NULL DEFAULT 0,
         created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      // Browsing is always scoped to one tenant and (by default) published-
      // only, ordered newest-first — this index covers exactly that query.
      `CREATE INDEX IF NOT EXISTS org_skills_tenant_status_idx
         ON org_skills (tenant_id, status, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS org_skills_tenant_name_idx
         ON org_skills (tenant_id, name)`,
    ],
  },
  {
    version: 26,
    name: "execution conversation identifiers",
    statements: [
      `ALTER TABLE executions ADD COLUMN IF NOT EXISTS conversation_id TEXT`,
      `ALTER TABLE executions ADD COLUMN IF NOT EXISTS chat_id TEXT`,
      `ALTER TABLE executions ADD COLUMN IF NOT EXISTS session_id TEXT`,
      `CREATE INDEX IF NOT EXISTS executions_conversation_idx
         ON executions (conversation_id, started_at ASC)
         WHERE conversation_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS executions_chat_idx
         ON executions (chat_id, started_at ASC)
         WHERE conversation_id IS NULL AND chat_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS executions_session_idx
         ON executions (session_id, started_at ASC)
         WHERE conversation_id IS NULL AND chat_id IS NULL AND session_id IS NOT NULL`,
    ],
  },
  {
    version: 27,
    name: "assistant sessions — durable transcript and pre-tool journal",
    statements: [
      `CREATE TABLE IF NOT EXISTS assistant_sessions (
         tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL,
         assistant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
         last_sequence BIGINT NOT NULL DEFAULT 0,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (tenant_id, user_id, assistant_id, conversation_id)
       )`,
      `CREATE TABLE IF NOT EXISTS assistant_session_events (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL,
         assistant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sequence BIGINT NOT NULL,
         execution_id UUID NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'event')),
         name TEXT, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
         UNIQUE (tenant_id, user_id, assistant_id, conversation_id, sequence)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_session_events_scope_idx
         ON assistant_session_events (tenant_id, user_id, assistant_id, conversation_id, sequence DESC)`,
      `CREATE INDEX IF NOT EXISTS assistant_session_events_search_idx
         ON assistant_session_events USING GIN (search_document)`,
      `CREATE TABLE IF NOT EXISTS assistant_tool_journal (
         tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
         conversation_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, execution_id UUID NOT NULL,
         tool_name TEXT NOT NULL, args JSONB NOT NULL, status TEXT NOT NULL
           CHECK (status IN ('pending', 'completed', 'failed')),
         result JSONB, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
         PRIMARY KEY (tenant_id, user_id, assistant_id, conversation_id, tool_call_id)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_tool_journal_recovery_idx
         ON assistant_tool_journal (tenant_id, user_id, assistant_id, status, created_at)
         WHERE status = 'pending'`,
    ],
  },
  {
    version: 28,
    name: "assistant session lifecycle — lineage, snapshots and durable tool recovery",
    statements: [
      `ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS parent_conversation_id TEXT`,
      `ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS forked_from_sequence BIGINT`,
      `ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS title TEXT`,
      `ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
      `CREATE INDEX IF NOT EXISTS assistant_sessions_scope_updated_idx
         ON assistant_sessions (tenant_id, user_id, assistant_id, updated_at DESC)
         WHERE deleted_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS assistant_session_snapshots (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL,
         assistant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sequence BIGINT NOT NULL,
         kind TEXT NOT NULL CHECK (kind IN ('summary', 'checkpoint')), content TEXT NOT NULL,
         source_from_sequence BIGINT, source_to_sequence BIGINT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_session_snapshots_scope_idx
         ON assistant_session_snapshots (tenant_id, user_id, assistant_id, conversation_id, sequence DESC)`,
      `ALTER TABLE assistant_session_events ADD COLUMN IF NOT EXISTS event_kind TEXT NOT NULL DEFAULT 'transcript'`,
      `ALTER TABLE assistant_tool_journal ADD COLUMN IF NOT EXISTS operation_id TEXT`,
      `ALTER TABLE assistant_tool_journal ADD COLUMN IF NOT EXISTS sequence BIGINT`,
      `ALTER TABLE assistant_tool_journal ADD COLUMN IF NOT EXISTS approval_id TEXT`,
      `ALTER TABLE assistant_tool_journal ADD COLUMN IF NOT EXISTS lease_owner TEXT`,
      `ALTER TABLE assistant_tool_journal ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
      `ALTER TABLE assistant_tool_journal ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE assistant_tool_journal ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `ALTER TABLE assistant_tool_journal DROP CONSTRAINT IF EXISTS assistant_tool_journal_status_check`,
      `ALTER TABLE assistant_tool_journal ADD CONSTRAINT assistant_tool_journal_status_check
         CHECK (status IN ('planned', 'awaiting_approval', 'pending', 'running', 'completed', 'failed', 'cancelled', 'unknown'))`,
      `UPDATE assistant_tool_journal SET operation_id = tool_call_id WHERE operation_id IS NULL`,
      `UPDATE assistant_tool_journal SET sequence = 0 WHERE sequence IS NULL`,
      `ALTER TABLE assistant_tool_journal ALTER COLUMN operation_id SET NOT NULL`,
      `ALTER TABLE assistant_tool_journal ALTER COLUMN sequence SET NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_tool_journal_operation_idx
         ON assistant_tool_journal (tenant_id, user_id, assistant_id, operation_id)`,
      `CREATE INDEX IF NOT EXISTS assistant_tool_journal_lease_idx
         ON assistant_tool_journal (tenant_id, user_id, assistant_id, lease_expires_at)
         WHERE status IN ('pending', 'running')`,
      `CREATE TABLE IF NOT EXISTS assistant_mirror_outbox (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL,
         assistant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id UUID NOT NULL,
         payload JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         delivered_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_mirror_outbox_event_idx
         ON assistant_mirror_outbox (tenant_id, event_id)`,
      `CREATE INDEX IF NOT EXISTS assistant_mirror_outbox_pending_idx
         ON assistant_mirror_outbox (available_at ASC) WHERE delivered_at IS NULL`,
    ],
  },
  {
    version: 29,
    name: "assistant mirror delivery leases",
    statements: [
      `ALTER TABLE assistant_mirror_outbox ADD COLUMN IF NOT EXISTS lease_owner TEXT`,
      `ALTER TABLE assistant_mirror_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
      `CREATE INDEX IF NOT EXISTS assistant_mirror_outbox_lease_idx
         ON assistant_mirror_outbox (available_at, lease_expires_at) WHERE delivered_at IS NULL`,
    ],
  },
  {
    version: 30,
    name: "durable assistant runs and at-most-once schedules",
    statements: [
      `CREATE TABLE IF NOT EXISTS assistant_runs (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
         parent_run_id UUID REFERENCES assistant_runs(id), idempotency_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
           CHECK (status IN ('queued','running','completed','failed','cancelled')), attempt INTEGER NOT NULL DEFAULT 0,
         max_attempts INTEGER NOT NULL DEFAULT 1, lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
         resume_payload JSONB NOT NULL, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (tenant_id,user_id,assistant_id,idempotency_key)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_runs_recovery_idx ON assistant_runs (lease_expires_at) WHERE status = 'running'`,
      `CREATE TABLE IF NOT EXISTS assistant_schedules (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
         due_at TIMESTAMPTZ NOT NULL, slot TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, resume_payload JSONB NOT NULL,
         lease_owner TEXT, lease_expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_schedules_due_idx ON assistant_schedules (due_at) WHERE enabled`,
    ],
  },
  {
    version: 31,
    name: "recurring assistant schedules and claimable run attempts",
    statements: [
      `ALTER TABLE assistant_runs ALTER COLUMN attempt SET DEFAULT 0`,
      `UPDATE assistant_runs SET attempt = 0
         WHERE status = 'queued' AND attempt = max_attempts AND attempt = 1`,
      `ALTER TABLE assistant_schedules ADD COLUMN IF NOT EXISTS cron_expression TEXT`,
      `ALTER TABLE assistant_schedules ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'`,
      `ALTER TABLE assistant_schedules ADD CONSTRAINT assistant_schedules_timezone_check CHECK (timezone = 'UTC')`,
    ],
  },
  {
    version: 32,
    name: "assistant run ownership and snapshot idempotency",
    statements: [
      `ALTER TABLE assistant_schedules ADD COLUMN IF NOT EXISTS last_error TEXT`,
      `ALTER TABLE assistant_session_snapshots ADD COLUMN IF NOT EXISTS content_fingerprint TEXT`,
      `UPDATE assistant_session_snapshots
          SET content_fingerprint = encode(sha256(convert_to(content, 'UTF8')), 'hex')
        WHERE content_fingerprint IS NULL`,
      `DELETE FROM assistant_session_snapshots a
        USING assistant_session_snapshots b
        WHERE a.ctid < b.ctid
          AND a.tenant_id = b.tenant_id AND a.user_id = b.user_id
          AND a.assistant_id = b.assistant_id AND a.conversation_id = b.conversation_id
          AND a.sequence = b.sequence AND a.kind = b.kind
          AND a.content_fingerprint = b.content_fingerprint`,
      `ALTER TABLE assistant_session_snapshots ALTER COLUMN content_fingerprint SET NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_session_snapshots_idempotency_idx
         ON assistant_session_snapshots
           (tenant_id, user_id, assistant_id, conversation_id, sequence, kind, content_fingerprint)`,
    ],
  },
  {
    version: 33,
    name: "Rocket.Chat assistant bindings and durable delivery outbox",
    statements: [
      `CREATE TABLE IF NOT EXISTS assistant_rocketchat_bindings (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL,
         assistant_id TEXT NOT NULL, server_url TEXT NOT NULL, rocket_user_id TEXT NOT NULL,
         rocket_username TEXT, room_id TEXT NOT NULL, flow_id TEXT NOT NULL,
         enabled BOOLEAN NOT NULL DEFAULT false, consented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         verified_at TIMESTAMPTZ, pairing_code_hash TEXT, pairing_expires_at TIMESTAMPTZ,
         revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_rocketchat_bindings_scope_idx
         ON assistant_rocketchat_bindings (tenant_id,user_id,assistant_id,created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_rocketchat_bindings_active_scope_idx
         ON assistant_rocketchat_bindings (tenant_id,user_id,assistant_id)
         WHERE enabled AND revoked_at IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_rocketchat_bindings_active_identity_idx
         ON assistant_rocketchat_bindings (server_url,rocket_user_id)
         WHERE enabled AND revoked_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS assistant_rocketchat_bindings_inbound_idx
         ON assistant_rocketchat_bindings (server_url,rocket_user_id,room_id)
         WHERE enabled AND revoked_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS assistant_rocketchat_outbox (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', user_id TEXT NOT NULL,
         assistant_id TEXT NOT NULL, binding_id UUID NOT NULL REFERENCES assistant_rocketchat_bindings(id),
         run_id UUID NOT NULL REFERENCES assistant_runs(id), external_message_id TEXT NOT NULL,
         room_id TEXT NOT NULL, message_text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
         available_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_owner TEXT,
         lease_expires_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
         last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (tenant_id,external_message_id)
       )`,
      `CREATE INDEX IF NOT EXISTS assistant_rocketchat_outbox_pending_idx
         ON assistant_rocketchat_outbox (available_at,lease_expires_at)
         WHERE delivered_at IS NULL AND cancelled_at IS NULL`,
    ],
  },
  {
    version: 34,
    name: "Rocket.Chat self-service connect requests and room-scoped bindings",
    statements: [
      `CREATE TABLE IF NOT EXISTS rocketchat_connect_requests (
         id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '_', server_url TEXT NOT NULL, rocket_user_id TEXT NOT NULL,
         room_id TEXT NOT NULL, verified_email TEXT NOT NULL, oidc_subject TEXT,
         expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS rocketchat_connect_requests_pending_idx ON rocketchat_connect_requests (server_url,rocket_user_id,room_id,expires_at) WHERE consumed_at IS NULL`,
      `DROP INDEX IF EXISTS assistant_rocketchat_bindings_active_identity_idx`,
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_rocketchat_bindings_active_room_identity_idx ON assistant_rocketchat_bindings (server_url,rocket_user_id,room_id) WHERE enabled AND revoked_at IS NULL`,
      `DROP INDEX IF EXISTS assistant_rocketchat_bindings_active_scope_idx`,
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_rocketchat_bindings_active_scope_room_idx ON assistant_rocketchat_bindings (tenant_id,user_id,assistant_id,room_id) WHERE enabled AND revoked_at IS NULL`,
    ],
  },
  {
    version: 35,
    name: "normalize double-encoded assistant run payloads",
    statements: [
      `UPDATE assistant_runs
          SET resume_payload = (resume_payload #>> '{}')::jsonb
        WHERE jsonb_typeof(resume_payload) = 'string'`,
      `UPDATE assistant_schedules
          SET resume_payload = (resume_payload #>> '{}')::jsonb
        WHERE jsonb_typeof(resume_payload) = 'string'`,
    ],
  },
  {
    version: 36,
    name: "encrypted Rocket.Chat OIDC delegation staging",
    statements: [
      `ALTER TABLE rocketchat_connect_requests
         ADD COLUMN IF NOT EXISTS encrypted_refresh_token TEXT`,
      `ALTER TABLE rocketchat_connect_requests
         ADD COLUMN IF NOT EXISTS oidc_scope TEXT`,
      `ALTER TABLE rocketchat_connect_requests
         ADD COLUMN IF NOT EXISTS oidc_issuer TEXT`,
      `ALTER TABLE rocketchat_connect_requests
         ADD COLUMN IF NOT EXISTS delegation_consumed_at TIMESTAMPTZ`,
      `ALTER TABLE assistant_runs
         ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'internal'`,
      `ALTER TABLE assistant_runs DROP CONSTRAINT IF EXISTS assistant_runs_origin_check`,
      `ALTER TABLE assistant_runs ADD CONSTRAINT assistant_runs_origin_check
         CHECK (origin IN ('internal','rocket-chat','schedule'))`,
      `CREATE INDEX IF NOT EXISTS rocketchat_connect_requests_secret_expiry_idx
         ON rocketchat_connect_requests (expires_at)
         WHERE encrypted_refresh_token IS NOT NULL`,
      `UPDATE rocketchat_connect_requests
          SET encrypted_refresh_token = NULL, oidc_scope = NULL,
              oidc_issuer = NULL, delegation_consumed_at = NULL
        WHERE expires_at <= now() OR consumed_at IS NOT NULL`,
    ],
  },
  {
    version: 37,
    name: "mutable Rocket.Chat run messages with terminal finalization",
    statements: [
      `ALTER TABLE assistant_rocketchat_outbox
         ADD COLUMN IF NOT EXISTS finalized BOOLEAN`,
      // Before this migration every outbox row was a final run response. Preserve
      // that terminal state so a retried historical webhook cannot replace it.
      // The migration connection is intentionally not tenant-scoped. Temporarily
      // disable RLS for this table or FORCE RLS would hide every historical row
      // from the backfill; restore both flags exactly before adding the constraint.
      `DO $$
       DECLARE
         rls_enabled BOOLEAN;
         rls_forced BOOLEAN;
       BEGIN
         SELECT relrowsecurity, relforcerowsecurity
           INTO rls_enabled, rls_forced
           FROM pg_class
          WHERE oid = 'assistant_rocketchat_outbox'::regclass;

         EXECUTE 'ALTER TABLE assistant_rocketchat_outbox DISABLE ROW LEVEL SECURITY';
         UPDATE assistant_rocketchat_outbox SET finalized=true WHERE finalized IS NULL;

         IF rls_enabled THEN
           EXECUTE 'ALTER TABLE assistant_rocketchat_outbox ENABLE ROW LEVEL SECURITY';
         ELSE
           EXECUTE 'ALTER TABLE assistant_rocketchat_outbox DISABLE ROW LEVEL SECURITY';
         END IF;
         IF rls_forced THEN
           EXECUTE 'ALTER TABLE assistant_rocketchat_outbox FORCE ROW LEVEL SECURITY';
         ELSE
           EXECUTE 'ALTER TABLE assistant_rocketchat_outbox NO FORCE ROW LEVEL SECURITY';
         END IF;
       END
       $$`,
      `ALTER TABLE assistant_rocketchat_outbox
         ALTER COLUMN finalized SET DEFAULT false`,
      `ALTER TABLE assistant_rocketchat_outbox
         ALTER COLUMN finalized SET NOT NULL`,
    ],
  },
  {
    version: 38,
    name: "structured analysis artifacts and retrieval eval metadata",
    statements: [
      `CREATE TABLE IF NOT EXISTS analysis_artifacts (
         id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         tenant_id           TEXT NOT NULL,
         user_id             TEXT,
         assistant_id        TEXT,
         conversation_id     TEXT,
         project_id          TEXT,
         case_id             TEXT,
         type                TEXT NOT NULL CHECK (type IN (
                               'chronology', 'contradiction_matrix', 'decision_register',
                               'requirements_matrix', 'entity_register', 'open_items',
                               'coverage_report')),
         schema_version      INTEGER NOT NULL CHECK (schema_version > 0),
         title               TEXT NOT NULL CHECK (length(btrim(title)) > 0),
         payload             JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
         status              TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'validated', 'superseded')),
         revision            INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
         supersedes_id       UUID,
         source_execution_id UUID,
         source_flow_id      TEXT,
         dataset_id          TEXT,
         created_by          TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
         content_hash        TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
         created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (tenant_id, id),
         UNIQUE (tenant_id, supersedes_id),
         CHECK (supersedes_id IS NULL OR supersedes_id <> id),
         FOREIGN KEY (tenant_id, supersedes_id)
           REFERENCES analysis_artifacts (tenant_id, id)
       )`,
      `CREATE INDEX IF NOT EXISTS analysis_artifacts_scope_created_idx
         ON analysis_artifacts (tenant_id, user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS analysis_artifacts_type_status_idx
         ON analysis_artifacts (tenant_id, type, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS analysis_artifacts_context_idx
         ON analysis_artifacts (tenant_id, project_id, case_id, conversation_id)`,
      `CREATE INDEX IF NOT EXISTS analysis_artifacts_sources_idx
         ON analysis_artifacts (tenant_id, source_execution_id, source_flow_id, dataset_id)`,
      `CREATE INDEX IF NOT EXISTS analysis_artifacts_supersedes_idx
         ON analysis_artifacts (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL`,
      `ALTER TABLE analysis_artifacts ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE analysis_artifacts FORCE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS tenant_isolation ON analysis_artifacts`,
      `CREATE POLICY tenant_isolation ON analysis_artifacts
         USING (tenant_id = current_setting('app.current_tenant', true))
         WITH CHECK (tenant_id = current_setting('app.current_tenant', true))`,
      `ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'evaluation'`,
      `ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS dataset_id TEXT`,
      `ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS dataset_version TEXT`,
      `ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS collection TEXT`,
      `ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS parameters JSONB`,
      `ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS retrieval_report JSONB`,
      `CREATE INDEX IF NOT EXISTS eval_runs_dataset_recorded_idx
         ON eval_runs (dataset_id, dataset_version, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS eval_runs_kind_collection_recorded_idx
         ON eval_runs (kind, collection, recorded_at DESC)`,
    ],
  },
  {
    version: 39,
    name: "durable asynchronous eval matrices with archived traces",
    statements: [
      `CREATE TABLE IF NOT EXISTS eval_matrix_runs (
         id           UUID PRIMARY KEY,
         name         TEXT NOT NULL,
         status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
         created_by   TEXT NOT NULL,
         created_at   TIMESTAMPTZ NOT NULL,
         started_at   TIMESTAMPTZ,
         completed_at TIMESTAMPTZ,
         expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
         payload      JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object')
       )`,
      `CREATE INDEX IF NOT EXISTS eval_matrix_runs_created_idx
         ON eval_matrix_runs (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS eval_matrix_runs_status_idx
         ON eval_matrix_runs (status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS eval_matrix_runs_expiry_idx
         ON eval_matrix_runs (expires_at)`,
    ],
  },
  {
    version: 40,
    name: "execution_snapshots per-flow index",
    statements: [
      // The optimizer and draft simulation read the newest snapshots of one flow.
      `CREATE INDEX IF NOT EXISTS execution_snapshots_flow_idx
         ON execution_snapshots (flow_id, created_at DESC)`,
    ],
  },
  {
    version: 41,
    name: "named drafts (several working copies per flow)",
    statements: [
      // Additional named drafts next to the implicit `flows.draft` working
      // copy, so the Studio can hold several drafts per flow and pick which
      // one to publish. The default draft stays mirrored in `flows.draft`
      // (compat with everything that predates this table).
      `CREATE TABLE IF NOT EXISTS flow_drafts (
         flow_id    TEXT NOT NULL,
         draft_id   TEXT NOT NULL,
         label      TEXT NOT NULL DEFAULT '',
         definition JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT,
         PRIMARY KEY (flow_id, draft_id)
       )`,
      `CREATE INDEX IF NOT EXISTS flow_drafts_flow_idx
         ON flow_drafts (flow_id, updated_at DESC)`,
      // Backfill: existing working copies become the 'default' named draft.
      `INSERT INTO flow_drafts (flow_id, draft_id, label, definition, updated_at, updated_by)
       SELECT id, 'default', 'default', draft, updated_at, updated_by
         FROM flows WHERE draft IS NOT NULL
       ON CONFLICT (flow_id, draft_id) DO NOTHING`,
    ],
  },
  {
    version: 42,
    name: "audit log immutability trigger and anchor table (Req 1.1/1.5)",
    statements: [
      // Durable in-database anchors: every retention purge records the last
      // removed id/hash here BEFORE deleting, so chain verification can
      // account for a purged prefix instead of reporting tampering (Req 1.5).
      `CREATE TABLE IF NOT EXISTS audit_anchors (
         id          BIGSERIAL PRIMARY KEY,
         upto_id     BIGINT NOT NULL,
         tip_hash    TEXT NOT NULL,
         anchored_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS audit_anchors_upto_idx
         ON audit_anchors (upto_id DESC)`,
      // Append-only enforcement: UPDATE/DELETE on audit_log abort unless the
      // transaction-local GUC `atf.audit_retention` is set to 'on' — which
      // only the SECURITY DEFINER purge function below is allowed to do.
      `CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
       LANGUAGE plpgsql AS $fn$
       BEGIN
         IF current_setting('atf.audit_retention', true) = 'on' THEN
           RETURN OLD;
         END IF;
         RAISE EXCEPTION
           'audit_log is append-only: % is not permitted (retention must go through audit_log_purge)',
           TG_OP;
       END
       $fn$`,
      `DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log`,
      `CREATE TRIGGER audit_log_immutable
         BEFORE UPDATE OR DELETE ON audit_log
         FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()`,
    ],
  },
  {
    version: 43,
    name: "audit_log_purge with pre-purge anchor and app-role revocations (Req 1.5)",
    statements: [
      // The ONLY sanctioned way to remove audit rows: anchors the chain tip
      // first, then deletes. SECURITY DEFINER so the trigger's retention GUC
      // can be set without granting DELETE on audit_log to anyone else.
      `CREATE OR REPLACE FUNCTION audit_log_purge(before_at TIMESTAMPTZ)
       RETURNS BIGINT
       LANGUAGE plpgsql SECURITY DEFINER
       SET search_path = public, pg_temp AS $fn$
       DECLARE
         last_row RECORD;
         n BIGINT;
       BEGIN
         PERFORM set_config('atf.audit_retention', 'on', true);
         -- Prior anchor: last removed entry including its hash, so chain
         -- verification recognizes the purge as a legitimate cut.
         SELECT id, hash INTO last_row
           FROM audit_log WHERE created_at < before_at ORDER BY id DESC LIMIT 1;
         IF last_row IS NOT NULL THEN
           INSERT INTO audit_anchors (upto_id, tip_hash)
           VALUES (last_row.id, COALESCE(last_row.hash, ''));
         END IF;
         DELETE FROM audit_log WHERE created_at < before_at;
         GET DIAGNOSTICS n = ROW_COUNT;
         RETURN n;
       END
       $fn$`,
      `REVOKE ALL ON FUNCTION audit_log_purge(TIMESTAMPTZ) FROM PUBLIC`,
      // Rights revocation for the application role (roles are created by the
      // RLS onboarding, which may run after migrations — guard on existence;
      // rls-onboarding.ts repeats the same revocations after its blanket
      // GRANT so the order of onboarding vs. migration does not matter).
      `DO $do$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_app') THEN
           EXECUTE 'REVOKE UPDATE, DELETE ON audit_log FROM aiperator_app';
         END IF;
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_operator') THEN
           EXECUTE 'REVOKE UPDATE, DELETE ON audit_log FROM aiperator_operator';
         END IF;
       END
       $do$`,
    ],
  },
  {
    version: 44,
    name: "erasure_requests for the DSAR orchestrator (Req 2.9-2.11)",
    statements: [
      // One row per DSAR/erasure operation. `request_id` is unique so a
      // repeated request replays the stored result instead of erasing twice
      // (idempotency, Req 2.9). `results` holds the per-store
      // ErasureStoreResult array; `receipt` the signed Erasure_Receipt
      // envelope once the operation completed (Req 2.11).
      `CREATE TABLE IF NOT EXISTS erasure_requests (
         id          BIGSERIAL PRIMARY KEY,
         request_id  TEXT NOT NULL UNIQUE,
         tenant_id   TEXT NOT NULL,
         scope       TEXT NOT NULL,
         subject     JSONB,
         doc_references JSONB,
         status      TEXT NOT NULL,
         results     JSONB NOT NULL DEFAULT '[]'::jsonb,
         store_groups   JSONB NOT NULL DEFAULT '[]'::jsonb,
         receipt     JSONB,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS erasure_requests_tenant_idx
         ON erasure_requests (tenant_id, created_at DESC)`,
    ],
  },
  {
    version: 45,
    name: "api_keys hash_alg — peppered HMAC-SHA-256 key hashing (Req 7.9)",
    statements: [
      // Records which one-way function produced `key_hash`: the original
      // unsalted SHA-256 ('sha256') or the peppered HMAC-SHA-256
      // ('hmac-sha256') used once API_KEY_PEPPER is configured. Existing rows
      // default to 'sha256' and are migrated lazily by
      // `PostgresTenantStore.lookupByApiKey` on the next successful lookup.
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS hash_alg TEXT NOT NULL DEFAULT 'sha256'`,
    ],
  },
  {
    version: 46,
    name: "receipt_log + receipt_tree_heads — Decision_Receipt transparency log (Req 15.3)",
    statements: [
      // RFC-6962 Merkle transparency log over signed Decision_Receipts.
      // `seq` is the leaf index, `leaf_hash` = H(0x00 || cose_bytes). The
      // table is append-only: the immutability trigger below aborts
      // UPDATE/DELETE for everyone (no sanctioned purge — receipts are
      // evidence), mirroring the audit_log pattern from migration 42.
      // `cose_bytes` holds the COSE_Sign1 bytes as lowercase hex (TEXT): the
      // Bun SQL adapter passes parameters through as text, matching the hex
      // leaf_hash / root_hash columns.
      `CREATE TABLE IF NOT EXISTS receipt_log (
         seq         BIGSERIAL PRIMARY KEY,
         receipt_id  TEXT NOT NULL UNIQUE,
         leaf_hash   TEXT NOT NULL,
         cose_bytes  TEXT NOT NULL,
         appended_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS receipt_log_appended_idx
         ON receipt_log (appended_at DESC)`,
      // Periodic signed Merkle tree heads (audit anchors). `cose_bytes` is a
      // COSE_Sign1 over the canonical tree-head CBOR [tree_size, root_hash,
      // timestamp]; verification lives in receipts/transparency-log.ts.
      `CREATE TABLE IF NOT EXISTS receipt_tree_heads (
         id          BIGSERIAL PRIMARY KEY,
         tree_size   BIGINT NOT NULL,
         root_hash   TEXT NOT NULL,
         cose_bytes  TEXT NOT NULL,
         sealed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS receipt_tree_heads_size_idx
         ON receipt_tree_heads (tree_size DESC)`,
      `CREATE OR REPLACE FUNCTION receipt_log_immutable() RETURNS trigger
       LANGUAGE plpgsql AS $fn$
       BEGIN
         RAISE EXCEPTION
           'receipt_log is append-only: % is not permitted (receipts are evidence)',
           TG_OP;
       END
       $fn$`,
      `DROP TRIGGER IF EXISTS receipt_log_immutable ON receipt_log`,
      `CREATE TRIGGER receipt_log_immutable
         BEFORE UPDATE OR DELETE ON receipt_log
         FOR EACH ROW EXECUTE FUNCTION receipt_log_immutable()`,
      `CREATE OR REPLACE FUNCTION receipt_tree_heads_immutable() RETURNS trigger
       LANGUAGE plpgsql AS $fn$
       BEGIN
         RAISE EXCEPTION
           'receipt_tree_heads is append-only: % is not permitted',
           TG_OP;
       END
       $fn$`,
      `DROP TRIGGER IF EXISTS receipt_tree_heads_immutable ON receipt_tree_heads`,
      `CREATE TRIGGER receipt_tree_heads_immutable
         BEFORE UPDATE OR DELETE ON receipt_tree_heads
         FOR EACH ROW EXECUTE FUNCTION receipt_tree_heads_immutable()`,
      // Belt-and-braces: the application roles get INSERT/SELECT only —
      // UPDATE/DELETE would fail at the trigger anyway, but revoking keeps
      // the permission model honest (same pattern as audit_log, migration 43).
      `DO $do$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_app') THEN
           EXECUTE 'GRANT INSERT, SELECT ON receipt_log TO aiperator_app';
           EXECUTE 'GRANT INSERT, SELECT ON receipt_tree_heads TO aiperator_app';
           EXECUTE 'REVOKE UPDATE, DELETE ON receipt_log FROM aiperator_app';
           EXECUTE 'REVOKE UPDATE, DELETE ON receipt_tree_heads FROM aiperator_app';
         END IF;
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_operator') THEN
           EXECUTE 'GRANT INSERT, SELECT ON receipt_log TO aiperator_operator';
           EXECUTE 'GRANT INSERT, SELECT ON receipt_tree_heads TO aiperator_operator';
           EXECUTE 'REVOKE UPDATE, DELETE ON receipt_log FROM aiperator_operator';
           EXECUTE 'REVOKE UPDATE, DELETE ON receipt_tree_heads FROM aiperator_operator';
         END IF;
       END
       $do$`,
    ],
  },
  {
    version: 47,
    name: "executions + token_usage_log: iss — issuer-scoped self-service erasure",
    statements: [
      // The verified token issuer next to the user identifier, so a
      // self-service erasure (DELETE /v1/me/data) removes only the caller
      // issuer's rows when two trusted issuers hand out the same `sub`.
      // Nullable: rows written before this migration keep matching by
      // identifier alone. A public URL, not personal data — stored plain.
      `ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS iss TEXT`,
      `ALTER TABLE executions ADD COLUMN IF NOT EXISTS iss TEXT`,
    ],
  },
  {
    version: 48,
    name: "audit_chain_meta — canonical-form cut-off of the audit hash chain",
    statements: [
      // Small key/value table next to audit_log. The first canonical-form row
      // records its id as `canonical_cutoff_id`; the chain verifier accepts the
      // legacy (pre-canonicalization) hash form only for rows BELOW it, so a
      // forged row after the cut-off cannot hide behind the legacy form.
      `CREATE TABLE IF NOT EXISTS audit_chain_meta (
         key    TEXT PRIMARY KEY,
         value  TEXT NOT NULL
       )`,
      // Insert/select only, like audit_log: the cut-off is written once.
      `DO $do$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_app') THEN
           EXECUTE 'GRANT INSERT, SELECT ON audit_chain_meta TO aiperator_app';
           EXECUTE 'REVOKE UPDATE, DELETE ON audit_chain_meta FROM aiperator_app';
         END IF;
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_operator') THEN
           EXECUTE 'GRANT INSERT, SELECT ON audit_chain_meta TO aiperator_operator';
           EXECUTE 'REVOKE UPDATE, DELETE ON audit_chain_meta FROM aiperator_operator';
         END IF;
       END
       $do$`,
    ],
  },
  {
    version: 49,
    name: "erasure_requests.lease_token — fencing token for the erasure lease",
    statements: [
      // The run that holds the lease carries this token; every heartbeat
      // renews the lease only while the token still matches, so a worker
      // that was taken over notices it and stops instead of racing the new one.
      `ALTER TABLE erasure_requests ADD COLUMN IF NOT EXISTS lease_token TEXT`,
    ],
  },
];
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);
