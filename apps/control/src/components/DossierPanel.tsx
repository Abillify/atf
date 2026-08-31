"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * DossierPanel — Auto-generated EU AI Act / GDPR compliance dossier.
 *
 * Fetches GET /admin/compliance/dossier and renders every evidence section:
 * audit-chain integrity, right-to-be-forgotten evidence, retention posture,
 * model-quality (eval) evidence, security posture, and the architectural
 * guarantees the platform provides — plus a downloadable Markdown export.
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  Button,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { downloadAuthenticated } from "../lib/authenticated-download";

// ---------------------------------------------------------------------------
// Types (mirrors backend src/compliance/dossier.ts)
// ---------------------------------------------------------------------------

interface AuditChainVerification {
  valid: boolean;
  checked: number;
  brokenAt?: { id: number; reason: string };
}

interface RtbfEvidenceEntry {
  at: string;
  actor: string;
  action: string;
  target?: string;
  erased: number;
}

interface RetentionTargetStatus {
  name: string;
  agePurge: boolean;
  subjectErase: boolean;
  maxAgeDays: number | null;
}

interface EvalEvidenceEntry {
  dataset: string;
  recordedAt: string;
  source: "ci" | "manual";
  passRate: number;
  passed: number;
  total: number;
  avgScore?: number;
}

interface RedTeamRunSummary {
  id: string;
  flowId: string;
  status: string;
  bypassRate?: number;
  postureScore?: number;
}

interface ArchitecturalGuarantee {
  topic: string;
  summary: string;
  reference: string;
}

interface ComplianceDossier {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  auditReport: {
    policy: { version: string; description?: string; failClosed: boolean } | null;
  };
  auditIntegrity: {
    chainVerification: AuditChainVerification;
  };
  rtbfEvidence: {
    totalOperations: number;
    totalRecordsErased: number;
    operations: RtbfEvidenceEntry[];
  };
  retentionPosture: {
    targets: RetentionTargetStatus[];
    policyRetentionRules: Array<{ dataClass: string; maxAgeDays: number }>;
  };
  evalEvidence: EvalEvidenceEntry[];
  securityPosture: {
    enabled: boolean;
    postureByFlow: Record<string, number>;
    recentRuns: RedTeamRunSummary[];
  };
  dlpEffectiveness?: {
    dataset: string;
    cases: number;
    overall: { recall: number; precision: number; f1: number; falseNegatives: number };
    byType: Array<{ type: string; recall: number; precision: number }>;
  };
  architecturalGuarantees: ArchitecturalGuarantee[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DossierPanel(): React.JSX.Element {
  const { token } = useAuth();
  const [dossier, setDossier] = useState<ComplianceDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadMarkdown = async (): Promise<void> => {
    if (!token) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadAuthenticated({
        url: backendUrl("/admin/compliance/dossier?format=markdown"),
        token,
        fallbackFilename: "compliance-dossier.md",
        accept: "text/markdown",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const fetchDossier = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await authFetch(
        backendUrl("/admin/compliance/dossier"),
        token,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setDossier((await resp.json()) as ComplianceDossier);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchDossier();
  }, [fetchDossier]);

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            📋 Compliance Dossier
          </h2>
          <p className="text-xs text-muted-foreground">
            Evidentiary document for an auditor — audit-chain integrity, RTBF
            proof, retention posture, eval and security-posture evidence.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchDossier()}
            disabled={loading}
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </Button>
          {token && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void downloadMarkdown()}
              disabled={downloading}
            >
              {downloading ? "Downloading…" : "↓ Download Markdown"}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {dossier && (
        <>
          <p className="text-xs text-muted-foreground">
            Generated {new Date(dossier.generatedAt).toLocaleString()} — window{" "}
            {new Date(dossier.windowStart).toLocaleDateString()} →{" "}
            {new Date(dossier.windowEnd).toLocaleDateString()}
          </p>

          {/* Audit chain integrity */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-1">
              Audit Trail Integrity
            </h3>
            {dossier.auditIntegrity.chainVerification.valid ? (
              <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                ✓ Verified — {dossier.auditIntegrity.chainVerification.checked} record(s)
                checked, hash chain intact from genesis.
              </div>
            ) : (
              <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                ✗ TAMPER DETECTED — broken at record #
                {dossier.auditIntegrity.chainVerification.brokenAt?.id} (
                {dossier.auditIntegrity.chainVerification.brokenAt?.reason})
              </div>
            )}
          </section>

          {/* RTBF evidence */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-1">
              Right-to-be-Forgotten Evidence
            </h3>
            <p className="text-xs text-muted-foreground mb-1">
              {dossier.rtbfEvidence.totalOperations} erasure operation(s),{" "}
              {dossier.rtbfEvidence.totalRecordsErased} record(s) erased in
              window.
            </p>
            {dossier.rtbfEvidence.operations.length > 0 && (
              <div className="rounded border border-border bg-card overflow-hidden">
                <Table>
                  <TableHead className="uppercase">
                    <TableRow>
                      <TableHeaderCell>Time</TableHeaderCell>
                      <TableHeaderCell>Actor</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                      <TableHeaderCell className="text-right">Erased</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {dossier.rtbfEvidence.operations.slice(0, 20).map((op, i) => (
                      <TableRow key={`${op.at}-${i}`}>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {new Date(op.at).toLocaleString()}
                        </TableCell>
                        <TableCell>{op.actor}</TableCell>
                        <TableCell className="font-mono">{op.action}</TableCell>
                        <TableCell className="text-right">{op.erased}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          {/* Retention posture */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-1">
              Retention Posture
            </h3>
            <div className="flex flex-wrap gap-2">
              {dossier.retentionPosture.targets.map((t) => (
                <span
                  key={t.name}
                  className="rounded border border-border bg-card px-2 py-1 text-xs"
                >
                  <span className="font-medium">{t.name}</span>:{" "}
                  {t.maxAgeDays !== null ? `${t.maxAgeDays}d` : "no window"}
                  {t.subjectErase && (
                    <span className="ml-1 text-green-600">RTBF-capable</span>
                  )}
                </span>
              ))}
            </div>
          </section>

          {/* Eval evidence */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-1">
              Model Quality (Eval Evidence)
            </h3>
            {dossier.evalEvidence.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No eval runs recorded. POST a report to /admin/eval/runs (e.g.
                from CI) to add evidence here.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {dossier.evalEvidence.map((e) => (
                  <div
                    key={e.dataset}
                    className="rounded border border-border bg-card px-3 py-2 text-xs flex items-center justify-between"
                  >
                    <span className="font-mono">{e.dataset}</span>
                    <span
                      className={
                        e.passRate >= 0.9 ? "text-green-600" : "text-amber-600"
                      }
                    >
                      {e.passed}/{e.total} passed ({(e.passRate * 100).toFixed(0)}%)
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(e.recordedAt).toLocaleDateString()} [{e.source}]
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Security posture */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-1">
              Security Posture
            </h3>
            {!dossier.securityPosture.enabled ? (
              <p className="text-xs text-muted-foreground">
                Red-team / security posture engine not enabled.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(dossier.securityPosture.postureByFlow).map(
                  ([flowId, score]) => (
                    <span
                      key={flowId}
                      className={`rounded px-2 py-1 text-xs border ${
                        score >= 0.7
                          ? "border-green-200 bg-green-50 text-green-700"
                          : "border-red-200 bg-red-50 text-red-700"
                      }`}
                    >
                      {flowId}: {(score * 100).toFixed(0)}%
                    </span>
                  ),
                )}
              </div>
            )}
          </section>

          {/* DLP effectiveness (measured PII detector recall) */}
          {dossier.dlpEffectiveness && (
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground mb-1">
                DLP Effectiveness (measured PII recall)
              </h3>
              <div className="rounded border border-border bg-card px-3 py-2 text-xs">
                <div className="mb-1">
                  Corpus{" "}
                  <span className="font-mono">{dossier.dlpEffectiveness.dataset}</span> (
                  {dossier.dlpEffectiveness.cases} cases):{" "}
                  <span
                    className={
                      dossier.dlpEffectiveness.overall.recall >= 0.9
                        ? "text-green-600"
                        : "text-amber-600"
                    }
                  >
                    recall {(dossier.dlpEffectiveness.overall.recall * 100).toFixed(1)}%
                  </span>
                  , precision{" "}
                  {(dossier.dlpEffectiveness.overall.precision * 100).toFixed(1)}% (
                  {dossier.dlpEffectiveness.overall.falseNegatives} miss(es))
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {dossier.dlpEffectiveness.byType.map((t) => (
                    <span
                      key={t.type}
                      className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {t.type}: {(t.recall * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Architectural guarantees */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-1">
              Architectural Guarantees
            </h3>
            <div className="flex flex-col gap-1.5">
              {dossier.architecturalGuarantees.map((g) => (
                <div
                  key={g.topic}
                  className="rounded border border-border bg-muted px-3 py-2 text-xs"
                >
                  <div className="font-medium text-foreground">
                    {g.topic}{" "}
                    <span className="text-muted-foreground font-mono text-[10px]">
                      ({g.reference})
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5">{g.summary}</p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
