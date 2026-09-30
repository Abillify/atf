// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Loading and serializing the configuration file (requirements 1.1, 1.2).
 *
 * The file format is YAML — JSON is a subset, so a JSON file parses through
 * the same path. `loadConfig` reads the optional file, merges the environment
 * over it (env wins per key, `merge.ts`), and validates the result
 * (`validate.ts`). Nothing here touches secrets: the schema has no secret
 * fields, and `_FILE` handling lives in `secrets-file.ts`.
 *
 * `serializeConfig` writes a validated configuration back out. Every string is
 * quoted (`forceQuotes`) so a metadata value like `true` or `123` survives the
 * round trip as a string instead of being re-read as a Boolean or number —
 * that is what makes the round-trip property (Property 1) hold for arbitrary
 * string values.
 */

import { readFile as fsReadFile } from "node:fs/promises";
import YAML from "yaml";
import type { Env } from "./secrets-file.js";
import { mergeConfig } from "./merge.js";
import { validateConfig, type ConfigError, type Result } from "./validate.js";
import type { OutpostConfig } from "./schema.js";

export interface LoadConfigDeps {
  /** Injected for tests; defaults to `node:fs/promises.readFile`. */
  readFile?: (path: string) => Promise<string>;
  /** Warnings from parsing/merging (e.g. a malformed `OUTPOST_*` value). */
  onWarn?: (message: string) => void;
}

/**
 * Load, merge and validate. A missing or unreadable file is a configuration
 * error (the CLI exits 78), never a silent fall back to environment-only.
 */
export async function loadConfig(
  file?: string,
  env: Env = process.env,
  deps: LoadConfigDeps = {},
): Promise<Result<OutpostConfig, ConfigError[]>> {
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, "utf8"));

  let fileConfig: unknown = null;
  if (file !== undefined) {
    let raw: string;
    try {
      raw = await readFile(file);
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            path: file,
            message: `configuration file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    try {
      fileConfig = raw.trim() === "" ? null : YAML.parse(raw);
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            path: file,
            message: `configuration file is not valid YAML/JSON: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  let merged: Record<string, unknown>;
  try {
    merged = mergeConfig(fileConfig, env);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "env",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return validateConfig(merged);
}

/** Remove `undefined` values recursively so YAML does not write them as null. */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = stripUndefined(entry);
    }
    return out;
  }
  return value;
}

/** Serialize a validated configuration into the file format (YAML). */
export function serializeConfig(cfg: OutpostConfig): string {
  return YAML.stringify(stripUndefined(cfg), null, {
    // Force quoted strings *and* keys: a metadata value of "true" or "123"
    // must come back as a string, not a Boolean or number, and a metadata key
    // of "true" must come back as the key "true", not a Boolean key — or the
    // round trip would fail schema validation (Property 1).
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "QUOTE_DOUBLE",
    lineWidth: 0,
  });
}
