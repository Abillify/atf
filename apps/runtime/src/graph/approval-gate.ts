// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Human-in-the-loop approval gate (`src/graph/approval-gate.ts`)
 *
 * Turns the platform from an autonomous chatbot into a *trusted actuator*: a
 * tool call flagged as consequential (e.g. a payment or collections action, a calendar
 * deletion, a ticket creation) does not execute until a human approves it.
 *
 * Flow:
 *   1. A node declares which of its tools require approval, or an operator
 *      configures a global list (`requiresApproval`).
 *   2. When the agent loop / tool node is about to invoke such a tool, it calls
 *      {@link ApprovalRegistry.request}. This registers a pending approval,
 *      surfaces it to the client/dashboard (via the engine's
 *      `approval_required` SSE chunk), and returns a Promise.
 *   3. A reviewer calls `POST /v1/approvals/:id` → {@link ApprovalRegistry.resolve},
 *      which settles the Promise. If nobody answers within the timeout the
 *      request auto-resolves to *deny* (fail-closed: a consequential action is
 *      never taken on silence).
 *
 * The registry is in-process (per replica). A run that is awaiting approval is
 * pinned to the replica that opened its stream, which is the natural ownership
 * for a synchronous HTTP/SSE request — the same Promise that the stream awaits
 * is the one a reviewer resolves. Cross-replica resolution would require the
 * durable-checkpoint interrupt/resume path and is out of scope here; this slice
 * delivers the guarantee for the common single-stream case.
 *
 * The decision logic ({@link toolRequiresApproval}) is pure and exported, so
 * matching is fully unit-testable. No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Decision logic (pure)
// ---------------------------------------------------------------------------

/**
 * Decides whether a tool reference requires approval. A tool matches when it is
 * listed (by full ref `server/tool`, bare name, or `server/*` / `*` wildcard)
 * in either the node-level list or the global list.
 */
export function toolRequiresApproval(
  toolRef: string,
  nodeList: readonly string[] | undefined,
  globalList: readonly string[] | undefined,
): boolean {
  const patterns = [...(nodeList ?? []), ...(globalList ?? [])];
  if (patterns.length === 0) return false;

  const parts = toolRef.split("/");
  const serverName = parts.length >= 2 ? (parts[0] ?? "") : "";
  const bareName = parts.length >= 2 ? parts.slice(1).join("/") : toolRef;

  for (const raw of patterns) {
    const p = raw.trim();
    if (p === "") continue;
    if (p === "*") return true;
    if (p === toolRef) return true;
    if (p === bareName) return true;
    if (serverName !== "" && p === `${serverName}/*`) return true;
  }
  return false;
}

/**
 * Reads a node's `config.requiresApproval` (string[]) into a list of patterns.
 * Returns undefined when not configured.
 */
export function nodeApprovalList(
  config: Record<string, unknown> | undefined,
): string[] | undefined {
  const raw = config?.requiresApproval;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === "string");
  return list.length > 0 ? list : undefined;
}

/**
 * Derives the display name of the end user who triggered an approval from the
 * request context, preferring the human-readable name, then email, then the
 * stable id. Returns undefined for anonymous requests (no usable identity), so
 * the caller can omit the field rather than persist a placeholder.
 */
export function approvalRequestedBy(ctx: {
  userName?: string;
  userEmail?: string;
  userId?: string;
}): string | undefined {
  const candidate = ctx.userName ?? ctx.userEmail ?? ctx.userId;
  const trimmed = candidate?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Approval records
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  /** Execution this approval belongs to. */
  executionId: string;
  /** Node that wants to call the tool. */
  nodeId: string;
  /** Full tool reference (`server/tool`). */
  tool: string;
  /** Arguments the model/flow wants to pass (credentials are never included). */
  args: Record<string, unknown>;
  /** Optional server-provided display data, rendered as escaped local UI text. */
  title?: string;
  message?: string;
  fields?: Array<{ name: string; label: string; value: unknown }>;
  /** Server-side expiry hint (ISO-8601); the local gate still fails closed. */
  expiresAt?: string;
  /** Tenant on whose behalf the action would run, when known. */
  tenantId?: string;
  /**
   * Display name of the end user whose request triggered this approval (from
   * the request context: userName → userEmail → userId). Used as the decision's
   * `by` on the open operator plane (no RBAC), where the reviewer IS that same
   * user clicking the in-chat widget — so the UI shows the real person instead
   * of the generic "anonymous" fallback.
   */
  requestedBy?: string;
  /**
   * Per-request auto-deny timeout override in ms — e.g. from a
   * compliance-policy.yaml `approvalRules[].timeoutMs` (ADR-0009). Falls back
   * to the registry's global {@link ApprovalRegistry.timeoutMs} when omitted.
   * Bounded 1s–1h by the policy schema when it's the source; callers setting
   * it directly are responsible for a sane value.
   */
  timeoutMs?: number;
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
  requestedAt: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Optional human-readable reason (shown to the model as the tool result). */
  reason?: string;
  /** Identifier of the reviewer who decided (for the audit trail). */
  by?: string;
  /** True when the decision came from the timeout auto-deny, not a human. */
  timedOut?: boolean;
}

/**
 * A decision that has already been made, retained briefly so a UI (e.g. the
 * in-chat approval widget) can re-render the final state after the pending
 * record is gone. Bounded in number; not a durable audit record.
 */
export interface ResolvedApproval {
  id: string;
  approved: boolean;
  /** Full tool reference, when known (may be empty on a non-owning replica). */
  tool?: string;
  /** Node that requested the approval — used to map the decision onto a graph node. */
  nodeId?: string;
  /** Execution the approval belonged to — used to scope the decision to one run. */
  executionId?: string;
  /**
   * Arguments the tool was to be called with (credentials are never included).
   * Retained so a dashboard can disambiguate multiple same-tool calls in one
   * node (e.g. eight cancel_booking calls) by matching on the exact args.
   */
  args?: Record<string, unknown>;
  /** Reviewer identifier, when known. */
  by?: string;
  /** True when the decision was the timeout auto-deny. */
  timedOut?: boolean;
  /** ISO-8601 timestamp when the approval was originally requested (mirrors PendingApproval.requestedAt). */
  requestedAt?: string;
  decidedAt: string;
}

/** Sink invoked when a new approval is requested (wired to SSE + audit). */
export type ApprovalListener = (pending: PendingApproval) => void;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface Waiter {
  pending: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalRegistry {
  enabled: boolean;
  /** Patterns from the global config (used together with per-node lists). */
  readonly globalPatterns: readonly string[];
  /**
   * Auto-deny timeout in milliseconds. Exposed so a UI (e.g. the in-chat
   * approval widget) can render an accurate countdown that ends exactly when
   * the gate fail-closes the pending request.
   */
  readonly timeoutMs: number;
  /** Whether the given tool (for a node) needs approval. */
  requires(
    toolRef: string,
    nodeConfig: Record<string, unknown> | undefined,
  ): boolean;
  /**
   * Registers a pending approval and resolves once a decision is made (or the
   * timeout auto-denies). The `notify` callback is invoked synchronously with
   * the created pending record so the caller can surface it (SSE chunk).
   */
  request(
    req: ApprovalRequest,
    notify?: ApprovalListener,
  ): Promise<ApprovalDecision>;
  /** Resolves a pending approval. Returns false when the id is unknown/settled. */
  resolve(id: string, decision: ApprovalDecision): boolean | Promise<boolean>;
  /** Lists currently-pending approvals (newest first). */
  listPending(): PendingApproval[] | Promise<PendingApproval[]>;
  /**
   * Lists recently-resolved decisions (newest first). Bounded/best-effort —
   * intended for dashboards (e.g. colouring graph nodes by approval outcome),
   * not as a durable audit record.
   */
  listResolved(): ResolvedApproval[] | Promise<ResolvedApproval[]>;
  /**
   * Returns a recently-resolved decision for re-rendering (e.g. the in-chat
   * approval widget after the pending record is gone), or undefined when the
   * id is unknown or no longer retained.
   */
  getResolved(
    id: string,
  ): ResolvedApproval | undefined | Promise<ResolvedApproval | undefined>;
}

/**
 * The gate a side-effect-free run (shadow, replay) sees: every approval is
 * denied at once, so no reviewer is asked to approve an action that is only a
 * re-run, and the gated tool is never called. Everything else delegates.
 */
export function sideEffectFreeApprovalGate(
  gate: ApprovalRegistry,
): ApprovalRegistry {
  return {
    get enabled() {
      return gate.enabled;
    },
    get globalPatterns() {
      return gate.globalPatterns;
    },
    get timeoutMs() {
      return gate.timeoutMs;
    },
    requires: (toolRef, nodeConfig) => gate.requires(toolRef, nodeConfig),
    request: async () => ({
      approved: false,
      reason:
        "Not requested: side effects are suppressed in shadow and replay runs.",
    }),
    resolve: (id, decision) => gate.resolve(id, decision),
    listPending: () => gate.listPending(),
    listResolved: () => gate.listResolved(),
    getResolved: (id) => gate.getResolved(id),
  };
}

class ApprovalRegistryImpl implements ApprovalRegistry {
  readonly enabled = true;
  private readonly waiters = new Map<string, Waiter>();
  /** Bounded log of recently-resolved decisions, for UI re-rendering. */
  private readonly resolvedLog = new Map<string, ResolvedApproval>();
  private static readonly RESOLVED_CAP = 500;

  constructor(
    readonly globalPatterns: readonly string[],
    readonly timeoutMs: number,
    private readonly logger?: Logger,
  ) {}

  requires(
    toolRef: string,
    nodeConfig: Record<string, unknown> | undefined,
  ): boolean {
    return toolRequiresApproval(
      toolRef,
      nodeApprovalList(nodeConfig),
      this.globalPatterns,
    );
  }

  request(
    req: ApprovalRequest,
    notify?: ApprovalListener,
  ): Promise<ApprovalDecision> {
    const id = crypto.randomUUID();
    const effectiveTimeoutMs = req.timeoutMs ?? this.timeoutMs;
    const pending: PendingApproval = {
      ...req,
      id,
      requestedAt: new Date().toISOString(),
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision): void => {
        const w = this.waiters.get(id);
        if (w === undefined) return; // already settled
        clearTimeout(w.timer);
        this.waiters.delete(id);
        this.retainResolved(pending, decision);
        resolve(decision);
      };

      const timer = setTimeout(() => {
        this.logger?.warn("Approval timed out — auto-denying", {
          id,
          tool: req.tool,
          executionId: req.executionId,
        });
        settle({
          approved: false,
          reason: `Approval timed out after ${effectiveTimeoutMs}ms — action denied.`,
          timedOut: true,
        });
      }, effectiveTimeoutMs);
      // Don't keep the event loop alive solely for a pending approval.
      if (typeof timer === "object" && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }

      this.waiters.set(id, { pending, resolve: settle, timer });
      this.logger?.info("Approval requested", {
        id,
        tool: req.tool,
        nodeId: req.nodeId,
        executionId: req.executionId,
      });
      if (notify !== undefined) {
        try {
          notify(pending);
        } catch {
          /* listener must never break the request path */
        }
      }
    });
  }

  resolve(id: string, decision: ApprovalDecision): boolean {
    const w = this.waiters.get(id);
    if (w === undefined) return false;
    this.logger?.info("Approval resolved", {
      id,
      approved: decision.approved,
      by: decision.by,
    });
    w.resolve(decision);
    return true;
  }

  listPending(): PendingApproval[] {
    return [...this.waiters.values()]
      .map((w) => w.pending)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  getResolved(id: string): ResolvedApproval | undefined {
    return this.resolvedLog.get(id);
  }

  listResolved(): ResolvedApproval[] {
    return [...this.resolvedLog.values()].sort((a, b) =>
      b.decidedAt.localeCompare(a.decidedAt),
    );
  }

  /** Records a settled decision in the bounded log (drops the oldest at cap). */
  private retainResolved(
    pending: PendingApproval,
    decision: ApprovalDecision,
  ): void {
    if (this.resolvedLog.size >= ApprovalRegistryImpl.RESOLVED_CAP) {
      const oldest = this.resolvedLog.keys().next().value;
      if (oldest !== undefined) this.resolvedLog.delete(oldest);
    }
    this.resolvedLog.set(pending.id, {
      id: pending.id,
      approved: decision.approved,
      tool: pending.tool,
      nodeId: pending.nodeId,
      executionId: pending.executionId,
      args: pending.args,
      ...(decision.by !== undefined ? { by: decision.by } : {}),
      ...(decision.timedOut === true ? { timedOut: true } : {}),
      requestedAt: pending.requestedAt,
      decidedAt: new Date().toISOString(),
    });
  }
}

export interface ApprovalGateConfig {
  enabled?: boolean;
  /** Tool patterns that always require approval (full ref, bare, `server/*`, `*`). */
  requireApprovalTools?: string[];
  /** Auto-deny after this many ms with no human decision. Default 30000 (30 s). */
  timeoutMs?: number;
}

/**
 * Builds an {@link ApprovalRegistry}, or undefined when disabled. Enabled
 * whenever `enabled` is true OR a non-empty global tool list is configured.
 */
export function createApprovalGate(
  config: ApprovalGateConfig,
  logger?: Logger,
): ApprovalRegistry | undefined {
  const patterns = config.requireApprovalTools ?? [];
  if (config.enabled !== true && patterns.length === 0) return undefined;
  const timeoutMs = config.timeoutMs ?? 30_000;
  logger?.info("Human-in-the-loop approval gate enabled", {
    globalPatterns: patterns,
    timeoutMs,
  });
  return new ApprovalRegistryImpl(patterns, timeoutMs, logger);
}
