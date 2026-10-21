// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the governance posture report (`src/compliance/posture.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  buildPostureReport,
  formatPostureReportAsTable,
  type PostureContext,
} from "../posture.js";
import type { AppConfig } from "../../config/schema.js";

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    appEnv: "production",
    evidenceSigningKey: "dGVzdC1lZDI1NTE5LXNlZWQtZm9yLXBvc3R1cmUtdGVzdHM=",
    auditAnchorFile: "/var/lib/atf/anchors.jsonl",
    egressAllowedHosts: ["api.openai.com"],
    taintWriteToolsRequireApproval: true,
    aiDisclosure: "field",
    decisionReceiptsEnabled: true,
    receiptSigningKey: "receipt-secret",
    redisUrl: "redis://127.0.0.1:6379",
    ...over,
  } as AppConfig;
}

const ctx = (over: Partial<PostureContext> = {}): PostureContext => ({
  compliancePolicyLoaded: true,
  flowLoadFailures: 0,
  now: new Date("2026-02-01T12:00:00.000Z"),
  ...over,
});

function check(report: ReturnType<typeof buildPostureReport>, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`missing check ${id}`);
  return c;
}

describe("buildPostureReport", () => {
  it("reports ok for every control when all are active", () => {
    const report = buildPostureReport(config(), ctx());
    expect(report.status).toBe("ok");
    expect(report.summary).toEqual({ ok: 9, warn: 0, fail: 0 });
    for (const c of report.checks) expect(c.status).toBe("ok");
    expect(report.generatedAt).toBe("2026-02-01T12:00:00.000Z");
  });

  it("uses the current time when no now is given", () => {
    const before = Date.now();
    const report = buildPostureReport(config(), {
      compliancePolicyLoaded: true,
      flowLoadFailures: 0,
    });
    const parsed = Date.parse(report.generatedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
  });

  describe("evidence_key", () => {
    it("ok with the Ed25519 evidence key", () => {
      expect(check(buildPostureReport(config(), ctx()), "evidence_key").status).toBe("ok");
    });
    it("warn when only a legacy HMAC secret signs the chain", () => {
      const report = buildPostureReport(
        config({ evidenceSigningKey: undefined, auditAnchorSecret: "hmac" }),
        ctx(),
      );
      expect(check(report, "evidence_key").status).toBe("warn");
    });
    it("fail when nothing signs the evidence chain", () => {
      const report = buildPostureReport(
        config({ evidenceSigningKey: undefined }),
        ctx(),
      );
      expect(check(report, "evidence_key").status).toBe("fail");
    });
  });

  describe("anchors", () => {
    it("ok with a durable anchor file", () => {
      expect(check(buildPostureReport(config(), ctx()), "anchors").status).toBe("ok");
    });
    it("warn when anchors are memory-only", () => {
      const report = buildPostureReport(config({ auditAnchorFile: undefined }), ctx());
      expect(check(report, "anchors").status).toBe("warn");
    });
  });

  describe("egress", () => {
    it("ok with an allow-list", () => {
      expect(check(buildPostureReport(config(), ctx()), "egress").status).toBe("ok");
    });
    it("warn when every public host is reachable", () => {
      const report = buildPostureReport(config({ egressAllowedHosts: [] }), ctx());
      expect(check(report, "egress").status).toBe("warn");
    });
  });

  describe("taint", () => {
    it("ok when write tools require approval", () => {
      expect(check(buildPostureReport(config(), ctx()), "taint").status).toBe("ok");
    });
    it("fail when the approval requirement is disabled", () => {
      const report = buildPostureReport(
        config({ taintWriteToolsRequireApproval: false }),
        ctx(),
      );
      expect(check(report, "taint").status).toBe("fail");
    });
  });

  describe("disclosure", () => {
    it("ok for header disclosure", () => {
      const report = buildPostureReport(config({ aiDisclosure: "header" }), ctx());
      expect(check(report, "disclosure").status).toBe("ok");
    });
    it("warn when disclosure is off", () => {
      const report = buildPostureReport(config({ aiDisclosure: "off" }), ctx());
      expect(check(report, "disclosure").status).toBe("warn");
    });
  });

  describe("policy", () => {
    it("ok when the policy is loaded", () => {
      expect(check(buildPostureReport(config(), ctx()), "policy").status).toBe("ok");
    });
    it("fail when the policy is required but missing", () => {
      const report = buildPostureReport(
        config({ compliancePolicyRequired: true }),
        ctx({ compliancePolicyLoaded: false }),
      );
      expect(check(report, "policy").status).toBe("fail");
    });
    it("warn when no policy is loaded and none is required", () => {
      const report = buildPostureReport(
        config({ compliancePolicyRequired: false }),
        ctx({ compliancePolicyLoaded: false }),
      );
      expect(check(report, "policy").status).toBe("warn");
    });
  });

  describe("receipts", () => {
    it("ok when receipts are enabled with a signing key", () => {
      expect(check(buildPostureReport(config(), ctx()), "receipts").status).toBe("ok");
    });
    it("fail when receipts are enabled without a signing key", () => {
      const report = buildPostureReport(
        config({ receiptSigningKey: undefined }),
        ctx(),
      );
      expect(check(report, "receipts").status).toBe("fail");
    });
    it("warn when receipts are disabled", () => {
      const report = buildPostureReport(
        config({ decisionReceiptsEnabled: false }),
        ctx(),
      );
      expect(check(report, "receipts").status).toBe("warn");
    });
  });

  describe("shared_state", () => {
    it("ok with Redis", () => {
      expect(check(buildPostureReport(config(), ctx()), "shared_state").status).toBe("ok");
    });
    it("ok with a Postgres URL only", () => {
      const report = buildPostureReport(
        config({ redisUrl: undefined, databaseUrl: "postgres://localhost/atf" }),
        ctx(),
      );
      expect(check(report, "shared_state").status).toBe("ok");
    });
    it("warn when state is per-replica only", () => {
      const report = buildPostureReport(
        config({ redisUrl: undefined, databaseUrl: undefined }),
        ctx(),
      );
      expect(check(report, "shared_state").status).toBe("warn");
    });
  });

  describe("flow_load", () => {
    it("ok when every flow loaded", () => {
      expect(check(buildPostureReport(config(), ctx()), "flow_load").status).toBe("ok");
    });
    it("fail when flows failed to load", () => {
      const report = buildPostureReport(config(), ctx({ flowLoadFailures: 2 }));
      expect(check(report, "flow_load").status).toBe("fail");
      expect(check(report, "flow_load").message).toContain("2 flow file(s)");
    });
  });

  describe("summary", () => {
    it("counts each status and takes the worst", () => {
      const report = buildPostureReport(
        config({
          evidenceSigningKey: undefined,
          auditAnchorFile: undefined,
          aiDisclosure: "off",
        }),
        ctx({ compliancePolicyLoaded: false }),
      );
      expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(
        report.checks.length,
      );
      expect(report.summary.fail).toBe(1);
      expect(report.summary.warn).toBe(3);
      expect(report.summary.ok).toBe(5);
      expect(report.status).toBe("fail");
    });
    it("is warn when nothing fails but something warns", () => {
      const report = buildPostureReport(config({ auditAnchorFile: undefined }), ctx());
      expect(report.summary).toEqual({ ok: 8, warn: 1, fail: 0 });
      expect(report.status).toBe("warn");
    });
  });
});

describe("formatPostureReportAsTable", () => {
  it("renders STATUS, ID and MESSAGE columns plus the tally", () => {
    const report = buildPostureReport(config(), ctx());
    const table = formatPostureReportAsTable(report);
    const lines = table.split("\n");
    expect(lines[0]).toStartWith("OK    evidence_key  ");
    expect(lines[0]).toContain("EVIDENCE_SIGNING_KEY");
    expect(lines[lines.length - 1]).toBe("9 ok, 0 warn, 0 fail (overall: OK)");
  });

  it("marks failing rows FAIL", () => {
    const report = buildPostureReport(config(), ctx({ flowLoadFailures: 1 }));
    const table = formatPostureReportAsTable(report);
    expect(table).toContain("FAIL  flow_load");
    expect(table).toContain("8 ok, 0 warn, 1 fail (overall: FAIL)");
  });
});
