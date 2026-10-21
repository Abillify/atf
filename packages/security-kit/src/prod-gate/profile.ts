// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * profile.ts
 *
 * The explicit operational profile (Betriebsprofil) shared by every ATF
 * service. Before this module, each service decided "are we in production?"
 * by an exact string match on its own environment variable (`APP_ENV`,
 * `MCPGATE_ENV`, `NODE_ENV`). That is fragile in three ways:
 *
 * 1. A typo (`prod`, `PRODUCTIVE`, `prodution`) silently disabled every
 *    production-readiness gate — the service started happily with the
 *    permissive development defaults in what the operator believed was
 *    production.
 * 2. The services normalized inconsistently: Gate and Search trimmed and
 *    lowercased, Extract did neither, Runtime used a closed Zod enum.
 * 3. There was no single knob an operator could set once to state the
 *    operating mode explicitly across the whole platform.
 *
 * The fix: one shared resolution. `ATF_PROFILE` is the explicit,
 * platform-wide knob and wins over the service variables
 * (`APP_ENV`/`MCPGATE_ENV`/`NODE_ENV`), which remain supported unchanged for
 * backward compatibility. Values are normalized (trim + lowercase), the
 * allowed set is closed, and an unknown value fails fast at startup — a typo
 * can no longer switch the gates off.
 *
 * `staging` and `test` are warn-mode profiles like `development`: findings
 * that would be fatal in production are reported as
 * `would-be-fatal-in-production` warnings, so a staging deployment surfaces
 * the same list before promotion without aborting. `test` exists because
 * Vitest and `bun test` set `NODE_ENV=test` automatically.
 */

/** The closed set of operational profiles. Only `production` enforces fatals. */
export type OperationalProfile = "development" | "staging" | "production" | "test";

/** All accepted profile values, in documentation order. */
export const OPERATIONAL_PROFILES: readonly OperationalProfile[] = [
  "development",
  "staging",
  "production",
  "test",
];

/**
 * The explicit, platform-wide operational profile variable. It overrides the
 * per-service variables (`APP_ENV`, `MCPGATE_ENV`, `NODE_ENV`). Not to be
 * confused with Runtime's `PROFILE`, which selects a config *preset*
 * (dev/secure/regulated/…) and is an unrelated concept.
 */
export const OPERATIONAL_PROFILE_ENV_VAR = "ATF_PROFILE";

/** Thrown when a profile variable holds a value outside the closed set. */
export class UnknownOperationalProfileError extends Error {
  readonly variable: string;
  readonly value: string;

  constructor(variable: string, value: string) {
    super(
      `Unknown operational profile "${value}" in ${variable}. Valid values: ` +
        `${OPERATIONAL_PROFILES.join(", ")}. Startup fails on purpose: an ` +
        "unrecognised profile would silently disable the production-readiness " +
        "gates, which is exactly the failure this check exists to prevent.",
    );
    this.name = "UnknownOperationalProfileError";
    this.variable = variable;
    this.value = value;
  }
}

export interface ResolvedOperationalProfile {
  /** The effective profile. */
  profile: OperationalProfile;
  /** True only for `production` — the profile that enforces fatal findings. */
  isProduction: boolean;
  /**
   * The environment variable the profile was read from, or `undefined` when
   * it fell back to the default (`development`). Useful in startup logs so
   * operators can see which knob actually took effect.
   */
  source: string | undefined;
  /**
   * Name of a lower-precedence variable that says `production` while the
   * effective profile is not `production` (for example `NODE_ENV=production`
   * with `ATF_PROFILE=staging`). The production checks are then not enforced;
   * services log {@link profileShadowWarning} so that is never silent.
   */
  shadowedProduction?: string;
}

function isOperationalProfile(value: string): value is OperationalProfile {
  return (OPERATIONAL_PROFILES as readonly string[]).includes(value);
}

/**
 * Normalize and validate a single raw profile value.
 *
 * @throws {UnknownOperationalProfileError} when the value is not in the
 *   closed set (after trim + lowercase normalization).
 */
export function normalizeOperationalProfile(
  variable: string,
  raw: string,
): OperationalProfile {
  const normalized = raw.trim().toLowerCase();
  if (!isOperationalProfile(normalized)) {
    throw new UnknownOperationalProfileError(variable, raw);
  }
  return normalized;
}

/**
 * Resolve the effective operational profile from an environment.
 *
 * Precedence: `ATF_PROFILE` first, then each of `serviceVars` in order (e.g.
 * `["MCPGATE_ENV", "NODE_ENV"]` for Gate), then `development`. A variable
 * that is unset or blank falls through to the next candidate; a variable with
 * a non-blank but unknown value throws — fail-fast, never a silent downgrade.
 */
export function resolveOperationalProfile(
  env: Record<string, string | undefined> = process.env,
  serviceVars: readonly string[] = [],
): ResolvedOperationalProfile {
  const candidates = [OPERATIONAL_PROFILE_ENV_VAR, ...serviceVars];
  for (const variable of candidates) {
    const raw = env[variable];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const profile = normalizeOperationalProfile(variable, trimmed);
    const shadowedProduction =
      profile === "production"
        ? undefined
        : candidates
            .slice(candidates.indexOf(variable) + 1)
            .find((other) => env[other]?.trim().toLowerCase() === "production");
    return {
      profile,
      isProduction: profile === "production",
      source: variable,
      ...(shadowedProduction !== undefined ? { shadowedProduction } : {}),
    };
  }
  return { profile: "development", isProduction: false, source: undefined };
}

/**
 * The startup warning for a downgraded production variable, or `undefined`
 * when nothing is shadowed.
 */
export function profileShadowWarning(
  resolved: ResolvedOperationalProfile,
): string | undefined {
  if (resolved.shadowedProduction === undefined) return undefined;
  return (
    `${resolved.shadowedProduction}=production is overridden by ` +
    `${resolved.source}=${resolved.profile}; production checks are not enforced.`
  );
}
