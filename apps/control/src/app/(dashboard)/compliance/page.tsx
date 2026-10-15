"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /compliance — Policy-as-Code compliance dashboard.
 *
 * Admin actions (tasks #4 + #5):
 *   GET  /admin/compliance/status           — retention targets / capabilities
 *   POST /admin/compliance/sweep            — run retention sweep
 *   POST /admin/compliance/forget           — RTBF erase
 *   GET  /admin/compliance/audit-anchor     — anchor status
 *   POST /admin/compliance/audit-anchor     — create new anchor
 *   GET  /admin/compliance-policy           — policy summary
 *   POST /admin/compliance-policy/evaluate  — dry-run evaluate
 *   GET  /admin/compliance-policy/report    — 24-h audit report (existing)
 *   GET  /v1/me/data                        — DSAR info note
 */

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import { downloadAuthenticated } from "../../../lib/authenticated-download";
import { DossierPanel } from "../../../components/DossierPanel";
import { PolicyReplayPanel } from "../../../components/PolicyReplayPanel";
import { RoPAPanel } from "../../../components/RoPAPanel";
import {
  Button,
  Badge,
  Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell,
  useConfirm,
} from "../../../lib/ui";
import { formatDateTime, formatTime } from "../../../lib/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PolicySummary {
  version: string; description?: string; failClosed: boolean;
  dataRules: number; modelRules: number; approvalRules: number;
  retentionRules: number; auditRules: number;
}
interface ViolationSummary {
  total: number; denied: number; requireApproval: number;
  recent: Array<{ at: string; action: string; actor: string; target?: string; details?: Record<string, unknown> }>;
}
interface AuditReport {
  generatedAt: string; windowStart: string; windowEnd: string;
  policy: PolicySummary | null; violations: ViolationSummary;
  approvals: { total: number; approved: number; denied: number; timedOut: number };
  modelUsage: Array<{ provider: string; model: string; requests: number; tenants: string[] }>;
  retentionRules: Array<{ dataClass: string; maxAgeDays: number }>;
}
interface RetentionTarget { name: string; description?: string; capabilities?: Record<string, unknown> }
interface ComplianceStatus { targets: RetentionTarget[] }
interface SweepEntry { target: string; purged: number; error?: string }
interface ForgetEntry { target: string; erased: number; error?: string }
interface AuditAnchor {
  active: boolean; reason?: string;
  uptoId?: string; signature?: string; createdAt?: string; valid?: boolean;
}
interface PolicyConfig {
  enabled: boolean; version?: string; description?: string; failClosed?: boolean;
  rules?: { dataRules: number; modelRules: number; approvalRules: number; retentionRules: number; auditRules: number };
  policy?: unknown;
  message?: string;
}
interface PolicyViolation {
  rule: "data" | "model" | "approval" | "retention" | "audit";
  message: string;
  detail?: Record<string, unknown>;
  blocking?: boolean;
}
interface EvalResult {
  decision: "allow" | "deny" | "require-approval";
  violations: PolicyViolation[];
  policyAbsent: boolean;
}

/** Slug for labelling generated form fields (a11y: label htmlFor/id pairing). */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function StatCard({ label, value, color = "gray" }: { label: string; value: string | number; color?: "gray"|"green"|"red"|"blue"|"amber" }) {
  const cls = { gray:"text-foreground", green:"text-success", red:"text-danger", blue:"text-info", amber:"text-warning" }[color];
  return (
    <div className="rounded border border-border bg-card p-3 text-center">
      <div className={`text-xl font-bold ${cls}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RetentionActionsPanel — sweep + forget + status
// ---------------------------------------------------------------------------

function RetentionActionsPanel({ token }: { token: string | undefined }) {
  const { confirm: confirmDialog } = useConfirm();
  const [status, setStatus] = useState<ComplianceStatus | null>(null);
  const [sweepResult, setSweepResult] = useState<{ report: SweepEntry[]; purged: number } | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [forgetTenantId, setForgetTenantId] = useState("");
  const [forgetUserId, setForgetUserId] = useState("");
  const [forgetResult, setForgetResult] = useState<{ subject: Record<string, string>; report: ForgetEntry[]; erased: number } | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authFetch(backendUrl("/admin/compliance/status"), token)
      .then(r => r.ok ? r.json() as Promise<ComplianceStatus> : null)
      .then(d => d && setStatus(d));
  }, [token]);

  const runSweep = async () => {
    setSweeping(true); setError(null); setSweepResult(null);
    try {
      const r = await authFetch(backendUrl("/admin/compliance/sweep"), token, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSweepResult(await r.json() as { report: SweepEntry[]; purged: number });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSweeping(false); }
  };

  const runForget = async () => {
    const subject: Record<string, string> = {};
    if (forgetTenantId.trim()) subject["tenantId"] = forgetTenantId.trim();
    if (forgetUserId.trim()) subject["userId"] = forgetUserId.trim();
    if (!Object.keys(subject).length) { setError("Provide at least a tenantId or userId."); return; }
    setForgetting(true); setError(null); setForgetResult(null);
    try {
      const r = await authFetch(backendUrl("/admin/compliance/forget"), token, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subject),
      });
      if (!r.ok) {
        const d = await r.json() as { error?: { message?: string } };
        throw new Error(d.error?.message ?? `HTTP ${r.status}`);
      }
      setForgetResult(await r.json() as { subject: Record<string, string>; report: ForgetEntry[]; erased: number });
      setForgetTenantId(""); setForgetUserId("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setForgetting(false); }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-4">
      <h2 className="text-sm font-semibold text-foreground">
        Data Retention &amp; RTBF
      </h2>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {/* Retention targets */}
      {status && status.targets.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Configured targets ({status.targets.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {status.targets.map((t) => (
              <span
                key={t.name}
                className="rounded border border-border bg-muted px-2 py-0.5 text-xs font-mono"
              >
                {t.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Sweep */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Retention sweep
        </p>
        <p className="text-xs text-muted-foreground">
          Purge data older than its configured retention window across all
          targets.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Run retention sweep now?",
              message: "Every record older than its configured retention window is deleted permanently.",
              confirmLabel: "Run sweep",
              destructive: true,
            });
            if (ok) await runSweep();
          }}
          disabled={sweeping}
        >
          {sweeping ? "Running sweep…" : "Run sweep now"}
        </Button>
        {sweepResult && (
          <div className="rounded border border-success-border bg-success-soft p-3 text-sm text-success space-y-1">
            <p className="font-medium">
              Sweep complete — {sweepResult.purged} record(s) purged
            </p>
            {sweepResult.report.map((e) => (
              <p key={e.target} className="text-xs">
                {e.target}:{" "}
                {e.error ? (
                  <span className="text-danger">{e.error}</span>
                ) : (
                  `${e.purged} purged`
                )}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Forget (RTBF) */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Right to be forgotten (Art. 17 GDPR)
        </p>
        <p className="text-xs text-muted-foreground">
          Erase all data for a subject. Requires at least one of tenantId /
          userId.
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            {
              label: "Tenant ID",
              value: forgetTenantId,
              set: setForgetTenantId,
              placeholder: "tenant-uuid",
            },
            {
              label: "User ID / email",
              value: forgetUserId,
              set: setForgetUserId,
              placeholder: "user@example.com",
            },
          ].map(({ label, value, set, placeholder }) => (
            <div key={label}>
              <label
                htmlFor={`forget-${slugify(label)}`}
                className="block text-xs text-muted-foreground mb-1"
              >
                {label}
              </label>
              <input
                id={`forget-${slugify(label)}`}
                value={value}
                onChange={(e) => set(e.target.value)}
                placeholder={placeholder}
                className="rounded border border-border bg-background px-3 py-1.5 text-sm w-56 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          ))}
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={async () => {
            const who = [
              forgetTenantId.trim() !== "" ? `tenant "${forgetTenantId.trim()}"` : "",
              forgetUserId.trim() !== "" ? `user "${forgetUserId.trim()}"` : "",
            ]
              .filter(Boolean)
              .join(" / ");
            const ok = await confirmDialog({
              title: "Erase this subject?",
              message: `All data held for ${who} is erased in every store. This cannot be undone.`,
              confirmLabel: "Erase",
              destructive: true,
            });
            if (ok) await runForget();
          }}
          disabled={
            forgetting || (!forgetTenantId.trim() && !forgetUserId.trim())
          }
        >
          {forgetting ? "Erasing…" : "Erase subject data"}
        </Button>
        {forgetResult && (
          <div className="rounded border border-success-border bg-success-soft p-3 text-sm text-success space-y-1">
            <p className="font-medium">
              {forgetResult.erased} record(s) erased for{" "}
              {Object.entries(forgetResult.subject)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}
            </p>
            {forgetResult.report.map((e) => (
              <p key={e.target} className="text-xs">
                {e.target}:{" "}
                {e.error ? (
                  <span className="text-danger">{e.error}</span>
                ) : (
                  `${e.erased} erased`
                )}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AuditAnchorPanel
// ---------------------------------------------------------------------------

function AuditAnchorPanel({ token }: { token: string | undefined }) {
  const [anchor, setAnchor] = useState<AuditAnchor | null>(null);
  const [anchoring, setAnchoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnchor = useCallback(async () => {
    const r = await authFetch(backendUrl("/admin/compliance/audit-anchor"), token);
    if (r.ok) setAnchor(await r.json() as AuditAnchor);
  }, [token]);

  useEffect(() => { void fetchAnchor(); }, [fetchAnchor]);

  const createAnchor = async () => {
    setAnchoring(true); setError(null);
    try {
      const r = await authFetch(backendUrl("/admin/compliance/audit-anchor"), token, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { ok: boolean; anchor?: AuditAnchor; reason?: string };
      if (!d.ok) throw new Error(d.reason ?? "Anchor failed");
      await fetchAnchor();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setAnchoring(false); }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">Audit Chain Anchor</h2>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void fetchAnchor()}>↻ Check</Button>
          <Button variant="outline" size="sm" onClick={() => void createAnchor()} disabled={anchoring}>
            {anchoring ? "Anchoring…" : "Create anchor now"}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {anchor && !anchor.active && (
        <div className="rounded border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning">
          {anchor.reason ?? "Audit anchoring is not configured (set AUDIT_ANCHOR_SECRET)."}
        </div>
      )}
      {anchor?.active && (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={anchor.valid ? "success" : "destructive"}>
              {anchor.valid ? "chain valid" : "chain INVALID"}
            </Badge>
            {anchor.createdAt && (
              <span className="text-xs text-muted-foreground">
                Last anchor: {formatDateTime(anchor.createdAt)}
              </span>
            )}
          </div>
          {anchor.uptoId && (
            <p className="text-xs text-muted-foreground">
              Anchored up to audit entry <span className="font-mono">{anchor.uptoId}</span>
            </p>
          )}
          {anchor.signature && (
            <p className="text-xs text-muted-foreground font-mono break-all">sig: {anchor.signature.slice(0, 64)}…</p>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PolicySummaryPanel + EvaluatePanel (task #5)
// ---------------------------------------------------------------------------

function PolicySummaryPanel({ token }: { token: string | undefined }) {
  const [cfg, setCfg] = useState<PolicyConfig | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    void authFetch(backendUrl("/admin/compliance-policy"), token)
      .then(r => r.ok ? r.json() as Promise<PolicyConfig> : null)
      .then(d => d && setCfg(d))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading policy…</p>;
  if (!cfg) return null;

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-foreground">Policy Summary</h2>
      {!cfg.enabled ? (
        <div className="rounded border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning">
          {cfg.message ?? "No compliance-policy.yaml found. Create one in FLOWS_DIR to enable enforcement."}
        </div>
      ) : (
        <>
          <div className="rounded border border-success-border bg-success-soft px-3 py-2 text-sm text-success flex flex-wrap items-center gap-2">
            <span className="font-medium">✓ Policy active (v{cfg.version})</span>
            {cfg.failClosed && <Badge variant="destructive">fail-closed</Badge>}
            {cfg.description && <span className="text-success text-xs">{cfg.description}</span>}
          </div>
          {cfg.rules && (
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {Object.entries(cfg.rules).map(([k, v]) => (
                <span key={k} className="rounded border border-border bg-muted px-2 py-0.5">{v} {k.replace("Rules","").replace(/([A-Z])/g," $1").toLowerCase()} rules</span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EvaluatePanel({ token }: { token: string | undefined }) {
  const [action, setAction] = useState("chat.completion");
  const [tenantId, setTenantId] = useState("");
  const [model, setModel] = useState("");
  const [dataClass, setDataClass] = useState("");
  const [result, setResult] = useState<{ result: EvalResult; policyLoaded: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const evaluate = async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (action.trim()) body["toolIds"] = [action.trim()];
      if (tenantId.trim()) body["tenantId"] = tenantId.trim();
      if (model.trim()) {
        const separator = model.indexOf("/");
        if (separator <= 0 || separator === model.length - 1) throw new Error("Model must use provider/model format.");
        body["llmConfig"] = { provider: model.slice(0, separator), model: model.slice(separator + 1) };
      }
      if (dataClass.trim()) body["dataClasses"] = [dataClass.trim()];
      const r = await authFetch(backendUrl("/admin/compliance-policy/evaluate"), token, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setResult(await r.json() as { result: EvalResult; policyLoaded: boolean });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  };

  const decisionColor = result?.result.decision === "allow" ? "text-success"
    : result?.result.decision === "deny" ? "text-danger"
    : "text-warning";

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-foreground">
        Policy Dry-Run Evaluate
      </h2>
      <p className="text-xs text-muted-foreground">
        Test a request context against the loaded policy without executing
        anything.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: "Action *",
            value: action,
            set: setAction,
            placeholder: "chat.completion",
          },
          {
            label: "Tenant ID",
            value: tenantId,
            set: setTenantId,
            placeholder: "optional",
          },
          {
            label: "Model",
            value: model,
            set: setModel,
            placeholder: "openai/gpt-4o",
          },
          {
            label: "Data class",
            value: dataClass,
            set: setDataClass,
            placeholder: "personal",
          },
        ].map(({ label, value, set, placeholder }) => (
          <div key={label}>
            <label
              htmlFor={`policy-${slugify(label)}`}
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              {label}
            </label>
            <input
              id={`policy-${slugify(label)}`}
              value={value}
              onChange={(e) => set(e.target.value)}
              placeholder={placeholder}
              className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => void evaluate()}
        disabled={loading}
      >
        {loading ? "Evaluating…" : "Evaluate"}
      </Button>
      {result && (
        <div className="rounded border border-border bg-muted p-3 space-y-1 text-sm">
          <p>
            <span className="font-medium">Decision: </span>
            <span className={`font-bold uppercase ${decisionColor}`}>
              {result.result.decision}
            </span>
            {!result.policyLoaded && (
              <span className="ml-2 text-xs text-warning">
                (no policy loaded — default allow)
              </span>
            )}
          </p>
          {result.result.violations.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {result.result.violations.map((violation, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: violations have no unique id; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
                <li key={`${violation.rule}-${index}`}>
                  <span className="font-medium">{violation.rule}</span>:{" "}
                  {violation.message}
                  {violation.blocking === false && (
                    <span className="ml-1 text-warning">(advisory)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.result.policyAbsent && (
            <p className="text-xs text-warning">
              No policy was loaded; the simulator used the compatibility allow
              result.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// DSARInfoPanel — user-plane note for end-users
// ---------------------------------------------------------------------------

function DSARInfoPanel() {
  return (
    <section className="rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-foreground space-y-2">
      <h2 className="font-semibold text-foreground">Self-Service Data Access (DSAR — Art. 15 / Art. 17 GDPR)</h2>
      <p>
        Authenticated users can access or erase their own data via the API. These endpoints
        authenticate via the user&apos;s own JWT (not the operator token).
      </p>
      <div className="font-mono text-xs space-y-1">
        <p><span className="font-bold">GET</span>  /v1/me/data — export a summary of all data held for the calling identity</p>
        <p><span className="font-bold">DELETE</span> /v1/me/data — erase all data for the calling identity (right-to-be-forgotten)</p>
      </div>
      <p className="text-xs">The operator RTBF form above (Erase subject data) covers admin-initiated erasures.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main audit-report section (preserved from original)
// ---------------------------------------------------------------------------

function AuditReportSection({ token }: { token: string | undefined }) {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadCsv = async (): Promise<void> => {
    setDownloading(true);
    setError(null);
    try {
      await downloadAuthenticated({
        url: backendUrl("/admin/compliance-policy/report.csv"),
        token,
        fallbackFilename: "compliance-report.csv",
        accept: "text/csv",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const fetchReport = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await authFetch(backendUrl("/admin/compliance-policy/report"), token);
      if (!r.ok) {
        const d = await r.json() as { error?: { message?: string } };
        throw new Error(d.error?.message ?? `HTTP ${r.status}`);
      }
      setReport(await r.json() as AuditReport);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
    // The flagged "error" below is `d.error` (the API response's `.error`
    // property from the `as { error?: ... }` cast above), not the `error`
    // state. @babel/eslint-parser has no TypeScript type info, so
    // exhaustive-deps' scope analysis can't tell the cast's property name
    // apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { void fetchReport(); }, [fetchReport]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          Audit Report (last 24 h)
        </h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchReport()}
            disabled={loading}
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void downloadCsv()}
            disabled={downloading}
          >
            {downloading ? "Exporting…" : "↓ Export CSV"}
          </Button>
        </div>
      </div>
      {error && (
        <div className="rounded border border-danger-border bg-danger-soft px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      {report && (
        <>
          {!report.policy ? (
            <div className="rounded border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning">
              <strong>No policy loaded.</strong> Create{" "}
              <code className="font-mono">flows/compliance-policy.yaml</code> to
              enable enforcement.
            </div>
          ) : (
            <div className="rounded border border-success-border bg-success-soft px-4 py-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-success">
                <span>✓ Policy active (v{report.policy.version})</span>
                {report.policy.failClosed && (
                  <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-medium text-danger">
                    fail-closed
                  </span>
                )}
              </div>
              {report.policy.description && (
                <p className="text-success text-xs mt-1">
                  {report.policy.description}
                </p>
              )}
              <div className="flex flex-wrap gap-3 mt-2 text-xs text-success">
                {(
                  [
                    "dataRules",
                    "modelRules",
                    "approvalRules",
                    "retentionRules",
                    "auditRules",
                  ] as const
                ).map((k) => (
                  <span key={k}>
                    {report.policy?.[k]}{" "}
                    {k
                      .replace("Rules", "")
                      .replace(/([A-Z])/g, " $1")
                      .toLowerCase()}{" "}
                    rules
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label="Violations"
              value={report.violations.total}
              color={report.violations.total > 0 ? "red" : "green"}
            />
            <StatCard
              label="Denied"
              value={report.violations.denied}
              color={report.violations.denied > 0 ? "red" : "gray"}
            />
            <StatCard
              label="Required approval"
              value={report.violations.requireApproval}
              color="amber"
            />
            <StatCard
              label="Approvals"
              value={report.approvals.total}
              color="blue"
            />
          </div>
          {report.modelUsage.length > 0 && (
            <div className="rounded border border-border bg-card overflow-hidden">
              <Table>
                <TableHead className="uppercase">
                  <TableRow>
                    <TableHeaderCell>Provider / Model</TableHeaderCell>
                    <TableHeaderCell className="text-right">
                      Requests
                    </TableHeaderCell>
                    <TableHeaderCell>Tenants</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {report.modelUsage.map((m) => (
                    <TableRow key={`${m.provider}/${m.model}`}>
                      <TableCell className="font-mono text-xs">
                        {m.provider}/{m.model}
                      </TableCell>
                      <TableCell className="text-right">{m.requests}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {m.tenants.join(", ") || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {report.violations.recent.length > 0 && (
            <div className="rounded border border-border bg-card overflow-hidden">
              <Table>
                <TableHead className="uppercase">
                  <TableRow>
                    <TableHeaderCell>Time</TableHeaderCell>
                    <TableHeaderCell>Actor</TableHeaderCell>
                    <TableHeaderCell>Action</TableHeaderCell>
                    <TableHeaderCell>Target</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {report.violations.recent.map((v, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: recent-violation rows have no unique id; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
                    <TableRow key={i}>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {formatTime(v.at)}
                      </TableCell>
                      <TableCell>{v.actor}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {v.action}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {v.target ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CompliancePage() {
  const { token, ready, isAuthenticated } = useAuth();

  if (!ready || !isAuthenticated) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">
          Policy-as-Code Compliance
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Declarative data-residency, model, approval and retention policies.
          Last 24 hours.
        </p>
      </div>

      {/* Policy summary card */}
      <PolicySummaryPanel token={token} />

      {/* Evaluate dry-run */}
      <EvaluatePanel token={token} />

      {/* Policy replay simulator (Req 16, task 22.3) */}
      <PolicyReplayPanel token={token} />

      {/* Audit report */}
      <AuditReportSection token={token} />

      {/* Retention actions: sweep + forget */}
      <RetentionActionsPanel token={token} />

      {/* Audit anchor */}
      <AuditAnchorPanel token={token} />

      {/* DSAR info */}
      <DSARInfoPanel />

      <hr className="border-border" />
      <RoPAPanel />
      <hr className="border-border" />
      <DossierPanel />
    </div>
  );
}
