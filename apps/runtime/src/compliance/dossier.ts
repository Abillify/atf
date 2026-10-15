// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * EU AI Act / GDPR compliance dossier generator (`src/compliance/dossier.ts`)
 *
 * `audit-report.ts` already answers "what happened on the operator plane in
 * the last N hours" (violations, approvals, model usage). An auditor asking
 * "can you PROVE this deployment is compliant" needs more than that single
 * window — they need a single document that ties together every control the
 * platform already has, with evidence, not just configuration:
 *
 *   - the ACTIVE policy (data residency, model allow/block, retention, audit
 *     verbosity rules) — from `policy-loader.ts`
 *   - the AUDIT TRAIL's own integrity — the hash-chain verification result,
 *     so the dossier itself carries proof it wasn't assembled from tampered
 *     records (see `observability/audit-log.ts`)
 *   - RIGHT-TO-BE-FORGOTTEN evidence — every erasure actually performed
 *     (`compliance.forget` / `dsar.self_erasure` audit entries), not just the
 *     retention windows configured
 *   - RETENTION posture — configured targets/windows (`RetentionService`)
 *   - MODEL QUALITY evidence — the most recent eval run per dataset
 *     (`eval-run-history.ts`), citable as "this flow was evaluated on <date>
 *     with pass rate <x>%"
 *   - SECURITY POSTURE — the red-team engine's latest bypass rate / posture
 *     score per flow, when the security posture engine is enabled
 *   - ARCHITECTURAL GUARANTEES — the tenant-isolation (ADR-0005) and
 *     plugin-trust-boundary (ADR-0006) design decisions, cited by reference so
 *     an auditor can trace a claim back to its source document
 *
 * Every section degrades gracefully to "not configured / no data" rather than
 * failing the whole dossier — a deployment without red-teaming enabled still
 * gets a usable dossier, just without a security-posture section.
 *
 * Output is a structured JSON object (matches the codebase's established
 * `ComplianceAuditReport` convention — no PDF/CSV generation exists anywhere
 * in the codebase to build on, see `compliance-policy.ts`'s CSV export for the
 * one precedent, which this module's route layer can reuse for a CSV variant).
 *
 * No `any` at module boundaries.
 */

import type { CompliancePolicy } from "./policy-schema.js";
import type { AuditLog, AuditChainVerification } from "../observability/audit-log.js";
import { buildDataFlowMap } from "./data-flow-map.js";
import type { RetentionService } from "../observability/retention.js";
import type { EvalRunHistory, EvalRunRecord } from "../eval/eval-run-history.js";
import type { RedTeamEngine, RedTeamRunSummary } from "../security/red-team-engine.js";
import {
  generateAuditReport,
  type ComplianceAuditReport,
} from "./audit-report.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RtbfEvidenceEntry {
  at: string;
  actor: string;
  action: "compliance.forget" | "dsar.self_erasure";
  target?: string;
  erased: number;
}

export interface RtbfEvidence {
  /** Total erasure operations performed in the window. */
  totalOperations: number;
  /** Total records erased across all operations in the window. */
  totalRecordsErased: number;
  /** Every erasure performed in the window, newest first. */
  operations: RtbfEvidenceEntry[];
}

export interface RetentionPosture {
  targets: Array<{
    name: string;
    agePurge: boolean;
    subjectErase: boolean;
    maxAgeDays: number | null;
    /** Why the store's personal data cannot be erased automatically, when it cannot. */
    erasureGap?: string;
  }>;
  /** Policy-declared per-data-class retention windows (from compliance-policy.yaml). */
  policyRetentionRules: Array<{ dataClass: string; maxAgeDays: number }>;
}

export interface AuditIntegrityEvidence {
  /** Result of verifying the FULL audit chain from genesis (see verifyAuditChain). */
  chainVerification: AuditChainVerification;
  /** True when the hash chain verified intact (no isolated edit/delete/reorder). */
  chainIntact: boolean;
  /**
   * True when a signed EXTERNAL anchor exists and still verifies against the
   * current chain tip — the only guarantee against a wholesale, internally
   * consistent rebuild of the chain by an attacker with database write access.
   */
  externallyAnchored: boolean;
  /** Details of the latest external anchor, when anchoring is active. */
  anchor?: {
    uptoId: number;
    anchoredAt: string;
    verified: boolean;
  };
  /**
   * Overall tamper-evidence assessment. `true` only when the chain is intact
   * AND an external anchor still verifies (the strong guarantee). Chain-intact
   * without anchoring is reported as `false` here (with `chainIntact: true`),
   * so the dossier never overstates the guarantee it can actually back.
   */
  tamperEvident: boolean;
}

export interface EvalEvidenceEntry {
  dataset: string;
  recordedAt: string;
  source: "ci" | "manual";
  passRate: number;
  passed: number;
  total: number;
  avgScore?: number;
}

export interface SecurityPostureEvidence {
  enabled: boolean;
  /** Latest posture score per flow (0-1, higher = more secure). Empty when disabled. */
  postureByFlow: Record<string, number>;
  /** Most recent run per flow that has run at least once. */
  recentRuns: RedTeamRunSummary[];
}

/**
 * Reversible PII tokenization vault posture (ADR-0007, ADR-0015). Durable,
 * verifiable configuration evidence: whether PII is tokenized before any LLM
 * provider sees the prompt, which detector backends do the detecting, whether
 * the token→value mapping is encrypted-at-rest, and which PII types are covered.
 * Runtime per-detector activity is exposed separately as the
 * `aiperator_pii_vault_tokens_total{detector,type}` metric.
 */
export interface PiiVaultPosture {
  /** True when PII_VAULT_ENABLED and the vault was constructed. */
  enabled: boolean;
  /** True when backed by an encrypted Postgres store (vs. in-memory per-replica). */
  durable: boolean;
  /**
   * Active detector backends (ADR-0015), e.g. ["regex","ner"]. Empty means the
   * vault uses the legacy sync regex-only path (no configurable pipeline).
   */
  detectors: string[];
  /** PII types the vault tokenizes; "all" when no explicit subset is configured. */
  piiTypes: string[] | "all";
  /**
   * Multimodal (image/file) PII handling mode (ADR-0016): "off" (attachments
   * pass through un-scanned), "block" (attachments stripped before reaching the
   * provider), or "redact" (attachments redacted via an external service).
   * Absent is treated as "off" for backward compatibility.
   */
  multimodalMode?: "off" | "block" | "redact" | "describe";
}

export interface ArchitecturalGuarantee {
  topic: string;
  summary: string;
  reference: string;
}

export interface ComplianceDossier {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  /** The underlying operator-plane audit report this dossier extends. */
  auditReport: ComplianceAuditReport;
  auditIntegrity: AuditIntegrityEvidence;
  rtbfEvidence: RtbfEvidence;
  retentionPosture: RetentionPosture;
  evalEvidence: EvalEvidenceEntry[];
  securityPosture: SecurityPostureEvidence;
  /** Reversible PII tokenization vault posture (config evidence). */
  piiVaultPosture: PiiVaultPosture;
  /**
   * DLP effectiveness — measured PII detector recall/precision on a labeled
   * corpus (see eval/pii-recall.ts). Present when a recall dataset was supplied,
   * so the dossier can cite "detector recall = X%" instead of asserting coverage.
   */
  dlpEffectiveness?: import("../eval/pii-recall.js").PiiRecallReport;
  /**
   * Record of Processing Activities (Art. 30) / data-flow map — present when
   * the loaded flows were supplied. Cross-references declared data classes and
   * node providers against the residency policy.
   */
  dataFlowMap?: import("./data-flow-map.js").DataFlowMap;
  architecturalGuarantees: ArchitecturalGuarantee[];
}

// ---------------------------------------------------------------------------
// Fixed reference material — cites the ADRs so a claim in the dossier can be
// traced to the design decision that backs it, without duplicating their text.
// ---------------------------------------------------------------------------

const ARCHITECTURAL_GUARANTEES: readonly ArchitecturalGuarantee[] = [
  {
    topic: "Multi-tenant data isolation",
    summary:
      "Every tenant-scoped store filters by tenant_id from the authenticated " +
      "request context (never client-supplied). Optional PostgreSQL Row-Level " +
      "Security (RLS) provides defense-in-depth: FORCE RLS + a tenant_id policy " +
      "on every tenant-scoped table means a missing application-level predicate " +
      "degrades to 'no rows' rather than a cross-tenant leak.",
    reference: "docs/adr/0005-tenant-data-isolation.md",
  },
  {
    topic: "Third-party plugin trust boundary",
    summary:
      "Operator-provided node-type handler plugins run in-process by default " +
      "(full engine access) or, when PLUGINS_SANDBOX=true, in an isolated Bun " +
      "Worker with no access to process.env, the database pool, or shared state.",
    reference: "docs/adr/0006-plugin-trust-boundary-and-isolation.md",
  },
  {
    topic: "Reversible PII tokenization at the LLM boundary",
    summary:
      "When PII_VAULT_ENABLED=true, detected PII in outbound prompts is replaced " +
      "with an encrypted-at-rest placeholder before any LLM provider sees it, " +
      "and transparently re-substituted in the response — the model and " +
      "provider never receive the real value. Detection is an extensible, " +
      "per-flow-selectable pipeline (deterministic regex + optional in-process " +
      "BERT-NER + optional external service) with per-detector provenance.",
    reference: "docs/adr/0015-extensible-pii-detector-pipeline.md",
  },
  {
    topic: "Tamper-evident audit trail",
    summary:
      "Every audit_log record is chained by a SHA-256 hash over its own fields " +
      "plus the previous record's hash. Editing, deleting, or reordering any " +
      "historical record breaks the chain from that point forward.",
    reference: "src/observability/audit-log.ts",
  },
];

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

interface AuditEntryLike {
  at: string;
  action: string;
  actor: string;
  target?: string;
  details?: Record<string, unknown>;
}

function buildRtbfEvidence(auditEntries: readonly AuditEntryLike[]): RtbfEvidence {
  const operations: RtbfEvidenceEntry[] = [];
  for (const e of auditEntries) {
    if (e.action !== "compliance.forget" && e.action !== "dsar.self_erasure") continue;
    const erased =
      typeof e.details?.erased === "number" ? (e.details.erased as number) : 0;
    operations.push({
      at: e.at,
      actor: e.actor,
      action: e.action,
      ...(e.target !== undefined ? { target: e.target } : {}),
      erased,
    });
  }
  return {
    totalOperations: operations.length,
    totalRecordsErased: operations.reduce((sum, o) => sum + o.erased, 0),
    operations,
  };
}

function buildEvalEvidence(records: readonly EvalRunRecord[]): EvalEvidenceEntry[] {
  // One entry per dataset name — the MOST RECENT run only (records are
  // expected newest-first from EvalRunHistory.listRecent()).
  const seen = new Set<string>();
  const out: EvalEvidenceEntry[] = [];
  for (const r of records) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push({
      dataset: r.name,
      recordedAt: r.recordedAt,
      source: r.source,
      passRate: r.report.passRate,
      passed: r.report.passed,
      total: r.report.total,
      ...(r.report.avgScore !== undefined ? { avgScore: r.report.avgScore } : {}),
    });
  }
  return out;
}

function buildSecurityPosture(engine: RedTeamEngine | undefined): SecurityPostureEvidence {
  if (engine === undefined) {
    return { enabled: false, postureByFlow: {}, recentRuns: [] };
  }
  const postureByFlow = engine.postureByFlow();
  const recentRuns = engine.listRuns();
  return { enabled: true, postureByFlow, recentRuns };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface DossierOptions {
  /** Start of the reporting window (ISO string or ms timestamp). Default: 30 days ago. */
  windowStart?: string | number;
  /** End of the reporting window (ISO string or ms timestamp). Default: now. */
  windowEnd?: string | number;
  /** Maximum number of recent policy violations embedded in the underlying audit report. Default 50. */
  maxRecentViolations?: number;
  /** Number of audit-chain records to verify. Default: undefined (verifies the FULL chain from genesis). */
  auditChainVerifyLimit?: number;
}

/**
 * Generates a {@link ComplianceDossier}. Every optional dependency degrades
 * gracefully — a deployment without eval history, red-teaming, or a loaded
 * compliance policy still produces a usable (partial) dossier rather than
 * throwing.
 */
export async function generateComplianceDossier(
  deps: {
    auditLog: AuditLog;
    retention: RetentionService;
    policy: CompliancePolicy | undefined;
    evalRunHistory?: EvalRunHistory;
    redTeamEngine?: RedTeamEngine;
    /** PII vault configuration posture. Absent → reported as disabled. */
    piiVaultPosture?: PiiVaultPosture;
    /**
     * Optional audit-anchor service. When present its latest anchor is
     * re-verified and embedded, so `tamperEvident` reflects whether external
     * anchoring is actually active and still valid. Absent → chain-only.
     */
    auditAnchor?: import("../observability/audit-anchor.js").AuditAnchorService;
    /**
     * Optional measured DLP effectiveness report (PII detector recall/precision
     * on a labeled corpus) — embedded verbatim as evidence when supplied.
     */
    dlpEffectiveness?: import("../eval/pii-recall.js").PiiRecallReport;
    /**
     * Optional loaded flows — when present a Record of Processing Activities
     * (Art. 30) / data-flow map is embedded, cross-referencing each flow's
     * declared data classes and node providers against the residency policy.
     */
    flows?: readonly import("../types/flow.js").FlowDefinition[];
    /** RoPA residency options (provider→region map, local-provider set). */
    dataFlowOptions?: import("./data-flow-map.js").DataFlowMapOptions;
  },
  opts: DossierOptions = {},
): Promise<ComplianceDossier> {
  const { auditLog, retention, policy, evalRunHistory, redTeamEngine } = deps;

  const now = Date.now();
  const windowEnd = opts.windowEnd !== undefined ? new Date(opts.windowEnd).getTime() : now;
  const windowStart =
    opts.windowStart !== undefined
      ? new Date(opts.windowStart).getTime()
      : windowEnd - 30 * 24 * 60 * 60 * 1000; // default: 30-day compliance window

  const auditReport = await generateAuditReport(auditLog, policy, {
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    ...(opts.maxRecentViolations !== undefined
      ? { maxRecentViolations: opts.maxRecentViolations }
      : {}),
  });

  // RTBF evidence needs the RAW compliance.forget / dsar.self_erasure entries,
  // which generateAuditReport's `violations` section does NOT include (those
  // are outcome:"success" operator actions, not policy violations) — fetch
  // separately from the audit log, scoped to the same window.
  const allEntries = await auditLog.list({ limit: 1000 });
  const windowEntries = allEntries.filter((e) => {
    const t = new Date(e.at).getTime();
    return t >= windowStart && t <= windowEnd;
  });
  const rtbfEvidence = buildRtbfEvidence(windowEntries);

  const chainVerification = await auditLog.verifyChain(opts.auditChainVerifyLimit);
  const chainIntact = chainVerification.valid;

  // External anchoring: re-verify the latest signed anchor (when configured)
  // so the dossier's tamper-evidence claim is derived from actual state.
  const anchorStatus =
    deps.auditAnchor !== undefined ? await deps.auditAnchor.verifyLatest() : undefined;
  const externallyAnchored =
    anchorStatus?.latest !== undefined && anchorStatus.verified === true;
  const auditIntegrity: AuditIntegrityEvidence = {
    chainVerification,
    chainIntact,
    externallyAnchored,
    ...(anchorStatus?.latest !== undefined
      ? {
          anchor: {
            uptoId: anchorStatus.latest.uptoId,
            anchoredAt: anchorStatus.latest.anchoredAt,
            verified: anchorStatus.verified === true,
          },
        }
      : {}),
    // Strong guarantee only when the chain is intact AND an external anchor
    // still verifies. Chain-intact-only is reported honestly as not (yet)
    // externally tamper-evident.
    tamperEvident: chainIntact && externallyAnchored,
  };

  const retentionPosture: RetentionPosture = {
    targets: retention.describeTargets(),
    policyRetentionRules: (policy?.retentionRules ?? []).map((r) => ({
      dataClass: r.dataClass,
      maxAgeDays: r.maxAgeDays,
    })),
  };

  const evalRecords = evalRunHistory !== undefined ? await evalRunHistory.listRecent(200) : [];
  const evalEvidence = buildEvalEvidence(evalRecords);

  const securityPosture = buildSecurityPosture(redTeamEngine);

  const piiVaultPosture: PiiVaultPosture = deps.piiVaultPosture ?? {
    enabled: false,
    durable: false,
    detectors: [],
    piiTypes: "all",
  };

  return {
    generatedAt: new Date().toISOString(),
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    auditReport,
    auditIntegrity,
    rtbfEvidence,
    retentionPosture,
    evalEvidence,
    securityPosture,
    piiVaultPosture,
    ...(deps.dlpEffectiveness !== undefined
      ? { dlpEffectiveness: deps.dlpEffectiveness }
      : {}),
    ...(deps.flows !== undefined
      ? { dataFlowMap: buildDataFlowMap(deps.flows, policy, Date.now, deps.dataFlowOptions ?? {}) }
      : {}),
    architecturalGuarantees: [...ARCHITECTURAL_GUARANTEES],
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (human-readable export, mirrors eval-runner's formatReport)
// ---------------------------------------------------------------------------

/** Renders a {@link ComplianceDossier} as a self-contained Markdown document. */
export function formatDossierAsMarkdown(dossier: ComplianceDossier): string {
  const lines: string[] = [];
  lines.push(`# Compliance Dossier`);
  lines.push("");
  lines.push(`Generated: ${dossier.generatedAt}`);
  lines.push(`Window: ${dossier.windowStart} → ${dossier.windowEnd}`);
  lines.push("");

  lines.push(`## Policy`);
  if (dossier.auditReport.policy === null) {
    lines.push("No compliance policy loaded.");
  } else {
    const p = dossier.auditReport.policy;
    lines.push(
      `Version ${p.version}${p.failClosed ? " (fail-closed)" : ""} — ` +
        `${p.dataRules} data rules, ${p.modelRules} model rules, ` +
        `${p.approvalRules} approval rules, ${p.retentionRules} retention rules, ` +
        `${p.auditRules} audit rules.`,
    );
    if (p.description !== undefined) lines.push(p.description);
  }
  lines.push("");

  lines.push(`## Audit trail integrity`);
  const v = dossier.auditIntegrity.chainVerification;
  lines.push(
    v.valid
      ? `✓ Hash chain verified — ${v.checked} record(s) checked, chain intact from genesis.`
      : `✗ TAMPER DETECTED — broken at record #${v.brokenAt?.id} (${v.brokenAt?.reason}).`,
  );
  const ai = dossier.auditIntegrity;
  if (ai.externallyAnchored && ai.anchor !== undefined) {
    lines.push(
      `✓ Externally anchored — signed checkpoint up to record #${ai.anchor.uptoId} ` +
        `(anchored ${ai.anchor.anchoredAt}) still verifies. Protects against a wholesale chain rebuild.`,
    );
  } else if (ai.anchor !== undefined) {
    lines.push(
      `✗ External anchor present but FAILED verification (record #${ai.anchor.uptoId}) — ` +
        `the chain was altered after the anchor was taken.`,
    );
  } else {
    lines.push(
      `ℹ No external anchor configured — integrity rests on the hash chain alone ` +
        `(detects isolated edits; set AUDIT_ANCHOR_SECRET to also detect a full-DB rebuild).`,
    );
  }
  lines.push(
    `Tamper-evident (strong guarantee): ${ai.tamperEvident ? "yes" : "no"}.`,
  );
  lines.push("");

  lines.push(`## Right-to-be-forgotten evidence`);
  lines.push(
    `${dossier.rtbfEvidence.totalOperations} erasure operation(s) in window, ` +
      `${dossier.rtbfEvidence.totalRecordsErased} record(s) erased.`,
  );
  for (const op of dossier.rtbfEvidence.operations.slice(0, 20)) {
    lines.push(`  - ${op.at}: ${op.actor} → ${op.action} (${op.target ?? "?"}), erased=${op.erased}`);
  }
  lines.push("");

  lines.push(`## Retention posture`);
  for (const t of dossier.retentionPosture.targets) {
    lines.push(
      `  - ${t.name}: age-purge=${t.agePurge}, subject-erase=${t.subjectErase}, window=${
        t.maxAgeDays ?? "none"
      } day(s)${t.erasureGap !== undefined ? ` — ERASURE GAP: ${t.erasureGap}` : ""}`,
    );
  }
  lines.push("");

  lines.push(`## Model quality (eval evidence)`);
  if (dossier.evalEvidence.length === 0) {
    lines.push("No eval runs recorded.");
  } else {
    for (const e of dossier.evalEvidence) {
      lines.push(
        `  - ${e.dataset}: ${e.passed}/${e.total} passed (${(e.passRate * 100).toFixed(1)}%)` +
          ` on ${e.recordedAt} [${e.source}]`,
      );
    }
  }
  lines.push("");

  lines.push(`## Security posture`);
  if (!dossier.securityPosture.enabled) {
    lines.push("Red-team / security posture engine not enabled.");
  } else {
    for (const [flowId, score] of Object.entries(dossier.securityPosture.postureByFlow)) {
      lines.push(`  - ${flowId}: posture score ${(score * 100).toFixed(1)}%`);
    }
  }
  lines.push("");

  lines.push(`## PII tokenization vault`);
  const pv = dossier.piiVaultPosture;
  if (!pv.enabled) {
    lines.push("PII vault not enabled (PII is not tokenized before reaching the LLM provider).");
  } else {
    const detectors = pv.detectors.length > 0 ? pv.detectors.join(", ") : "regex (legacy sync)";
    const types = pv.piiTypes === "all" ? "all" : pv.piiTypes.join(", ");
    const multimodal = pv.multimodalMode ?? "off";
    const multimodalDesc =
      multimodal === "off"
        ? "image/file attachments pass through un-scanned"
        : multimodal === "block"
          ? "image/file attachments are stripped before reaching the provider"
          : multimodal === "describe"
            ? "image/file attachments are converted to text by a vision model and redacted before reaching the provider"
            : "image/file attachments are redacted before reaching the provider";
    lines.push(
      `✓ Active — mapping ${pv.durable ? "durable (encrypted at rest)" : "in-memory (per-replica)"}; ` +
        `detectors: ${detectors}; PII types: ${types}; ` +
        `multimodal handling: ${multimodal} (${multimodalDesc}). ` +
        `Per-detector activity is exposed as the ` +
        `\`aiperator_pii_vault_tokens_total{detector,type}\` metric.`,
    );
  }
  lines.push("");

  if (dossier.dlpEffectiveness !== undefined) {
    const d = dossier.dlpEffectiveness;
    lines.push(`## DLP effectiveness (measured PII detector recall)`);
    lines.push(
      `Evaluated ${d.total} public case(s): recall ${(d.recall * 100).toFixed(1)}%, precision ` +
        `${(d.precision * 100).toFixed(1)}%.`,
    );
    lines.push("");
  }

  if (dossier.dataFlowMap !== undefined) {
    const m = dossier.dataFlowMap;
    lines.push(`## Record of Processing Activities (Art. 30) / data-flow map`);
    lines.push(
      `${m.summary.flows} flow(s), ${m.summary.withDataClasses} with declared data classes, ` +
        `${m.summary.violations} residency violation(s). ` +
        `Providers: ${m.summary.providers.join(", ") || "none"}.`,
    );
    for (const e of m.entries) {
      const procs = e.processors
        .map((p) => `${p.provider}${p.local ? "(local)" : ""}`)
        .join(", ");
      lines.push(
        `  - **${e.flowId}** [${e.status}] — classes: ` +
          `${e.dataClasses.join(", ") || "(none)"}; processors: ${procs || "none"}`,
      );
    }
    lines.push("");
  }

  lines.push(`## Architectural guarantees`);
  for (const g of dossier.architecturalGuarantees) {
    lines.push(`  - **${g.topic}** (${g.reference}): ${g.summary}`);
  }

  return lines.join("\n");
}
