<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Deprecations

Every option, field and header that still works but is scheduled for removal.
Everything on this list is removed in **1.0.0**, so a deployment that stops
using these names before then needs no change at 1.0.0. The
[stability contract](STABILITY.md) describes how deprecations work from 1.0.0
on.

| Item | Kind | Replacement | Deprecated since | Removed in |
| --- | --- | --- | --- | --- |
| `PROFILE` (Runtime) | env | `ATF_PRESET` (same values) | 0.19.0 | 1.0.0 |
| `API_SERVICE_TENANT_ID` (Search) | env | `DEFAULT_TENANT_ID` | before 0.20.0 | 1.0.0 |
| `API_OIDC_DEFAULT_TENANT_ID` (Search) | env | `DEFAULT_TENANT_ID` | before 0.20.0 | 1.0.0 |
| `AUTHORIZATION_ENABLED` (Gate) | env | `AUTHZ_ENABLED` | before 0.20.0 | 1.0.0 |
| `TENANT_ISOLATION_DEFAULT_TENANT_ID` (Gate) | env | `DEFAULT_TENANT_ID` | before 0.20.0 | 1.0.0 |
| `auth.oauth.allowAnyIssuer`, `auth.oauth.additionalIssuers[].allowAnyIssuer` | gate config | None; the option has no effect, the issuer is always required and pinned. Remove it. | before 0.20.0 | 1.0.0 |
| `auth.oauth.allowAnyAudience`, `auth.oauth.additionalIssuers[].allowAnyAudience` | gate config | None; the option has no effect, the audience is always required. Remove it. | before 0.20.0 | 1.0.0 |
| `server.forwardBearerToken` on `tools[]` and `mcpServers[]` | gate config | `server.tokenExchange` (RFC 8693 token exchange) | 0.15.0 | 1.0.0 |
| `X-Mandant-Id` request header (assistant routes) | API | `X-Tenant-Id` | 0.1.0 | 1.0.0 |
| Implicit default `clientClientdocs` of `ragProfiles.authoritativeTagField` | flow field | Set `authoritativeTagField` explicitly in the flow | 0.1.0 | 1.0.0 |

"Before 0.20.0" means the release that deprecated the item was not recorded;
the item is documented as deprecated in 0.20.0.

## How you are told

Each deprecated environment variable and Gate option logs a warning at startup
when it is set, in the form `<NAME> is deprecated and will be removed in 1.0.0;
use <REPLACEMENT>` (some older messages word this differently):

- Runtime: `PROFILE` logs a deprecation warning.
- Search: `API_SERVICE_TENANT_ID` and `API_OIDC_DEFAULT_TENANT_ID`.
- Gate: `AUTHORIZATION_ENABLED` and `TENANT_ISOLATION_DEFAULT_TENANT_ID` at
  startup; `allowAnyIssuer`, `allowAnyAudience` and `forwardBearerToken`
  through the production-readiness gate at startup, and `forwardBearerToken`
  once more per tool on its first forwarded call.

Two items do not warn yet, because they are read where no logger is at hand:
the `X-Mandant-Id` header and the implicit `clientClientdocs` default. Search
your clients and flows for them before upgrading to 1.0.0.

## Not on this list

Source-level `@deprecated` markers on internal TypeScript names are not
operator-facing and carry no promise; they are removed when unused.
