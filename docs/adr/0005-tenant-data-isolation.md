# 5. Tenant data isolation model

Date: 2026-06-16  
Updated: 2026-09-02

## Status

Accepted — application scoping is implemented; database-enforced RLS is an explicit deployment
onboarding step and must be verified against the target PostgreSQL instance.

## Context

ATF stores tenant-scoped cost, billing, execution, provider-key, assistant, and analysis data. A
request must not read or mutate another tenant's rows. The control must remain understandable
when PostgreSQL RLS is not enabled, while deployments that require defense in depth need a
database boundary that does not rely on every query retaining its predicate.

## Decision

### Primary control: application-enforced row scoping

Tenant-scoped stores include `tenant_id` in their SQL predicates. The tenant value comes from the
authenticated request context, not from row data supplied by the client. Job and idempotency
lookups are similarly bound to their submitter and return 404 on a mismatch.

Cross-tenant operator-plane operations are intentional exceptions. Execution history, aggregate
cost/billing views, audit operations, and retention work are protected by operator RBAC and, when
database RLS is enabled, use a separate privileged connection.

Application predicates remain mandatory even when RLS is active. A missing predicate is a defect;
RLS is defense in depth, not permission to remove application scoping.

### Optional defense in depth: PostgreSQL RLS

Runtime contains the reviewed, idempotent RLS DDL in
`apps/runtime/src/db/rls-onboarding.ts`. The supported operator path is the Runtime CLI, not a
standalone SQL file:

```bash
cd apps/runtime
DATABASE_URL='postgresql://migration-admin@localhost/atf' \
  bun run scripts/cli.ts rls-status

# Dry-run: prints planned role, grant, policy, and table changes.
DATABASE_URL='postgresql://migration-admin@localhost/atf' \
  bun run scripts/cli.ts rls-setup

# Mutating operation: apply only after reviewing the plan and taking a backup.
DATABASE_URL='postgresql://migration-admin@localhost/atf' \
  bun run scripts/cli.ts rls-setup --confirm
```

`rls-setup --confirm` creates least-privilege `aiperator_app` and BYPASSRLS
`aiperator_operator` roles when absent, grants their documented table access, and enables and
forces the `tenant_isolation` policy on the tenant tables known to that Runtime version. It does
not assign passwords or change application connection strings. Credentials and authentication
for both roles remain deployment-owned.

After setup, the deployment must:

1. point `DATABASE_URL` at the non-owner `aiperator_app` role;
2. point `DATABASE_OPERATOR_URL` at the `aiperator_operator` role;
3. set `TENANT_RLS_ENABLED=true` so tenant-scoped operations use a reserved transaction and set
   transaction-local `app.current_tenant`;
4. restart Runtime and run `rls-status` again with sufficient inspection privileges;
5. verify cross-tenant denial and required operator-plane behavior against the real database.

Runtime's production-readiness gate treats `TENANT_RLS_ENABLED=true` without
`DATABASE_OPERATOR_URL` as fatal. The CLI's table list is versioned with Runtime, so operators
must rerun status/setup after upgrades that add tenant-scoped tables.

### Two database access planes

- **Tenant plane:** `Database.withTenant(tenantId, cb)` reserves a connection, opens a
  transaction, sets `app.current_tenant` with `set_config(..., true)`, executes the callback,
  and commits or rolls back. Transaction-local state prevents GUC leakage between pooled leases.
- **Operator plane:** `Database.withOperator(cb)` uses the `DATABASE_OPERATOR_URL` pool for
  intentional cross-tenant work. Without that URL it falls back to the regular pool, which is
  compatible only while enforced RLS is off.

API-key lookup resolves a tenant from the key and therefore cannot start with a tenant GUC;
`api_keys` is not in the forced tenant-table policy set. This exception is protected at the
application layer.

## Verification

`apps/runtime/src/db/__tests__/pg-integration.test.ts` contains PostgreSQL integration coverage
for tenant filtering, `WITH CHECK` rejection, and the operator pool. Those tests are skipped
unless a suitable `DATABASE_URL` is provided; their presence is not evidence that a particular
deployment has run them.

The read-only command below is the minimum operational check:

```bash
cd apps/runtime
DATABASE_URL='postgresql://inspection-role@localhost/atf' \
  bun run scripts/cli.ts rls-status
```

A production rollout additionally needs backup/restore readiness, role and grant review,
migration testing, and explicit negative tests using separate tenant identities.

## Consequences

- Runtime remains usable without RLS, but isolation then depends on application predicates.
- Enforced RLS is opt-in because applying role and policy DDL to a live database is a
  deployment-owned, potentially disruptive operation.
- Cross-tenant operator behavior requires a narrowly held BYPASSRLS credential.
- New tenant tables must be added to the onboarding table list and covered by status/setup and
  integration tests.
- `rls-status` provides an auditable table-by-table state report; configuration flags alone do
  not prove that PostgreSQL is enforcing the policies.
