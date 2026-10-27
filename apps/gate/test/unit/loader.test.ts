// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deprecatedEnvWarnings, loadConfig } from "../../src/config/loader.ts";

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
    if (tool?.type !== "database") throw new Error("expected a database tool");
    expect(tool.query).toContain(":ctx.username");
  });

  it("coerces string booleans (boolish) from env interpolation", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises env-interpolation syntax in config values
      BASE + "\nmonitoring:\n  enabled: '${X:-false}'\n",
    );
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

describe("trust proxy config (Req 6.12)", () => {
  it("defaults to trusting one proxy hop", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    expect(loadConfig(dir).config.server.trustProxy).toBe(1);
  });

  it("takes a boolean from TRUST_PROXY", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    process.env.TRUST_PROXY = "false";
    try {
      expect(loadConfig(dir).config.server.trustProxy).toBe(false);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it("takes a hop count from TRUST_PROXY", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    process.env.TRUST_PROXY = "2";
    try {
      expect(loadConfig(dir).config.server.trustProxy).toBe(2);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it("lets TRUST_PROXY override the YAML value", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      "server: { port: 3000, trustProxy: 3 }\n" +
        BASE.slice(BASE.indexOf("auth:")),
    );
    process.env.TRUST_PROXY = "false";
    try {
      expect(loadConfig(dir).config.server.trustProxy).toBe(false);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it("rejects an invalid TRUST_PROXY", () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, "config.yaml"), BASE);
    process.env.TRUST_PROXY = "sometimes";
    try {
      expect(() => loadConfig(dir)).toThrow(
        /TRUST_PROXY must be true, false, or a hop count/,
      );
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it("accepts a YAML hop count or boolean string", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      "server: { port: 3000, trustProxy: '2' }\n" +
        BASE.slice(BASE.indexOf("auth:")),
    );
    expect(loadConfig(dir).config.server.trustProxy).toBe(2);
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

describe("database tool pagination config (Req 6.5 / 6.6)", () => {
  it("rejects a paginated tool whose SQL already pages at top level", () => {
    for (const sql of [
      "select id from t LIMIT 10",
      "select TOP 10 id from t",
      "select id from t OFFSET 5 ROWS",
      "select id from t fetch first 10 rows only",
    ]) {
      const dir = makeConfigDir();
      writeFileSync(
        join(dir, "config.yaml"),
        BASE +
          "\ntools:\n" +
          `  - name: t\n    type: database\n    database: d\n    query: "${sql}"\n` +
          "    pagination: { enabled: true, orderBy: [id] }\n",
      );
      expect(() => loadConfig(dir)).toThrow(
        /already contains a top-level LIMIT/,
      );
    }
  });

  it("ignores LIMIT inside subqueries, strings and comments", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n" +
        '    query: "select id from (select id from t limit 10) x -- limit me\\n"\n' +
        "    pagination: { enabled: true, orderBy: [id] }\n",
    );
    expect(loadConfig(dir).config.tools).toHaveLength(1);
  });

  it("rejects pagination without orderBy (Req 6.6)", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select id from t'\n" +
        "    pagination: { enabled: true }\n",
    );
    expect(() => loadConfig(dir)).toThrow(
      /orderBy is required when pagination\.enabled/,
    );
  });

  it("rejects an orderBy entry that is not a plain column reference", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select id from t'\n" +
        "    pagination: { enabled: true, orderBy: ['lower(name); drop table x'] }\n",
    );
    expect(() => loadConfig(dir)).toThrow(/plain column references/);
  });

  it("rejects a keyset column missing from orderBy", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select id from t'\n" +
        "    pagination: { enabled: true, orderBy: [name], keyset: [id] }\n",
    );
    expect(() => loadConfig(dir)).toThrow(/must appear in pagination\.orderBy/);
  });

  it("accepts pagination with a valid orderBy and keyset", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select id from t'\n" +
        "    pagination: { enabled: true, orderBy: [created_at DESC, id], keyset: [created_at, id] }\n",
    );
    const tool = loadConfig(dir).config.tools.find((t) => t.name === "t");
    expect(
      (tool as { pagination?: { keyset?: string[] } }).pagination?.keyset,
    ).toEqual(["created_at", "id"]);
  });

  it("rejects a keyset that is only part of the orderBy columns (Req 6.6)", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select id from t'\n" +
        "    pagination: { enabled: true, orderBy: [created_at DESC, id], keyset: [id] }\n",
    );
    expect(() => loadConfig(dir)).toThrow(
      /keyset must list every pagination\.orderBy column, in the same order/,
    );
  });

  it("rejects a keyset whose column order differs from orderBy (Req 6.6)", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select id from t'\n" +
        "    pagination: { enabled: true, orderBy: [grp, id], keyset: [id, grp] }\n",
    );
    expect(() => loadConfig(dir)).toThrow(/in the same order/);
  });

  it("rejects keyset mode with a qualified orderBy column (Req 6.6)", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select t.id from t'\n" +
        "    pagination: { enabled: true, orderBy: [t.id], keyset: [id] }\n",
    );
    expect(() => loadConfig(dir)).toThrow(/requires unqualified orderBy column names/);
  });

  it("rejects a keyset column that is also redacted (Req 6.6)", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        "\ntools:\n" +
        "  - name: t\n    type: database\n    database: d\n    query: 'select id, email from t'\n" +
        "    redact: [{ column: email }]\n" +
        "    pagination: { enabled: true, orderBy: [email], keyset: [email] }\n",
    );
    expect(() => loadConfig(dir)).toThrow(/also listed in redact/);
  });
});

// ── Req 6.13: MCP token exchange config ─────────────────────────────────────

const MCP_TOOL_BASE =
  "\ntools:\n" +
  "  - name: ds\n    type: mcp\n    targetTool: search\n" +
  "    server:\n      url: https://mcp.example.com\n";

const TOKEN_EXCHANGE_YAML =
  "      tokenExchange:\n" +
  "        tokenEndpoint: https://idp.example.com/token\n" +
  "        clientId: atf-gate\n" +
  "        clientSecretEnv: MCP_DS_SECRET\n" +
  "        audience: downstream-mcp\n";

describe("loadConfig — MCP token exchange (Req 6.13)", () => {
  it("resolves clientSecretEnv (and actor) into clientSecret", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE + MCP_TOOL_BASE + TOKEN_EXCHANGE_YAML,
    );
    process.env.MCP_DS_SECRET = "resolved-secret";
    try {
      const tool = loadConfig(dir).config.tools.find((t) => t.name === "ds");
      const exchange = (
        tool as { server?: { tokenExchange?: { clientSecret?: string } } }
      ).server?.tokenExchange;
      expect(exchange?.clientSecret).toBe("resolved-secret");
    } finally {
      delete process.env.MCP_DS_SECRET;
    }
  });

  it("aborts startup when the referenced secret env var is unset", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE + MCP_TOOL_BASE + TOKEN_EXCHANGE_YAML,
    );
    delete process.env.MCP_DS_SECRET;
    expect(() => loadConfig(dir)).toThrow(
      /MCP_DS_SECRET, which is unset or empty/,
    );
  });

  it("rejects tokenExchange together with forwardBearerToken", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        MCP_TOOL_BASE +
        "      forwardBearerToken: true\n" +
        TOKEN_EXCHANGE_YAML,
    );
    process.env.MCP_DS_SECRET = "x";
    try {
      expect(() => loadConfig(dir)).toThrow(
        /both server\.tokenExchange and server\.forwardBearerToken/,
      );
    } finally {
      delete process.env.MCP_DS_SECRET;
    }
  });

  it("resolves an actor clientSecretEnv too", () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, "config.yaml"),
      BASE +
        MCP_TOOL_BASE +
        TOKEN_EXCHANGE_YAML +
        "        actor:\n" +
        "          grant: client_credentials\n" +
        "          clientId: atf-actor\n" +
        "          clientSecretEnv: MCP_ACTOR_SECRET\n",
    );
    process.env.MCP_DS_SECRET = "ds-secret";
    process.env.MCP_ACTOR_SECRET = "actor-secret";
    try {
      const tool = loadConfig(dir).config.tools.find((t) => t.name === "ds");
      const actor = (
        tool as {
          server?: { tokenExchange?: { actor?: { clientSecret?: string } } };
        }
      ).server?.tokenExchange?.actor;
      expect(actor?.clientSecret).toBe("actor-secret");
    } finally {
      delete process.env.MCP_DS_SECRET;
      delete process.env.MCP_ACTOR_SECRET;
    }
  });
});

describe("deprecated environment variables", () => {
  it("warns once per deprecated variable that is set", () => {
    expect(deprecatedEnvWarnings({})).toEqual([]);
    expect(deprecatedEnvWarnings({ AUTHZ_ENABLED: "true", DEFAULT_TENANT_ID: "acme" })).toEqual([]);
    expect(
      deprecatedEnvWarnings({
        AUTHORIZATION_ENABLED: "true",
        TENANT_ISOLATION_DEFAULT_TENANT_ID: "acme",
      }),
    ).toEqual([
      "AUTHORIZATION_ENABLED is deprecated and will be removed in 1.0.0; use AUTHZ_ENABLED",
      "TENANT_ISOLATION_DEFAULT_TENANT_ID is deprecated and will be removed in 1.0.0; use DEFAULT_TENANT_ID",
    ]);
  });
});
