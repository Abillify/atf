# 5. Tenant data isolation model

Date: 2026-06-16  
Updated: 2026-07-07

## Status

Accepted ✅ — all wiring complete, integration-tested

## Context

aiperator is multi-tenant: cost ledger, budgets, billing usage, execution
history/snapshots, BYOK provider keys and API keys are all keyed by a
`tenant_id`. A B2B customer must never be able to read or mutate another
tenant's rows. We needed an explicit, auditable statement of _how_ that
isolation is enforced and what the residual risk is — and a defense-in-depth
path that does not depend solely on application code being bug-free.

The persistence layer (`src/db/database.ts`) is a thin wrapper over Bun's
pooled `SQL` client. Queries run as parameterised statements; there is no
per-request transaction or per-connection session state today.

## Decision

**Primary control — application-enforced row scoping.** Every tenant-scoped
store filters by `tenant_id` in the SQL predicate, and the value comes from the
authenticated request context (`RequestContext.clientId`), never from
client-supplied row data. This is verified across the stores:

| Table                        | Store                           | Scoping predicate        |
| ---------------------------- | ------------------------------- | ------------------------ |
| `cost_ledger`                | `observability/cost.ts`         | `WHERE tenant_id = $1`   |
| `billing_usage`              | `observability/billing.ts`      | `WHERE tenant_id = $1 …` |
| `executions` / `node_events` | `monitoring/execution-store.ts` | `WHERE tenant_id = $1`   |
| `tenant_provider_keys`       | `graph/tenant-provider-keys.ts` | `WHERE tenant_id = $1 …` |
| `api_keys`                   | `graph/tenant-manager.ts`       | `WHERE tenant_id = $1 …` |

Cross-cutting reads that are _operator-plane_ (audit log, full execution
history in the dashboard) are intentionally not tenant-scoped — they are gated
by operator RBAC instead, and that boundary is documented as such.

Job and idempotency reads enforce the same boundary at the application layer:
a job/idempotency record is scoped to its submitter (tenant id, else bearer
token) and a mismatch returns 404 (see `routes/jobs.ts`, the idempotency store).

**Defense-in-depth — optional Postgres Row-Level Security.** Application
scoping is the contract, but a single missing predicate in a future query would
be a cross-tenant leak. For regulated deployments we ship an _optional_ RLS
hardening script (`deploy/postgres-rls.sql`) that:

1. Creates a least-privilege application role (no `BYPASSRLS`, not the table
   owner).
2. Enables **and forces** RLS on every tenant-scoped table.
3. Adds policies of the form
   `USING (tenant_id = current_setting('app.current_tenant', true))`.

Once the app sets the `app.current_tenant` GUC per request, the database itself
rejects any row outside the active tenant — so an application bug degrades to
"no rows" rather than "another tenant's rows".

**GUC wiring (implemented ✅).** The per-request GUC wiring is fully in place:

- `src/db/database.ts` exposes `Database.withTenant(tenantId, cb)`, which
  reserves a pooled connection, opens a transaction, runs
  `SELECT set_config('app.current_tenant', $1, true)` (parameter-bound,
  transaction-local so it never leaks across pooled leases), executes `cb`, and
  COMMITs/ROLLBACKs.
- It is gated by `TENANT_RLS_ENABLED` (default **false**): when off, `withTenant`
  is a pure pass-through with no transaction overhead, so existing deployments
  are unchanged. When on, the tenant-scoped store paths set the GUC.
- Wired tenant-scoped paths: `cost_ledger` (record/window read),
  `billing_usage` (flush/read), `tenant_provider_keys` (all), `executions`
  (write + tenant erase), `api_keys` (create/list).

**BYPASSRLS operator pool (implemented ✅).** The second connection for
cross-tenant operator-plane reads is fully wired:

- `Database.withOperator(cb)` routes to a dedicated `DATABASE_OPERATOR_URL`
  pool that connects as a BYPASSRLS role. This lets execution history, cost
  snapshots, billing dashboards, audit log and retention purges see all tenants'
  rows while the regular app pool is restricted by FORCE RLS.
- When `DATABASE_OPERATOR_URL` is absent, `withOperator` is a pass-through
  to the regular pool (pre-RLS behaviour) — safe only when RLS is not enforced.
- The production-readiness gate (`checkProductionReadiness`) now treats
  `TENANT_RLS_ENABLED=true` **without** `DATABASE_OPERATOR_URL` as a **fatal**
  error in production, preventing silent deployment with broken operator dashboards.
- `PostgresCostStore.snapshot()` and `snapshotByUser()` / `snapshotByFlow()`
  already route through `withOperator`.

**Two access planes.** Enforced RLS surfaces a structural split the application
respects:

- _Tenant plane_ — requests that already carry a tenant. These set the GUC and
  are safe under FORCE RLS.
- _Cross-tenant / privileged plane_ — paths that resolve or span tenants by
  design: API-key authentication (`lookupByApiKey`), operator history / cost /
  billing dashboards, and retention purges. These use `withOperator` (BYPASSRLS
  role) or stay RBAC-gated at the application layer. `api_keys` is consequently
  **excluded** from the forced-RLS table set so key auth never breaks.

## Integration tests

The isolation guarantees are verified against a real Postgres instance in
`src/db/__tests__/pg-integration.test.ts` (skipped unless `DATABASE_URL` is
set). The test suites cover:

| Suite                                               | What is verified                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Postgres — replay snapshot retention`              | purge by cutoff, erase by tenant (RTBF)                                                   |
| `Postgres — execution history retention`            | purge + cascade-delete of node_events                                                     |
| `Postgres — BYOK encryption at rest`                | ciphertext stored, plaintext decrypted, mask on list                                      |
| `Postgres — cluster-wide semantic cache (pgvector)` | cross-replica hits, namespace isolation                                                   |
| `Postgres — enforced RLS tenant isolation`          | predicate-less read sees only own rows; WITH CHECK rejects cross-tenant writes            |
| `Postgres — BYPASSRLS operator pool`                | `withTenant` filtered by RLS; `withOperator` sees all tenants; `snapshot()` spans tenants |

## Consequences

- The isolation guarantee is explicit and testable: a store query without a
  `tenant_id` predicate is a review-blocking defect.
- RLS is **opt-in and operationally gated**, not an auto-migration, because
  enabling it without (a) a non-owner app role and (b) the `app.current_tenant`
  GUC being set per request would break a running deployment.
- The operator plane is deliberately cross-tenant and protected by RBAC
  (`middleware/operator-rbac.ts`) + a BYPASSRLS pool, not by tenant scoping.
- Right-to-be-forgotten erasure (`observability/retention*.ts`) reuses the same
  `tenant_id` predicate, so the deletion boundary matches the read boundary.
- Deployments that enable `TENANT_RLS_ENABLED=true` in production MUST also
  set `DATABASE_OPERATOR_URL` — enforced by the startup readiness gate.

## Context

aiperator is multi-tenant: cost ledger, budgets, billing usage, execution
history/snapshots, BYOK provider keys and API keys are all keyed by a
`tenant_id`. A B2B customer must never be able to read or mutate another
tenant's rows. We needed an explicit, auditable statement of _how_ that
isolation is enforced and what the residual risk is — and a defense-in-depth
path that does not depend solely on application code being bug-free.

The persistence layer (`src/db/database.ts`) is a thin wrapper over Bun's
pooled `SQL` client. Queries run as parameterised statements; there is no
per-request transaction or per-connection session state today.

## Decision

**Primary control — application-enforced row scoping.** Every tenant-scoped
store filters by `tenant_id` in the SQL predicate, and the value comes from the
authenticated request context (`RequestContext.clientId`), never from
client-supplied row data. This is verified across the stores:

| Table                        | Store                           | Scoping predicate        |
| ---------------------------- | ------------------------------- | ------------------------ |
| `cost_ledger`                | `observability/cost.ts`         | `WHERE tenant_id = $1`   |
| `billing_usage`              | `observability/billing.ts`      | `WHERE tenant_id = $1 …` |
| `executions` / `node_events` | `monitoring/execution-store.ts` | `WHERE tenant_id = $1`   |
| `tenant_provider_keys`       | `graph/tenant-provider-keys.ts` | `WHERE tenant_id = $1 …` |
| `api_keys`                   | `graph/tenant-manager.ts`       | `WHERE tenant_id = $1 …` |

Cross-cutting reads that are _operator-plane_ (audit log, full execution
history in the dashboard) are intentionally not tenant-scoped — they are gated
by operator RBAC instead, and that boundary is documented as such.

Job and idempotency reads enforce the same boundary at the application layer:
a job/idempotency record is scoped to its submitter (tenant id, else bearer
token) and a mismatch returns 404 (see `routes/jobs.ts`, the idempotency store).

**Defense-in-depth — optional Postgres Row-Level Security.** Application
scoping is the contract, but a single missing predicate in a future query would
be a cross-tenant leak. For regulated deployments we ship an _optional_ RLS
hardening script (`deploy/postgres-rls.sql`) that:

1. Creates a least-privilege application role (no `BYPASSRLS`, not the table
   owner).
2. Enables **and forces** RLS on every tenant-scoped table.
3. Adds policies of the form
   `USING (tenant_id = current_setting('app.current_tenant', true))`.

Once the app sets the `app.current_tenant` GUC per request, the database itself
rejects any row outside the active tenant — so an application bug degrades to
"no rows" rather than "another tenant's rows".

**GUC wiring (implemented).** The per-request GUC wiring this ADR previously
listed as the "one remaining task" is now in place:

- `src/db/database.ts` exposes `Database.withTenant(tenantId, cb)`, which
  reserves a pooled connection, opens a transaction, runs
  `SELECT set_config('app.current_tenant', $1, true)` (parameter-bound,
  transaction-local so it never leaks across pooled leases), executes `cb`, and
  COMMITs/ROLLBACKs.
- It is gated by `TENANT_RLS_ENABLED` (default **false**): when off, `withTenant`
  is a pure pass-through with no transaction overhead, so existing deployments
  are unchanged. When on, the tenant-scoped store paths set the GUC.
- Wired tenant-scoped paths: `cost_ledger` (record/window read),
  `billing_usage` (flush/read), `tenant_provider_keys` (all), `executions`
  (write + tenant erase), `api_keys` (create/list).

**Two access planes.** Enforced RLS surfaces a structural split the application
must respect, because it runs under a single Postgres role:

- _Tenant plane_ — requests that already carry a tenant. These set the GUC and
  are safe under FORCE RLS.
- _Cross-tenant / privileged plane_ — paths that resolve or span tenants by
  design and therefore CANNOT set a single tenant GUC: API-key authentication
  (`lookupByApiKey` resolves identity _from_ the key), the operator history /
  cost / billing dashboards, and retention purges. These stay RBAC-gated at the
  application layer. `api_keys` is consequently **excluded** from the forced-RLS
  table set (otherwise key auth would see zero rows); the operator-plane reads
  on `executions`/`cost_ledger`/`billing_usage` require a dedicated **BYPASSRLS**
  connection — wiring that second connection is the next step before relying on
  enforced RLS for those operator reads.

## Consequences

- The isolation guarantee is explicit and testable: a store query without a
  `tenant_id` predicate is a review-blocking defect.
- RLS is **opt-in and operationally gated**, not an auto-migration, because
  enabling it without (a) a non-owner app role and (b) the `app.current_tenant`
  GUC being set per request would break a running deployment. The GUC is now
  set automatically when `TENANT_RLS_ENABLED=true` (see `withTenant` in
  `src/db/database.ts`); the operator still applies `deploy/postgres-rls.sql`
  with a least-privilege role to switch enforcement on at the database.
- The operator plane is deliberately cross-tenant and is protected by RBAC
  (ADR-aligned with `middleware/operator-rbac.ts`), not by tenant scoping.
- Right-to-be-forgotten erasure (`observability/retention*.ts`) reuses the same
  `tenant_id` predicate, so the deletion boundary matches the read boundary.
