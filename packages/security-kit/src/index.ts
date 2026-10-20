// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/security-kit
 *
 * Shared security primitives for the ATF platform: constant-time comparison,
 * base64url, the Egress Guard (SSRF), JWT/OIDC verification with multi-issuer
 * routing and discovery caching, a GCRA rate limiter (memory + Redis), and
 * Prod_Gate rule building blocks.
 *
 * Node-only. Browser code must import `@atf/security-kit/browser`, which
 * exposes only the base64url helpers.
 */

export { safeEqual, safeEqualBytes } from "./compare.ts";
export { createStaticTokenMatcher } from "./auth/static-token.ts";
export {
  cborEncode,
  cborDecode,
  cborTagged,
  cborMap,
  CborEncodeError,
  CborDecodeError,
  type CborValue,
  type CborTagged,
  type CborMap,
} from "./cbor/index.ts";
export {
  COSE_ALG_EDDSA,
  ED25519_PUB_KEY_BYTES,
  ED25519_SIG_BYTES,
  coseSign1,
  coseSign1Verify,
  cborEncodeSign1,
  cborDecodeSign1,
  decodeProtectedHeader,
  importEd25519PrivateKeySeed,
  exportEd25519RawPublicKey,
  ed25519RawKeyToJwk,
  jwkToEd25519RawKey,
  type CoseSign1,
  type CoseSign1Options,
  type Ed25519PublicJwk,
} from "./cose/index.ts";
export {
  createServerWithOptionalTls,
  TlsServerConfigError,
  type ServerTlsConfig,
} from "./server/tls-server.ts";
export {
  createClientTlsInit,
  ClientTlsConfigError,
  type ClientTlsOptions,
} from "./http/client-tls.ts";
export {
  parseBooleanHeader,
  readHeader,
  readListHeader,
  decodeIfBase64,
  sanitizeHeaderValue,
} from "./headers.ts";
export {
  base64UrlEncode,
  base64UrlEncodePadded,
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncodeString,
} from "./base64url.ts";

export {
  parseIPv4,
  parseIPv6,
  isForbiddenAddress,
  isAlwaysForbiddenAddress,
  FORBIDDEN_HOST_PATTERNS,
  isHostAllowed,
} from "./egress/addresses.ts";
export {
  createEgressGuard,
  EgressError,
  type EgressGuard,
  type EgressGuardOptions,
  type GuardedResponse,
  type GuardedRequestInit,
  type HostResolver,
  type ResolvedAddress,
} from "./egress/guard.ts";

export {
  createDiscoveryClient,
  DiscoveryError,
  parseMaxAgeMs,
  validateJwksUri,
  DEFAULT_MIN_POSITIVE_TTL_MS,
  DEFAULT_NEGATIVE_TTL_MS,
  DEFAULT_MAX_NEGATIVE_TTL_MS,
  type DiscoveryClient,
  type DiscoveryOptions,
  type OidcDiscoveryDocument,
} from "./jwt/discovery.ts";
export {
  createJwtVerifier,
  JwtVerificationError,
  type IssuerConfig,
  type JwtVerifier,
  type JwtVerifierOptions,
  type JwtRejectionReason,
  type VerifiedJwt,
} from "./jwt/verifier.ts";

export {
  gcraCheck,
  type GcraConfig,
  type GcraDecision,
  type GcraState,
  type FailMode,
  type RateLimitBackend,
  type RateLimitResult,
} from "./rate-limit/gcra.ts";
export {
  createMemoryRateLimitBackend,
  type MemoryBackendOptions,
} from "./rate-limit/memory.ts";
export {
  createRateLimitMiddleware,
  type RateLimitMiddleware,
  type RateLimitMiddlewareOptions,
  type RateLimitRequest,
  type RateLimitResponse,
} from "./rate-limit/middleware.ts";
export {
  createRedisRateLimitBackend,
  createLazyRedisRateLimitBackend,
  GCRA_LUA,
  type LazyRedisBackendOptions,
  type LazyRedisRateLimitBackend,
  type RedisBackendOptions,
  type RedisEvalClient,
} from "./rate-limit/redis.ts";

export {
  createProdGate,
  requireExplicitAuthMode,
  forbidWildcardCors,
  requireTicketSecret,
  requireEnabled,
  requireSecretLength,
  forbidSharedSecrets,
  requirePositiveTimeout,
  type ProdGate,
  type ProdGateFinding,
} from "./prod-gate/rules.ts";
export {
  reportProdGate,
  type ReportSink,
  type ReportOutcome,
} from "./prod-gate/reporter.ts";
export {
  OPERATIONAL_PROFILES,
  OPERATIONAL_PROFILE_ENV_VAR,
  UnknownOperationalProfileError,
  normalizeOperationalProfile,
  resolveOperationalProfile,
  type OperationalProfile,
  type ResolvedOperationalProfile,
} from "./prod-gate/profile.ts";

export {
  TokenExchanger,
  ActorTokenProvider,
  createTokenEndpointResolver,
  EXCHANGE_EXPIRY_MARGIN_MS,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_JWT,
  type ActorClientCredentialsConfig,
  type ClientAuthMethod,
  type ExchangeLogger,
  type ExchangeResult,
  type ExchangedToken,
  type FetchLike,
  type TokenEndpointResolver,
  type TokenExchangeConfig,
} from "./auth/token-exchange.ts";
export {
  LOG_REDACTED,
  hashIdentifier,
  isSensitiveLogKey,
  pinoLogRedaction,
  redactLogFields,
  redactLogString,
  withMaskedChildBindings,
} from "./log-redact.ts";
