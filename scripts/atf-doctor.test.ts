// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `scripts/atf-doctor.ts`: env-file parsing, secret masking,
 * exit-code aggregation, parent-process checks, and one integration test per
 * service probe with a minimal synthetic environment (placeholder values
 * only, modelled on the `.env.example` files).
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gateDoctorChecks } from "../apps/gate/scripts/doctor-probe.ts";
import { AppConfigSchema } from "../apps/gate/src/config/schema.ts";
import {
  buildRows,
  exitCodeForRows,
  maskSecrets,
  parseEnvFile,
  parentChecks,
  runProbe,
  type DoctorRow,
} from "./atf-doctor.ts";

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "atf-doctor-test-"));
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

function tempConfigDir(configYaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "atf-doctor-gate-"));
  writeFileSync(path.join(dir, "config.yaml"), configYaml, "utf8");
  return dir;
}

const GATE_MINIMAL_YAML = [
  "server:",
  "  name: doctor-test-gate",
  "auth:",
  "  mode: disabled",
  "authorization:",
  "  enabled: false",
  "tenantIsolation:",
  "  enabled: false",
  "tools: []",
  "",
].join("\n");

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines and skips comments and blanks", () => {
    const env = parseEnvFile("# comment\n\nFOO=bar\n  # indented comment\nBAZ=qux\n");
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips optional single and double quotes", () => {
    const env = parseEnvFile('A="quoted value"\nB=\'single quoted\'\nC=unquoted\n');
    expect(env).toEqual({ A: "quoted value", B: "single quoted", C: "unquoted" });
  });

  it("keeps '=' inside values", () => {
    const env = parseEnvFile("DATABASE_URL=postgres://user:pa=ss@host:5432/db\n");
    expect(env.DATABASE_URL).toBe("postgres://user:pa=ss@host:5432/db");
  });

  it("handles CRLF line endings", () => {
    const env = parseEnvFile("A=1\r\nB=2\r\n# comment\r\nC=3\r\n");
    expect(env).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("does not expand shell syntax", () => {
    const env = parseEnvFile('A=$HOME\nB=$(whoami)\nC="~"\n');
    expect(env).toEqual({ A: "$HOME", B: "$(whoami)", C: "~" });
  });

  it("ignores lines without a valid key", () => {
    const env = parseEnvFile("not a pair\n=nokey\n1BAD=x\nGOOD_KEY=y\n");
    expect(env).toEqual({ GOOD_KEY: "y" });
  });
});

describe("maskSecrets", () => {
  it("replaces values of at least 8 characters", () => {
    const env = { API_TOKEN: "supersecret123", SHORT: "abc" };
    const masked = maskSecrets("failed with supersecret123 in message", env);
    expect(masked).toBe("failed with *** in message");
  });

  it("leaves values shorter than 8 characters untouched", () => {
    const env = { SMALL: "abc" };
    expect(maskSecrets("the value abc stays", env)).toBe("the value abc stays");
  });

  it("replaces every occurrence of every long value", () => {
    const env = { A: "aaaaaaaa", B: "bbbbbbbb" };
    expect(maskSecrets("a aaaaaaaa and bbbbbbbb again aaaaaaaa", env)).toBe(
      "a *** and *** again ***",
    );
  });
});

describe("exitCodeForRows", () => {
  const row = (status: DoctorRow["status"]): DoctorRow => ({
    service: "runtime",
    check: "x",
    status,
    detail: "",
  });

  it("returns 0 when no row failed", () => {
    expect(exitCodeForRows([row("ok"), row("warn")])).toBe(0);
  });

  it("returns 1 when any row failed", () => {
    expect(exitCodeForRows([row("ok"), row("fail")])).toBe(1);
  });

  it("returns 0 for an empty row set", () => {
    expect(exitCodeForRows([])).toBe(0);
  });
});

describe("parentChecks", () => {
  const cleanProbe = { service: "runtime", configError: null, fatal: [], warnings: [], posture: null };

  it("warns on AUTHN_MODE=disabled", () => {
    const rows = parentChecks("runtime", { AUTHN_MODE: "disabled" }, cleanProbe);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("warn");
    expect(rows[0]?.detail).toContain("authentication disabled");
  });

  it("stays silent on a non-disabled auth mode", () => {
    expect(parentChecks("runtime", { AUTHN_MODE: "oidc" }, cleanProbe)).toHaveLength(0);
  });

  it("warns on a shadowed production profile", () => {
    const rows = parentChecks("runtime", { APP_ENV: "production", ATF_PROFILE: "staging" }, cleanProbe);
    const profileRow = rows.find((r) => r.check === "profile");
    expect(profileRow?.status).toBe("warn");
    expect(profileRow?.detail).toContain("APP_ENV=production");
  });

  it("warns on NODE_ENV=production shadowed by ATF_PROFILE for Search", () => {
    const rows = parentChecks("search", { NODE_ENV: "production", ATF_PROFILE: "development" }, cleanProbe);
    const profileRow = rows.find((r) => r.check === "profile");
    expect(profileRow?.status).toBe("warn");
    expect(profileRow?.detail).toContain("NODE_ENV=production");
  });

  it("does not duplicate a shadow warning the probe already reported", () => {
    const probe = {
      ...cleanProbe,
      warnings: [
        "APP_ENV=production is overridden by ATF_PROFILE=staging; production checks are not enforced.",
      ],
    };
    const rows = parentChecks("runtime", { APP_ENV: "production", ATF_PROFILE: "staging" }, probe);
    expect(rows.filter((r) => r.check === "profile")).toHaveLength(0);
  });
});

describe("buildRows", () => {
  it("reports a config error as a single fail row", () => {
    const rows = buildRows(
      "search",
      { service: "search", configError: "POSTGRES_URL is required", fatal: ["x"], warnings: ["y"], posture: null },
      {},
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      service: "search",
      check: "config",
      status: "fail",
      detail: "POSTGRES_URL is required",
    });
  });

  it("warns that flows were not checked and omits the flow_load row when FLOWS_DIR is unusable", () => {
    const rows = buildRows(
      "runtime",
      {
        service: "runtime",
        configError: null,
        fatal: [],
        warnings: [],
        flowsDirReadable: false,
        posture: {
          generatedAt: "2026-10-25T00:00:00.000Z",
          operationalProfile: "development",
          preset: null,
          status: "ok",
          summary: { ok: 2, warn: 0, fail: 0 },
          checks: [
            { id: "flow_load", area: "flows", status: "ok", message: "All flow files loaded without errors." },
            { id: "taint", area: "injection", status: "ok", message: "taint active" },
          ],
          productionGate: { fatal: [], warnings: [] },
        },
      },
      {},
    );
    expect(rows.map((r) => [r.check, r.status])).toEqual([
      ["flows_dir", "warn"],
      ["posture:taint", "ok"],
    ]);
    expect(rows[0]?.detail).toBe("FLOWS_DIR is not set or not readable from here; flow files were not checked");
  });

  it("keeps the flow_load row when the flows directory was read", () => {
    const rows = buildRows(
      "runtime",
      {
        service: "runtime",
        configError: null,
        fatal: [],
        warnings: [],
        flowsDirReadable: true,
        posture: {
          generatedAt: "2026-10-25T00:00:00.000Z",
          operationalProfile: "development",
          preset: null,
          status: "ok",
          summary: { ok: 1, warn: 0, fail: 0 },
          checks: [{ id: "flow_load", area: "flows", status: "ok", message: "All flow files loaded without errors." }],
          productionGate: { fatal: [], warnings: [] },
        },
      },
      {},
    );
    expect(rows.map((r) => r.check)).toEqual(["posture:flow_load"]);
  });

  it("maps fatal to fail, warnings to warn, and posture checks by status", () => {
    const rows = buildRows(
      "runtime",
      {
        service: "runtime",
        configError: null,
        fatal: ["fatal one"],
        warnings: ["warn one"],
        posture: {
          generatedAt: "2026-10-25T00:00:00.000Z",
          operationalProfile: "development",
          preset: null,
          status: "warn",
          summary: { ok: 1, warn: 1, fail: 0 },
          checks: [
            { id: "anchors", area: "audit", status: "warn", message: "no anchor file" },
            { id: "taint", area: "injection", status: "ok", message: "taint active" },
          ],
          productionGate: { fatal: ["fatal one"], warnings: ["warn one"] },
        },
      },
      {},
    );
    expect(rows.map((r) => [r.check, r.status])).toEqual([
      ["prod-gate", "fail"],
      ["prod-gate", "warn"],
      ["posture:anchors", "warn"],
      ["posture:taint", "ok"],
    ]);
  });
});

describe("probe integration", () => {
  it("runtime probe loads a minimal development config and reports posture", async () => {
    const report = await runProbe("runtime", {
      APP_ENV: "development",
      AUTHN_MODE: "disabled",
      FLOWS_DIR: path.join(tmpdir(), "atf-doctor-no-such-flows-dir"),
    });
    expect(report.service).toBe("runtime");
    expect(report.configError).toBeNull();
    expect(report.posture).not.toBeNull();
    expect(report.posture?.operationalProfile).toBe("development");
    expect(report.flowsDirReadable).toBe(false);
    expect(Array.isArray(report.posture?.checks)).toBe(true);
    // A development profile never produces fatal findings from the gate.
    expect(report.fatal).toEqual([]);
  }, 60_000);

  it("runtime probe sees a readable FLOWS_DIR", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atf-doctor-flows-"));
    try {
      const report = await runProbe("runtime", {
        APP_ENV: "development",
        AUTHN_MODE: "disabled",
        FLOWS_DIR: dir,
      });
      expect(report.flowsDirReadable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("runtime probe treats an unset FLOWS_DIR as not checked", async () => {
    const report = await runProbe("runtime", { APP_ENV: "development", AUTHN_MODE: "disabled" });
    expect(report.flowsDirReadable).toBe(false);
  }, 60_000);

  it("runtime probe reports a config error instead of posture", async () => {
    const report = await runProbe("runtime", { APP_ENV: "not-a-profile" });
    expect(report.configError).not.toBeNull();
    expect(report.posture).toBeNull();
    const rows = buildRows("runtime", report, {});
    expect(rows[0]?.status).toBe("fail");
  }, 60_000);

  it("search probe passes with the minimal required variables", async () => {
    const report = await runProbe("search", {
      POSTGRES_URL: "postgres://CHANGE_ME",
      EMBED_URL: "http://127.0.0.1:8080/v1/embeddings",
      EMBED_MODEL: "CHANGE_ME",
    });
    expect(report.service).toBe("search");
    expect(report.configError).toBeNull();
    expect(report.fatal).toEqual([]);
    expect(report.posture).toBeNull();
  }, 60_000);

  it("search probe reports a missing required variable as config error", async () => {
    const report = await runProbe("search", { EMBED_URL: "http://127.0.0.1:8080/v1/embeddings" });
    expect(report.configError).not.toBeNull();
    expect(report.configError).toContain("POSTGRES_URL");
  }, 60_000);

  it("extract probe passes with the minimal required variables", async () => {
    const report = await runProbe("extract", {
      VISION_URL: "http://127.0.0.1:8000",
      VISION_MODEL: "CHANGE_ME",
      TENANT_ISOLATION_ENABLED: "false",
    });
    expect(report.service).toBe("extract");
    expect(report.configError).toBeNull();
    expect(report.fatal).toEqual([]);
    expect(report.posture).toBeNull();
  }, 60_000);

  it("extract probe reports a missing required variable as config error", async () => {
    const report = await runProbe("extract", { VISION_MODEL: "CHANGE_ME", TENANT_ISOLATION_ENABLED: "false" });
    expect(report.configError).not.toBeNull();
    expect(report.configError).toContain("VISION_URL");
  }, 60_000);
});

describe("env file end to end", () => {
  it("parses a written env file and runs the search probe on it", async () => {
    const file = tempFile(
      "search.env",
      [
        "# minimal synthetic environment",
        'POSTGRES_URL="postgres://CHANGE_ME"',
        "EMBED_URL=http://127.0.0.1:8080/v1/embeddings",
        "EMBED_MODEL=CHANGE_ME",
        "",
      ].join("\r\n"),
    );
    const env = parseEnvFile(await Bun.file(file).text());
    expect(Object.keys(env).sort()).toEqual(["EMBED_MODEL", "EMBED_URL", "POSTGRES_URL"]);
    const report = await runProbe("search", env);
    expect(report.configError).toBeNull();
  }, 60_000);
});

describe("gate doctor checks", () => {
  const base = {
    server: { name: "doctor-test-gate" },
    auth: { mode: "disabled" },
    authorization: { enabled: false },
    tenantIsolation: { enabled: false },
    tools: [],
  };
  const parse = (extra: Record<string, unknown>) =>
    AppConfigSchema.parse({ ...base, ...extra }) as ReturnType<typeof AppConfigSchema.parse>;

  it("warns on a permissive default effect", () => {
    const checks = gateDoctorChecks(parse({}), {}, []);
    expect(checks.some((m) => m.includes('policies.defaultEffect is "allow"'))).toBe(true);
  });

  it("does not warn when the default effect denies", () => {
    const checks = gateDoctorChecks(parse({ policies: { defaultEffect: "deny" } }), {}, []);
    expect(checks.some((m) => m.includes("defaultEffect"))).toBe(false);
  });

  it("warns on missing approver separation while approvals are configured", () => {
    const config = parse({
      policies: { defaultEffect: "deny", rules: [{ effect: "approval", match: { tool: "send_mail" } }] },
    });
    const checks = gateDoctorChecks(config, {}, []);
    expect(checks.some((m) => m.includes("requireDifferentApprover is false"))).toBe(true);
  });

  it("stays silent on approver separation when enabled or unused", () => {
    const enabled = parse({
      policies: {
        defaultEffect: "deny",
        rules: [{ effect: "approval", match: {} }],
        approval: { requireDifferentApprover: true },
      },
    });
    expect(gateDoctorChecks(enabled, {}, []).some((m) => m.includes("requireDifferentApprover"))).toBe(false);
    const unused = parse({ policies: { defaultEffect: "deny" } });
    expect(gateDoctorChecks(unused, {}, []).some((m) => m.includes("requireDifferentApprover"))).toBe(false);
  });

  it("warns on unpinned imported MCP tools", () => {
    const config = parse({
      mcpServers: [{ server: { url: "http://127.0.0.1:9999/mcp" }, include: ["read_file", "write_file"], overrides: [{ name: "read_file", pin: "a".repeat(64) }] }],
    });
    const checks = gateDoctorChecks(config, {}, []);
    const pinning = checks.filter((m) => m.includes("imported MCP tools"));
    expect(pinning).toHaveLength(1);
    expect(pinning[0]).toContain("write_file");
    expect(pinning[0]).not.toContain("read_file");
  });

  it("warns when no imported MCP tool is pinned at all", () => {
    const config = parse({ mcpServers: [{ server: { url: "http://127.0.0.1:9999/mcp" }, overrides: [] }] });
    expect(gateDoctorChecks(config, {}, []).some((m) => m.includes("no imported MCP tool"))).toBe(true);
  });

  it("warns when the monitor admits every IdP user", () => {
    const config = parse({
      monitoring: {
        enabled: true,
        oidc: {
          issuer: "https://idp.example",
          clientId: "monitor",
          clientSecret: "CHANGE_ME_CHANGE_ME",
          redirectUri: "https://gate.example/monitor/callback",
          sessionSecret: "CHANGE_ME_CHANGE_ME",
        },
      },
    });
    expect(gateDoctorChecks(config, {}, []).some((m) => m.includes("requiredGroups is empty"))).toBe(true);
    const restricted = parse({
      monitoring: {
        enabled: true,
        oidc: {
          issuer: "https://idp.example",
          clientId: "monitor",
          clientSecret: "CHANGE_ME_CHANGE_ME",
          redirectUri: "https://gate.example/monitor/callback",
          sessionSecret: "CHANGE_ME_CHANGE_ME",
          requiredGroups: ["ops"],
        },
      },
    });
    expect(gateDoctorChecks(restricted, {}, []).some((m) => m.includes("requiredGroups"))).toBe(false);
  });

  it("warns when transaction tokens accept HS256", () => {
    expect(gateDoctorChecks(parse({}), { MCPGATE_TRANSACTION_HS256_SECRET: "s".repeat(32) }, []).some((m) => m.includes("HS256"))).toBe(true);
    expect(
      gateDoctorChecks(parse({}), { MCPGATE_TRANSACTION_ALGORITHMS: "EdDSA,HS256" }, []).some((m) =>
        m.includes("HS256"),
      ),
    ).toBe(true);
    expect(
      gateDoctorChecks(parse({}), { MCPGATE_TRANSACTION_ALGORITHMS: "EdDSA" }, []).some((m) => m.includes("HS256")),
    ).toBe(false);
  });

  it("skips a check the production gate already reported", () => {
    const reported = ["governance.defaultEffect is 'allow' and 3 tool(s) declare no requiredScopes"];
    const checks = gateDoctorChecks(parse({}), {}, reported);
    expect(checks.some((m) => m.includes("defaultEffect"))).toBe(false);
  });
});

describe("gate probe integration", () => {
  it("loads a minimal config directory and reports the permissive default", async () => {
    const dir = tempConfigDir(GATE_MINIMAL_YAML);
    const report = await runProbe("gate", { MCPGATE_ENV: "development" }, dir);
    expect(report.service).toBe("gate");
    expect(report.configError).toBeNull();
    expect(report.fatal).toEqual([]);
    expect(report.warnings.some((m) => m.includes('policies.defaultEffect is "allow"'))).toBe(true);
  }, 60_000);

  it("checks unpinned mcpServers imports without the network", async () => {
    const dir = tempConfigDir(
      `${GATE_MINIMAL_YAML.replace("tools: []", "")}mcpServers:\n  - server:\n      url: http://127.0.0.1:9999/mcp\n    overrides: []\n`,
    );
    const report = await runProbe("gate", { MCPGATE_ENV: "development" }, dir);
    expect(report.configError).toBeNull();
    expect(report.warnings.some((m) => m.includes("no imported MCP tool"))).toBe(true);
  }, 60_000);

  it("reports a missing config file as config error", async () => {
    const dir = path.join(tmpdir(), "atf-doctor-gate-no-such-dir");
    const report = await runProbe("gate", { MCPGATE_ENV: "development" }, dir);
    expect(report.configError).not.toBeNull();
    expect(report.configError).toContain("not found");
    const rows = buildRows("gate", report, {});
    expect(rows[0]?.status).toBe("fail");
  }, 60_000);

  it("honours MCPGATE_CONFIG_DIR from the env file when no directory is given", async () => {
    const dir = tempConfigDir(GATE_MINIMAL_YAML);
    const report = await runProbe("gate", { MCPGATE_ENV: "development", MCPGATE_CONFIG_DIR: dir });
    expect(report.configError).toBeNull();
    expect(report.warnings.some((m) => m.includes('policies.defaultEffect is "allow"'))).toBe(true);
  }, 60_000);
});
