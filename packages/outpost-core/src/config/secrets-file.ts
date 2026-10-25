// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `_FILE` secret resolution (requirements 1.2, 12.7).
 *
 * Docker Swarm / Compose mount secrets as files, so the convention is: for any
 * variable `X`, a sibling `X_FILE` naming a readable path supplies the value of
 * `X` (file content with one trailing newline stripped). When both are set,
 * `X_FILE` wins and a warning is emitted — a secret should never sit in the
 * environment where `/proc`, crash dumps or CI logs can leak it.
 *
 * The rule is applied generically to every `*_FILE` variable rather than a
 * hard-coded list, so a new secret needs no code change here. The resolved
 * secret values are returned alongside the environment so the caller can
 * register them with the log redactor.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface ResolvedSecretEnv {
  /** Environment with every `X_FILE` folded into `X`. */
  env: Record<string, string>;
  /** Every value that came from a `_FILE` (or a bare secret variable), for redaction. */
  secretValues: string[];
}

/** Strip exactly one trailing line break, as Docker secret files end with one. */
export function stripTrailingNewline(content: string): string {
  return content.replace(/\r?\n$/, "");
}

/**
 * Variable names that hold a secret and must never be logged. Matched as a
 * suffix so `OUTPOST_SOURCE_A_S3_SECRET_KEY` and `OUTPOST_CLIENT_SECRET` are
 * both covered without enumerating every source.
 */
const SECRET_NAME = /(^|_)(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|CREDENTIALS)$/;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/**
 * Fold every `X_FILE` into `X`. `readFile` is injected so the function is
 * testable without touching disk and so the caller controls error handling
 * (a missing secret file is a configuration error, exit 78 — not a silent
 * fallback).
 */
export async function resolveSecretEnv(
  env: Env,
  readFile: (path: string) => Promise<string>,
  onWarn?: (message: string) => void,
): Promise<ResolvedSecretEnv> {
  const result: Record<string, string> = {};
  const secretValues: string[] = [];

  // Copy non-`_FILE` variables first; a `_FILE` may overwrite its base below.
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.endsWith("_FILE")) continue;
    result[key] = value;
    if (isSecretName(key)) secretValues.push(value);
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.endsWith("_FILE")) continue;
    const base = key.slice(0, -"_FILE".length);
    if (env[base] !== undefined) {
      onWarn?.(
        `${base} and ${key} are both set; using the file referenced by ${key}. ` +
          "Secrets should not be placed directly in the environment.",
      );
    }
    result[base] = stripTrailingNewline(await readFile(value));
    secretValues.push(result[base] as string);
  }

  return { env: result, secretValues };
}
