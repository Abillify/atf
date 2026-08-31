# 19. Agent Identity Broker and cross-scope Revocation Console

Date: 2026-08-02

## Status

Accepted

## Context

The per-user assistant subsystem (`src/assistants/`) already has every
primitive needed to decide, per run, whose authority an assistant's tool
calls carry (`execution-authority.ts`'s `decideExecutionAuthority`), to store
a user-consented OIDC delegation grant encrypted at rest
(`credential-store.ts`), and to mint and cache short-lived delegated access
tokens from it (`token-minter.ts`). What did not exist was any operator-facing
way to answer two organisational questions those primitives make possible but
do not themselves surface:

1. **"Who holds delegated authority right now, across the whole
   deployment?"** `CredentialStore.list()` is scoped to a single
   `(tenant, user, assistant)` — correct for the user-plane API (a user must
   never see another user's grants) but useless for an operator who needs to
   audit or investigate across the estate, the same gap `AssistantStore.list`
   vs. `AssistantStore.listForOperator` already solved for the assistant
   registry itself.
2. **"If I revoke a grant, does the assistant actually stop acting
   immediately?"** `CredentialStore.revoke()` only updates the stored grant —
   it does not touch `DelegatedTokenMinter`'s independent, short-TTL
   (minutes) in-process cache of already-minted access tokens. Revoking a
   grant without invalidating that cache leaves the assistant able to keep
   calling protected tools with the old token until it expires on its own,
   which is not what "revoke" means to an operator who just pressed the
   button — likely in response to a compromised credential or an offboarded
   user.

## Decision

### Identity Broker

`AuthorityResolver` (already the single call every assistant run makes before
using any tool) gains one new method: `invalidateDelegatedToken(scope,
issuer)`, a thin pass-through to `DelegatedTokenMinter.invalidate()`. No new
resolution logic is introduced — the "broker" is the existing
resolve-and-mint pipeline; this ADR's job is closing the one gap in its
lifecycle (cache invalidation on revoke), not replacing it.

The user-plane revoke route (`DELETE /v1/assistants/:id/delegation`) is
updated to call both `credentials.revoke()` **and**
`authority.invalidateDelegatedToken()` — revocation is one user action but two
required server-side effects.

### Revocation Console

`CredentialStore` gains `listForOperator(params?)`, mirroring
`AssistantStore.listForOperator` exactly: a separate method rather than a
widened `list()`, so no caller can accidentally turn a per-assistant read into
an estate-wide one by omitting an argument. It supports filtering by tenant,
user, assistant, and the derived delegation `state` (`usable` / `revoked` /
`broken` / `absent`), and returns a bounded, paged result with the unpaged
total. The Postgres implementation pushes the structural filters
(tenant/user/assistant) into SQL under a hard row cap, then applies the
`state` filter and paging in-process — `state` is derived from decrypted
credential fields via `resolveDelegationState`, and pushing that into SQL
would mean duplicating decrypt-then-decide logic in two places.

Two new operator-plane routes in `src/routes/assistants-admin.ts` (the router
already established as the cross-user operator surface, per ADR-adjacent
convention — see its own module doc comment):

- `GET /admin/identity-broker/delegations` — the cross-scope listing, gated
  on `monitoring:read`. Never returns a refresh token, same guarantee as every
  other delegation-reading route on any plane.
- `DELETE /admin/assistants/:tenantId/:userId/:id/delegation?issuer=…` — the
  operator-plane revoke, gated on `monitoring:write`. Performs both required
  effects (`credentials.revoke()` + `authority.invalidateDelegatedToken()`)
  and records an audit entry (`assistant.delegation.revoke`) — the first
  audit-logged action on this router, since none of its prior mutations
  (constraints, status/autonomy, proposal rejection) were considered
  consequential enough to need one; revoking another user's delegated
  authority is.

The dashboard's existing `/assistants` operator page gains a second tab,
"Revocation Console" (`AssistantsPanel.tsx`), presenting the cross-scope
listing with a per-row revoke button, alongside the existing per-assistant
estate view (which itself also gained a revoke button on its own
"Delegated credentials" section, using the same route with an
already-known scope).

## Consequences

- Revoking a delegation grant, from either plane, now reliably and
  immediately stops an assistant from acting with it — closing the "revoked
  but still working for a few minutes" window that existed before.
- An operator can audit every delegated credential in the deployment from one
  screen, filtered by state, without knowing in advance which
  tenant/user/assistant to look at — the actual shape of "did we leak a
  credential" or "did our IdP migration break every grant" investigations.
- No new storage primitive, encryption boundary, or trust decision was
  introduced: this ADR only exposes and completes the lifecycle of
  primitives ADR-adjacent code (`src/assistants/*.ts`'s own extensive doc
  comments, which function as this subsystem's de facto design record) had
  already established. `listForOperator`'s Postgres query is bounded (a
  fixed row cap before in-process filtering) to keep it a genuine
  operator-console query rather than an unbounded table scan, consistent
  with `AssistantStore.listForOperator`'s own paging bound.
- The operator-plane revoke route is deliberately narrower than the
  user-plane one only in gating (`monitoring:write` vs. the user's own
  identity) — the request/response shape and required query parameter
  (`issuer`) are identical, so a client already speaking one plane's
  delegation API needs no new mental model for the other.
