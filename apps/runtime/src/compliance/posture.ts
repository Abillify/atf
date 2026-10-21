// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Governance posture report (`src/compliance/posture.ts`).
 *
 * The prod-gate answers "may this config start in production?". The posture
 * report answers the auditor's question instead: "which controls are ACTIVE
 * right now?". Each control is judged independently as `ok`, `warn` or `fail`
 * with a concrete message, so the report doubles as evidence of the active
 * control set (EU AI Act Art. 9/17, GDPR Art. 32) rather than a pass/fail
 * verdict on one deployment mode.
 *
 * Pure — no I/O. The route/CLI pass in the loaded config plus the two runtime
 * facts that are only known after bootstrap (`compliancePolicyLoaded`,
 * `flowLoadFailures`).
 *
 * No `any` at module boundaries.
 */

import type { AppConfig } from "../config/schema.js";

/** Outcome of one posture check. */
export type PostureStatus = "ok" | "warn" | "fail";

/** One posture check result. */
export interface PostureCheck {
  /** Stable machine-readable id (e.g. `"evidence_key"`). */
  id: string;
  status: PostureStatus;
  /** Human-readable explanation of the status. */
  message: string;
}

/** Aggregated posture report. */
export interface PostureReport {
  /** ISO-8601 timestamp of report generation. */
  generatedAt: string;
  /** Worst status across all checks (`fail` > `warn` > `ok`). */
  status: PostureStatus;
  /** Number of checks per status. */
  summary: { ok: number; warn: number; fail: number };
  /** Individual check results, in report order. */
  checks: PostureCheck[];
}

/** Runtime facts the posture report cannot read from the config alone. */
export interface PostureContext {
  /** Whether a valid `compliance-policy.yaml` is loaded. */
  compliancePolicyLoaded: boolean;
  /** Number of flow files that failed to load at startup. */
  flowLoadFailures: number;
  /** Injection point for the report timestamp (tests). */
  now?: Date;
}

function worst(a: PostureStatus, b: PostureStatus): PostureStatus {
  const rank: Record<PostureStatus, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Builds the governance posture report for a loaded config.
 *
 * Checks (in order): evidence key, anchors, egress, taint, disclosure,
 * policy, receipts, shared state, flow load.
 */
export function buildPostureReport(
  config: AppConfig,
  ctx: PostureContext,
): PostureReport {
  const checks: PostureCheck[] = [];

  // ── Evidence key (ADR 0030) ──────────────────────────────────────────────
  if (config.evidenceSigningKey !== undefined) {
    checks.push({
      id: "evidence_key",
      status: "ok",
      message:
        "EVIDENCE_SIGNING_KEY (Ed25519) is configured — anchors, Evidence Bundles and Erasure Receipts are signed for offline third-party verification via the evidence JWKS.",
    });
  } else if (
    config.auditAnchorSecret !== undefined ||
    config.evidenceBundleSecret !== undefined
  ) {
    checks.push({
      id: "evidence_key",
      status: "warn",
      message:
        "The evidence chain is signed with an HMAC shared secret only — third parties cannot verify it independently. Configure EVIDENCE_SIGNING_KEY (Ed25519, ADR 0030).",
    });
  } else {
    checks.push({
      id: "evidence_key",
      status: "fail",
      message:
        "No evidence signing key is configured (EVIDENCE_SIGNING_KEY, nor a legacy HMAC secret) — audit anchors, Evidence Bundles and Erasure Receipts are not cryptographically signed.",
    });
  }

  // ── Anchors ──────────────────────────────────────────────────────────────
  if (config.auditAnchorFile !== undefined) {
    checks.push({
      id: "anchors",
      status: "ok",
      message:
        "AUDIT_ANCHOR_FILE is set — signed audit-chain checkpoints persist outside the audit DB and survive restarts.",
    });
  } else {
    checks.push({
      id: "anchors",
      status: "warn",
      message:
        "AUDIT_ANCHOR_FILE is not set — signed audit-chain checkpoints are kept in memory only and lost on restart. External anchoring of the audit chain is not durable.",
    });
  }

  // ── Egress guard ─────────────────────────────────────────────────────────
  if ((config.egressAllowedHosts ?? []).length > 0) {
    checks.push({
      id: "egress",
      status: "ok",
      message: `EGRESS_ALLOWED_HOSTS lists ${(config.egressAllowedHosts ?? []).length} allowed destination(s) — guarded outbound calls are restricted to them.`,
    });
  } else {
    checks.push({
      id: "egress",
      status: "warn",
      message:
        "EGRESS_ALLOWED_HOSTS is empty — every public host is a permitted destination for guarded outbound calls (private and metadata ranges stay blocked). Set the destinations you actually use.",
    });
  }

  // ── Taint tracking ───────────────────────────────────────────────────────
  if (config.taintWriteToolsRequireApproval === false) {
    checks.push({
      id: "taint",
      status: "fail",
      message:
        "TAINT_WRITE_TOOLS_REQUIRE_APPROVAL is disabled — write tools run without approval even when an execution is tainted.",
    });
  } else {
    checks.push({
      id: "taint",
      status: "ok",
      message:
        "Write tools require approval (TAINT_WRITE_TOOLS_REQUIRE_APPROVAL active) — tainted executions cannot trigger side effects unchecked.",
    });
  }

  // ── AI disclosure (EU AI Act Art. 50) ────────────────────────────────────
  if (config.aiDisclosure === "field" || config.aiDisclosure === "header") {
    checks.push({
      id: "disclosure",
      status: "ok",
      message: `Machine-readable AI disclosure is active via AI_DISCLOSURE=${config.aiDisclosure}.`,
    });
  } else {
    checks.push({
      id: "disclosure",
      status: "warn",
      message:
        "AI_DISCLOSURE is off — completions carry no machine-readable AI disclosure (EU AI Act Art. 50). Set AI_DISCLOSURE=header or field.",
    });
  }

  // ── Compliance policy ────────────────────────────────────────────────────
  if (ctx.compliancePolicyLoaded) {
    checks.push({
      id: "policy",
      status: "ok",
      message:
        "A valid compliance-policy.yaml is loaded — data-class residency and provider rules are enforced.",
    });
  } else if (config.compliancePolicyRequired === true) {
    checks.push({
      id: "policy",
      status: "fail",
      message:
        "COMPLIANCE_POLICY_REQUIRED is set but no valid compliance-policy.yaml is loaded — data-class residency and provider rules are not enforced.",
    });
  } else {
    checks.push({
      id: "policy",
      status: "warn",
      message:
        "No compliance-policy.yaml is loaded — data-class residency and provider rules are not enforced. Add the policy to the flows directory (see compliance-policy.example.yaml).",
    });
  }

  // ── Decision receipts ────────────────────────────────────────────────────
  if (config.decisionReceiptsEnabled === true && config.receiptSigningKey !== undefined) {
    checks.push({
      id: "receipts",
      status: "ok",
      message:
        "DECISION_RECEIPTS_ENABLED with a signing key — executions yield signed receipts with a verifiable signature.",
    });
  } else if (config.decisionReceiptsEnabled === true) {
    checks.push({
      id: "receipts",
      status: "fail",
      message:
        "DECISION_RECEIPTS_ENABLED is set without RECEIPT_SIGNING_KEY — receipts cannot carry a verifiable signature.",
    });
  } else {
    checks.push({
      id: "receipts",
      status: "warn",
      message:
        "DECISION_RECEIPTS_ENABLED is off — executions do not produce signed Decision_Receipts.",
    });
  }

  // ── Shared state ─────────────────────────────────────────────────────────
  if (config.redisUrl !== undefined || config.databaseUrl !== undefined) {
    checks.push({
      id: "shared_state",
      status: "ok",
      message:
        "A shared store (REDIS_URL or DATABASE_URL) is configured — rate limit, semaphore, approval log, monitoring history and semantic cache are cluster-wide.",
    });
  } else {
    checks.push({
      id: "shared_state",
      status: "warn",
      message:
        "No shared store is configured (REDIS_URL/DATABASE_URL) — cluster-wide states are per-replica only and diverge across instances.",
    });
  }

  // ── Flow load ────────────────────────────────────────────────────────────
  if (ctx.flowLoadFailures === 0) {
    checks.push({
      id: "flow_load",
      status: "ok",
      message: "All flow files loaded without errors.",
    });
  } else {
    checks.push({
      id: "flow_load",
      status: "fail",
      message: `${ctx.flowLoadFailures} flow file(s) failed to load — those flows are unavailable and their controls inactive.`,
    });
  }

  let status: PostureStatus = "ok";
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    summary[c.status] += 1;
    status = worst(status, c.status);
  }

  return {
    generatedAt: (ctx.now ?? new Date()).toISOString(),
    status,
    summary,
    checks,
  };
}

/**
 * Renders the report as the `STATUS  ID  MESSAGE` table used by the CLI.
 */
export function formatPostureReportAsTable(report: PostureReport): string {
  const width = Math.max(6, ...report.checks.map((c) => c.id.length));
  const lines = report.checks.map(
    (c) => `${c.status.toUpperCase().padEnd(6)}${c.id.padEnd(width)}  ${c.message}`,
  );
  lines.push(
    "",
    `${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail (overall: ${report.status.toUpperCase()})`,
  );
  return lines.join("\n");
}
