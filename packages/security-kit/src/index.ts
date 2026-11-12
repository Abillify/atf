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

export {
	applySecrets,
	materializeSecrets,
	resolveSecret,
	SecretConfigError,
} from "./auth/resolve-secret.ts";
export { createStaticTokenMatcher } from "./auth/static-token.ts";
export {
	type ActorClientCredentialsConfig,
	ActorTokenProvider,
	type ClientAuthMethod,
	createTokenEndpointResolver,
	EXCHANGE_EXPIRY_MARGIN_MS,
	type ExchangedToken,
	type ExchangeLogger,
	type ExchangeResult,
	type FetchLike,
	TOKEN_TYPE_ACCESS_TOKEN,
	TOKEN_TYPE_JWT,
	type TokenEndpointResolver,
	type TokenExchangeConfig,
	TokenExchanger,
} from "./auth/token-exchange.ts";
export {
	base64UrlDecode,
	base64UrlDecodeToString,
	base64UrlEncode,
	base64UrlEncodePadded,
	base64UrlEncodeString,
} from "./base64url.ts";
export {
	CborDecodeError,
	CborEncodeError,
	type CborMap,
	type CborTagged,
	type CborValue,
	cborDecode,
	cborEncode,
	cborMap,
	cborTagged,
} from "./cbor/index.ts";
export { safeEqual, safeEqualBytes } from "./compare.ts";
export {
	COSE_ALG_EDDSA,
	type CoseSign1,
	type CoseSign1Options,
	cborDecodeSign1,
	cborEncodeSign1,
	coseSign1,
	coseSign1Verify,
	decodeProtectedHeader,
	ED25519_PUB_KEY_BYTES,
	ED25519_SIG_BYTES,
	type Ed25519PublicJwk,
	ed25519RawKeyToJwk,
	exportEd25519RawPublicKey,
	importEd25519PrivateKeySeed,
	jwkToEd25519RawKey,
} from "./cose/index.ts";
export {
	type AllowlistPartition,
	type CidrRange,
	FORBIDDEN_HOST_PATTERNS,
	isAddressInCidr,
	isAlwaysForbiddenAddress,
	isForbiddenAddress,
	isHostAllowed,
	parseCidr,
	parseIPv4,
	parseIPv6,
	partitionAllowlistEntries,
} from "./egress/addresses.ts";
export {
	createEgressGuard,
	EgressError,
	type EgressGuard,
	type EgressGuardOptions,
	type GuardedRequestInit,
	type GuardedResponse,
	type HostResolver,
	type ResolvedAddress,
} from "./egress/guard.ts";
export {
	decodeIfBase64,
	parseBooleanHeader,
	readHeader,
	readListHeader,
	sanitizeHeaderValue,
} from "./headers.ts";
export {
	ClientTlsConfigError,
	type ClientTlsOptions,
	createClientTlsInit,
} from "./http/client-tls.ts";

export {
	createDiscoveryClient,
	DEFAULT_MAX_NEGATIVE_TTL_MS,
	DEFAULT_MIN_POSITIVE_TTL_MS,
	DEFAULT_NEGATIVE_TTL_MS,
	type DiscoveryClient,
	DiscoveryError,
	type DiscoveryOptions,
	type OidcDiscoveryDocument,
	parseMaxAgeMs,
	validateJwksUri,
} from "./jwt/discovery.ts";
export {
	createJwtVerifier,
	type IssuerConfig,
	type JwtRejectionReason,
	JwtVerificationError,
	type JwtVerifier,
	type JwtVerifierOptions,
	type VerifiedJwt,
} from "./jwt/verifier.ts";
export {
	hashIdentifier,
	isSensitiveLogKey,
	LOG_REDACTED,
	pinoLogRedaction,
	redactLogFields,
	redactLogString,
	withMaskedChildBindings,
} from "./log-redact.ts";
export {
	normalizeOperationalProfile,
	OPERATIONAL_PROFILE_ENV_VAR,
	OPERATIONAL_PROFILES,
	type OperationalProfile,
	profileShadowWarning,
	type ResolvedOperationalProfile,
	resolveOperationalProfile,
	UnknownOperationalProfileError,
} from "./prod-gate/profile.ts";
export {
	type ReportOutcome,
	type ReportSink,
	reportProdGate,
} from "./prod-gate/reporter.ts";
export {
	createProdGate,
	forbidSharedSecrets,
	forbidWildcardCors,
	type ProdGate,
	type ProdGateFinding,
	requireEnabled,
	requireExplicitAuthMode,
	requirePositiveTimeout,
	requireSecretLength,
	requireTicketSecret,
} from "./prod-gate/rules.ts";
export {
	type FailMode,
	type GcraConfig,
	type GcraDecision,
	type GcraState,
	gcraCheck,
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
	createLazyRedisRateLimitBackend,
	createRedisRateLimitBackend,
	GCRA_LUA,
	type LazyRedisBackendOptions,
	type LazyRedisRateLimitBackend,
	type RedisBackendOptions,
	type RedisEvalClient,
} from "./rate-limit/redis.ts";
export {
	createServerWithOptionalTls,
	type ServerTlsConfig,
	TlsServerConfigError,
} from "./server/tls-server.ts";
export { trimTrailingSlashes } from "./url-trim.ts";
