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
 * The check ids and their statuses are the established ones (snake_case,
 * e.g. `evidence_key`); a missing evidence key and failed flow loads are
 * `fail`. The report additionally names the operational profile, the preset
 * and the production-gate result, and every check carries an `area`.
 *
 * No `any` at module boundaries.
 */

import type { AppConfig } from "../config/schema.js";
import { checkProductionReadiness } from "../config/prod-gate.js";

/** Outcome of one posture check. */
export type PostureStatus = "ok" | "warn" | "fail";

/** One posture check result. */
export interface PostureCheck {
  /** Stable machine-readable id (e.g. `"evidence_key"`). */
  id: string;
  /** Control area the check belongs to (e.g. `"evidence"`, `"privacy"`). */
  area: string;
  status: PostureStatus;
  /** Human-readable explanation of the status. */
  message: string;
}

/** Aggregated posture report. */
export interface PostureReport {
  /** ISO-8601 timestamp of report generation. */
  generatedAt: string;
  /** Effective operational profile (`ATF_PROFILE`/`APP_ENV`, default `development`). */
  operationalProfile: string;
  /** Applied configuration preset (`ATF_PRESET`), or `null`. */
  preset: string | null;
  /** Worst status across all checks (`fail` > `warn` > `ok`). */
  status: PostureStatus;
  /** Number of checks per status. */
  summary: { ok: number; warn: number; fail: number };
  /** Individual check results, in report order. */
  checks: PostureCheck[];
  /** Result of the production-readiness gate for the same config. */
  productionGate: { fatal: string[]; warnings: string[] };
}

/** Runtime facts the posture report cannot read from the config alone. */
export interface PostureContext {
  /** Whether a valid `compliance-policy.yaml` is loaded. */
  compliancePolicyLoaded: boolean;
  /** Number of flow files that failed to load at startup. */
  flowLoadFailures: number;
  /** Injection point for the report timestamp (tests). */
  now?: Date;
  /** Environment for the production gate (default `process.env`; tests). */
  env?: Record<string, string | undefined>;
}

function worst(a: PostureStatus, b: PostureStatus): PostureStatus {
  const rank: Record<PostureStatus, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Builds the governance posture report for a loaded config.
 *
 * Checks (in order): evidence key, anchors, egress, taint, disclosure,
 * policy, receipts, shared state, flow load, audit pseudonym pepper, PII
 * vault, approval gate, authentication mode, replicas.
 */
export function buildPostureReport(
  config: AppConfig,
  ctx: PostureContext,
): PostureReport {
  const checks: PostureCheck[] = [];
  const isProd = config.appEnv === "production";

  // ── Evidence key (ADR 0030) ──────────────────────────────────────────────
  if (config.evidenceSigningKey !== undefined) {
    checks.push({
      id: "evidence_key",
      area: "evidence",
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
      area: "evidence",
      status: "warn",
      message:
        "The evidence chain is signed with an HMAC shared secret only — third parties cannot verify it independently. Configure EVIDENCE_SIGNING_KEY (Ed25519, ADR 0030).",
    });
  } else {
    checks.push({
      id: "evidence_key",
      area: "evidence",
      status: "fail",
      message:
        "No evidence signing key is configured (EVIDENCE_SIGNING_KEY, nor a legacy HMAC secret) — audit anchors, Evidence Bundles and Erasure Receipts are not cryptographically signed.",
    });
  }

  // ── Anchors ──────────────────────────────────────────────────────────────
  if (config.auditAnchorFile !== undefined) {
    checks.push({
      id: "anchors",
      area: "audit",
      status: "ok",
      message:
        "AUDIT_ANCHOR_FILE is set — signed audit-chain checkpoints persist outside the audit DB and survive restarts.",
    });
  } else {
    checks.push({
      id: "anchors",
      area: "audit",
      status: "warn",
      message:
        "AUDIT_ANCHOR_FILE is not set — signed audit-chain checkpoints are kept in memory only and lost on restart. External anchoring of the audit chain is not durable.",
    });
  }

  // ── Egress guard ─────────────────────────────────────────────────────────
  if ((config.egressAllowedHosts ?? []).length > 0) {
    checks.push({
      id: "egress",
      area: "egress",
      status: "ok",
      message: `EGRESS_ALLOWED_HOSTS lists ${(config.egressAllowedHosts ?? []).length} allowed destination(s) — guarded outbound calls are restricted to them.`,
    });
  } else {
    checks.push({
      id: "egress",
      area: "egress",
      status: "warn",
      message:
        "EGRESS_ALLOWED_HOSTS is empty — every public host is a permitted destination for guarded outbound calls (private and metadata ranges stay blocked). Set the destinations you actually use.",
    });
  }

  // ── Taint tracking ───────────────────────────────────────────────────────
  if (config.taintWriteToolsRequireApproval === false) {
    checks.push({
      id: "taint",
      area: "injection",
      status: "fail",
      message:
        "TAINT_WRITE_TOOLS_REQUIRE_APPROVAL is disabled — write tools run without approval even when an execution is tainted.",
    });
  } else {
    checks.push({
      id: "taint",
      area: "injection",
      status: "ok",
      message:
        "Write tools require approval (TAINT_WRITE_TOOLS_REQUIRE_APPROVAL active) — tainted executions cannot trigger side effects unchecked.",
    });
  }

  // ── AI disclosure (EU AI Act Art. 50) ────────────────────────────────────
  if (config.aiDisclosure === "field" || config.aiDisclosure === "header") {
    checks.push({
      id: "disclosure",
      area: "disclosure",
      status: "ok",
      message: `Machine-readable AI disclosure is active via AI_DISCLOSURE=${config.aiDisclosure}.`,
    });
  } else {
    checks.push({
      id: "disclosure",
      area: "disclosure",
      status: "warn",
      message:
        "AI_DISCLOSURE is off — completions carry no machine-readable AI disclosure (EU AI Act Art. 50). Set AI_DISCLOSURE=header or field.",
    });
  }

  // ── Compliance policy ────────────────────────────────────────────────────
  if (ctx.compliancePolicyLoaded) {
    checks.push({
      id: "policy",
      area: "compliance",
      status: "ok",
      message:
        "A valid compliance-policy.yaml is loaded — data-class residency and provider rules are enforced.",
    });
  } else if (config.compliancePolicyRequired === true) {
    checks.push({
      id: "policy",
      area: "compliance",
      status: "fail",
      message:
        "COMPLIANCE_POLICY_REQUIRED is set but no valid compliance-policy.yaml is loaded — data-class residency and provider rules are not enforced.",
    });
  } else {
    checks.push({
      id: "policy",
      area: "compliance",
      status: "warn",
      message:
        "No compliance-policy.yaml is loaded — data-class residency and provider rules are not enforced. Add the policy to the flows directory (see compliance-policy.example.yaml).",
    });
  }

  // ── Decision receipts ────────────────────────────────────────────────────
  if (config.decisionReceiptsEnabled === true && config.receiptSigningKey !== undefined) {
    checks.push({
      id: "receipts",
      area: "receipts",
      status: "ok",
      message:
        "DECISION_RECEIPTS_ENABLED with a signing key — executions yield signed receipts with a verifiable signature.",
    });
  } else if (config.decisionReceiptsEnabled === true) {
    checks.push({
      id: "receipts",
      area: "receipts",
      status: "fail",
      message:
        "DECISION_RECEIPTS_ENABLED is set without RECEIPT_SIGNING_KEY — receipts cannot carry a verifiable signature.",
    });
  } else {
    checks.push({
      id: "receipts",
      area: "receipts",
      status: "warn",
      message:
        "DECISION_RECEIPTS_ENABLED is off — executions do not produce signed Decision_Receipts.",
    });
  }

  // ── Shared state ─────────────────────────────────────────────────────────
  if (config.redisUrl !== undefined || config.databaseUrl !== undefined) {
    checks.push({
      id: "shared_state",
      area: "replicas",
      status: "ok",
      message:
        "A shared store (REDIS_URL or DATABASE_URL) is configured — rate limit, semaphore, approval log, monitoring history and semantic cache are shared through it. The media store (show_figure links) and the receipts transparency log stay per process.",
    });
  } else {
    checks.push({
      id: "shared_state",
      area: "replicas",
      status: "warn",
      message:
        "No shared store is configured (REDIS_URL/DATABASE_URL) — rate limit, semaphore, approval log, monitoring history and semantic cache are kept per replica and diverge across instances.",
    });
  }

  // ── Flow load ────────────────────────────────────────────────────────────
  if (ctx.flowLoadFailures === 0) {
    checks.push({
      id: "flow_load",
      area: "flows",
      status: "ok",
      message: "All flow files loaded without errors.",
    });
  } else {
    checks.push({
      id: "flow_load",
      area: "flows",
      status: "fail",
      message: `${ctx.flowLoadFailures} flow file(s) failed to load — those flows are unavailable and their controls inactive.`,
    });
  }

  // ── Audit pseudonym pepper ───────────────────────────────────────────────
  if (config.auditPseudonymPepper !== undefined) {
    checks.push({
      id: "audit_pseudonym_pepper",
      area: "privacy",
      status: "ok",
      message:
        "AUDIT_PSEUDONYM_PEPPER is set — erasure and policy audit entries carry keyed (HMAC) pseudonyms.",
    });
  } else {
    checks.push({
      id: "audit_pseudonym_pepper",
      area: "privacy",
      status: "warn",
      message:
        "AUDIT_PSEUDONYM_PEPPER is not set — audit pseudonyms are unkeyed SHA-256 values that anyone who guesses an identifier can recompute.",
    });
  }

  // ── PII vault ────────────────────────────────────────────────────────────
  if (config.piiVaultEnabled === true) {
    checks.push({
      id: "pii_vault",
      area: "privacy",
      status: "ok",
      message: "The PII vault is active — detected personal data is replaced by tokens before it reaches a provider.",
    });
  } else {
    checks.push({
      id: "pii_vault",
      area: "privacy",
      status: "warn",
      message: "The PII vault is off (PII_VAULT_ENABLED) — personal data reaches the model providers in clear text.",
    });
  }

  // ── Approval gate ────────────────────────────────────────────────────────
  if (config.approvalGateEnabled === true) {
    checks.push({
      id: "approval_gate",
      area: "approval",
      status: "ok",
      message: "APPROVAL_GATE_ENABLED is set — tools that require approval wait for a human decision.",
    });
  } else {
    checks.push({
      id: "approval_gate",
      area: "approval",
      status: "warn",
      message: "APPROVAL_GATE_ENABLED is off — no tool call waits for a human approval.",
    });
  }

  // ── Authentication ───────────────────────────────────────────────────────
  if (config.authnMode === "disabled") {
    checks.push({
      id: "auth_mode",
      area: "auth",
      status: isProd ? "fail" : "warn",
      message: "AUTHN_MODE=disabled — every caller is accepted without authentication.",
    });
  } else {
    checks.push({
      id: "auth_mode",
      area: "auth",
      status: "ok",
      message: `Requests are authenticated (AUTHN_MODE=${config.authnMode ?? "inferred from the verifier settings"}).`,
    });
  }

  // ── Replicas ─────────────────────────────────────────────────────────────
  const replicas = config.replicas ?? 1;
  if (replicas <= 1) {
    checks.push({
      id: "replicas",
      area: "replicas",
      status: "ok",
      message: `REPLICAS=${replicas} — per-process state is not split across instances.`,
    });
  } else if (config.redisUrl !== undefined) {
    checks.push({
      id: "replicas",
      area: "replicas",
      status: "warn",
      message: `REPLICAS=${replicas} with REDIS_URL — the media store (show_figure links) and the receipts transparency log still exist per replica.`,
    });
  } else {
    checks.push({
      id: "replicas",
      area: "replicas",
      status: "fail",
      message: `REPLICAS=${replicas} without REDIS_URL — rate limits, semaphores and caches diverge across replicas.`,
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
    operationalProfile: config.appEnv ?? "development",
    preset: config.profile ?? null,
    status,
    summary,
    checks,
    productionGate: checkProductionReadiness(config, undefined, ctx.env ?? process.env),
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
