// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Compliance Policy routes (`src/routes/compliance-policy.ts`)
 *
 * Operator API for the Policy-as-Code compliance pack.
 * Mounted at `/admin/compliance-policy/*`, gated by operator RBAC.
 *
 * Endpoints:
 *   GET  /admin/compliance-policy            — current policy summary
 *   POST /admin/compliance-policy/evaluate   — dry-run a request context
 *   GET  /admin/compliance-policy/report     — generate an audit report
 *   GET  /admin/compliance-policy/report.csv — audit report as CSV
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { CompliancePolicyLoader } from "../compliance/policy-loader.js";
import { evaluatePolicy, type EvalRequestContext } from "../compliance/policy-evaluator.js";
import { generateAuditReport } from "../compliance/audit-report.js";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";

export interface CompliancePolicyRouterDeps {
  policyLoader: CompliancePolicyLoader;
  operatorAuth: OperatorAuthorizer;
  auditLog: AuditLog;
}

export function createCompliancePolicyRouter(deps: CompliancePolicyRouterDeps): Hono {
  const router = new Hono();
  const { policyLoader, operatorAuth, auditLog } = deps;

  const guard = async (ctx: {
    req: {
      header: (k: string) => string | undefined;
      query: (k: string) => string | undefined;
    };
  }) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "flows:read",
    );
    return r.ok
      ? (r.actor ?? { name: "operator", role: "admin" as const, via: "open" as const })
      : null;
  };

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      { error: { message: "Unauthorized operator access.", type: "authentication_error" } },
      401,
    );

  // ── GET /admin/compliance-policy ──────────────────────────────────────────
  router.get("/", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);
    const policy = policyLoader.policy;
    if (policy === undefined) {
      return ctx.json({
        enabled: false,
        message:
          "No compliance-policy.yaml found in FLOWS_DIR. " +
          "Create one to enable policy-as-code enforcement.",
      });
    }
    return ctx.json({
      enabled: true,
      version: policy.version,
      description: policy.description,
      failClosed: policy.failClosed,
      rules: {
        dataRules: policy.dataRules?.length ?? 0,
        modelRules: policy.modelRules?.length ?? 0,
        approvalRules: policy.approvalRules?.length ?? 0,
        retentionRules: policy.retentionRules?.length ?? 0,
        auditRules: policy.auditRules?.length ?? 0,
      },
      // Expose the full policy for operator review.
      policy,
    });
  });

  // ── POST /admin/compliance-policy/evaluate ────────────────────────────────
  // Dry-run a request context against the current policy.
  router.post("/evaluate", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);

    let body: EvalRequestContext;
    try {
      body = await ctx.req.json<EvalRequestContext>();
    } catch {
      return ctx.json(
        { error: { message: "Request body must be valid JSON.", type: "invalid_request_error" } },
        400,
      );
    }

    const result = evaluatePolicy(policyLoader.policy, body);
    return ctx.json({ result, policyLoaded: policyLoader.hasPolicy });
  });

  // ── GET /admin/compliance-policy/report ───────────────────────────────────
  router.get("/report", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);

    const windowStart = ctx.req.query("from");
    const windowEnd = ctx.req.query("to");
    const maxViolations = ctx.req.query("maxViolations")
      ? Number(ctx.req.query("maxViolations"))
      : undefined;

    const report = await generateAuditReport(auditLog, policyLoader.policy, {
      ...(windowStart !== undefined ? { windowStart } : {}),
      ...(windowEnd !== undefined ? { windowEnd } : {}),
      ...(maxViolations !== undefined && !Number.isNaN(maxViolations)
        ? { maxRecentViolations: maxViolations }
        : {}),
    });

    return ctx.json(report);
  });

  // ── GET /admin/compliance-policy/report.csv ───────────────────────────────
  // Simple CSV export of violations for spreadsheet import.
  router.get("/report.csv", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);

    const report = await generateAuditReport(auditLog, policyLoader.policy);

    const lines: string[] = [
      "timestamp,actor,action,target,decision,details",
    ];
    for (const v of report.violations.recent) {
      const row = [
        v.at,
        csv(v.actor),
        csv(v.action),
        csv(v.target ?? ""),
        csv(
          v.details?.decision !== undefined
            ? String(v.details.decision)
            : "violation",
        ),
        csv(v.details !== undefined ? JSON.stringify(v.details) : ""),
      ].join(",");
      lines.push(row);
    }

    ctx.header("Content-Type", "text/csv; charset=utf-8");
    ctx.header(
      "Content-Disposition",
      `attachment; filename="compliance-report-${report.generatedAt.slice(0, 10)}.csv"`,
    );
    return ctx.text(lines.join("\n"));
  });

  return router;
}

function csv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
