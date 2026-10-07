// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * rules.ts
 *
 * Building blocks shared by every service's `prod-gate.ts`. The contract each
 * service already follows — a permissive setting is fatal in production and a
 * warning elsewhere — becomes one primitive ({@link ProdGate.flag}) plus a set
 * of named rules so the same check reads the same in runtime, search, gate and
 * extract.
 *
 * Services keep their own `prod-gate.ts`; it only composes these rules, which
 * keeps service-specific findings (and their wording) local while the
 * semantics stay identical platform-wide.
 */

export interface ProdGateFinding {
  severity: "fatal" | "warning";
  message: string;
}

export interface ProdGate {
  /** Fatal in production, warning otherwise. */
  flag(message: string): void;
  /** Always fatal, regardless of environment. */
  fatal(message: string): void;
  /** Always a warning, regardless of environment. */
  warn(message: string): void;
  readonly isProduction: boolean;
  readonly environment: string;
  readonly fatalFindings: readonly string[];
  readonly warnings: readonly string[];
}

export function createProdGate(environment: string): ProdGate {
  const isProduction = environment === "production";
  const fatal: string[] = [];
  const warnings: string[] = [];
  return {
    flag(message: string): void {
      if (isProduction) fatal.push(message);
      else warnings.push(message);
    },
    fatal(message: string): void {
      fatal.push(message);
    },
    warn(message: string): void {
      warnings.push(message);
    },
    isProduction,
    environment,
    fatalFindings: fatal,
    warnings,
  };
}

// ── Named rules ─────────────────────────────────────────────────────────────

/**
 * `AUTHN_MODE` (or equivalent) must be set explicitly; an unset/empty auth
 * mode means "whatever the default happens to be", which is never acceptable
 * in production.
 */
export function requireExplicitAuthMode(gate: ProdGate, authMode: string | undefined | null): void {
  if (authMode === undefined || authMode === null || authMode.trim() === "") {
    gate.flag("Authentication mode is not set explicitly — set AUTHN_MODE (or the service equivalent).");
  }
}

/**
 * A wildcard CORS origin (`*`, or `*` among a list) is fatal in production:
 * any website can issue credentialed cross-origin requests if the server also
 * reflects credentials.
 */
export function forbidWildcardCors(gate: ProdGate, origins: readonly string[] | string | undefined): void {
  const list = typeof origins === "string" ? origins.split(",").map((o) => o.trim()) : (origins ?? []);
  if (list.includes("*")) {
    gate.flag("CORS origin is set to \"*\" — enumerate the exact origins instead.");
  }
}

/**
 * A signing secret for tickets/tokens must exist and carry enough entropy.
 * Shorter than 32 characters is fatal in production.
 */
export function requireTicketSecret(gate: ProdGate, secret: string | undefined | null, name = "TICKET_SECRET"): void {
  if (secret === undefined || secret === null || secret.trim() === "") {
    gate.flag(`${name} is not set — signed tickets/tokens cannot be verified.`);
    return;
  }
  if (secret.length < 32) {
    gate.flag(`${name} is shorter than 32 characters — use a high-entropy value.`);
  }
}

/** A boolean hardening switch must be enabled in production. */
export function requireEnabled(gate: ProdGate, enabled: boolean | undefined, name: string): void {
  if (enabled !== true) {
    gate.flag(`${name} must be enabled in production.`);
  }
}

/** A shared secret, when configured, must carry enough entropy. */
export function requireSecretLength(gate: ProdGate, secret: string | undefined | null, name: string, min = 32): void {
  if (secret !== undefined && secret !== null && secret !== "" && secret.length < min) {
    gate.flag(`${name} is shorter than ${min} characters — use a high-entropy value.`);
  }
}

/** Two secrets must differ so they can be rotated independently. */
export function forbidSharedSecrets(gate: ProdGate, a: string | undefined | null, b: string | undefined | null, nameA: string, nameB: string): void {
  if (a !== undefined && a !== null && b !== undefined && b !== null && a !== "" && a === b) {
    gate.flag(`${nameA} and ${nameB} are identical — they cannot be rotated or revoked independently.`);
  }
}

/** A subprocess/resource timeout of 0 disables the limit — fatal in production. */
export function requirePositiveTimeout(gate: ProdGate, ms: number | undefined, name: string): void {
  if (ms === undefined || ms === 0) {
    gate.flag(`${name} is 0/unset, which disables the timeout — set a finite limit in production.`);
  }
}
