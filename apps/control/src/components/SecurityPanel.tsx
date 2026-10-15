"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useCanWrite } from "../lib/auth/useCanWrite";
import { useState } from "react";
import { Badge, Button } from "../lib/ui";
import { FlowPicker } from "./FlowPicker";
import type {
  RedTeamRunSummary,
  RedTeamRun,
  AttackInfo,
  PostureResponse,
  ToolAuthzPolicyView,
  McpServerInfo,
} from "../types/security";
import { formatDateTime } from "../lib/i18n";

export interface SecurityPanelProps {
  posture: PostureResponse | null;
  runs: RedTeamRunSummary[];
  attacks: AttackInfo[];
  toolAuthz: ToolAuthzPolicyView | null;
  mcp: McpServerInfo | null;
  redTeamEnabled: boolean;
  isLoading?: boolean;
  error?: string | null;
  isRunning?: boolean;
  flows: { id: string; name: string }[];
  onRun: (flowId: string) => void;
  onViewRun: (runId: string) => Promise<RedTeamRun | null>;
  /** Persist an edited tool-authz policy. Optional — omit to keep read-only. */
  onSaveToolAuthz?: (policy: {
    rules: ToolAuthzPolicyView["rules"];
    defaultAction: "allow" | "deny";
  }) => Promise<
    { ok: true; policy: ToolAuthzPolicyView } | { ok: false; error: string }
  >;
}

function scoreColor(score: number): string {
  if (score >= 0.9) return "text-success";
  if (score >= 0.7) return "text-warning";
  return "text-danger";
}

function scoreBg(score: number): string {
  if (score >= 0.9) return "bg-success-solid";
  if (score >= 0.7) return "bg-warning-solid";
  return "bg-danger-solid";
}

const CATEGORY_LABELS: Record<string, string> = {
  prompt_injection: "Prompt Injection",
  jailbreak: "Jailbreak",
  exfiltration: "Exfiltration",
  pii_extraction: "PII Extraction",
  tool_abuse: "Tool Abuse",
  encoding_evasion: "Encoding Evasion",
};

export function SecurityPanel(props: SecurityPanelProps): React.JSX.Element {
  const writeGate = useCanWrite("admin");
  const {
    posture,
    runs,
    attacks,
    toolAuthz,
    mcp,
    redTeamEnabled,
    error,
    isRunning,
    flows,
    onRun,
    onViewRun,
    onSaveToolAuthz,
  } = props;

  const [selectedFlow, setSelectedFlow] = useState<string>("");
  const [expandedRun, setExpandedRun] = useState<RedTeamRun | null>(null);
  const [section, setSection] = useState<
    "posture" | "attacks" | "authz" | "mcp"
  >("posture");

  // Tool-authz editor state.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startEditing = (): void => {
    const current = {
      defaultAction: toolAuthz?.defaultAction ?? "allow",
      rules: toolAuthz?.rules ?? [],
    };
    setDraft(JSON.stringify(current, null, 2));
    setSaveError(null);
    setEditing(true);
  };

  const handleSave = async (): Promise<void> => {
    if (onSaveToolAuthz === undefined) return;
    setSaving(true);
    setSaveError(null);
    let parsed: {
      rules: ToolAuthzPolicyView["rules"];
      defaultAction: "allow" | "deny";
    };
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setSaveError(
        `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      setSaving(false);
      return;
    }
    const result = await onSaveToolAuthz(parsed);
    setSaving(false);
    if (result.ok) {
      setEditing(false);
    } else {
      setSaveError(result.error);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">
          AI Security Posture
        </h2>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>

      {/* Sub-navigation — a segmented control. Content is rendered below by
          `section` state (not as ARIA tab panels), so plain buttons with
          `aria-current` are used rather than the tab/panel primitive. */}
      {/* biome-ignore lint/a11y/useSemanticElements: group of navigation buttons — <fieldset> is for form controls and would be wrong here */}
      <div
        role="group"
        aria-label="Security sections"
        className="flex flex-wrap gap-1 border-b border-border"
      >
        {(
          [
            ["posture", "Red-Team & Posture"],
            ["attacks", `Attack Library (${attacks.length})`],
            ["authz", "Tool Authorization"],
            ["mcp", "Flow-as-MCP"],
          ] as const
        ).map(([id, label]) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={active ? "page" : undefined}
              className={[
                "-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-accent text-accent"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* ── Posture & Red-Team ─────────────────────────────────────────────── */}
      {section === "posture" && (
        <div className="space-y-5">
          {!redTeamEnabled && (
            <div className="rounded-lg border border-dashed border-warning-border bg-warning-soft p-4 text-sm text-warning">
              The red-team engine is disabled. Set{" "}
              <code className="font-mono">RED_TEAM_ENABLED=true</code> to run
              adversarial tests, or configure{" "}
              <code className="font-mono">RED_TEAM_SCHEDULE_FLOWS</code> for
              automatic runs. The attack library, tool-authorization policy, and
              MCP views below remain available.
            </div>
          )}

          {/* Posture scores per flow */}
          {posture && Object.keys(posture.posture).length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(posture.posture).map(([flow, score]) => (
                <div
                  key={flow}
                  className="rounded-lg border border-border bg-card p-4 shadow-sm"
                >
                  <div
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={flow}
                  >
                    {flow}
                  </div>
                  <div
                    className={`mt-1 text-2xl font-bold tabular-nums ${scoreColor(score)}`}
                  >
                    {Math.round(score * 100)}
                    <span className="text-sm font-normal text-muted-foreground">
                      /100
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
                    <div
                      className={`h-1.5 rounded-full ${scoreBg(score)}`}
                      style={{ width: `${Math.round(score * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {posture && (
            <p className="text-xs text-muted-foreground">
              Current input-guardrail threshold:{" "}
              <span className="font-mono font-semibold">
                {posture.guardrailThreshold.toFixed(2)}
              </span>{" "}
              (lower = stricter; auto-tuned when RED_TEAM_AUTO_TUNE is on)
            </p>
          )}

          {/* Trigger a run */}
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4">
            <FlowPicker
              flows={flows}
              value={selectedFlow}
              onChange={setSelectedFlow}
              ariaLabel="Flow to red-team"
              placeholder="Select a flow…"
            />
            <Button
              variant="destructive"
              disabled={selectedFlow === "" || isRunning || !redTeamEnabled || !writeGate.allowed}
              title={writeGate.title}
              onClick={() => onRun(selectedFlow)}
            >
              {isRunning ? "Running attacks…" : "Run Red-Team"}
            </Button>
          </div>

          {/* Run history */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              Recent runs{" "}
              <span className="font-normal text-muted-foreground">({runs.length})</span>
            </h3>
            {runs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-card py-8 text-center text-sm text-muted-foreground">
                No red-team runs yet.
              </div>
            ) : (
              <div className="space-y-2">
                {runs.map((run) => (
                  <button type="button"
                    key={run.id}
                    onClick={() =>
                      void onViewRun(run.id).then((r) => setExpandedRun(r))
                    }
                    className="flex w-full items-center justify-between rounded-lg border border-border bg-card p-3 text-left shadow-sm hover:bg-muted"
                  >
                    <div className="min-w-0">
                      <span className="font-mono text-sm font-semibold text-foreground">
                        {run.flowId}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {run.triggeredBy} ·{" "}
                        {formatDateTime(run.startedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground">
                        {run.bypasses}/{run.trials} bypassed
                      </span>
                      {run.postureScore !== undefined && (
                        <span
                          className={`font-bold tabular-nums ${scoreColor(run.postureScore)}`}
                        >
                          {Math.round(run.postureScore * 100)}/100
                        </span>
                      )}
                      {run.regressionCasesGenerated !== undefined &&
                        run.regressionCasesGenerated > 0 && (
                          <span className="rounded bg-accent/20 px-1.5 py-0.5 text-accent">
                            +{run.regressionCasesGenerated} regression
                          </span>
                        )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Expanded run detail */}
          {expandedRun && (
            <div className="rounded-lg border border-border bg-card p-4 shadow">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">
                  Run detail ·{" "}
                  <span className="font-mono">{expandedRun.flowId}</span>
                </h4>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setExpandedRun(null)}
                >
                  Close
                </Button>
              </div>
              <div className="max-h-96 space-y-1.5 overflow-auto">
                {expandedRun.trials.map((t) => (
                  <div
                    key={t.id}
                    className={`rounded border p-2 text-xs ${
                      t.verdict === "bypassed"
                        ? "border-danger-border bg-danger-soft"
                        : t.verdict === "blocked"
                          ? "border-success-border bg-success-soft"
                          : "border-border bg-muted"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold">
                        {t.attackId}
                      </span>
                      <Badge
                        variant={
                          t.verdict === "bypassed"
                            ? "destructive"
                            : t.verdict === "blocked"
                              ? "success"
                              : "secondary"
                        }
                      >
                        {t.verdict}
                      </Badge>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {CATEGORY_LABELS[t.attackCategory] ?? t.attackCategory} ·
                      severity {t.severity.toFixed(2)}
                      {t.judgeScore !== undefined &&
                        ` · judge ${t.judgeScore.toFixed(2)}`}
                    </div>
                    {t.reasoning && (
                      <div className="mt-1 italic text-muted-foreground">
                        {t.reasoning}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Attack library ─────────────────────────────────────────────────── */}
      {section === "attacks" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            These are the adversarial payloads the red-team harness fires at
            your flows.
          </p>
          {attacks.map((a) => (
            <div
              key={a.id}
              className="rounded-lg border border-border bg-card p-3 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-semibold text-foreground">
                  {a.id}
                </span>
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {CATEGORY_LABELS[a.category] ?? a.category}
                  </span>
                  <span
                    className={`font-semibold ${a.severity >= 0.85 ? "text-danger" : "text-warning"}`}
                  >
                    sev {a.severity.toFixed(2)}
                  </span>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{a.description}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Tool Authorization ─────────────────────────────────────────────── */}
      {section === "authz" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Machine-enforced rules gating tool calls by tenant, role, and
              argument constraints. First matching rule wins; hot-reloaded on
              save.
            </p>
            {onSaveToolAuthz !== undefined && !editing && (
              <Button variant="primary" size="sm" onClick={startEditing} disabled={!writeGate.allowed} title={writeGate.title}>
                {toolAuthz?.active ? "Edit policy" : "Create policy"}
              </Button>
            )}
          </div>

          {editing ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Edit the policy JSON. Each rule needs{" "}
                <code className="font-mono">id</code>,{" "}
                <code className="font-mono">tool</code> (exact{" "}
                <code className="font-mono">server/tool</code> or glob{" "}
                <code className="font-mono">server/*</code>), and{" "}
                <code className="font-mono">action</code> (
                <code className="font-mono">allow</code>/
                <code className="font-mono">deny</code>). Optional:{" "}
                <code className="font-mono">match</code>,{" "}
                <code className="font-mono">constraints</code>,{" "}
                <code className="font-mono">reason</code>.
              </p>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="h-80 w-full rounded border border-border bg-muted p-3 font-mono text-xs text-success"
              />
              {saveError && (
                <div className="rounded border border-danger-border bg-danger-soft p-2 text-xs text-danger">
                  {saveError}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? "Saving…" : "Save & reload"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : toolAuthz === null || !toolAuthz.active ? (
            <div className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
              No tool-authorization policy is active. Add{" "}
              <code className="font-mono">flows/tool-authz.json</code> to gate
              tool calls by tenant, role, and argument constraints
              (hot-reloaded)
              {onSaveToolAuthz !== undefined
                ? ", or click “Create policy” above."
                : "."}
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {toolAuthz.ruleCount} rule(s) · default action:{" "}
                <span
                  className={`font-semibold ${
                    toolAuthz.defaultAction === "deny"
                      ? "text-danger"
                      : "text-success"
                  }`}
                >
                  {toolAuthz.defaultAction}
                </span>
              </p>
              {toolAuthz.rules.map((rule) => (
                <div
                  key={rule.id}
                  className="rounded-lg border border-border bg-card p-3 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {rule.id}
                    </span>
                    <Badge
                      variant={rule.action === "deny" ? "destructive" : "success"}
                    >
                      {rule.action}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    tool <span className="font-mono">{rule.tool}</span>
                    {rule.match && Object.keys(rule.match).length > 0 && (
                      <> · match {JSON.stringify(rule.match)}</>
                    )}
                    {rule.constraints &&
                      Object.keys(rule.constraints).length > 0 && (
                        <> · constraints {JSON.stringify(rule.constraints)}</>
                      )}
                  </div>
                  {rule.reason && (
                    <p className="mt-1 text-xs italic text-muted-foreground">
                      {rule.reason}
                    </p>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── Flow-as-MCP ────────────────────────────────────────────────────── */}
      {section === "mcp" && mcp && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <p className="text-sm text-foreground">
              Every published flow is callable as an MCP tool at:
            </p>
            <code className="mt-1 block rounded bg-muted px-3 py-2 font-mono text-sm text-success">
              POST {mcp.endpoint}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              Transport: {mcp.transport}. Authenticate with the same Bearer
              token as /v1/chat.
            </p>
          </div>
          <h3 className="text-sm font-semibold text-foreground">
            Exposed flow tools{" "}
            <span className="font-normal text-muted-foreground">
              ({mcp.flows.length})
            </span>
          </h3>
          {mcp.flows.map((f) => (
            <div
              key={f.id}
              className="rounded-lg border border-border bg-card p-3 shadow-sm"
            >
              <span className="font-mono text-sm font-semibold text-foreground">
                {f.id}
              </span>
              <p className="mt-0.5 text-xs text-muted-foreground">{f.description}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
