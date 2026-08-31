// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Secure configuration defaults — applied when security-relevant configuration
 * is missing or invalid, regardless of APP_ENV.
 *
 * These values are intentionally restrictive: closed CORS, RLS enforced,
 * monitoring/metrics require auth. The platform starts safe by default and
 * operators explicitly relax what they need.
 *
 * Requirements: 3.3
 */

import type { AppConfig } from "./schema.js";

// ---------------------------------------------------------------------------
// Secure Defaults
// ---------------------------------------------------------------------------

/**
 * Security-relevant subset of AppConfig that always receives safe values when
 * the operator has not explicitly configured them. Keyed to the same property
 * names as AppConfig so they can be spread directly.
 */
export interface SecureDefaults {
  /** CORS: no wildcard — empty origins list blocks all cross-origin requests. */
  corsOrigins: AppConfig["corsOrigins"];
  /** Monitoring stream requires authentication. */
  monitoringAuthRequired: AppConfig["monitoringAuthRequired"];
  /** Metrics endpoint requires authentication. */
  metricsAuthRequired: NonNullable<AppConfig["metricsAuthRequired"]>;
  /** Tenant RLS is enabled (GUC-wiring active). */
  tenantRlsEnabled: NonNullable<AppConfig["tenantRlsEnabled"]>;
  /** Debug credential capture is off. */
  debugCaptureRequestTokens: NonNullable<
    AppConfig["debugCaptureRequestTokens"]
  >;
  /** Tool authorization policy fails closed on parse error. */
  toolAuthzFailClosed: NonNullable<AppConfig["toolAuthzFailClosed"]>;
  /** Rate-limit store errors fail closed (reject). */
  rateLimitFailMode: NonNullable<AppConfig["rateLimitFailMode"]>;
  /** Unverified JWTs are not accepted. */
  allowUnverifiedJwt: NonNullable<AppConfig["allowUnverifiedJwt"]>;
}

/**
 * The canonical set of secure defaults. These values are applied when the
 * corresponding environment variable is absent or invalid, independent of
 * APP_ENV. They represent the most restrictive (safest) operational posture.
 */
export const SECURE_DEFAULTS: Readonly<SecureDefaults> = Object.freeze({
  // CORS: no origins allowed (operator must explicitly list allowed origins)
  corsOrigins: [],

  // Monitoring/metrics: require authentication
  monitoringAuthRequired: true,
  metricsAuthRequired: true,

  // RLS: enforced by default
  tenantRlsEnabled: true,

  // Debug: credentials never captured
  debugCaptureRequestTokens: false,

  // Tool authorization: fail-closed on bad policy (deny all)
  toolAuthzFailClosed: true,

  // Rate-limit: fail-closed (reject on store errors)
  rateLimitFailMode: "closed" as const,

  // JWT: do not accept unverified tokens
  allowUnverifiedJwt: false,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Applies secure defaults to a partial config, filling security-critical fields
 * that are undefined/missing OR have an invalid type/value. Non-security fields
 * and explicitly-set **valid** values (even if permissive) are left untouched —
 * the operator owns the final decision, we just ensure the ABSENCE of a valid
 * decision defaults to safe.
 *
 * Invalid values (e.g. non-array CORS, non-boolean RLS, unrecognised
 * rateLimitFailMode) are treated as missing and replaced with the secure
 * default (Requirement 3.3).
 *
 * Usage in config/load.ts:
 *   const raw = parseEnv();
 *   const secured = applySecureDefaults(raw);
 */
export function applySecureDefaults<T extends Partial<AppConfig>>(
  config: T,
): T {
  const result = { ...config };

  // CORS: apply secure default when missing or invalid (not an array)
  if (result.corsOrigins === undefined || !Array.isArray(result.corsOrigins)) {
    (result as Record<string, unknown>).corsOrigins =
      SECURE_DEFAULTS.corsOrigins;
  }

  // Monitoring auth: apply secure default when missing or invalid (not boolean)
  if (
    result.monitoringAuthRequired === undefined ||
    typeof result.monitoringAuthRequired !== "boolean"
  ) {
    (result as Record<string, unknown>).monitoringAuthRequired =
      SECURE_DEFAULTS.monitoringAuthRequired;
  }

  // Metrics auth: apply secure default when missing or invalid (not boolean)
  if (
    result.metricsAuthRequired === undefined ||
    typeof result.metricsAuthRequired !== "boolean"
  ) {
    (result as Record<string, unknown>).metricsAuthRequired =
      SECURE_DEFAULTS.metricsAuthRequired;
  }

  // Tenant RLS: apply secure default when missing or invalid (not boolean)
  if (
    result.tenantRlsEnabled === undefined ||
    typeof result.tenantRlsEnabled !== "boolean"
  ) {
    (result as Record<string, unknown>).tenantRlsEnabled =
      SECURE_DEFAULTS.tenantRlsEnabled;
  }

  // Debug capture tokens: apply secure default when missing or invalid (not boolean)
  if (
    result.debugCaptureRequestTokens === undefined ||
    typeof result.debugCaptureRequestTokens !== "boolean"
  ) {
    (result as Record<string, unknown>).debugCaptureRequestTokens =
      SECURE_DEFAULTS.debugCaptureRequestTokens;
  }

  // Tool authz fail mode: apply secure default when missing or invalid (not boolean)
  if (
    result.toolAuthzFailClosed === undefined ||
    typeof result.toolAuthzFailClosed !== "boolean"
  ) {
    (result as Record<string, unknown>).toolAuthzFailClosed =
      SECURE_DEFAULTS.toolAuthzFailClosed;
  }

  // Rate-limit fail mode: apply secure default when missing or invalid
  if (
    result.rateLimitFailMode === undefined ||
    (result.rateLimitFailMode !== "closed" &&
      result.rateLimitFailMode !== "open")
  ) {
    (result as Record<string, unknown>).rateLimitFailMode =
      SECURE_DEFAULTS.rateLimitFailMode;
  }

  // Unverified JWT: apply secure default when missing or invalid (not boolean)
  if (
    result.allowUnverifiedJwt === undefined ||
    typeof result.allowUnverifiedJwt !== "boolean"
  ) {
    (result as Record<string, unknown>).allowUnverifiedJwt =
      SECURE_DEFAULTS.allowUnverifiedJwt;
  }

  return result;
}
