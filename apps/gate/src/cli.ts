// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, loadConfigAsync } from "./config/loader.ts";
import { checkProductionReadiness } from "./config/prod-gate.ts";
import type { AppConfig } from "./config/schema.ts";

const SCHEMA_PATH = resolve(import.meta.dir, "../config.schema.json");
const COMMANDS = new Set(["validate", "doctor", "inspect", "schema"]);

function usage(): string {
  return `Usage: bun run mcpgate <command> [options]\n\nCommands:\n  validate [config-dir] [--remote]  Validate configuration (local-only by default)\n  doctor [config-dir] [--remote]    Show readiness, backends, and feature status\n  inspect [config-dir] [--remote]   Print a normalized, secret-free JSON summary\n  schema [--check] [output-file]    Write or verify the bundled JSON Schema\n`;
}

function parseConfigArgs(args: string[]): { dir?: string; remote: boolean } {
  const unknown = args.filter((arg) => arg.startsWith("-") && arg !== "--remote");
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length > 1) throw new Error("Expected at most one config directory");
  return { dir: positional[0], remote: args.includes("--remote") };
}

async function load(args: string[]): Promise<{ config: AppConfig; dir: string; remote: boolean }> {
  const { dir, remote } = parseConfigArgs(args);
  const loaded = remote ? await loadConfigAsync(dir) : loadConfig(dir);
  return { ...loaded, remote };
}

function summarize(config: AppConfig, dir: string, remote: boolean) {
  const toolTypes: Record<string, number> = {};
  for (const tool of config.tools) toolTypes[tool.type] = (toolTypes[tool.type] ?? 0) + 1;
  return {
    configDir: dir,
    validationMode: remote ? "remote" : "local-only",
    server: {
      name: config.server.name,
      version: config.server.version,
      host: config.server.host,
      port: config.server.port,
      endpoints: {
        mcp: config.server.mcpPath,
        mcp2026: config.server.mcp2026.enabled ? config.server.mcp2026.path : null,
        sse: config.server.ssePath,
      },
    },
    backends: {
      databases: Object.entries(config.databases).map(([name, database]) => ({
        name,
        client: database.client,
      })),
      mqtt: config.mqtt ? { configured: true } : { configured: false },
      openapiImports: config.openapi?.length ?? 0,
      mcpServerImports: config.mcpServers?.length ?? 0,
    },
    features: {
      authentication: config.auth.mode,
      monitoring: config.monitoring.enabled,
      tracing: config.tracing.enabled,
      router: config.router?.enabled ?? false,
      mcp2026: config.server.mcp2026.enabled,
      policies: config.policies.rules.length,
      resources: config.resources.length,
      prompts: config.prompts.length,
      skills: config.skills.length,
      apps: config.apps.length,
      asyncTasks: config.tasks.asyncTools.length,
    },
    tools: config.tools.map((tool) => ({
      name: tool.name,
      type: tool.type,
      description: tool.description,
      enabled: tool.enabled,
      exposed: tool.expose,
      access: tool.access,
      requiredScopes: tool.requiredScopes,
    })),
    toolTypes,
  };
}

async function runSchema(args: string[]): Promise<number> {
  const unknown = args.filter((arg) => arg.startsWith("-") && arg !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length > 1) throw new Error("Expected at most one schema output file");
  const output = resolve(positional[0] ?? "config.schema.json");
  const bundled = readFileSync(SCHEMA_PATH, "utf8");
  if (args.includes("--check")) {
    if (!existsSync(output) || readFileSync(output, "utf8") !== bundled) {
      console.error(`Schema is missing or outdated: ${output}`);
      return 1;
    }
    console.log(`Schema is current: ${output}`);
    return 0;
  }
  writeFileSync(output, bundled);
  console.log(`Wrote handwritten configuration schema to ${output}`);
  return 0;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (!COMMANDS.has(command)) {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    return 2;
  }
  try {
    if (command === "schema") return await runSchema(args);
    const { config, dir, remote } = await load(args);
    if (command === "validate") {
      console.log(
        `Valid configuration: ${dir} (${remote ? "remote imports enabled" : "local-only"}, ${config.tools.length} tools)`,
      );
      return 0;
    }
    const summary = summarize(config, dir, remote);
    if (command === "inspect") {
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    const readiness = checkProductionReadiness(config);
    console.log(`Config: ${dir}`);
    console.log(`Environment: ${readiness.environment}`);
    console.log(
      `Backends: databases=${summary.backends.databases.length}, mqtt=${summary.backends.mqtt.configured}, openapi=${summary.backends.openapiImports}, mcp=${summary.backends.mcpServerImports}`,
    );
    console.log(
      `Features: ${Object.entries(summary.features)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    );
    console.log(
      `Tools: ${config.tools.length} (${
        Object.entries(summary.toolTypes)
          .map(([type, count]) => `${type}=${count}`)
          .join(", ") || "none"
      })`,
    );
    for (const warning of readiness.warnings) console.log(`WARN: ${warning}`);
    for (const fatal of readiness.fatal) console.error(`FATAL: ${fatal}`);
    console.log(
      `Readiness: ${readiness.fatal.length === 0 ? "valid" : "fatal"} (${readiness.warnings.length} warnings)`,
    );
    return readiness.fatal.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await runCli());
