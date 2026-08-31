# 13. Backend-driven (BFF) OIDC session authentication for the operator plane

Date: 2026-07-13

## Status

Accepted

## Context

The operator/monitoring plane already authenticates via a static bearer token
or RBAC-mapped JWT (`MONITORING_AUTH`, the operator verifier). That works for
service-to-service and single-operator setups, but does not scale to a team:
there is no per-person identity, no way to revoke one person's access without
rotating a shared secret, and no integration with an organization's existing
identity provider (Okta, Azure AD, Google Workspace, …).

Adding OIDC login naively — a browser-side (SPA) Authorization Code flow with
PKCE — would put the client secret nowhere (public clients don't have one,
which is correct for SPAs) but would also require the dashboard to ship
build-time `NEXT_PUBLIC_OIDC_*` configuration per deployment and would leave
token refresh logic in the browser. We wanted operator login to work the same
way regardless of which IdP a customer runs, configured entirely through
backend env vars, with the browser never holding a long-lived secret.

## Decision

`src/routes/auth-oidc.ts` implements a **confidential-client** Authorization
Code + PKCE flow that runs entirely on the backend (the Backend-for-Frontend /
BFF pattern) — the client secret (`OIDC_CLIENT_SECRET`) never leaves the
server process, and the dashboard needs zero build-time configuration, only
runtime endpoints under `/monitoring/auth/*` that the reverse proxy already
routes to the backend.

### Flow

1. `GET /monitoring/auth/login` — discovers the IdP's metadata (memoised per
   issuer in `metadataCache`), generates `state`/`nonce`/PKCE `codeVerifier`,
   stashes them in a **signed, HttpOnly, 10-minute** cookie
   (`aiperator_oidc_flow`, HS256-signed with `OIDC_SESSION_SECRET`) — not
   server-side session state, so no store is required just to survive the
   redirect round-trip — and 302s to the IdP.
2. `GET /monitoring/auth/callback` — recovers and clears the flow cookie
   regardless of outcome, validates `state`, exchanges the code
   (`client_id`+`client_secret`+PKCE verifier) at the token endpoint, verifies
   the `id_token` (`jwtVerify` against the IdP's JWKS, checking `iss`, `aud`,
   and `nonce`), and resolves an `OperatorRole` from its claims via the
   **existing** `resolveOperatorRoleFromClaims()` (shared with the static
   operator authorizer, so role-mapping config is not duplicated). It then
   mints a short-lived **HS256 JWT carrying only the resolved `role`** claim,
   signed with `OIDC_SESSION_SECRET`, and redirects to the dashboard with it
   in the URL **fragment** (`#session=...`) — never a query string, so it is
   never logged by the reverse proxy or any intermediate access log.
3. `POST /monitoring/auth/logout` — drops the server-side refresh session (if
   any) and offers the IdP's `end_session_endpoint` for optional RP-initiated
   logout.

The minted session token is verified downstream by the **existing** operator
verifier (HMAC over `OIDC_SESSION_SECRET`) and read through the **existing**
RBAC — this touches only the operator/monitoring auth plane, never the `/v1`
API plane, which keeps its own independent authentication.

### Silent renewal requires holding the IdP refresh token server-side

An HS256 session token with a short TTL needs a renewal path that does not
force a full interactive login every time it expires. Since the refresh token
must never reach the browser (that is the entire point of the confidential-
client BFF pattern), it has to be held server-side, keyed by an opaque id the
browser holds instead. `src/routes/oidc-session-store.ts` implements exactly
that mapping:

- `InMemoryOidcSessionStore` — per-replica; correct for a single-backend
  deployment.
- `RedisOidcSessionStore` — cluster-wide, using Bun's native `RedisClient`
  (via the shared `createRedisClient` helper), so a renewal request landing on
  a different replica than the one that handled login still finds the
  refresh token. **Reads fail closed**: any Redis error on `get()` returns
  `undefined` rather than throwing, which forces the client to re-authenticate
  interactively — the safe direction for a credential store (an unreachable
  store must not be treated as "no session restriction," it must be treated
  as "no valid session").

`createOidcSessionStore(redisUrl, logger)` never returns `undefined` — a
single-replica deployment is fully served by the in-memory store, so silent
renewal always has somewhere to persist the token; only the choice of backing
store depends on configuration.

`GET /monitoring/auth/refresh` looks up the stored refresh token by the opaque
session id (`aiperator_oidc_session` HttpOnly cookie), exchanges it at the
token endpoint, and — critically — **re-runs the full role-resolution check on
every renewal**, via the same `verifyAndMintSession()` helper the callback
uses. A role revoked at the IdP since the last login is honored on the very
next silent renewal, not only on the next interactive login. The IdP's
response may rotate the refresh token; when it does, the stored record is
updated (`sessionStore.set` with the new token), otherwise the existing one is
kept and only the TTL is reset — a sliding window for an active operator.

### Open-redirect guard

`pickReturnUrl()` only honors a caller-supplied `redirect` query parameter
when its origin matches the configured `dashboardUrl` (or, absent that
config, the request's own origin) — an absolute URL to an arbitrary origin is
rejected and the flow falls back to `dashboardUrl` or `/`.

## Consequences

- Operators authenticate with their organization's real identity, with
  per-person revocation at the IdP and no shared secret to rotate.
- The dashboard requires zero OIDC-specific build-time configuration; the
  entire flow is backend-driven, so the same frontend bundle works against
  any customer's IdP.
- Silent renewal is opt-in and degrades gracefully: when no `sessionStore` is
  wired (or `REDIS_URL` is unset and Redis is unavailable), `GET
  /monitoring/auth/refresh` simply 401s and the dashboard falls back to an
  interactive login — this is documented as "pre-refresh behaviour," not a
  new failure mode.
- Static-token/JWT operator auth and OIDC session auth run side by side
  behind the same verifier; a deployment can enable OIDC without disabling
  the static token path, useful for CI/service accounts that should not go
  through an interactive login.
- The refresh-session store is a second credential-adjacent server-side store
  (after the tenant provider-key store) that must be protected at the
  infrastructure level — Redis holding IdP refresh tokens is a sensitive
  target, same class of risk as the BYOK provider-key store, and should be
  operated with equivalent access controls.
