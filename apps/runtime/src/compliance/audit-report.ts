// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Compliance Audit Report Generator (`src/compliance/audit-report.ts`)
 *
 * Aggregates data from multiple observability sources to generate a
 * structured compliance audit report. The report covers a configurable
 * time window and includes:
 *
 *   - Policy summary (rules in effect, version)
 *   - Request statistics (total, denied, approved, by flow/tenant)
 *   - Policy violation log (from audit log, last N)
 *   - Model usage per tenant (for EU AI Act provider-residency audits)
 *   - Approval decision summary (approved / denied / timed-out)
 *   - Retention compliance state (which data classes are within policy)
 *
 * The report is returned as a structured JSON object. Callers can serialise it
 * to PDF/CSV via the route layer if needed.
 *
 * No `any` at module boundaries.
 */

import type { CompliancePolicy } from "./policy-schema.js";
import type { AuditLog } from "../observability/audit-log.js";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface PolicySummary {
  version: string;
  description?: string;
  failClosed: boolean;
  dataRules: number;
  modelRules: number;
  approvalRules: number;
  retentionRules: number;
  auditRules: number;
}

export interface ViolationSummary {
  total: number;
  denied: number;
  requireApproval: number;
  /** Most recent violations (newest first). */
  recent: Array<{
    at: string;
    action: string;
    actor: string;
    target?: string;
    details?: Record<string, unknown>;
  }>;
}

export interface ApprovalSummary {
  total: number;
  approved: number;
  denied: number;
  timedOut: number;
}

export interface ModelUsageEntry {
  provider: string;
  model: string;
  requests: number;
  tenants: string[];
}

export interface ComplianceAuditReport {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  policy: PolicySummary | null;
  violations: ViolationSummary;
  approvals: ApprovalSummary;
  /** Unique model/provider combinations observed in the window (from audit log). */
  modelUsage: ModelUsageEntry[];
  /** Raw retention rules for operator verification. */
  retentionRules: Array<{ dataClass: string; maxAgeDays: number }>;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface AuditReportOptions {
  /** Start of the reporting window (ISO string or ms timestamp). Default: 24h ago. */
  windowStart?: string | number;
  /** End of the reporting window (ISO string or ms timestamp). Default: now. */
  windowEnd?: string | number;
  /** Maximum number of recent violations to include. Default 50. */
  maxRecentViolations?: number;
}

/**
 * Generates a compliance audit report from the audit log and the current
 * compliance policy.
 */
export async function generateAuditReport(
  auditLog: AuditLog,
  policy: CompliancePolicy | undefined,
  opts: AuditReportOptions = {},
): Promise<ComplianceAuditReport> {
  const now = Date.now();
  const windowEnd = opts.windowEnd !== undefined ? new Date(opts.windowEnd).getTime() : now;
  const windowStart =
    opts.windowStart !== undefined
      ? new Date(opts.windowStart).getTime()
      : windowEnd - 24 * 60 * 60 * 1000;

  const maxViolations = opts.maxRecentViolations ?? 50;

  // Fetch all recent audit entries (up to 1000) and filter to window.
  const allEntries = await auditLog.list({ limit: 1000 });
  const windowEntries = allEntries.filter((e) => {
    const t = new Date(e.at).getTime();
    return t >= windowStart && t <= windowEnd;
  });

  // ── Violation summary ────────────────────────────────────────────────────
  const violationEntries = windowEntries.filter((e) =>
    e.action.startsWith("compliance.violation") || e.outcome === "denied",
  );
  const denyEntries = violationEntries.filter(
    (e) => e.details?.decision === "deny",
  );
  const approvalRequiredEntries = violationEntries.filter(
    (e) => e.details?.decision === "require-approval",
  );

  const violations: ViolationSummary = {
    total: violationEntries.length,
    denied: denyEntries.length,
    requireApproval: approvalRequiredEntries.length,
    recent: violationEntries.slice(0, maxViolations).map((e) => ({
      at: e.at,
      action: e.action,
      actor: e.actor,
      ...(e.target !== undefined ? { target: e.target } : {}),
      ...(e.details !== undefined ? { details: e.details } : {}),
    })),
  };

  // ── Approval summary ─────────────────────────────────────────────────────
  const approvalEntries = windowEntries.filter((e) =>
    e.action.startsWith("approvals."),
  );
  const approvals: ApprovalSummary = {
    total: approvalEntries.length,
    approved: approvalEntries.filter((e) => e.details?.decision === "approved").length,
    denied: approvalEntries.filter((e) => e.details?.decision === "denied").length,
    timedOut: approvalEntries.filter((e) => e.details?.decision === "timeout").length,
  };

  // ── Model usage ──────────────────────────────────────────────────────────
  const modelMap = new Map<string, { requests: number; tenants: Set<string> }>();
  for (const entry of windowEntries) {
    if (entry.action.startsWith("chat.") || entry.action === "flows.execute") {
      const provider = entry.details?.provider as string | undefined;
      const model = entry.details?.model as string | undefined;
      const tenant = entry.details?.tenantId as string | undefined;
      if (provider !== undefined && model !== undefined) {
        const key = `${provider}/${model}`;
        const existing = modelMap.get(key) ?? { requests: 0, tenants: new Set<string>() };
        existing.requests += 1;
        if (tenant !== undefined) existing.tenants.add(tenant);
        modelMap.set(key, existing);
      }
    }
  }
  const modelUsage: ModelUsageEntry[] = [...modelMap.entries()].map(
    ([key, v]) => {
      const [provider, model] = key.split("/") as [string, string];
      return {
        provider,
        model,
        requests: v.requests,
        tenants: [...v.tenants],
      };
    },
  );

  // ── Policy summary ───────────────────────────────────────────────────────
  const policySummary: PolicySummary | null =
    policy !== undefined
      ? {
          version: policy.version,
          ...(policy.description !== undefined ? { description: policy.description } : {}),
          failClosed: policy.failClosed,
          dataRules: policy.dataRules?.length ?? 0,
          modelRules: policy.modelRules?.length ?? 0,
          approvalRules: policy.approvalRules?.length ?? 0,
          retentionRules: policy.retentionRules?.length ?? 0,
          auditRules: policy.auditRules?.length ?? 0,
        }
      : null;

  const retentionRules = (policy?.retentionRules ?? []).map((r) => ({
    dataClass: r.dataClass,
    maxAgeDays: r.maxAgeDays,
  }));

  return {
    generatedAt: new Date().toISOString(),
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    policy: policySummary,
    violations,
    approvals,
    modelUsage,
    retentionRules,
  };
}
