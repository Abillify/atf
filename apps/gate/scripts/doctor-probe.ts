#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * atf-doctor probe for the Gate (`apps/gate/scripts/doctor-probe.ts`).
 *
 * Started by `scripts/atf-doctor.ts` in a dedicated child process whose
 * environment is built only from the operator's env file. The optional first
 * CLI argument is the configuration directory (the equivalent of
 * `MCPGATE_CONFIG_DIR`; an explicit argument wins over the variable). The
 * probe loads the Gate configuration, runs the production-readiness gate,
 * adds the doctor-only policy checks below, and writes exactly one JSON line
 * to stdout:
 *
 *   {"service":"gate","configError":null,"fatal":[],"warnings":[],"posture":null}
 *
 * `loadConfig()` is offline by design and refuses `mcpServers` imports
 * (discovering downstream tools needs the network). For those configurations
 * the probe falls back to parsing the configuration files directly so the
 * pinning check can still run without any network access; env overrides and
 * per-tool directories are then not expanded.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, resolveConfigDir } from "../src/config/loader.ts";
import { checkProductionReadiness } from "../src/config/prod-gate.ts";
import { AppConfigSchema, type AppConfig } from "../src/config/schema.ts";

interface ProbeResult {
  service: string;
  configError: string | null;
  fatal: string[];
  warnings: string[];
  posture: null;
}

function emit(result: ProbeResult): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

/** Replace ${VAR} / ${VAR:-default} like the loader does, offline. */
function interpolateEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, def) => {
      const env = process.env[name];
      if (env !== undefined && env !== "") return env;
      return def !== undefined ? def : "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnv(v);
    }
    return out as unknown as T;
  }
  return value;
}

function readConfigFile(file: string): unknown {
  const raw = readFileSync(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
}

function findBaseConfig(dir: string): string | undefined {
  for (const ext of [".yaml", ".yml", ".json"]) {
    const p = join(dir, `config${ext}`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Offline parse used when `loadConfig()` refuses a configuration that
 * imports remote MCP servers: reads the base file (plus the git-ignored
 * `config.local.*` override) and validates it against the schema. The
 * `mcpServers` entries survive parsing, so the pinning check works without
 * connecting to any server.
 */
function loadOffline(dir: string): AppConfig {
  const base = findBaseConfig(dir);
  if (base === undefined) throw new Error(`No config.{yaml,yml,json} found in ${dir}`);
  let merged = readConfigFile(base) as Record<string, unknown>;
  for (const ext of [".yaml", ".yml", ".json"]) {
    const local = join(dir, `config.local${ext}`);
    if (existsSync(local)) merged = { ...merged, ...(readConfigFile(local) as Record<string, unknown>) };
  }
  return AppConfigSchema.parse(interpolateEnv(merged));
}

/**
 * Doctor-only Gate checks, in addition to the production-readiness gate.
 * All of them are warnings; a check is skipped when the gate already
 * reported the same field (deduped by marker substring), so a production
 * configuration does not show the finding twice.
 */
export function gateDoctorChecks(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  reported: readonly string[],
): string[] {
  const out: string[] = [];
  const add = (marker: string, msg: string): void => {
    if (!reported.some((m) => m.includes(marker))) out.push(msg);
  };

  if (config.policies.defaultEffect === "allow") {
    add(
      "defaultEffect",
      'policies.defaultEffect is "allow": every tool without a matching deny rule is ' +
        "permitted. Set it to \"deny\" and allow the intended tools explicitly.",
    );
  }

  const approvalsConfigured =
    config.policies.defaultEffect === "approval" ||
    config.policies.rules.some((rule) => rule.effect === "approval");
  if (approvalsConfigured && config.policies.approval.requireDifferentApprover !== true) {
    add(
      "requireDifferentApprover",
      "policies.approval.requireDifferentApprover is false while approvals are configured: " +
        "the principal that requested an approval may resolve it itself.",
    );
  }

  for (const imp of config.mcpServers ?? []) {
    const pinned = new Set(imp.overrides.filter((o) => o.pin !== undefined).map((o) => o.name));
    const skipped = new Set(
      imp.overrides.filter((o) => o.enabled === false).map((o) => o.name),
    );
    const excluded = new Set(imp.exclude ?? []);
    if (imp.include !== undefined && imp.include.length > 0) {
      const unpinned = imp.include.filter(
        (name) => !pinned.has(name) && !skipped.has(name) && !excluded.has(name),
      );
      if (unpinned.length > 0) {
        add(
          "imported MCP tool",
          `imported MCP tools from ${imp.server.url} are not pinned: ${unpinned.join(", ")}. ` +
            "Set overrides[].pin (lowercase hex SHA-256) so a changed downstream definition " +
            "(tool poisoning) is refused at load time.",
        );
      }
    } else if (pinned.size === 0) {
      add(
        "imported MCP tool",
        `no imported MCP tool from ${imp.server.url} is pinned: the tool set is discovered ` +
          "at load time, so every downstream definition is trusted as-is. Pin each tool with " +
          "overrides[].pin (lowercase hex SHA-256).",
      );
    }
  }

  if (
    config.monitoring.enabled &&
    config.monitoring.oidc !== undefined &&
    config.monitoring.oidc.requiredGroups.length === 0
  ) {
    add(
      "requiredGroups",
      "monitoring admits every IdP user: monitoring.oidc.requiredGroups is empty, so any " +
        "authenticated user of the identity provider can see live tool calls, arguments and results.",
    );
  }

  const algorithms = (env.MCPGATE_TRANSACTION_ALGORITHMS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const secretSet = (env.MCPGATE_TRANSACTION_HS256_SECRET ?? "") !== "";
  const acceptsHs256 = algorithms.length > 0 ? algorithms.includes("HS256") : secretSet;
  if (acceptsHs256) {
    add(
      "HS256",
      "transaction tokens use HS256: every party holding the shared secret can mint tokens " +
        "this Gate accepts. Verify with the issuer's public key instead " +
        "(MCPGATE_TRANSACTION_JWKS_URI, EdDSA/ES256).",
    );
  }

  return out;
}

function run(): void {
  try {
    const dirArg = process.argv[2];
    let config: AppConfig;
    try {
      config = loadConfig(dirArg).config;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The offline loader refuses mcpServers imports; parse the files
      // directly so the pinning check still runs without the network.
      if (!message.includes("'mcpServers'")) throw err;
      config = loadOffline(resolveConfigDir(dirArg));
    }
    const report = checkProductionReadiness(config, undefined, process.env);
    emit({
      service: "gate",
      configError: null,
      fatal: report.fatal,
      warnings: [...report.warnings, ...gateDoctorChecks(config, process.env, report.warnings)],
      posture: null,
    });
  } catch (err) {
    emit({
      service: "gate",
      configError: err instanceof Error ? err.message : String(err),
      fatal: [],
      warnings: [],
      posture: null,
    });
  }
}

if (import.meta.main) {
  run();
}
