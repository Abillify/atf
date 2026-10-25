// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `scripts/atf-doctor.ts`: env-file parsing, secret masking,
 * exit-code aggregation, parent-process checks, and one integration test per
 * service probe with a minimal synthetic environment (placeholder values
 * only, modelled on the `.env.example` files).
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    expect(Array.isArray(report.posture?.checks)).toBe(true);
    // A development profile never produces fatal findings from the gate.
    expect(report.fatal).toEqual([]);
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
