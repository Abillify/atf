# ADR-0001: A verified identity is authoritative for access control

- **Status:** Accepted
- **Date:** 2026-08-02
- **Context repo:** vectorsearch

## Context

vectorsearch enforces two layers of access control: per-row `allowed_users` /
`allowed_groups` (in `query-builder.ts`) and per-collection ACLs (in
`handlers/collection-access.ts`). Both resolved the acting identity from the
`X-User` / `X-Groups` request headers, on the documented assumption that the
API-token-holding caller asserts the end user truthfully.

Two properties of that design combined into a hole that made the ACLs
ineffective in practice:

**1. Header-less meant admin.** A caller that sent neither `X-User` nor
`X-Groups` was treated as a service/admin context and received every row of every
collection. The ACL could therefore be bypassed by *removing* a header — the
easiest possible bypass, and one indistinguishable from an ordinary request.

**2. A verified JWT was thrown away.** `jwt-verifier.ts` validated bearer tokens
against configured OIDC issuers correctly, but `auth.ts` discarded the resulting
principal:

```ts
jwtVerifier.verify(bearerToken).then((principal) => {
  if (principal) return next();   // <- principal dropped here
  …
});
```

It never reached `req`, so downstream code found no identity and applied
property 1. A caller presenting a real end-user token arrived as an *admin*.

That is exactly how aiperator calls this service. With `forwardAuthToken`,
aiperator opens a per-caller MCP session authenticated with the end user's own
bearer and sends **only** `Authorization` — never `X-User`. So on the primary
integration path, both ACL layers were inert.

**3. The MCP tool made it explicit.** `handlers/mcp.ts` passed literal
`undefined` for the identity, annotated `// userId — not exposed in MCP tool
(use filter for ACL)`. A `filter` chosen by the caller is not an access control.

## Decision

**A verified identity is authoritative and can never be overridden by a header.**

Identity resolution moves into one module, `src/request-principal.ts`, which
produces a `RequestPrincipal { userId, userGroups, source }` where `source` is
one of `jwt` · `asserted` · `session` · `service` · `anonymous`.

| Credential | Identity source | May headers override? |
| --- | --- | --- |
| Verified JWT bearer | token claims | **No** |
| Verified OIDC session | session claims | **No** |
| Static `API_TOKEN` (a *service* credential) | `X-User` / `X-Groups`, else service context | Yes — this is the trusted-middle-tier model, retained deliberately |
| No credential (auth disabled) | `X-User` / `X-Groups` | Moot: nothing was authenticated to escalate from |

Supporting changes:

- `JwtPrincipal` gains `userId` (from a per-issuer `userClaim`, default `sub`)
  and `groups` (from `groupsClaim`, default `groups`). `sub` is frequently an
  opaque UUID while `allowed_users` holds usernames, so the mapping has to be
  configurable. A configured claim that is present but unusable falls back to
  `sub` rather than yielding an empty identity — an empty identity used to mean
  *full access*, so failing that way was silent and unsafe.
- `normaliseGroupsClaim` accepts an array, a space-separated string and a
  comma-separated string. IdPs genuinely disagree here, and accepting only one
  shape would produce an empty group list for the others — which reads as "this
  user is in no groups" rather than as a configuration error.
- The MCP tool path gets the principal through `AsyncLocalStorage`
  (`runWithPrincipal` / `getAmbientPrincipal`), mirroring the existing
  `usage-context.ts` pattern rather than introducing a second mechanism. The tool
  closures are built per *session*, so they cannot receive `req`. When no ambient
  principal is in scope the tool **fails closed** with an identity that cannot
  match any ACL, and logs the wiring bug.
- `ACL_REQUIRE_IDENTITY` (default `false`) refuses any request that establishes
  no end-user identity, instead of promoting it to a service context.

## Consequences

**Good**

- Row- and collection-level ACLs actually apply on the aiperator path, verified
  end-to-end against real pgvector (`tests/pgvector-integration.test.ts`).
- A caller holding a real user token cannot relabel itself as another user — or
  as a service — by adding a header.
- Identity resolution is one testable module instead of duplicated header parsing
  in three places.

**Costs and limits, stated plainly**

- **Behavioural change for existing deployments.** A caller that presented a
  *JWT* and also relied on `X-User` to act as somebody else will now act as the
  token's subject. That was the escalation; there is no compatible way to keep it.
- **Header assertion still exists** for static-token service callers, and is
  still only as trustworthy as that token. It is retained because a legitimate
  middle tier needs it. `ACL_REQUIRE_IDENTITY` narrows it; it does not remove it.
- **`ACL_REQUIRE_IDENTITY` defaults to off**, so the "no identity = service
  context" branch remains reachable by default. Turning it on unconditionally
  would break correct deployments: a service-to-service ingest legitimately has
  no end user. The production-readiness gate therefore *warns* about it rather
  than failing, and says what the residual exposure is.
- **Claim mapping is now a configuration responsibility.** If `userClaim` points
  at the wrong claim, users lose access (fail-closed) rather than gaining it. The
  previous failure direction was the opposite, which is why it went unnoticed.

## Alternatives considered

- **Bind the identity to the MCP session at `initialize`.** Rejected: a session
  is long-lived, so the identity captured at hand-shake would keep applying after
  the caller's token changed or expired. `AsyncLocalStorage` re-reads it per
  request.
- **Keep reading headers and simply require them.** Rejected: it does not fix the
  escalation, only the header-less case. A caller could still assert a different
  user.
- **Drop header assertion entirely.** Rejected: it is the documented integration
  model for trusted middle tiers, and removing it would break working callers to
  solve a problem that pinning the JWT path already solves.
