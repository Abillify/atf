# @atf/security-kit

Package `1.4.0`. Shared security building blocks of the ATF services: constant-time
comparison, base64url, the SSRF egress guard, multi-issuer JWT/OIDC verification, GCRA rate
limiting (memory and Redis), the operational-profile resolver and production-gate rule
primitives, COSE/CBOR for decision receipts, token exchange and log redaction.

The root entry point is Node-only. Browser code imports `@atf/security-kit/browser`, which
exposes only the base64url helpers, the CBOR codec and COSE_Sign1 verification (WebCrypto), so
a bundler never pulls `node:crypto` into a client bundle.

## Exports

| Area | Exports | Purpose |
| --- | --- | --- |
| Comparison | `safeEqual`, `safeEqualBytes`, `createStaticTokenMatcher` | Constant-time comparison; a matcher over configured static tokens (a matcher without tokens rejects everything) |
| base64url | `base64UrlEncode`, `base64UrlEncodePadded`, `base64UrlDecode`, `base64UrlDecodeToString`, `base64UrlEncodeString` | Codec without `Buffer` assumptions |
| CBOR / COSE | `cborEncode`, `cborDecode`, `cborTagged`, `cborMap`, `coseSign1`, `coseSign1Verify`, `cborEncodeSign1`, `cborDecodeSign1`, `importEd25519PrivateKeySeed`, `exportEd25519RawPublicKey`, `ed25519RawKeyToJwk`, `jwkToEd25519RawKey` | Decision-receipt signing and offline verification (EdDSA, `COSE_ALG_EDDSA`) |
| Egress guard | `createEgressGuard`, `EgressError`, `isForbiddenAddress`, `isAlwaysForbiddenAddress`, `isHostAllowed`, `parseIPv4`, `parseIPv6`, `FORBIDDEN_HOST_PATTERNS` | SSRF protection: resolves, checks and pins the address before a request leaves |
| JWT / OIDC | `createJwtVerifier`, `JwtVerificationError`, `createDiscoveryClient`, `DiscoveryError`, `validateJwksUri`, `parseMaxAgeMs` | Multi-issuer verification with discovery and JWKS caching |
| Token exchange | `TokenExchanger`, `ActorTokenProvider`, `createTokenEndpointResolver` | RFC 8693 token exchange and actor client-credentials tokens |
| Rate limiting | `gcraCheck`, `createMemoryRateLimitBackend`, `createRedisRateLimitBackend`, `createLazyRedisRateLimitBackend`, `createRateLimitMiddleware` | GCRA limiter with an in-process and a shared Redis backend |
| Production profile | `OPERATIONAL_PROFILES`, `OPERATIONAL_PROFILE_ENV_VAR`, `resolveOperationalProfile`, `normalizeOperationalProfile`, `profileShadowWarning`, `UnknownOperationalProfileError` | One explicit operating mode for every service |
| Prod gate | `createProdGate`, `requireExplicitAuthMode`, `forbidWildcardCors`, `requireTicketSecret`, `requireEnabled`, `requireSecretLength`, `forbidSharedSecrets`, `requirePositiveTimeout`, `reportProdGate` | Rules that are fatal in `production` and warnings elsewhere |
| TLS | `createServerWithOptionalTls`, `createClientTlsInit` | Optional (m)TLS for servers and clients |
| Headers | `parseBooleanHeader`, `readHeader`, `readListHeader`, `decodeIfBase64`, `sanitizeHeaderValue` | Tolerant header parsing |
| Log redaction | `pinoLogRedaction`, `redactLogFields`, `redactLogString`, `isSensitiveLogKey`, `hashIdentifier`, `withMaskedChildBindings`, `LOG_REDACTED` | Credential-shaped values are replaced; identifiers can be logged as short hashes |

## Operational profile

`resolveOperationalProfile(env, serviceVars)` returns `{ profile, isProduction, source }`. The
precedence is `ATF_PROFILE`, then each service variable in the order given (for example
`MCPGATE_ENV`, `NODE_ENV`), then `development`. A blank variable falls through to the next
candidate; a non-blank unknown value throws `UnknownOperationalProfileError`, so a typo can never
switch the production gates off. The closed set is `development`, `staging`, `production`, `test`;
only `production` enforces fatal findings, the others report them as warnings. `ATF_PROFILE` is
unrelated to Runtime's `PROFILE`, which selects a configuration preset.

When a lower-precedence variable says `production` while the effective profile is not (for
example `NODE_ENV=production` with `ATF_PROFILE=staging`), the result carries
`shadowedProduction` and `profileShadowWarning(resolved)` returns the startup warning
`<VAR>=production is overridden by <SOURCE>=<profile>; production checks are not enforced.`
Every service logs it.

## JWT verifier

`createJwtVerifier({ issuers, ... })` routes a token to its issuer, fetches keys from the
issuer's JWKS (via discovery) and checks signature, issuer, audience and expiry. The algorithm
allow-list defaults to `RS256`, `ES256`, `EdDSA` and may never contain `none`.

`allowedTypes` (optional) restricts the JWT `typ` header. The value is compared lowercased and
without an `application/` prefix, so `at+jwt` and `application/at+jwt` are equivalent. When set,
a token with another or no `typ` is rejected as `invalid_token`; when unset or empty the header is
not checked, which keeps identity providers that send `typ: JWT` working. The Gate exposes it as
`auth.oauth.allowedTokenTypes`.

## Rate limiting

`createMemoryRateLimitBackend` limits per process. `createRedisRateLimitBackend` (and
`createLazyRedisRateLimitBackend`, which connects on first use and retries after a failed
connect) share the limit across replicas through a Lua script. The lazy backend loads the `redis`
package by name, so a service that sets a Redis URL must install it.

When Redis errors, the Redis backend applies its own `failMode`: `"closed"` (the default) denies,
`"open"` allows. The middleware itself, when handed an async backend that throws, lets the
request pass and calls `onBackendError`, so an outage of a backend without its own `failMode`
degrades to "no limiting" rather than blocking traffic. The middleware option `failMode: "closed"`
answers 503 instead (default `"open"`).

## Usage

```ts
import {
  createJwtVerifier,
  resolveOperationalProfile,
  safeEqual,
} from "@atf/security-kit";

const { isProduction } = resolveOperationalProfile(process.env, ["NODE_ENV"]);

const verifier = createJwtVerifier({
  issuers: [{ issuer: "https://id.example.com", audiences: ["atf"] }],
  allowedTypes: isProduction ? ["at+jwt"] : undefined,
});
const { payload } = await verifier.verify(token);

const sameSecret = safeEqual(presented, expected);
```

## Compatibility

Imported by `apps/control` (browser entry for receipt verification), `apps/extract`,
`apps/gate`, `apps/runtime` and `apps/search`. Additive exports bump the minor version.

## Tests

```bash
bun run --filter @atf/security-kit test
bun run --filter @atf/security-kit test:node
```
