// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * RLS onboarding helper (`src/db/rls-onboarding.ts`)
 *
 * Turns the manual, easy-to-skip RLS DDL step into an explicit, scriptable
 * onboarding action with a clear multi-tenant risk signal — so a
 * Row-Level-Security rollout is a guided checklist item rather than a
 * documentation page an operator can miss.
 *
 * Backs `bun run scripts/cli.ts rls-status` / `rls-setup` (see scripts/cli.ts)
 * and is unit-tested against a fake {@link Database} — no real Postgres is
 * required to exercise the decision logic.
 *
 * Design:
 *   - `checkRlsOnboarding` is READ-ONLY: reports the current RLS state per
 *     tenant table AND a "multiple tenants detected" signal (row count in
 *     the `tenants` table > 1, when that table exists), so the operator sees
 *     WHY this matters for their specific deployment, not just an abstract
 *     recommendation.
 *   - `applyRlsOnboarding` is the only function that mutates the database. It
 *     requires an explicit `confirm: true` — the CLI only sets this with
 *     `--confirm` after printing the plan. The reviewed DDL is defined in this
 *     module so the CLI has one executable source of truth.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "./database.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tenant-scoped tables that must have RLS enabled + forced. Mirrors bootstrap/persistence.ts. */
export const RLS_TENANT_TABLES = [
  "cost_ledger",
  "token_usage_log",
  "pii_vault_entries",
  "billing_usage",
  "executions",
  "execution_snapshots",
  "tenant_provider_keys",
  "assistant_rocketchat_bindings",
  "assistant_rocketchat_outbox",
  "rocketchat_connect_requests",
  "analysis_artifacts",
] as const;

const RLS_WORKER_TABLES = [
  "assistant_mirror_outbox",
  "assistant_runs",
  "assistant_schedules",
  "assistant_rocketchat_bindings",
  "assistant_rocketchat_outbox",
] as const;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface TableRlsStatus {
  table: string;
  /** True when the table exists in the connected database. */
  exists: boolean;
  /** `ENABLE ROW LEVEL SECURITY` is set. */
  enabled: boolean;
  /** `FORCE ROW LEVEL SECURITY` is set (closes the table-owner bypass). */
  forced: boolean;
}

export interface RlsOnboardingStatus {
  /** Per-table RLS state. */
  tables: TableRlsStatus[];
  /** True when every table in {@link RLS_TENANT_TABLES} is both enabled and forced. */
  fullyEnforced: boolean;
  /**
   * True when the `tenants` table exists and holds more than one row — the
   * concrete signal that this deployment IS multi-tenant and RLS is not just
   * theoretical hardening. `undefined` when the table does not exist (tenant
   * management not in use) or the count could not be determined.
   */
  multiTenantDetected: boolean | undefined;
  /** Row count backing {@link multiTenantDetected}, when determinable. */
  tenantCount: number | undefined;
  /** Whether the `aiperator_app` / `aiperator_operator` roles from the setup script already exist. */
  rolesConfigured: boolean;
}

/**
 * Reads the current RLS enforcement state without making any changes.
 * Safe to call at any time (including in production) — pure read.
 */
export async function checkRlsOnboarding(
  db: Database,
): Promise<RlsOnboardingStatus> {
  const rlsRows = await db.query<{
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
  const byName = new Map(rlsRows.map((r) => [r.relname, r]));

  const tables: TableRlsStatus[] = RLS_TENANT_TABLES.map((table) => {
    const row = byName.get(table);
    return {
      table,
      exists: row !== undefined,
      enabled: row?.relrowsecurity ?? false,
      forced: row?.relforcerowsecurity ?? false,
    };
  });
  const fullyEnforced = tables.every((t) => t.exists && t.enabled && t.forced);

  // Multi-tenant detection: best-effort, tolerates a missing `tenants` table.
  let multiTenantDetected: boolean | undefined;
  let tenantCount: number | undefined;
  try {
    const existsRows = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'tenants'
       ) AS exists`,
    );
    if (existsRows[0]?.exists === true) {
      const countRows = await db.query<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count FROM public.tenants`,
      );
      tenantCount = Number(countRows[0]?.count ?? 0);
      multiTenantDetected = tenantCount > 1;
    }
  } catch {
    // Best-effort — leave both undefined when the check itself fails.
  }

  const roleRows = await db.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('aiperator_app', 'aiperator_operator')`,
  );
  const rolesConfigured = roleRows.length === 2;

  return {
    tables,
    fullyEnforced,
    multiTenantDetected,
    tenantCount,
    rolesConfigured,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyRlsOnboardingOptions {
  /**
   * Required explicit confirmation — `applyRlsOnboarding` refuses to run any
   * DDL when this is not `true`. Forces every caller (CLI or otherwise) to
   * make the "yes, modify the schema" decision an explicit, visible step.
   */
  confirm: true;
  logger?: Logger;
}

export interface ApplyRlsOnboardingResult {
  /** Statements executed, in order (for an audit trail / dry-run echo). */
  statementsApplied: number;
  /** Post-apply verification status — should have `fullyEnforced: true`. */
  status: RlsOnboardingStatus;
}

/**
 * Applies the RLS onboarding statements — creating the least-privilege
 * `aiperator_app` role and the BYPASSRLS `aiperator_operator` role (if
 * missing), enabling + forcing RLS with a tenant-isolation policy on every
 * table in {@link RLS_TENANT_TABLES} — then re-verifies the result.
 *
 * Idempotent: every statement uses `IF NOT EXISTS` / `DROP POLICY IF EXISTS`
 * so re-running against an already-onboarded database is a no-op.
 *
 * This function does NOT change `DATABASE_URL` / `DATABASE_OPERATOR_URL` —
 * the operator must still point the app at `aiperator_app` and the operator
 * plane at `aiperator_operator` and restart. It also does not grant a
 * password / auth method for the new roles (out of band by design: this
 * script should never see or set a credential).
 */
export async function applyRlsOnboarding(
  db: Database,
  opts: ApplyRlsOnboardingOptions,
): Promise<ApplyRlsOnboardingResult> {
  if (opts.confirm !== true) {
    throw new Error(
      "applyRlsOnboarding requires explicit confirm: true — refusing to modify the schema.",
    );
  }

  let applied = 0;
  for (const stmt of RLS_SETUP_STATEMENTS) {
    await db.query(stmt);
    applied++;
  }

  opts.logger?.info("RLS onboarding statements applied", { count: applied });

  const status = await checkRlsOnboarding(db);
  if (!status.fullyEnforced) {
    opts.logger?.warn(
      "RLS onboarding ran but verification still reports gaps — inspect table-by-table status",
      { tables: status.tables.filter((t) => !(t.exists && t.enabled && t.forced)) },
    );
  }
  return { statementsApplied: applied, status };
}

/**
 * The reviewed DDL applied by {@link applyRlsOnboarding}. This array is the
 * executable source of truth used by the CLI; the public ADR documents the
 * plan, activation sequence, and residual deployment responsibilities.
 * Every statement is idempotent (`IF NOT EXISTS` / safe `DROP ... IF EXISTS`),
 * so the setup can be re-run after an upgrade and then re-verified.
 */
const RLS_SETUP_STATEMENTS: readonly string[] = [
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_app') THEN
       CREATE ROLE aiperator_app LOGIN;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiperator_operator') THEN
       CREATE ROLE aiperator_operator LOGIN BYPASSRLS;
     END IF;
   END
   $$`,
  `GRANT USAGE ON SCHEMA public TO aiperator_app`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aiperator_app`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aiperator_app`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE aiperator_app IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aiperator_app`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE aiperator_app IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO aiperator_app`,
  `GRANT USAGE ON SCHEMA public TO aiperator_operator`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA public TO aiperator_operator`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE aiperator_app IN SCHEMA public
     GRANT SELECT ON TABLES TO aiperator_operator`,
  // Req 1.5 (platform-hardening): audit_log is append-only. The blanket GRANT
  // above would give both roles UPDATE/DELETE on it — take those back so the
  // immutability trigger is backed by real privileges, not only a trigger.
  // (Migration 43 repeats the revocations for databases onboarded before this
  // change; both are idempotent and guarded, so the order does not matter.)
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'audit_log') THEN
       EXECUTE 'REVOKE UPDATE, DELETE ON public.audit_log FROM aiperator_app';
       EXECUTE 'REVOKE UPDATE, DELETE ON public.audit_log FROM aiperator_operator';
       -- PostgresAuditLog appends the chain on the operator pool: INSERT and
       -- the id sequence are required (migration 52 repeats this).
       EXECUTE 'GRANT INSERT ON public.audit_log TO aiperator_operator';
       IF to_regclass('public.audit_log_id_seq') IS NOT NULL THEN
         EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.audit_log_id_seq TO aiperator_operator';
       END IF;
     END IF;
   END
   $$`,
  // Req 15.3 (platform-hardening): the Decision_Receipt transparency log is
  // append-only evidence as well — take UPDATE/DELETE back from the blanket
  // grant above (mirrors audit_log; migration 46 repeats this idempotently).
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'receipt_log') THEN
       EXECUTE 'REVOKE UPDATE, DELETE ON public.receipt_log FROM aiperator_app';
       EXECUTE 'REVOKE UPDATE, DELETE ON public.receipt_log FROM aiperator_operator';
     END IF;
     IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'receipt_tree_heads') THEN
       EXECUTE 'REVOKE UPDATE, DELETE ON public.receipt_tree_heads FROM aiperator_app';
       EXECUTE 'REVOKE UPDATE, DELETE ON public.receipt_tree_heads FROM aiperator_operator';
     END IF;
   END
   $$`,
  `DO $$
   DECLARE
     worker_table TEXT;
     worker_tables TEXT[] := ARRAY[${RLS_WORKER_TABLES.map((t) => `'${t}'`).join(", ")}];
   BEGIN
     FOREACH worker_table IN ARRAY worker_tables LOOP
       IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = worker_table) THEN
         EXECUTE format(
           'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO aiperator_operator',
           worker_table
         );
       END IF;
     END LOOP;
   END
   $$`,
  `DO $$
   DECLARE
     tbl TEXT;
     tenant_tables TEXT[] := ARRAY[${RLS_TENANT_TABLES.map((t) => `'${t}'`).join(", ")}];
   BEGIN
     FOREACH tbl IN ARRAY tenant_tables LOOP
       IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = tbl) THEN
         EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
         EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
         EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
         EXECUTE format($f$
           CREATE POLICY tenant_isolation ON public.%I
             USING (tenant_id = current_setting('app.current_tenant', true))
             WITH CHECK (tenant_id = current_setting('app.current_tenant', true))
         $f$, tbl);
       END IF;
     END LOOP;
   END
   $$`,
];
