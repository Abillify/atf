// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the compliance dossier generator (`src/compliance/dossier.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  generateComplianceDossier,
  formatDossierAsMarkdown,
} from "../dossier.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import { createAuditAnchorService } from "../../observability/audit-anchor.js";
import {
  RetentionService,
  type RetentionTarget,
} from "../../observability/retention.js";
import { InMemoryEvalRunHistory } from "../../eval/eval-run-history.js";
import type { EvalReport } from "../../eval/eval-runner.js";
import type { CompliancePolicy } from "../policy-schema.js";
import type { RedTeamEngine, RedTeamRunSummary } from "../../security/red-team-engine.js";

function makeReport(name: string, passRate: number): EvalReport {
  return {
    name,
    total: 10,
    passed: Math.round(passRate * 10),
    failed: 10 - Math.round(passRate * 10),
    passRate,
    totalCost: 0.01,
    avgLatencyMs: 100,
    cases: [],
  };
}

const POLICY: CompliancePolicy = {
  version: "1",
  description: "test policy",
  failClosed: true,
  retentionRules: [{ dataClass: "personal", maxAgeDays: 90 }],
};

class FakeTarget implements RetentionTarget {
  constructor(public readonly name: string) {}
  async purgeOlderThan(): Promise<number> {
    return 0;
  }
  async eraseSubject(): Promise<number> {
    return 0;
  }
}

function fakeRedTeamEngine(overrides: Partial<RedTeamEngine> = {}): RedTeamEngine {
  return {
    run: async () => {
      throw new Error("not used in this test");
    },
    listRuns: () => [] as RedTeamRunSummary[],
    getRun: () => undefined,
    currentGuardrailThreshold: () => 0.8,
    postureByFlow: () => ({}),
    ...overrides,
  };
}

describe("generateComplianceDossier", () => {
  it("produces a complete dossier with a valid audit chain, no data anywhere else", async () => {
    const auditLog = new InMemoryAuditLog();
    const retention = new RetentionService([new FakeTarget("snapshots")], {
      maxAgeDaysByTarget: { snapshots: 30 },
    });

    const dossier = await generateComplianceDossier({
      auditLog,
      retention,
      policy: undefined,
    });

    expect(dossier.auditIntegrity.chainVerification.valid).toBe(true);
    expect(dossier.auditIntegrity.chainIntact).toBe(true);
    // No external anchor configured → the STRONG tamper-evidence guarantee is
    // reported honestly as not (yet) available, and the chain is intact.
    expect(dossier.auditIntegrity.externallyAnchored).toBe(false);
    expect(dossier.auditIntegrity.tamperEvident).toBe(false);
    expect(dossier.auditReport.policy).toBeNull();
    expect(dossier.rtbfEvidence.totalOperations).toBe(0);
    expect(dossier.retentionPosture.targets).toHaveLength(1);
    expect(dossier.evalEvidence).toHaveLength(0);
    expect(dossier.securityPosture.enabled).toBe(false);
    expect(dossier.architecturalGuarantees.length).toBeGreaterThan(0);
  });

  it("reports strong tamper-evidence when an external anchor verifies", async () => {
    const auditLog = new InMemoryAuditLog();
    auditLog.record({ actor: "alice", action: "flows.publish", target: "f" });
    const retention = new RetentionService([new FakeTarget("snapshots")], {
      maxAgeDaysByTarget: { snapshots: 30 },
    });
    const anchor = createAuditAnchorService(auditLog, {
      secret: "anchor-secret-1234567890",
    });
    if (anchor === undefined) throw new Error("expected the anchor service to be enabled");
    await anchor.anchorNow();

    const dossier = await generateComplianceDossier({
      auditLog,
      retention,
      policy: undefined,
      auditAnchor: anchor,
    });

    expect(dossier.auditIntegrity.chainIntact).toBe(true);
    expect(dossier.auditIntegrity.externallyAnchored).toBe(true);
    expect(dossier.auditIntegrity.tamperEvident).toBe(true);
    expect(dossier.auditIntegrity.anchor?.verified).toBe(true);
    const md = formatDossierAsMarkdown(dossier);
    expect(md).toContain("Externally anchored");
  });

  it("includes the active compliance policy summary and its retention rules", async () => {
    const auditLog = new InMemoryAuditLog();
    const retention = new RetentionService([], {});

    const dossier = await generateComplianceDossier({
      auditLog,
      retention,
      policy: POLICY,
    });

    expect(dossier.auditReport.policy?.version).toBe("1");
    expect(dossier.retentionPosture.policyRetentionRules).toEqual([
      { dataClass: "personal", maxAgeDays: 90 },
    ]);
  });

  it("collects RTBF evidence from compliance.forget and dsar.self_erasure audit entries", async () => {
    const auditLog = new InMemoryAuditLog();
    auditLog.record({
      actor: "admin",
      action: "compliance.forget",
      target: "tenant-a",
      outcome: "success",
      details: { erased: 5 },
    });
    auditLog.record({
      actor: "user-42",
      action: "dsar.self_erasure",
      target: "user-42",
      outcome: "success",
      details: { erased: 2 },
    });
    // Not RTBF evidence — must be excluded.
    auditLog.record({ actor: "admin", action: "flows.publish", outcome: "success" });

    const retention = new RetentionService([], {});
    const dossier = await generateComplianceDossier({ auditLog, retention, policy: undefined });

    expect(dossier.rtbfEvidence.totalOperations).toBe(2);
    expect(dossier.rtbfEvidence.totalRecordsErased).toBe(7);
    expect(dossier.rtbfEvidence.operations.map((o) => o.action)).toEqual(
      expect.arrayContaining(["compliance.forget", "dsar.self_erasure"]),
    );
  });

  it("excludes audit entries outside the requested window", async () => {
    const auditLog = new InMemoryAuditLog();
    auditLog.record({
      actor: "admin",
      action: "compliance.forget",
      outcome: "success",
      details: { erased: 99 },
    });
    const retention = new RetentionService([], {});

    // A window entirely in the past excludes the just-recorded entry.
    const dossier = await generateComplianceDossier(
      { auditLog, retention, policy: undefined },
      { windowStart: "2000-01-01T00:00:00.000Z", windowEnd: "2000-01-02T00:00:00.000Z" },
    );

    expect(dossier.rtbfEvidence.totalOperations).toBe(0);
  });

  it("detects a tampered audit chain and surfaces it as invalid", async () => {
    // Build a fake AuditLog whose verifyChain reports tampering, to verify
    // the dossier surfaces it rather than silently reporting valid:true.
    const auditLog = {
      record: () => {},
      recordRequired: async () => {},
      list: async () => [],
      verifyChain: async () => ({
        valid: false,
        checked: 3,
        brokenAt: { id: 2, reason: "hash_mismatch" as const },
      }),
    };
    const retention = new RetentionService([], {});
    const dossier = await generateComplianceDossier({ auditLog, retention, policy: undefined });

    expect(dossier.auditIntegrity.chainVerification.valid).toBe(false);
    expect(dossier.auditIntegrity.chainVerification.brokenAt?.id).toBe(2);
  });

  it("cites only the most recent eval run per dataset", async () => {
    const auditLog = new InMemoryAuditLog();
    const retention = new RetentionService([], {});
    const evalRunHistory = new InMemoryEvalRunHistory();
    await evalRunHistory.record({ name: "ds-a", source: "ci", report: makeReport("ds-a", 0.6) });
    await evalRunHistory.record({ name: "ds-a", source: "manual", report: makeReport("ds-a", 0.95) });
    await evalRunHistory.record({ name: "ds-b", source: "ci", report: makeReport("ds-b", 1) });

    const dossier = await generateComplianceDossier({
      auditLog,
      retention,
      policy: undefined,
      evalRunHistory,
    });

    expect(dossier.evalEvidence).toHaveLength(2);
    const dsA = dossier.evalEvidence.find((e) => e.dataset === "ds-a");
    expect(dsA?.passRate).toBe(0.95); // most recent, not the first
  });

  it("reports security posture when a red-team engine is provided", async () => {
    const auditLog = new InMemoryAuditLog();
    const retention = new RetentionService([], {});
    const redTeamEngine = fakeRedTeamEngine({
      postureByFlow: () => ({ "flow-a": 0.9 }),
      listRuns: () => [
        {
          id: "r1",
          flowId: "flow-a",
          triggeredBy: "schedule",
          startedAt: new Date().toISOString(),
          status: "completed",
          trials: 10,
          bypasses: 1,
          blocks: 9,
          errors: 0,
          bypassRate: 0.1,
          postureScore: 0.9,
        },
      ],
    });

    const dossier = await generateComplianceDossier({
      auditLog,
      retention,
      policy: undefined,
      redTeamEngine,
    });

    expect(dossier.securityPosture.enabled).toBe(true);
    expect(dossier.securityPosture.postureByFlow["flow-a"]).toBe(0.9);
    expect(dossier.securityPosture.recentRuns).toHaveLength(1);
  });

  it("reports the PII vault posture as disabled by default", async () => {
    const auditLog = new InMemoryAuditLog();
    const retention = new RetentionService([], {});
    const dossier = await generateComplianceDossier({ auditLog, retention, policy: undefined });

    expect(dossier.piiVaultPosture.enabled).toBe(false);
    expect(dossier.piiVaultPosture.detectors).toEqual([]);
  });

  it("surfaces the provided PII vault posture (detectors + durability) as config evidence", async () => {
    const auditLog = new InMemoryAuditLog();
    const retention = new RetentionService([], {});
    const dossier = await generateComplianceDossier({
      auditLog,
      retention,
      policy: undefined,
      piiVaultPosture: {
        enabled: true,
        durable: true,
        detectors: ["regex", "ner"],
        piiTypes: "all",
      },
    });

    expect(dossier.piiVaultPosture.enabled).toBe(true);
    expect(dossier.piiVaultPosture.durable).toBe(true);
    expect(dossier.piiVaultPosture.detectors).toEqual(["regex", "ner"]);
  });
});

describe("formatDossierAsMarkdown", () => {
  it("renders a self-contained markdown document covering every section", async () => {
    const auditLog = new InMemoryAuditLog();
    auditLog.record({
      actor: "admin",
      action: "compliance.forget",
      outcome: "success",
      details: { erased: 3 },
    });
    const retention = new RetentionService([new FakeTarget("snapshots")], {
      maxAgeDaysByTarget: { snapshots: 30 },
    });
    const evalRunHistory = new InMemoryEvalRunHistory();
    await evalRunHistory.record({ name: "ds-a", source: "ci", report: makeReport("ds-a", 0.8) });

    const dossier = await generateComplianceDossier({
      auditLog,
      retention,
      policy: POLICY,
      evalRunHistory,
    });
    const md = formatDossierAsMarkdown(dossier);

    expect(md).toContain("# Compliance Dossier");
    expect(md).toContain("## Policy");
    expect(md).toContain("## Audit trail integrity");
    expect(md).toContain("Hash chain verified");
    expect(md).toContain("## Right-to-be-forgotten evidence");
    expect(md).toContain("## Retention posture");
    expect(md).toContain("## Model quality (eval evidence)");
    expect(md).toContain("ds-a");
    expect(md).toContain("## Security posture");
    expect(md).toContain("## PII tokenization vault");
    expect(md).toContain("## Architectural guarantees");
    expect(md).toContain("docs/adr/0005-tenant-data-isolation.md");
  });

  it("renders a tamper-detected chain distinctly from a verified one", async () => {
    const auditLog = {
      record: () => {},
      recordRequired: async () => {},
      list: async () => [],
      verifyChain: async () => ({
        valid: false,
        checked: 5,
        brokenAt: { id: 3, reason: "prev_hash_mismatch" as const },
      }),
    };
    const retention = new RetentionService([], {});
    const dossier = await generateComplianceDossier({ auditLog, retention, policy: undefined });
    const md = formatDossierAsMarkdown(dossier);
    expect(md).toContain("TAMPER DETECTED");
    expect(md).toContain("#3");
  });
});
