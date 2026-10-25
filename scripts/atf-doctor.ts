#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * atf-doctor — offline preflight for one service's environment file.
 *
 * Checks a `KEY=VALUE` env file against the service's production-readiness
 * gate and, for the Runtime, the governance posture — without starting the
 * service. Each check runs in its own child process (the `loadConfig`
 * functions read `process.env` and exit or throw on failure), with an
 * environment built only from the env file plus `PATH` and `HOME`, so the
 * operator's shell environment cannot mask a missing variable.
 *
 * Usage:
 *   bun run atf-doctor --service runtime --env-file ./runtime.env [--json]
 *   bun run atf-doctor --service search  --env-file ./search.env
 *   bun run atf-doctor --service extract --env-file ./extract.env
 *   bun run atf-doctor --service gate    --config-dir ./mcpgate --env-file ./gate.env
 *
 * Output: a `Service | Check | Status | Detail` table (or JSON with
 * `--json`). Values from the env file are never printed; stderr of a failing
 * probe is truncated and any substring equal to an env-file value of at least
 * 8 characters is replaced by `***`.
 *
 * Exit codes: 0 = no `fail` row, 1 = at least one `fail`, 2 = usage error.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PostureReport } from "../apps/runtime/src/compliance/posture.ts";
import {
  profileShadowWarning,
  resolveOperationalProfile,
} from "../packages/security-kit/src/prod-gate/profile.ts";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const PROBE_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 400;
const MASK_MIN_LENGTH = 8;

const SERVICES = ["runtime", "search", "extract", "gate"] as const;
type Service = (typeof SERVICES)[number];

/** The service variable each service reads its profile from besides ATF_PROFILE. */
const SERVICE_PROFILE_VARS: Record<Service, readonly string[]> = {
  runtime: ["APP_ENV"],
  search: ["NODE_ENV"],
  extract: ["NODE_ENV"],
  gate: ["MCPGATE_ENV", "NODE_ENV"],
};

const USAGE = `atf-doctor — offline preflight for an environment file

Usage:
  bun run atf-doctor --service runtime --env-file <file> [--json]
  bun run atf-doctor --service search  --env-file <file> [--json]
  bun run atf-doctor --service extract --env-file <file> [--json]
  bun run atf-doctor --service gate --config-dir <dir> --env-file <file> [--json]

Options:
  --service <name>    runtime | search | extract | gate (required)
  --env-file <file>   KEY=VALUE file to check (required)
  --config-dir <dir>  Gate configuration directory (gate only; wins over
                      MCPGATE_CONFIG_DIR from the env file)
  --json              print the report as JSON instead of a table
  --help, -h          show this help

Exit codes: 0 = no fail, 1 = at least one fail, 2 = usage error.`;

interface DoctorOptions {
  service: Service;
  envFile: string;
  configDir?: string;
  json: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): DoctorOptions {
  const partial: Partial<DoctorOptions> = {};
  const needValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--service":
        partial.service = needValue(arg, argv[++i]) as Service;
        break;
      case "--env-file":
        partial.envFile = needValue(arg, argv[++i]);
        break;
      case "--config-dir":
        partial.configDir = needValue(arg, argv[++i]);
        break;
      case "--json":
        partial.json = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(EXIT_OK);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (partial.service === undefined) throw new UsageError("--service is required");
  if (!(SERVICES as readonly string[]).includes(partial.service)) {
    throw new UsageError(`--service must be one of: ${SERVICES.join(", ")}`);
  }
  if (partial.envFile === undefined) throw new UsageError("--env-file is required");
  if (partial.configDir !== undefined && partial.service !== "gate") {
    throw new UsageError("--config-dir is only supported for --service gate");
  }
  return {
    service: partial.service,
    envFile: partial.envFile,
    configDir: partial.configDir,
    json: partial.json === true,
  };
}

/**
 * Parse a `KEY=VALUE` env file: `#` comment lines, blank lines, optional
 * single or double quotes around the value, `=` inside values, CRLF line
 * endings. No shell expansion of any kind — values are taken literally.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Replace every occurrence of each env-file value with at least
 * {@link MASK_MIN_LENGTH} characters by `***`, so a probe's stderr can be
 * shown without leaking secrets.
 */
export function maskSecrets(text: string, env: Record<string, string>): string {
  let masked = text;
  for (const value of Object.values(env)) {
    if (value.length < MASK_MIN_LENGTH) continue;
    masked = masked.split(value).join("***");
  }
  return masked;
}

type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorRow {
  service: Service;
  check: string;
  status: CheckStatus;
  detail: string;
}

interface ProbeReport {
  service: string;
  configError: string | null;
  fatal: string[];
  warnings: string[];
  posture: PostureReport | null;
}

/**
 * Run one service probe in a child process with an environment built only
 * from the env file (plus PATH and HOME). Never inherits the rest of the
 * shell environment, so a variable exported in the terminal cannot mask a
 * missing entry in the file.
 */
export async function runProbe(
  service: Service,
  env: Record<string, string>,
  configDir?: string,
): Promise<ProbeReport> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const appDir = path.join(repoRoot, "apps", service);
  const probePath = path.join(appDir, "scripts", "doctor-probe.ts");
  const started = Date.now();
  const child = Bun.spawn(
    [process.execPath, "run", "--no-env-file", probePath, ...(configDir !== undefined ? [configDir] : [])],
    {
      cwd: appDir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    },
  );
  const [stdoutText, stderrText] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;

  const line = stdoutText.trim().split("\n").find((l) => l.trim().startsWith("{"));
  if (line !== undefined) {
    try {
      const parsed = JSON.parse(line) as ProbeReport;
      if (parsed.service === service) return parsed;
    } catch {
      // fall through to the exit-code based error below
    }
  }
  const tail = maskSecrets(stderrText.trim().slice(0, STDERR_LIMIT), env);
  const timedOut = Date.now() - started >= PROBE_TIMEOUT_MS - 1_000;
  const reason = timedOut
    ? `probe timed out after ${PROBE_TIMEOUT_MS / 1000} s`
    : `probe exited with code ${exitCode}`;
  return {
    service,
    configError: tail.length > 0 ? `${reason}: ${tail}` : reason,
    fatal: [],
    warnings: [],
    posture: null,
  };
}

/**
 * Checks the parent runs on the env file itself, for every service. The
 * profile-shadow warning is only added when the probe did not already report
 * it (the Runtime's production gate includes it, so it must not appear twice).
 */
export function parentChecks(
  service: Service,
  env: Record<string, string>,
  probe: ProbeReport,
): DoctorRow[] {
  const rows: DoctorRow[] = [];
  if (env.AUTHN_MODE?.trim().toLowerCase() === "disabled") {
    rows.push({
      service,
      check: "authn_mode",
      status: "warn",
      detail: "authentication disabled — only for isolated networks",
    });
  }
  try {
    const shadowed = profileShadowWarning(
      resolveOperationalProfile(env, SERVICE_PROFILE_VARS[service]),
    );
    const alreadyReported = [...probe.fatal, ...probe.warnings].some((m) => m === shadowed);
    if (shadowed !== undefined && !alreadyReported) {
      rows.push({ service, check: "profile", status: "warn", detail: shadowed });
    }
  } catch {
    // An unknown profile value fails the config load; the probe reports it.
  }
  return rows;
}

/** Flatten a probe report and the parent checks into table rows. */
export function buildRows(service: Service, probe: ProbeReport, env: Record<string, string>): DoctorRow[] {
  const rows: DoctorRow[] = [];
  if (probe.configError !== null) {
    rows.push({ service, check: "config", status: "fail", detail: probe.configError });
    return rows;
  }
  for (const msg of probe.fatal) {
    rows.push({ service, check: "prod-gate", status: "fail", detail: msg });
  }
  for (const msg of probe.warnings) {
    rows.push({ service, check: "prod-gate", status: "warn", detail: msg });
  }
  const posture = probe.posture;
  if (posture !== null && Array.isArray(posture.checks)) {
    for (const check of posture.checks) {
      rows.push({ service, check: `posture:${check.id}`, status: check.status, detail: check.message });
    }
  }
  rows.push(...parentChecks(service, env, probe));
  return rows;
}

/** Exit code for a set of rows: 1 when any row failed, 0 otherwise. */
export function exitCodeForRows(rows: readonly DoctorRow[]): number {
  return rows.some((row) => row.status === "fail") ? EXIT_FAIL : EXIT_OK;
}

function renderTable(rows: readonly DoctorRow[]): string {
  const headers = ["Service", "Check", "Status", "Detail"];
  const body = rows.map((r) => [r.service, r.check, r.status, r.detail]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => (cells[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join(" | ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("-+-"), ...body.map(line)].join("\n");
}

async function main(): Promise<number> {
  let opts: DoctorOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`atf-doctor: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (!existsSync(opts.envFile)) {
    console.error(`atf-doctor: env file not found: ${opts.envFile}`);
    return EXIT_USAGE;
  }
  const env = parseEnvFile(readFileSync(opts.envFile, "utf8"));
  const probe = await runProbe(opts.service, env, opts.configDir);
  const rows = buildRows(opts.service, probe, env);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          service: opts.service,
          status: rows.some((r) => r.status === "fail")
            ? "fail"
            : rows.some((r) => r.status === "warn")
              ? "warn"
              : "ok",
          configError: probe.configError,
          fatal: probe.fatal,
          warnings: probe.warnings,
          posture: probe.posture,
          checks: rows.map(({ check, status, detail }) => ({ check, status, detail })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderTable(rows));
    const fails = rows.filter((r) => r.status === "fail").length;
    const warns = rows.filter((r) => r.status === "warn").length;
    console.log(`\n${fails} fail, ${warns} warn — ${opts.service}`);
  }
  return exitCodeForRows(rows);
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`atf-doctor: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(EXIT_FAIL);
    });
}
