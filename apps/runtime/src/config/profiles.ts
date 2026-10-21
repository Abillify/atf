// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Configuration profiles / presets (`src/config/profiles.ts`)
 *
 * The platform exposes ~130 environment variables. Standing up a correct
 * regulated multi-tenant deployment means flipping a dozen of them on in
 * concert (guardrails, PII vault, retention, RLS, monitoring auth, …) — the
 * single biggest source of misconfiguration risk.
 *
 * A `PROFILE` picks a curated bundle of *defaults* for those flags. The rule is
 * strict and intentional:
 *
 *   explicit environment variable  >  profile default  >  built-in schema default
 *
 * i.e. a profile only fills a variable that the operator has NOT set. Setting a
 * variable in the environment always wins, so a profile can never override an
 * explicit operator choice — it only removes boilerplate. Profiles never carry
 * secrets (keys, URLs, tokens): they toggle behaviour and leave the operator to
 * supply credentials, so a feature a profile enables degrades gracefully
 * (e.g. the PII vault falls back to in-memory) rather than refusing to start
 * when a secret is absent.
 *
 * Pure and dependency-free so it is trivially unit-testable and runs before any
 * logger/service exists (it is applied inside `loadConfig`, before Zod parsing).
 *
 * No `any` at module boundaries.
 */

/** A raw (string-valued) environment map, as read from `process.env`. */
export type RawEnv = Record<string, string | undefined>;

/** Profile defaults are raw strings — they merge into the env before Zod coerces. */
type ProfileDefaults = Record<string, string>;

// ---------------------------------------------------------------------------
// Building blocks (composed into the shipped profiles below)
// ---------------------------------------------------------------------------

/** Hardened operator/edge posture — safe defaults for any production deployment. */
const SECURE_BASE: ProfileDefaults = {
  APP_ENV: "production",
  MONITORING_AUTH: "true",
  JWT_REQUIRE_VERIFICATION: "true",
  METRICS_AUTH: "true",
};

/** The guardrail + privacy stack a regulated flow should run with. */
const REGULATED_CONTROLS: ProfileDefaults = {
  INPUT_GUARDRAILS_ENABLED: "true",
  INPUT_GUARDRAIL_MODE: "block",
  OUTPUT_GUARDRAILS_ENABLED: "true",
  GUARDRAIL_REDACT_PII: "true",
  TOOL_EGRESS_GUARDRAIL: "true",
  TOOL_OUTPUT_VALIDATOR_ENABLED: "true",
  PII_VAULT_ENABLED: "true",
  PII_VAULT_MULTIMODAL_MODE: "block",
  APPROVAL_GATE_ENABLED: "true",
  RETENTION_ENABLED: "true",
  REPLAY_ENABLED: "true",
  IDEMPOTENCY_ENABLED: "true",
  // `DECISION_RECEIPTS_ENABLED` is deliberately NOT set here: it aborts the
  // start without a `RECEIPT_SIGNING_KEY`, and profiles never carry secrets.
  TAINT_MODE: "on-untrusted-source",
  AI_DISCLOSURE: "header",
  COMPLIANCE_POLICY_REQUIRED: "true",
};

/** Cost/latency levers — safe to enable everywhere (no-ops without an embedder). */
const PERFORMANCE_CACHES: ProfileDefaults = {
  RESPONSE_CACHE_ENABLED: "true",
  SEMANTIC_CACHE_ENABLED: "true",
  EMBEDDING_CACHE_ENABLED: "true",
};

// ---------------------------------------------------------------------------
// Shipped profiles
// ---------------------------------------------------------------------------

export const PROFILES: Record<string, ProfileDefaults> = {
  /** Local development convenience — verbose logs, explicit dev env. */
  dev: {
    APP_ENV: "development",
    LOG_LEVEL: "debug",
  },

  /** Hardened production edge without the regulated privacy stack. */
  secure: {
    ...SECURE_BASE,
    ...PERFORMANCE_CACHES,
  },

  /** Single-tenant regulated deployment (GDPR/EU-AI-Act posture). */
  regulated: {
    ...SECURE_BASE,
    ...REGULATED_CONTROLS,
    ...PERFORMANCE_CACHES,
  },

  /** Regulated deployment serving multiple tenants — adds isolation + BYOK. */
  "regulated-multitenant": {
    ...SECURE_BASE,
    ...REGULATED_CONTROLS,
    ...PERFORMANCE_CACHES,
    TENANT_MANAGEMENT_ENABLED: "true",
    BYOK_ENABLED: "true",
    TENANT_RLS_ENABLED: "true",
    TENANT_RLS_REQUIRED: "true",
  },

  /** Throughput/cost-optimised — caching levers only, no posture changes. */
  performance: {
    ...PERFORMANCE_CACHES,
  },
};

/** The valid profile names, for error messages and docs. */
export function listProfiles(): string[] {
  return Object.keys(PROFILES);
}

export interface ApplyProfileResult {
  /** The env map with profile defaults merged in for unset keys. */
  env: RawEnv;
  /** The resolved profile name, or undefined when none was requested. */
  profile?: string;
  /** Keys the profile actually filled (were unset in the input env). */
  applied: string[];
  /** Set when `PROFILE` names an unknown profile — caller should fail fast. */
  error?: string;
}

/**
 * Merges the profile named by `env.PROFILE` into a COPY of `env`, filling only
 * keys the caller has not already set (explicit env wins). Returns the merged
 * env plus a report of what was applied. Never mutates the input.
 *
 * When `PROFILE` is unset, returns the env unchanged. When `PROFILE` names an
 * unknown profile, returns `error` set (and the env unchanged) so the loader
 * can fail fast with a clear message rather than silently ignoring a typo.
 */
export function applyProfile(env: RawEnv): ApplyProfileResult {
  const requested = env.PROFILE?.trim();
  if (requested === undefined || requested === "") {
    return { env, applied: [] };
  }

  const defaults = PROFILES[requested];
  if (defaults === undefined) {
    return {
      env,
      applied: [],
      error:
        `Unknown PROFILE "${requested}". Valid profiles: ${listProfiles().join(", ")}.`,
    };
  }

  const merged: RawEnv = { ...env };
  const applied: string[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    // Explicit env (including an explicit empty string) always wins.
    if (merged[key] === undefined) {
      merged[key] = value;
      applied.push(key);
    }
  }

  return { env: merged, profile: requested, applied };
}
