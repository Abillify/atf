// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Prod_Gate rule building blocks and the shared reporter: a permissive
 * setting must be fatal in production and a warning everywhere else, and the
 * reporter's abort signal must match.
 */

import { describe, expect, test } from "bun:test";
import {
  createProdGate,
  forbidSharedSecrets,
  forbidWildcardCors,
  requireEnabled,
  requireExplicitAuthMode,
  requirePositiveTimeout,
  requireSecretLength,
  requireTicketSecret,
} from "../src/index.js";
import { reportProdGate, type ReportSink } from "../src/prod-gate/reporter.ts";

function collectSink(): ReportSink & { lines: { level: string; line: string }[] } {
  const lines: { level: string; line: string }[] = [];
  return {
    lines,
    error: (line) => lines.push({ level: "error", line }),
    warn: (line) => lines.push({ level: "warn", line }),
    info: (line) => lines.push({ level: "info", line }),
  };
}

describe("createProdGate", () => {
  test("flag is fatal in production, warning elsewhere", () => {
    const prod = createProdGate("production");
    prod.flag("loose setting");
    expect(prod.fatalFindings).toEqual(["loose setting"]);
    expect(prod.warnings).toEqual([]);

    const dev = createProdGate("development");
    dev.flag("loose setting");
    expect(dev.fatalFindings).toEqual([]);
    expect(dev.warnings).toEqual(["loose setting"]);
  });

  test("fatal and warn are environment independent", () => {
    for (const env of ["production", "development", "test"]) {
      const gate = createProdGate(env);
      gate.fatal("hard failure");
      gate.warn("soft note");
      expect(gate.fatalFindings).toEqual(["hard failure"]);
      expect(gate.warnings).toEqual(["soft note"]);
    }
  });

  test("isProduction only for the exact value", () => {
    expect(createProdGate("production").isProduction).toBe(true);
    expect(createProdGate("Production").isProduction).toBe(false);
    expect(createProdGate("staging").isProduction).toBe(false);
  });
});

describe("named rules", () => {
  test("requireExplicitAuthMode", () => {
    for (const missing of [undefined, null, "", "  "]) {
      const gate = createProdGate("production");
      requireExplicitAuthMode(gate, missing);
      expect(gate.fatalFindings.length).toBe(1);
    }
    const ok = createProdGate("production");
    requireExplicitAuthMode(ok, "oidc");
    expect(ok.fatalFindings.length).toBe(0);
  });

  test("forbidWildcardCors (string and list forms)", () => {
    const gate = createProdGate("production");
    forbidWildcardCors(gate, "*");
    forbidWildcardCors(gate, "https://a.example, *");
    forbidWildcardCors(gate, ["https://ok.example", "*"]);
    expect(gate.fatalFindings.length).toBe(3);

    const ok = createProdGate("production");
    forbidWildcardCors(ok, "https://a.example,https://b.example");
    forbidWildcardCors(ok, undefined);
    forbidWildcardCors(ok, []);
    expect(ok.fatalFindings.length).toBe(0);
  });

  test("requireTicketSecret: missing, short, long enough", () => {
    const missing = createProdGate("production");
    requireTicketSecret(missing, undefined);
    expect(missing.fatalFindings[0]).toContain("TICKET_SECRET is not set");

    const short = createProdGate("production");
    requireTicketSecret(short, "s".repeat(31));
    expect(short.fatalFindings[0]).toContain("shorter than 32");

    const ok = createProdGate("production");
    requireTicketSecret(ok, "s".repeat(32), "SESSION_SECRET");
    expect(ok.fatalFindings.length).toBe(0);
  });

  test("requireEnabled", () => {
    const gate = createProdGate("production");
    requireEnabled(gate, false, "ENFORCE_TENANT_SCOPE");
    requireEnabled(gate, undefined, "REQUIRE_MTLS");
    expect(gate.fatalFindings.length).toBe(2);
    expect(gate.fatalFindings[0]).toContain("ENFORCE_TENANT_SCOPE");

    const ok = createProdGate("production");
    requireEnabled(ok, true, "ENFORCE_TENANT_SCOPE");
    expect(ok.fatalFindings.length).toBe(0);
  });

  test("requireSecretLength only fires when set", () => {
    const gate = createProdGate("production");
    requireSecretLength(gate, undefined, "WEBHOOK_SECRET");
    requireSecretLength(gate, "", "WEBHOOK_SECRET");
    expect(gate.fatalFindings.length).toBe(0);
    requireSecretLength(gate, "short", "WEBHOOK_SECRET", 16);
    expect(gate.fatalFindings.length).toBe(1);
    expect(gate.fatalFindings[0]).toContain("WEBHOOK_SECRET");
  });

  test("forbidSharedSecrets", () => {
    const gate = createProdGate("production");
    forbidSharedSecrets(gate, "same-value", "same-value", "A_SECRET", "B_SECRET");
    expect(gate.fatalFindings.length).toBe(1);
    expect(gate.fatalFindings[0]).toContain("A_SECRET and B_SECRET");

    const ok = createProdGate("production");
    forbidSharedSecrets(ok, "value-a", "value-b", "A_SECRET", "B_SECRET");
    forbidSharedSecrets(ok, undefined, undefined, "A_SECRET", "B_SECRET");
    forbidSharedSecrets(ok, "", "", "A_SECRET", "B_SECRET");
    expect(ok.fatalFindings.length).toBe(0);
  });

  test("requirePositiveTimeout", () => {
    const gate = createProdGate("production");
    requirePositiveTimeout(gate, undefined, "SUBPROCESS_TIMEOUT_MS");
    requirePositiveTimeout(gate, 0, "CONVERT_TIMEOUT_MS");
    expect(gate.fatalFindings.length).toBe(2);

    const ok = createProdGate("production");
    requirePositiveTimeout(ok, 30_000, "CONVERT_TIMEOUT_MS");
    expect(ok.fatalFindings.length).toBe(0);
  });
});

describe("reportProdGate", () => {
  test("no findings → single info line, no abort", () => {
    const gate = createProdGate("production");
    const sink = collectSink();
    const outcome = reportProdGate(gate, "atf-runtime", sink);
    expect(outcome).toEqual({ abort: false, fatalCount: 0, warningCount: 0 });
    expect(sink.lines.length).toBe(1);
    expect(sink.lines[0]?.level).toBe("info");
    expect(sink.lines[0]?.line).toContain("no findings");
  });

  test("production with fatals → error banner, abort", () => {
    const gate = createProdGate("production");
    gate.flag("auth mode unset");
    gate.warn("deprecated flag");
    const sink = collectSink();
    const outcome = reportProdGate(gate, "atf-search", sink);
    expect(outcome.abort).toBe(true);
    expect(outcome.fatalCount).toBe(1);
    expect(outcome.warningCount).toBe(1);
    expect(sink.lines[0]?.level).toBe("error");
    expect(sink.lines[0]?.line).toBe(
      "[atf-search] production-readiness (production): 1 fatal, 1 warning",
    );
    expect(sink.lines.some((l) => l.level === "error" && l.line.includes("FATAL: auth mode unset"))).toBe(true);
    expect(sink.lines.some((l) => l.level === "warn" && l.line.includes("warning: deprecated flag"))).toBe(true);
  });

  test("development with fatals → warnings only, no abort", () => {
    const gate = createProdGate("development");
    gate.fatal("misconfigured in a way that would abort production");
    const sink = collectSink();
    const outcome = reportProdGate(gate, "atf-gate", sink);
    expect(outcome.abort).toBe(false);
    expect(outcome.fatalCount).toBe(1);
    expect(sink.lines.every((l) => l.level !== "error")).toBe(true);
    expect(
      sink.lines.some((l) => l.line.includes("would-be-fatal-in-production: misconfigured")),
    ).toBe(true);
  });

  test("warnings only → warn banner, no abort", () => {
    const gate = createProdGate("production");
    gate.warn("cosmetic");
    const sink = collectSink();
    const outcome = reportProdGate(gate, "atf-extract", sink);
    expect(outcome.abort).toBe(false);
    expect(sink.lines[0]?.level).toBe("warn");
  });
});
