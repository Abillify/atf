<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 42. Identity provisioning: OIDC group claims first, SCIM only where claims cannot reach

Date: 2026-11-13

## Status

Proposed

## Context

ATF holds identity-related state in several places, and none of it is
provisioned from an identity provider automatically today:

- **Tenants** are created and managed through `/admin/tenants/*`
  (`apps/runtime/src/routes/tenants.ts`, enabled by
  `routes-management.ts`); tenant lifecycle is an operator action.
- **Operator roles** gate the management plane; operators authenticate via
  OIDC (`OIDC_CLIENT_SECRET`, session cookies) or API keys.
- **Search ACL groups** restrict which documents a subject may retrieve:
  `AccessScope` is compiled into SQL by `buildAccessSql` /
  `aclExistsClause` (`apps/search/src/asset-store.ts`), so group membership
  is evaluated per request from the token's claims, not from a synced table.
- **Flow scopes** (`scopes` in `apps/runtime/schemas/flow.schema.json`) are
  OAuth/OIDC scopes a caller needs to discover and run a flow — again
  claim-based at request time.
- **Assistants and channel bindings** are per-user records created by the
  user (self-service pairing, ADR 0041) — not by an IdP.
- **API keys** are per-tenant secrets minted through the admin plane.

The review finding: "automated provisioning of users and groups from the
identity provider is missing." The question this ADR answers is whether
SCIM 2.0 is the right instrument, because much of the premise is already
solved differently: authorization in ATF is **claim-evaluated, not
table-synchronized**. Search ACLs and flow scopes read the groups/scopes
present in the verified token at request time. A user added to an IdP group
gains retrieval rights on their next token — no sync needed, and no stale
local copy to reconcile.

What SCIM would actually add is the *lifecycle* half: deprovisioning. When a
user leaves the organization, ATF-side artifacts (assistants, channel
bindings, personal API keys, PII-vault entries, run history) must be dealt
with. Today that only happens through the erasure orchestration of ADR 0025
(`apps/runtime/src/compliance/erasure-orchestrator.ts`), which is triggered
by a data-subject request or an operator DSAR — not by the IdP telling ATF
"this subject is gone."

## Decision

Adopt a two-tier position:

1. **Groups and entitlements: OIDC claims, no SCIM.** Authorization
   decisions (search ACL groups, flow scopes, operator roles) continue to
   evaluate verified token claims per request. If a deployment needs
   role-based access, the IdP group claim is mapped to roles at the auth
   boundary; ATF does not mirror IdP group membership into its own tables.
   This keeps revocation immediate (token lifetime, ADR on token lifetimes)
   and eliminates a synchronization state machine.
2. **Lifecycle: a deprovisioning endpoint, SCIM-shaped but not full SCIM.**
   Add an authenticated `POST /provisioning/deprovision` (operator token or
   a dedicated scoped credential) taking `{ subject, tenantId }`. It does
   not delete content — it (a) marks the subject deprovisioned, (b) revokes
   their API keys and sessions, (c) disables their assistants and revokes
   channel bindings, and (d) enqueues the ADR 0025 erasure orchestrator for
   the personal-data part under the existing DSAR policy (retention windows
   still apply; deprovisioning is not automatic erasure). A full SCIM 2.0
   server (`/Users`, `/Groups`, PATCH semantics, etags) is explicitly not
   adopted: ATF has no local user or group store for it to write into, and
   inventing one to satisfy a protocol would *weaken* the claim-based model
   by introducing stale copies.

If a future enterprise deployment is mandated to speak SCIM by its IdP
tooling, the endpoint above is the seam: a thin SCIM adapter can translate
`DELETE /Users/<id}` to a deprovisioning call without changing the core.

## Consequences

- Deprovisioning becomes an explicit, auditable event distinct from erasure;
  the audit log records who/what triggered it and which artifacts were
  revoked.
- The "missing provisioning" finding is answered for the authorization half
  by pointing at the claim model, and for the lifecycle half by one small
  endpoint instead of a SCIM server.
- Cost: a `subjects`-style lifecycle marker needs a home (per-tenant table
  or column) and every auth path must honor it — this is the main
  implementation surface and the reason this is an ADR rather than a task.
- Risk accepted: a subject whose IdP account is disabled but who holds a
  valid unexpired token keeps access until the token expires. This is the
  standard OIDC trade-off; it is bounded by the short token lifetimes
  already in force, and the deprovisioning endpoint exists precisely to
  shorten the window when an operator learns of it earlier.
- Out of scope: just-in-time user creation (ATF has no user accounts to
  create — first login is the account), and IdP-driven tenant lifecycle
  (tenant offboarding already runs through the ADR 0025 orchestrator).
