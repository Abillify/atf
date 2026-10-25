// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Merging of file configuration and environment.
 *
 * `mergeConfig` is pure: given the parsed file object and the environment, the
 * environment wins *per key* — a key the environment sets replaces the file
 * value entirely, a key it leaves unset keeps the file value. Arrays replace
 * rather than concatenate, because a container that sets `OUTPOST_SOURCES`
 * means "these sources", not "these sources in addition to the file's".
 *
 * The environment speaks flat `OUTPOST_*` names; `envToConfig` translates them
 * into the nested shape of the file format so both sources merge uniformly.
 * Secrets are not part of this mapping — they live in the CredentialStore
 *  — except the public per-provider OAuth client ids, which
 * are not secrets and may be set either way.
 */

import type { Env } from "./secrets-file.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge where `override` wins per key; arrays and scalars replace. */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
  }
  return out;
}

function parseBool(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  if (lowered === "true" || lowered === "1" || lowered === "yes" || lowered === "on") return true;
  if (lowered === "false" || lowered === "0" || lowered === "no" || lowered === "off") return false;
  throw new Error(`expected a boolean, got "${value}"`);
}

function parseIntEnv(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`expected an integer, got "${value}"`);
  return Number.parseInt(trimmed, 10);
}

function parseNumberEnv(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`expected a number, got "${value}"`);
  return Number.parseFloat(trimmed);
}

function parseListEnv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseJsonEnv(value: string): unknown {
  return JSON.parse(value);
}

/** Value shape of an `OUTPOST_*` variable, used to generate valid test values. */
export type EnvValueKind =
  | "string"
  | "url"
  | "collection"
  | "bool"
  | "int"
  | "number"
  | "list"
  | "json";

export interface EnvMapEntry {
  name: string;
  path: readonly string[];
  kind: EnvValueKind;
  parse: (value: string) => unknown;
}

/**
 * Flat `OUTPOST_*` names → nested config paths. `OUTPOST_SOURCES` accepts a
 * JSON array in the file format; sources are otherwise configured in the file.
 * `OUTPOST_SOURCE_<ID>_*` variables are *not* config here — they carry secrets
 * resolved by `resolveSecretEnv`/`resolveSourceCredential`.
 */
export const ENV_MAP: ReadonlyArray<EnvMapEntry> = [
  { name: "OUTPOST_EXTRACT_URL", path: ["extractUrl"], kind: "url", parse: (v) => v },
  {
    name: "OUTPOST_ALLOW_INSECURE_LOCALHOST",
    path: ["allowInsecureLocalhost"],
    kind: "bool",
    parse: parseBool,
  },
  { name: "OUTPOST_CA_CERT_PATH", path: ["caCertPath"], kind: "string", parse: (v) => v },
  { name: "OUTPOST_OIDC_ISSUER", path: ["oidc", "issuer"], kind: "url", parse: (v) => v },
  { name: "OUTPOST_OIDC_CLIENT_ID", path: ["oidc", "clientId"], kind: "string", parse: (v) => v },
  { name: "OUTPOST_OIDC_AUDIENCE", path: ["oidc", "audience"], kind: "string", parse: (v) => v },
  { name: "OUTPOST_OIDC_SCOPES", path: ["oidc", "scopes"], kind: "list", parse: parseListEnv },
  { name: "OUTPOST_COLLECTION", path: ["collection"], kind: "collection", parse: (v) => v },
  {
    name: "OUTPOST_SYNC_INTERVAL_SEC",
    path: ["syncIntervalSec"],
    kind: "int",
    parse: parseIntEnv,
  },
  { name: "OUTPOST_MIRROR_DELETE", path: ["mirrorDelete"], kind: "bool", parse: parseBool },
  {
    name: "OUTPOST_DELETE_THRESHOLD_PERCENT",
    path: ["deleteThresholdPercent"],
    kind: "number",
    parse: parseNumberEnv,
  },
  {
    name: "OUTPOST_RESUMABLE_THRESHOLD_BYTES",
    path: ["resumableThresholdBytes"],
    kind: "int",
    parse: parseIntEnv,
  },
  {
    name: "OUTPOST_MAX_CONCURRENT_UPLOADS",
    path: ["maxConcurrentUploads"],
    kind: "int",
    parse: parseIntEnv,
  },
  { name: "OUTPOST_HEALTH_BIND", path: ["health", "bind"], kind: "string", parse: (v) => v },
  { name: "OUTPOST_HEALTH_PORT", path: ["health", "port"], kind: "int", parse: parseIntEnv },
  {
    name: "OUTPOST_GDRIVE_CLIENT_ID",
    path: ["cloudOAuth", "gdrive", "clientId"],
    kind: "string",
    parse: (v) => v,
  },
  {
    name: "OUTPOST_DROPBOX_APP_KEY",
    path: ["cloudOAuth", "dropbox", "appKey"],
    kind: "string",
    parse: (v) => v,
  },
  { name: "OUTPOST_SOURCES", path: ["sources"], kind: "json", parse: parseJsonEnv },
];

/** Build the nested override object for every `OUTPOST_*` variable that is set. */
export function envToConfig(env: Env): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const entry of ENV_MAP) {
    const raw = env[entry.name];
    if (raw === undefined) continue;
    let value: unknown;
    try {
      value = entry.parse(raw);
    } catch (error) {
      throw new Error(
        `${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    result = setPath(result, entry.path, value);
  }
  return result;
}

function setPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) throw new Error("empty config path");
  const [head, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) return { ...root, [head]: value };
  const child = isPlainObject(root[head]) ? (root[head] as Record<string, unknown>) : {};
  return { ...root, [head]: setPath(child, rest, value) };
}

/**
 * Merge the parsed file object with the environment (env wins per key).
 * A file value of `null`/`undefined` (empty file) counts as "no file".
 */
export function mergeConfig(
  fileConfig: unknown,
  env: Env,
): Record<string, unknown> {
  const fromFile = isPlainObject(fileConfig) ? fileConfig : {};
  return deepMerge(fromFile, envToConfig(env));
}
