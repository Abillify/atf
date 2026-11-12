<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 42. Identity provisioning: OIDC group claims first, SCIM only where claims cannot reach

Date: 2026-11-11

## Status

Accepted (2026-11-12). Tier 1 is the current behaviour and stays. Tier 2, the deprovisioning
endpoint, is decided and not yet implemented.

## Context

ATF holds identity-related state in several places, and none of it is provisioned from an
identity provider automatically:

- **Tenants** are created and managed through `/admin/tenants/*` (`routes/tenants.ts`); tenant
  lifecycle is an operator action.
- **Operator roles** gate the management plane. They are already derived from the verified
  token at request time: `OPERATOR_ROLE_CLAIM`, `OPERATOR_GROUPS_CLAIM` and `OPERATOR_ROLE_MAP`
  map IdP roles or groups to `viewer`/`operator`/`admin`.
- **Search ACLs** restrict which documents a subject may retrieve. `AccessScope` is compiled into
  SQL (`buildAccessSql` in `apps/search/src/access-scope.ts`) from the user and groups of the
  verified principal of each request, not from a synchronised table.
- **Flow access** (`requiredScopes` in `apps/runtime/schemas/flow.schema.json`, plus
  `FLOW_SCOPE_CLAIMS`) is evaluated from token claims per request as well.
- **Assistants, channel bindings and conversation data** are per-user records the user creates
  (self-service pairing, ADR 0041).
- **API keys** belong to a tenant, not to a person (`api_keys.tenant_id`); they are minted and
  revoked through the admin plane.

The review finding was: "automated provisioning of users and groups from the identity provider
is missing." Much of the premise is already solved differently: authorization in ATF is
**claim-evaluated, not table-synchronised**. A user added to an IdP group gains rights with their
next token; there is no local copy to reconcile.

What is genuinely missing is the **lifecycle** half: when a person leaves, their ATF-side
artefacts — assistants, channel bindings, operator sessions, personal data — are only handled
when someone files a data-subject request through the erasure orchestration of ADR 0025.

## Decision

### Tier 1 — groups and entitlements: OIDC claims, no SCIM

Authorization keeps evaluating verified token claims per request: Search ACL groups, flow
`requiredScopes`, operator roles. A deployment that needs role-based access maps IdP groups to
roles at the auth boundary with the existing variables. ATF does not mirror IdP group membership
into its own tables. Revocation is as fast as the IdP's access-token lifetime, and there is no
synchronisation state machine to fail.

### Tier 2 — lifecycle: a deprovisioning endpoint, SCIM-shaped but not full SCIM

`POST /admin/identity/deprovision` with body `{ "subject": "<sub>", "tenantId": "<tenant>" }`,
protected by a new operator permission `identity:deprovision` (admin role by default).

It does not delete content. In one audited operation it:

1. records the subject as deprovisioned for the tenant (`deprovisioned_subjects`: tenant,
   subject, time, actor);
2. ends the subject's operator sessions (OIDC session store);
3. disables the subject's assistants and revokes their channel bindings;
4. rejects further requests whose verified subject is on the list — the auth middleware checks
   the list after token verification, so a still-valid token stops working at once instead of at
   expiry;
5. starts the ADR 0025 erasure orchestration for the subject's personal data **only when the
   request says so** (`"erase": true`); otherwise retention windows apply as usual.

It answers idempotently: a second call for the same subject reports the existing record.

A full SCIM 2.0 server (`/Users`, `/Groups`, PATCH semantics, ETags) is not adopted: ATF has no
local user or group store for SCIM to write into, and creating one to satisfy a protocol would
weaken the claim-based model with a stale copy. If an IdP can only speak SCIM, a thin adapter maps
`DELETE /Users/{id}` (or `active: false`) onto this endpoint; that adapter is a separate change.

## Implementation plan

1. Migration: `deprovisioned_subjects` (tenant-scoped, RLS like other tenant tables).
2. Runtime: endpoint, permission, audit entry `identity.deprovision` (regulated action, recorded
   with `recordRequired`), and the subject check in the auth middleware after verification.
3. Erasure: optional hand-off to the existing orchestrator; the receipt of ADR 0025 documents
   what was erased.
4. Docs: CAPABILITIES (Multi-tenancy and identity; Retention and erasure), CONFIGURATION.

## Consequences

- Deprovisioning becomes an explicit, auditable event distinct from erasure.
- The subject check adds one indexed lookup per authenticated request; it is cached per process
  for a short TTL, so a deprovisioning takes effect within that TTL on every replica.
- Tenant API keys are untouched: they are not personal. An operator who must cut off a machine
  client revokes its key as today.
- Out of scope: just-in-time user creation (first login is the account), IdP-driven tenant
  lifecycle (tenant offboarding runs through ADR 0025), and the SCIM adapter itself.
