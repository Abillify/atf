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
  createRedisRateLimitBackend,
  GCRA_LUA,
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
