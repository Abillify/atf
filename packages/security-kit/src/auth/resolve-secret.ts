// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Secret loading: `NAME_FILE` before `NAME` (ADR 0040, layer 1).
 *
 * Every variable marked SECRET in `docs/CONFIGURATION.md` can be supplied
 * either directly through the environment variable `NAME` or, preferably in
 * Kubernetes-style deployments, through a file whose path is in `NAME_FILE`
 * (a projected secret volume, External Secrets Operator, `docker --secret`).
 *
 * Semantics (pinned by ADR 0040):
 * - `NAME_FILE` set → read the file, strip ONE trailing `\n` (or `\r\n`),
 *   ignore `NAME` entirely.
 * - `NAME_FILE` unset → `NAME` verbatim; the variable itself is never
 *   trimmed, so a secret legitimately ending in whitespace survives.
 * - Both set → throw. Which key signed a receipt must never depend on
 *   precedence luck.
 * - `NAME_FILE` unreadable → throw with the path and the OS error, not a
 *   generic "missing" — a typo'd path and an absent secret need different
 *   fixes.
 * - Empty content (after the single-newline strip) → throw. Empty is a
 *   configuration error, not a secret.
 *
 * Reading happens once, at config load, like every other variable: rotation
 * stays a restart (see `docs/runbooks/key-rotation.md`).
 */

import { readFileSync } from "node:fs";

/** Thrown for every `resolveSecret` misuse; message names the variables. */
export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConfigError";
  }
}

/**
 * Resolve one secret from an environment record.
 *
 * @param env the environment record (usually `process.env`)
 * @param name the secret variable name, e.g. `RECEIPT_SIGNING_KEY`
 * @returns the secret value, or `undefined` when neither `NAME` nor
 *          `NAME_FILE` is set (the caller's schema decides whether the
 *          secret is optional)
 * @throws SecretConfigError when both are set, the file cannot be read, or
 *         the file is empty.
 */
export function resolveSecret(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const filePath = env[`${name}_FILE`];
  const direct = env[name];

  if (filePath !== undefined && filePath !== "") {
    if (direct !== undefined && direct !== "") {
      throw new SecretConfigError(
        `${name} and ${name}_FILE are both set: supply the secret through ` +
          `exactly one of them (${name}_FILE points at a file, e.g. a mounted ` +
          `secret; ${name} carries the value directly).`,
      );
    }
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SecretConfigError(
        `${name}_FILE is set to "${filePath}" but the file cannot be read: ${reason}`,
      );
    }
    // Strip exactly one trailing line ending — a secret manager writing a
    // file appends one; a secret that legitimately contains a newline keeps
    // everything before it.
    const value = raw.endsWith("\r\n")
      ? raw.slice(0, -2)
      : raw.endsWith("\n")
        ? raw.slice(0, -1)
        : raw;
    if (value === "") {
      throw new SecretConfigError(
        `${name}_FILE is set to "${filePath}" but the file is empty. ` +
          `An empty secret is a configuration error, not a value.`,
      );
    }
    return value;
  }

  if (direct !== undefined && direct !== "") return direct;
  return undefined;
}

/**
 * Resolve every secret in `names`, returning a new record with the resolved
 * values under `NAME` (and the `NAME_FILE` entries removed). Non-secret keys
 * pass through untouched.
 *
 * @throws SecretConfigError on the first offending variable (message names it).
 */
export function applySecrets(
  env: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of names) {
    const value = resolveSecret(env, name);
    delete out[`${name}_FILE`];
    if (value === undefined) {
      delete out[name];
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Startup helper: resolve every secret in `names` from `NAME_FILE`/`NAME`
 * and write the resolved values back into `process.env` in place, removing
 * the `NAME_FILE` entries. Services whose subsystems read `process.env`
 * directly (rather than through one config record) call this once, at the
 * top of `loadConfig`, so every later read — including `${VAR}` template
 * interpolation — sees the file's content without knowing about files.
 *
 * All variables are checked before the first throw: a deployment with three
 * misconfigured secrets gets all three messages, not one per restart.
 *
 * @throws SecretConfigError listing every offending variable.
 */
export function materializeSecrets(
  names: readonly string[],
): void {
  const errors: string[] = [];
  const resolved: [string, string | undefined][] = [];
  for (const name of names) {
    try {
      resolved.push([name, resolveSecret(process.env, name)]);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new SecretConfigError(errors.join("\n"));
  }
  for (const [name, value] of resolved) {
    delete process.env[`${name}_FILE`];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
