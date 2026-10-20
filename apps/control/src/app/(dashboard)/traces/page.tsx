"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /traces — interactive execution trace viewer (Req. 13.1)
 *
 * Combines two views in a single tab:
 *
 *   1. Step-by-Step Replay  — all NodeExecutionEvents of an execution in
 *      chronological order, navigable via Prev/Next or by direct selection.
 *      The active step shows the complete node I/O (prompt, response, tool
 *      calls, routing decision, RAG citations, errors). Tool calls behind an
 *      approval gate show an outcome badge (approved / denied / auto-closed),
 *      the reviewer and the wait time until the decision.
 *
 *   2. OTel Span Waterfall  — classic span visualisation for deployments with
 *      distributed tracing enabled.
 *
 * Data sources:
 *   - GET /monitoring/history/:executionId  → NodeExecutionEvent[]
 *   - GET /monitoring/approvals             → { pending, resolved } (filtered by executionId)
 *   - GET /api/traces/:executionId          → OTel spans (optional)
 */

import { useState, useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { canonicalJsonNull } from "@atf/canonical-json";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery } from "@tanstack/react-query";
import { json, request } from "../../../lib/control-api";
import { formatCost } from "../../../lib/currency";
import { Badge, Button, Tabs, TabsList, TabsTrigger } from "../../../lib/ui";
import type { BadgeVariant } from "../../../lib/ui";
import type { NodeExecutionEvent, NodeToolCall } from "../../../types/monitoring";
import type { PendingApproval, ResolvedApproval } from "../../../types/control";
import { translate, formatTime } from "../../../lib/i18n";

// Heavy detail panel — loaded client-side only.
const ExplainCard = dynamic(
  () => import("../../../components/ExplainCard").then((m) => m.ExplainCard),
  { ssr: false },
);

// Decision receipts (Req 15.7) — client-side COSE/Merkle verification.
const ReceiptsPanel = dynamic(
  () =>
    import("../../../components/ReceiptsPanel").then((m) => m.ReceiptsPanel),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OtelSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime: number;
  status: "ok" | "error" | "unset";
  attributes?: Record<string, string | number | boolean>;
}

interface OtelTracesResponse {
  executionId: string;
  spans: OtelSpan[];
}

type TabId = "steps" | "waterfall" | "explain" | "receipts";

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

// Req 9.2: all data queries go through lib/control-api; direct
// fetch calls are no longer allowed here.
async function fetchNodeEvents(executionId: string, token: string | undefined): Promise<NodeExecutionEvent[]> {
  const data = await json<{ events?: NodeExecutionEvent[] }>(
    `/monitoring/history/${encodeURIComponent(executionId)}`,
    { target: "backend", token },
  );
  return data.events ?? [];
}

async function fetchOtelSpans(executionId: string, token: string | undefined): Promise<OtelTracesResponse> {
  return json<OtelTracesResponse>(`/api/traces/${encodeURIComponent(executionId)}`, {
    token,
  });
}

interface ApprovalsResponse {
  pending: PendingApproval[];
  resolved: ResolvedApproval[];
}

async function fetchApprovals(token: string | undefined): Promise<ApprovalsResponse> {
  // Approvals endpoint may not be configured — degrade silently (only on an
  // HTTP error status; network errors stay visible as before).
  const resp = await request("/monitoring/approvals", { target: "backend", token });
  if (!resp.ok) return { pending: [], resolved: [] };
  return (await resp.json()) as ApprovalsResponse;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: NodeExecutionEvent["status"] }) {
  const variant: BadgeVariant =
    status === "running"
      ? "warning"
      : status === "error"
        ? "destructive"
        : "success";
  return <Badge variant={variant}>{status}</Badge>;
}

// ---------------------------------------------------------------------------
// Approval outcome badge
// ---------------------------------------------------------------------------

/**
 * Formats a duration in milliseconds as a human-readable wait string.
 * < 1 s  → "NNN ms"
 * < 60 s → "N.N s"
 * ≥ 60 s → "N m N s"
 */
function formatWait(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const min = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${min} m ${sec} s`;
}

interface ApprovalOutcomeBadgeProps {
  /** The resolved decision for this tool call, or undefined if none. */
  resolved: ResolvedApproval | undefined;
  /** A still-pending approval for this tool call (shown when resolved is absent). */
  pending: PendingApproval | undefined;
}

/**
 * Shows the approval outcome inline next to a tool call.
 * Four states:
 *   approved   — green badge, reviewer name if known, wait time
 *   denied     — red badge, reviewer name if known, wait time
 *   auto-close — amber badge (timedOut=true), wait time to timeout
 *   pending    — blue pulsing badge (should be rare in a completed trace)
 */
function ApprovalOutcomeBadge({ resolved, pending }: ApprovalOutcomeBadgeProps) {
  if (resolved === undefined && pending === undefined) return null;

  if (resolved !== undefined) {
    const waitMs =
      resolved.requestedAt !== undefined
        ? new Date(resolved.decidedAt).getTime() -
          new Date(resolved.requestedAt).getTime()
        : null;

    if (resolved.timedOut) {
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">
            {translate("traces.autoClosed")}
          </span>
          {waitMs !== null && waitMs >= 0 && (
            <span
              className="text-[11px] text-muted-foreground"
              title={translate("traces.timeUntilTimeoutAutoDeny")}
            >
              after {formatWait(waitMs)}
            </span>
          )}
        </span>
      );
    }

    if (resolved.approved) {
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success">
            {translate("traces.approved")}
          </span>
          {resolved.by !== undefined && (
            <span className="text-[11px] text-muted-foreground">
              by {resolved.by}
            </span>
          )}
          {waitMs !== null && waitMs >= 0 && (
            <span
              className="text-[11px] text-muted-foreground"
              title={translate("traces.timeFromRequestToDecision")}
            >
              in {formatWait(waitMs)}
            </span>
          )}
        </span>
      );
    }

    // denied
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">
          {translate("traces.denied")}
        </span>
        {resolved.by !== undefined && (
          <span className="text-[11px] text-muted-foreground">
            by {resolved.by}
          </span>
        )}
        {waitMs !== null && waitMs >= 0 && (
          <span
            className="text-[11px] text-muted-foreground"
            title={translate("traces.timeFromRequestToDecision")}
          >
            in {formatWait(waitMs)}
          </span>
        )}
      </span>
    );
  }

  // Still pending (unlikely in a completed trace, but possible for in-flight ones)
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-[11px] font-semibold text-accent animate-pulse">
      {translate("traces.awaitingApproval")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Node I/O Detail Panel
// ---------------------------------------------------------------------------

/**
 * A single approval bound to a node, normalised over pending + resolved so the
 * UI can treat both uniformly. Exactly one of `resolved`/`pending` is set.
 */
interface NodeApproval {
  id: string;
  tool?: string;
  args?: Record<string, unknown>;
  resolved?: ResolvedApproval;
  pending?: PendingApproval;
}

/**
 * Deterministic JSON stringify (keys sorted) for stable args comparison.
 * `@atf/canonical-json` concat mode (code-unit order, `undefined` as `null`)
 * — byte-identical to the former local helper; UI-only, but sharing the
 * package keeps the display consistent with the hashes the server computes.
 */
const stableStringify = canonicalJsonNull;

function parseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    return undefined;
  }
}

/**
 * Matches an approval's tool reference against a tool_call name. The monitoring
 * layer names tool calls "server__tool" (double underscore) while the approval
 * gate stores the MCP ref "server/tool" (or a bare name). We normalise both.
 */
function toolMatches(approvalTool: string | undefined, toolCallName: string): boolean {
  if (approvalTool === undefined) return false;
  const bare = toolCallName.replace(/__/g, "/");
  return (
    approvalTool === toolCallName ||
    approvalTool === bare ||
    approvalTool.endsWith(`/${bare}`) ||
    approvalTool.endsWith(`/${toolCallName}`)
  );
}

/**
 * Collects every approval (pending + resolved) that belongs to a node, in a
 * uniform shape. Resolved records whose `nodeId` is absent still count when
 * they share the execution (a non-owning replica may omit nodeId). Deduped by
 * approval id.
 */
function collectNodeApprovals(
  nodeId: string,
  executionId: string,
  resolvedApprovals: ResolvedApproval[],
  pendingApprovals: PendingApproval[],
): NodeApproval[] {
  const out: NodeApproval[] = [];
  const seen = new Set<string>();
  for (const r of resolvedApprovals) {
    if (r.executionId !== executionId) continue;
    if (r.nodeId !== undefined && r.nodeId !== nodeId) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, tool: r.tool, args: r.args, resolved: r });
  }
  for (const p of pendingApprovals) {
    if (p.executionId !== executionId || p.nodeId !== nodeId) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, tool: p.tool, args: p.args, pending: p });
  }
  return out;
}

/**
 * Maps each tool_call to at most one distinct approval, consuming matches so N
 * calls to the same tool bind to N different approvals (not all to the first).
 * Preference order per call: exact args match → any remaining same-tool match.
 * Returns a map keyed by tool_call id, plus the approvals left unmatched (e.g.
 * DENIED calls that never executed and therefore have no tool_call row).
 */
function mapToolCallApprovals(
  toolCalls: NodeToolCall[],
  nodeApprovals: NodeApproval[],
): { byToolCall: Map<string, NodeApproval>; unmatched: NodeApproval[] } {
  const consumed = new Set<string>();
  const byToolCall = new Map<string, NodeApproval>();

  for (const tc of toolCalls) {
    const tcArgsKey = stableStringify(parseArgs(tc.args_json));
    // 1. Same tool AND identical args — the precise, unambiguous match.
    let match = nodeApprovals.find(
      (a) =>
        !consumed.has(a.id) &&
        toolMatches(a.tool, tc.name) &&
        a.args !== undefined &&
        stableStringify(a.args) === tcArgsKey,
    );
    // 2. Fall back to any remaining approval for the same tool.
    if (match === undefined) {
      match = nodeApprovals.find(
        (a) => !consumed.has(a.id) && toolMatches(a.tool, tc.name),
      );
    }
    if (match !== undefined) {
      consumed.add(match.id);
      byToolCall.set(tc.id, match);
    }
  }

  const unmatched = nodeApprovals.filter((a) => !consumed.has(a.id));
  return { byToolCall, unmatched };
}

interface NodeIOPanelProps {
  event: NodeExecutionEvent;
  resolvedApprovals: ResolvedApproval[];
  pendingApprovals: PendingApproval[];
}

function NodeIOPanel({ event, resolvedApprovals, pendingApprovals }: NodeIOPanelProps) {
  const [expandPrompt, setExpandPrompt] = useState(false);
  const [expandResponse, setExpandResponse] = useState(false);

  // All approvals bound to this node (approved, denied, auto-closed, pending).
  const nodeApprovals = useMemo(
    () =>
      collectNodeApprovals(
        event.node_id,
        event.execution_id,
        resolvedApprovals,
        pendingApprovals,
      ),
    [resolvedApprovals, pendingApprovals, event.execution_id, event.node_id],
  );

  // Distinct approval per tool_call (consuming, so N same-tool calls bind to N
  // different approvals). Approvals with no matching call — e.g. denied ones
  // that never executed — still surface in the summary banner above.
  const { byToolCall } = useMemo(
    () => mapToolCallApprovals(event.tool_calls ?? [], nodeApprovals),
    [event.tool_calls, nodeApprovals],
  );

  const sections: Array<{ label: string; content: string; expandable?: boolean; expanded?: boolean; toggle?: () => void }> = [];
  if (event.prompt) {
    sections.push({
      label: translate("traces.systemPromptInput"),
      content: event.prompt,
      expandable: true,
      expanded: expandPrompt,
      toggle: () => setExpandPrompt((p) => !p),
    });
  }
  if (event.response) {
    sections.push({
      label: translate("traces.modelResponse"),
      content: event.response,
      expandable: true,
      expanded: expandResponse,
      toggle: () => setExpandResponse((p) => !p),
    });
  }
  if (event.error_message) {
    sections.push({ label: translate("traces.error"), content: event.error_message });
  }

  return (
    <div className="mt-4 space-y-3">
      {/* Metadata row */}
      <div className="flex flex-wrap gap-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        {event.model && (
          <span>
            <span className="font-medium text-muted-foreground">model</span>{" "}
            {event.model}
          </span>
        )}
        {event.latency_ms != null && (
          <span>
            <span className="font-medium text-muted-foreground">latency</span>{" "}
            {event.latency_ms} ms
          </span>
        )}
        {event.input_tokens != null && (
          <span>
            <span className="font-medium text-muted-foreground">in-tokens</span>{" "}
            {event.input_tokens}
          </span>
        )}
        {event.output_tokens != null && (
          <span>
            <span className="font-medium text-muted-foreground">
              out-tokens
            </span>{" "}
            {event.output_tokens}
          </span>
        )}
        {event.cost != null && event.cost > 0 && (
          <span>
            <span className="font-medium text-muted-foreground">cost</span>{" "}
            {formatCost(event.cost)}
          </span>
        )}
        {event.sequence != null && (
          <span>
            <span className="font-medium text-muted-foreground">seq</span>{" "}
            {event.sequence}
          </span>
        )}
      </div>

      {/* ── Node-level approval summary banner ──────────────────────────── */}
      {nodeApprovals.length > 0 && (
        <div className="rounded-md border border-accent/20 bg-accent/5 px-3 py-2">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
            {translate("traces.approvalsLength", { length: nodeApprovals.length })}
          </div>
          <div className="space-y-1.5">
            {nodeApprovals.map((a) => {
              const { resolved, pending } = a;
              const tool = a.tool ?? "unknown tool";
              // Strip server prefix for display: "crm/cancel_booking" → "cancel_booking"
              const displayTool = tool.includes("/")
                ? tool.split("/").slice(1).join("/")
                : tool;
              const requestedAt = resolved?.requestedAt ?? pending?.requestedAt;
              const waitMs =
                resolved?.requestedAt !== undefined
                  ? new Date(resolved.decidedAt).getTime() -
                    new Date(resolved.requestedAt).getTime()
                  : null;
              // Compact args preview (single line) so identical-tool approvals
              // are distinguishable (e.g. different booking_id).
              const argsKeys = a.args ? Object.keys(a.args) : [];
              const argsPreview =
                argsKeys.length > 0
                  ? argsKeys
                      .map((k) => `${k}: ${JSON.stringify(a.args![k])}`)
                      .join(", ")
                  : null;
              // A denied/auto-closed approval means the tool never ran → no row.
              const neverExecuted =
                resolved !== undefined && !resolved.approved;

              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span className="font-mono text-accent">{displayTool}</span>
                  {argsPreview && (
                    <span
                      className="max-w-[240px] truncate font-mono text-[11px] text-muted-foreground"
                      title={argsPreview}
                    >
                      {argsPreview}
                    </span>
                  )}
                  <ApprovalOutcomeBadge resolved={resolved} pending={pending} />
                  {neverExecuted && (
                    <span className="text-[11px] italic text-muted-foreground">
                      {translate("traces.toolNotExecuted")}
                    </span>
                  )}
                  {requestedAt && (
                    <span
                      className="text-[11px] text-muted-foreground"
                      title={translate("traces.whenApprovalWasRequested")}
                    >
                      requested {formatTime(requestedAt)}
                    </span>
                  )}
                  {waitMs !== null && waitMs >= 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {translate("traces.waitValue", { value: formatWait(waitMs) })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Prompt / Response */}
      {sections.map((sec) => (
        <div
          key={sec.label}
          className="rounded-md border border-border bg-card"
        >
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-muted-foreground hover:bg-muted"
            onClick={sec.toggle}
            aria-expanded={sec.expandable ? sec.expanded : undefined}
            aria-label={translate("traces.toggleLabel", { label: sec.label })}
          >
            <span>{sec.label}</span>
            {sec.expandable && (
              <span className="text-muted-foreground">
                {sec.expanded ? "▲" : "▼"}
              </span>
            )}
          </button>
          {(!sec.expandable || sec.expanded) && (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-xs text-foreground">
              {sec.content}
            </pre>
          )}
        </div>
      ))}

      {/* Tool calls */}
      {event.tool_calls && event.tool_calls.length > 0 && (
        <div className="rounded-md border border-accent/20 bg-card">
          <div className="border-b border-accent/20 px-3 py-2 text-xs font-semibold text-accent">
            {translate("traces.toolCallsLength", { length: event.tool_calls.length })}
          </div>
          <div className="divide-y divide-border">
            {event.tool_calls.map((tc: NodeToolCall) => {
              const match = byToolCall.get(tc.id);
              const resolved = match?.resolved;
              const pending = match?.pending;
              const hasApproval = match !== undefined;
              return (
                <div
                  key={tc.id}
                  className={`px-3 py-2 ${hasApproval ? "bg-accent/5" : ""}`}
                >
                  {/* Tool name row + exec time + approval badge */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium text-accent">
                      {tc.name}
                    </span>
                    {tc.exec_time_seconds != null && (
                      <span className="text-xs text-muted-foreground">
                        {(tc.exec_time_seconds * 1000).toFixed(0)} ms
                      </span>
                    )}
                    {/* Approval outcome inline */}
                    <ApprovalOutcomeBadge
                      resolved={resolved}
                      pending={pending}
                    />
                  </div>
                  {/* Args */}
                  <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                    {tc.args_json}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Routing decision */}
      {event.routing_decision && (
        <div className="rounded-md border border-warning-border bg-card">
          <div className="border-b border-warning-border px-3 py-2 text-xs font-semibold text-warning">
            {translate("traces.routingDecision")} {event.routing_decision.target ?? "end"}
          </div>
          <div className="divide-y divide-border">
            {event.routing_decision.candidates?.map((c, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: routing candidates have no unique id; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
                key={i}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs ${c.matched ? "bg-warning-soft" : ""}`}
              >
                <span
                  className={`w-4 ${c.matched ? "text-success" : "text-muted-foreground"}`}
                >
                  {c.matched ? "✓" : "○"}
                </span>
                <span className="font-mono text-foreground">{c.target}</span>
                {c.condition && (
                  <span className="text-muted-foreground">{c.condition}</span>
                )}
                {c.label && (
                  <span className="italic text-muted-foreground">
                    {c.label}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step Navigator
// ---------------------------------------------------------------------------

function StepNavigator({
  events,
  activeIdx,
  onSelect,
  resolvedApprovals,
  pendingApprovals,
}: {
  events: NodeExecutionEvent[];
  activeIdx: number;
  onSelect: (i: number) => void;
  resolvedApprovals: ResolvedApproval[];
  pendingApprovals: PendingApproval[];
}) {
  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto pr-1" style={{ maxHeight: "calc(100vh - 280px)" }}>
      {events.map((e, i) => {
        const isActive = i === activeIdx;
        const dot =
          e.status === "running"
            ? "bg-warning-solid"
            : e.status === "error"
              ? "bg-danger-solid"
              : "bg-success-solid";

        // Check whether this node had any approval activity.
        const nodeResolved = resolvedApprovals.filter(
          (r) => r.executionId === e.execution_id && r.nodeId === e.node_id,
        );
        const nodePending = pendingApprovals.filter(
          (p) => p.executionId === e.execution_id && p.nodeId === e.node_id,
        );
        const approvalCount = nodeResolved.length + nodePending.length;
        const anyDenied = nodeResolved.some((r) => !r.approved);
        const anyApproved = nodeResolved.some((r) => r.approved);
        const anyPending = nodePending.length > 0;
        const approvalDot = anyPending
          ? "bg-info-solid"
          : anyDenied
            ? "bg-danger-solid"
            : anyApproved
              ? "bg-success-solid"
              : null;

        return (
          <button
            type="button"
            // biome-ignore lint/suspicious/noArrayIndexKey: a node can execute several times per trace, so execution id + node id alone are not unique
            key={`${e.execution_id}-${e.node_id}-${i}`}
            onClick={() => onSelect(i)}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              isActive
                ? "bg-accent/10 text-accent font-medium"
                : "text-muted-foreground hover:bg-muted"
            }`}
            aria-current={isActive ? "step" : undefined}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className="truncate">{e.label ?? e.node_id}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* Approval indicator dot */}
              {approvalDot !== null && (
                <span
                  role="img"
                  className={`h-1.5 w-1.5 rounded-full ${approvalDot}`}
                  title={`${approvalCount} approval${approvalCount !== 1 ? "s" : ""}`}
                  aria-label={`${approvalCount} approval${approvalCount !== 1 ? "s" : ""}`}
                />
              )}
              {e.latency_ms != null && (
                <span className="text-muted-foreground">{e.latency_ms} ms</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OTel Span Waterfall (unchanged from original, now a sub-view)
// ---------------------------------------------------------------------------

function SpanBar({
  span,
  minTime,
  totalDuration,
}: {
  span: OtelSpan;
  minTime: number;
  totalDuration: number;
}) {
  const left = totalDuration > 0 ? ((span.startTime - minTime) / totalDuration) * 100 : 0;
  const width = totalDuration > 0 ? ((span.endTime - span.startTime) / totalDuration) * 100 : 2;
  const color = span.status === "error" ? "bg-danger-solid" : "bg-info-solid";
  const durationMs = span.endTime - span.startTime;
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <div className="w-48 shrink-0 truncate text-foreground" title={span.name}>
        {span.parentSpanId && <span className="mr-1 text-muted-foreground">↳</span>}
        {span.name}
      </div>
      <div className="relative h-5 flex-1 rounded bg-muted">
        <div
          className={`absolute h-full rounded ${color} opacity-80`}
          style={{ left: `${left}%`, width: `${Math.max(width, 1)}%` }}
          title={`${durationMs} ms`}
        />
      </div>
      <div className="w-20 shrink-0 text-right text-xs text-muted-foreground">{durationMs} ms</div>
      <div className={`w-14 shrink-0 rounded px-1 py-0.5 text-center text-xs font-medium ${span.status === "error" ? "bg-danger-soft text-danger" : "bg-success-soft text-success"}`}>
        {span.status}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function TracesPage() {
  const { token, ready, isAuthenticated } = useAuth();
  const [executionId, setExecutionId] = useState("");
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("steps");
  const [activeStep, setActiveStep] = useState(0);

  // Deep link: /traces?execution=<id>[&tab=steps|waterfall|explain] — the
  // History page's Trace button (and external tools) open one run directly,
  // optionally on a specific tab. Applied once on mount, mirroring the Live
  // Graph's one-shot ?execution= handling; afterwards the lookup bar is the
  // operator's to control.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const linkedTab = params.get("tab");
    if (
      linkedTab === "steps" ||
      linkedTab === "waterfall" ||
      linkedTab === "explain" ||
      linkedTab === "receipts"
    ) {
      setTab(linkedTab);
    }
    const linked = params.get("execution")?.trim();
    if (linked !== undefined && linked !== "") {
      setExecutionId(linked);
      setSubmittedId(linked);
      setActiveStep(0);
    }
  }, []);

  // ── Fetch node events (Step-by-Step view) ────────────────────────────────
  const {
    data: nodeEvents,
    isLoading: loadingEvents,
    error: eventsError,
  } = useQuery<NodeExecutionEvent[], Error>({
    queryKey: ["trace-events", submittedId],
    queryFn: () => fetchNodeEvents(submittedId!, token),
    enabled: !!submittedId && ready && isAuthenticated,
  });

  // ── Fetch approvals (filtered to this execution client-side) ─────────────
  const { data: approvalsData } = useQuery<ApprovalsResponse, Error>({
    queryKey: ["trace-approvals", submittedId],
    queryFn: () => fetchApprovals(token),
    enabled: !!submittedId && ready && isAuthenticated,
    // Approvals are ephemeral — stale after 30 s but kept in cache so switching
    // tabs doesn't refetch while the user is still reviewing the same execution.
    staleTime: 30_000,
  });

  const resolvedApprovals = useMemo(
    () =>
      (approvalsData?.resolved ?? []).filter(
        (r) => r.executionId === submittedId,
      ),
    [approvalsData, submittedId],
  );
  const pendingApprovals = useMemo(
    () =>
      (approvalsData?.pending ?? []).filter(
        (p) => p.executionId === submittedId,
      ),
    [approvalsData, submittedId],
  );

  // ── Fetch OTel spans (Waterfall view) ────────────────────────────────────
  const {
    data: otelData,
    isLoading: loadingSpans,
    error: spansError,
  } = useQuery<OtelTracesResponse, Error>({
    queryKey: ["traces", submittedId],
    queryFn: () => fetchOtelSpans(submittedId!, token),
    enabled: !!submittedId && ready && isAuthenticated && tab === "waterfall",
    retry: false, // OTel may not be configured — fail silently
  });

  // Sort events chronologically
  const sortedEvents = useMemo(
    () =>
      [...(nodeEvents ?? [])].sort((a, b) => {
        const seqDiff = (a.sequence ?? 0) - (b.sequence ?? 0);
        if (seqDiff !== 0) return seqDiff;
        return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
      }),
    [nodeEvents],
  );

  const activeEvent = sortedEvents[activeStep] ?? null;

  const handleSubmit = useCallback(() => {
    const id = executionId.trim();
    if (!id) return;
    setSubmittedId(id);
    setActiveStep(0);
  }, [executionId]);

  const otelSpans = otelData?.spans ?? [];
  const minTime = otelSpans.length ? Math.min(...otelSpans.map((s) => s.startTime)) : 0;
  const maxTime = otelSpans.length ? Math.max(...otelSpans.map((s) => s.endTime)) : 0;
  const totalDuration = maxTime - minTime;
  const sortedSpans = [...otelSpans].sort((a, b) => {
    if (!a.parentSpanId && b.parentSpanId) return -1;
    if (a.parentSpanId && !b.parentSpanId) return 1;
    return a.startTime - b.startTime;
  });

  return (
    <div className="flex h-full flex-col p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        {translate("traces.executionTraceViewer")}
      </h1>

      {/* Lookup bar */}
      <div className="mb-4 flex gap-2">
        <input
          type="text"
          value={executionId}
          onChange={(e) => setExecutionId(e.target.value)}
          placeholder={translate("traces.executionID")}
          className="flex-1 rounded-md border border-border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          aria-label={translate("traces.executionID2")}
        />
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!executionId.trim()}
        >
          {translate("traces.load")}
        </Button>
      </div>

      {/* Tabs */}
      {submittedId && (
        <Tabs
          className="mb-4"
          value={tab}
          onValueChange={(v) => setTab(v as TabId)}
        >
          <TabsList>
            {(["steps", "waterfall", "explain", "receipts"] as TabId[]).map(
              (t) => (
                <TabsTrigger key={t} value={t}>
                  {t === "steps"
                    ? translate("traces.stepByStep")
                    : t === "waterfall"
                      ? translate("traces.spanWaterfall")
                      : t === "explain"
                        ? translate("traces.explain")
                        : translate("traces.receipts")}
                </TabsTrigger>
              ),
            )}
          </TabsList>
        </Tabs>
      )}

      {/* Idle state */}
      {!submittedId && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          {translate("traces.enterAnExecutionIDTo")}
          <div className="mt-2 text-xs text-muted-foreground">
            {translate("traces.findExecutionIDsInThe")}
          </div>
        </div>
      )}

      {/* Loading */}
      {(loadingEvents || loadingSpans) && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {translate("traces.loadingTrace")}
        </div>
      )}

      {/* ── Step-by-Step View ─────────────────────────────────────────── */}
      {tab === "steps" && submittedId && !loadingEvents && (
        <>
          {eventsError && (
            <div
              role="alert"
              className="rounded-md bg-danger-soft p-3 text-sm text-danger"
            >
              {translate("traces.failedToLoadEventsMessage", { message: eventsError.message })}
            </div>
          )}

          {!eventsError && sortedEvents.length === 0 && (
            <div className="rounded-lg border border-border bg-card py-10 text-center text-sm text-muted-foreground">
              {translate("traces.noEventsFoundForThis")}
            </div>
          )}

          {sortedEvents.length > 0 && (
            <div className="flex flex-1 flex-col gap-4 overflow-hidden lg:flex-row">
              {/* Step list (left panel) */}
              <div className="w-full shrink-0 rounded-lg border border-border bg-card p-2 lg:w-56">
                <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
                  {sortedEvents.length} step
                  {sortedEvents.length !== 1 ? "s" : ""}
                </div>
                <StepNavigator
                  events={sortedEvents}
                  activeIdx={activeStep}
                  onSelect={setActiveStep}
                  resolvedApprovals={resolvedApprovals}
                  pendingApprovals={pendingApprovals}
                />
              </div>

              {/* Detail panel (right) */}
              <div className="flex flex-1 flex-col overflow-y-auto rounded-lg border border-border bg-card p-4">
                {activeEvent && (
                  <>
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="font-semibold text-foreground">
                          {activeEvent.label ?? activeEvent.node_id}
                        </h2>
                        <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {activeEvent.node_id}
                          {activeEvent.kind === "tool" && translate("traces.tool")}
                        </div>
                      </div>
                      <StatusBadge status={activeEvent.status} />
                    </div>

                    {/* Timestamps */}
                    <div className="mt-1 text-xs text-muted-foreground">
                      {activeEvent.start_time}
                      {activeEvent.end_time && ` → ${activeEvent.end_time}`}
                    </div>

                    {/* I/O */}
                    <NodeIOPanel
                      event={activeEvent}
                      resolvedApprovals={resolvedApprovals}
                      pendingApprovals={pendingApprovals}
                    />

                    {/* Step navigation buttons */}
                    <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
                        disabled={activeStep === 0}
                        aria-label={translate("traces.previousStep")}
                      >
                        {translate("traces.prev")}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {activeStep + 1} / {sortedEvents.length}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setActiveStep((s) =>
                            Math.min(sortedEvents.length - 1, s + 1),
                          )
                        }
                        disabled={activeStep === sortedEvents.length - 1}
                        aria-label={translate("traces.nextStep")}
                      >
                        {translate("traces.next")}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── OTel Span Waterfall ───────────────────────────────────────── */}
      {tab === "waterfall" && submittedId && !loadingSpans && (
        <>
          {spansError && (
            <div
              role="alert"
              className="rounded-md bg-warning-soft p-3 text-sm text-warning"
            >
              {translate("traces.oTelSpansUnavailableMessage", { message: spansError.message })}
              <span className="ml-1 text-warning">
                {translate("traces.ensureTRACINGENABLEDTrueAnd")}
              </span>
            </div>
          )}
          {!spansError && sortedSpans.length === 0 && (
            <div className="rounded-lg border border-border bg-card py-10 text-center text-sm text-muted-foreground">
              {translate("traces.noOTelSpansFoundFor")}
            </div>
          )}
          {sortedSpans.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {translate("traces.execution")} <code className="font-mono">{submittedId}</code>
                </span>
                <span>
                  {sortedSpans.length} span{sortedSpans.length !== 1 ? "s" : ""}{" "}
                  {translate("traces.totalDurationMsTotal", { totalDuration })}
                </span>
              </div>
              <div className="divide-y divide-border">
                {sortedSpans.map((span) => (
                  <SpanBar
                    key={span.spanId}
                    span={span}
                    minTime={minTime}
                    totalDuration={totalDuration}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Decision-Provenance Explainability Card ──────────────────────── */}
      {tab === "explain" && submittedId && (
        <ExplainCard
          executionId={submittedId}
          token={token}
          enabled={ready && isAuthenticated}
        />
      )}

      {/* ── Decision Receipts (Req 15.7) ─────────────────────────────────── */}
      {tab === "receipts" && submittedId && (
        <ReceiptsPanel
          executionId={submittedId}
          token={token}
          enabled={ready && isAuthenticated}
        />
      )}
    </div>
  );
}
