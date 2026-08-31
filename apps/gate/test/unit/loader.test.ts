// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/loader.ts";

let dirs: string[] = [];

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpgate-cfg-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const BASE = `
server: { port: 3000 }
auth:
  mode: static
  static:
    tokens:
      - token: \${TEST_TOKEN:-fallback-token}
        username: u
`;

describe("loadConfig", () => {
  it("interpolates env vars with fallbacks", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    process.env.TEST_TOKEN = "from-env";
    const { config } = loadConfig(dir);
    expect(config.auth.static?.tokens[0]?.token).toBe("from-env");
    delete process.env.TEST_TOKEN;
  });

  it("loads a per-tool directory and resolves queryFile", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    const toolDir = join(dir, "tools", "orders");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      join(toolDir, "tool.yaml"),
      "name: orders\ntype: database\ndatabase: main\nqueryFile: q.sql\n",
    );
    writeFileSync(join(toolDir, "q.sql"), "SELECT 1 WHERE u = :ctx.username");
    const { config } = loadConfig(dir);
    const tool = config.tools.find((t) => t.name === "orders");
    expect(tool?.type).toBe("database");
    expect((tool as any).query).toContain(":ctx.username");
  });

  it("coerces string booleans (boolish) from env interpolation", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE + "\nmonitoring:\n  enabled: '${X:-false}'\n");
    const { config } = loadConfig(dir);
    expect(config.monitoring.enabled).toBe(false);
  });

  it("rejects duplicate tool names", () => {
    const dir = makeConfigDir();
    const dup =
      BASE +
      "\ntools:\n" +
      "  - { name: t, type: database, database: d, query: 'select 1' }\n" +
      "  - { name: t, type: database, database: d, query: 'select 2' }\n";
    writeFileSync(join(dir, "config.yaml"), dup);
    expect(() => loadConfig(dir)).toThrow(/Duplicate tool name/);
  });

  it("rejects a database tool without query or queryFile", () => {
    const dir = makeConfigDir();
    const bad = BASE + "\ntools:\n  - { name: t, type: database, database: d }\n";
    writeFileSync(join(dir, "config.yaml"), bad);
    expect(() => loadConfig(dir)).toThrow(/must define 'query' or 'queryFile'/);
  });
});


describe("schema compatibility config", () => {
  it("defaults reload compatibility checks to report", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    expect(loadConfig(dir).config.schemaCompatibility.mode).toBe("report");
  });

  it("overrides the mode from MCP_SCHEMA_COMPATIBILITY_MODE", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE + "\nschemaCompatibility: { mode: report }\n",
    );
    process.env.MCP_SCHEMA_COMPATIBILITY_MODE = "strict";
    try {
      expect(loadConfig(dir).config.schemaCompatibility.mode).toBe("strict");
    } finally {
      delete process.env.MCP_SCHEMA_COMPATIBILITY_MODE;
    }
  });

  it("rejects an invalid MCP_SCHEMA_COMPATIBILITY_MODE", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    process.env.MCP_SCHEMA_COMPATIBILITY_MODE = "enforce";
    try {
      expect(() => loadConfig(dir)).toThrow(
        /MCP_SCHEMA_COMPATIBILITY_MODE must be report or strict/,
      );
    } finally {
      delete process.env.MCP_SCHEMA_COMPATIBILITY_MODE;
    }
  });
});

describe("tenant SQL validation config", () => {
  it("defaults semantic SQL validation to report", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    expect(loadConfig(dir).config.tenantIsolation.sqlValidationMode).toBe("report");
  });

  it("loads strict mode from the security environment contract", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    process.env.TENANT_ISOLATION_SQL_VALIDATION_MODE = "strict";
    try {
      expect(loadConfig(dir).config.tenantIsolation.sqlValidationMode).toBe("strict");
    } finally {
      delete process.env.TENANT_ISOLATION_SQL_VALIDATION_MODE;
    }
  });

  it("preserves the minimum raw marker presence check", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntenantIsolation: { enabled: true }\n" +
        "tools:\n  - { name: t, type: database, database: d, query: 'select 1' }\n",
    );
    expect(() => loadConfig(dir)).toThrow(/Bind :ctx\.tenantId/);
  });

  it("leaves semantic marker quality to readiness diagnostics", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntenantIsolation: { enabled: true }\n" +
        "tools:\n" +
        "  - name: t\n    type: database\n    database: d\n" +
        "    query: \"select ':ctx.tenantId'\"\n",
    );
    expect(loadConfig(dir).config.tools).toHaveLength(1);
  });
});
