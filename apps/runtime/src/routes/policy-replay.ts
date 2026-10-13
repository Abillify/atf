// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Policy-Replay Simulator routes (`src/routes/policy-replay.ts`) — Req 16,
 * Task 22.1/22.3.
 *
 * Mounted at `/admin/policy-replay/*`, gated by operator RBAC.
 *
 * Endpoints:
 *   POST /admin/policy-replay         — run a replay, return the full diff JSON
 *   POST /admin/policy-replay/stream  — same run, progress + result over SSE
 *
 * The replay is a pure dry-run: candidate policies are validated and applied
 * against stored executions via the side-effect-free simulator; nothing is
 * written to any store except a best-effort audit entry for the replay itself.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type { CompliancePolicyLoader } from "../compliance/policy-loader.js";
import type { ToolAuthzLoader } from "../graph/tool-authz-loader.js";
import type { InputGuardrail } from "../graph/input-guardrails.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";
import {
  simulatePolicyReplay,
  validateCandidatePolicies,
  type PolicyReplayOptions,
  type PolicyReplayPolicies,
  type ReplayExecutionSource,
} from "../replay/policy-replay.js";

export interface PolicyReplayRouterDeps {
  /** Read-only execution history source (adapter over MonitoringService). */
  executionSource: ReplayExecutionSource;
  /** Live compliance policy (the OLD side of the diff). */
  policyLoader: CompliancePolicyLoader;
  /** Live tool-authz policy (the OLD side of the diff). */
  toolAuthzLoader: ToolAuthzLoader;
  operatorAuth: OperatorAuthorizer;
  auditLog: AuditLog;
  /** Optional input guardrail — scanned over stored prompts when configured. */
  inputGuardrail?: InputGuardrail;
}

/**
 * Adapt the monitoring service to the simulator's read-only source. Only the
 * two read methods are exposed, so the replay structurally cannot mutate
 * history (Property 17).
 */
export function replaySourceFromMonitoringService(
  monitoring: MonitoringServiceInterface,
): ReplayExecutionSource {
  return {
    listHistory: (query) => monitoring.getHistoryPage(query),
    listEvents: (executionId) => monitoring.getExecutionEvents(executionId),
  };
}

/** Body accepted by the replay endpoints. */
interface PolicyReplayRequestBody {
  candidateCompliancePolicy?: unknown;
  candidateToolAuthzPolicy?: unknown;
  maxExecutions?: number;
  from?: string;
  to?: string;
  flowIds?: string[];
}

function toReplayPolicies(
  body: PolicyReplayRequestBody,
  loaders: { policyLoader: CompliancePolicyLoader; toolAuthzLoader: ToolAuthzLoader },
): PolicyReplayPolicies {
  return {
    currentCompliancePolicy: loaders.policyLoader.policy,
    // Pass the live engine itself: it reproduces the exact in-force semantics
    // (including fail-closed deny-all), which a describe() round-trip loses.
    currentToolAuthzEngine: loaders.toolAuthzLoader.engine,
    ...(body.candidateCompliancePolicy !== undefined
      ? { candidateCompliancePolicy: body.candidateCompliancePolicy }
      : {}),
    ...(body.candidateToolAuthzPolicy !== undefined
      ? { candidateToolAuthzPolicy: body.candidateToolAuthzPolicy }
      : {}),
  };
}

function toReplayOptions(body: PolicyReplayRequestBody): PolicyReplayOptions {
  return {
    ...(body.maxExecutions !== undefined && Number.isFinite(body.maxExecutions)
      ? { maxExecutions: body.maxExecutions }
      : {}),
    ...(typeof body.from === "string" && body.from !== "" ? { from: body.from } : {}),
    ...(typeof body.to === "string" && body.to !== "" ? { to: body.to } : {}),
    ...(Array.isArray(body.flowIds) && body.flowIds.length > 0
      ? { flowIds: body.flowIds.filter((f): f is string => typeof f === "string") }
      : {}),
  };
}

export function createPolicyReplayRouter(deps: PolicyReplayRouterDeps): Hono {
  const router = new Hono();
  const { executionSource, policyLoader, toolAuthzLoader, operatorAuth, auditLog } = deps;

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

  const parseBody = async (ctx: import("hono").Context):
    Promise<PolicyReplayRequestBody | null> => {
    try {
      return await ctx.req.json<PolicyReplayRequestBody>();
    } catch {
      return null;
    }
  };

  // ── POST /admin/policy-replay ─────────────────────────────────────────────
  // Run the replay and return the full old-vs-new diff + summary as JSON.
  router.post("/", async (ctx) => {
    const actor = await guard(ctx);
    if (actor === null) return unauthorized(ctx);

    const body = await parseBody(ctx);
    if (body === null) {
      return ctx.json(
        { error: { message: "Request body must be valid JSON.", type: "invalid_request_error" } },
        400,
      );
    }

    const policies = toReplayPolicies(body, { policyLoader, toolAuthzLoader });
    const validationErrors = validateCandidatePolicies(policies);
    if (validationErrors.length > 0) {
      return ctx.json(
        { error: { message: validationErrors.join("; "), type: "invalid_request_error" } },
        400,
      );
    }

    const result = await simulatePolicyReplay(
      executionSource,
      policies,
      toReplayOptions(body),
      deps.inputGuardrail,
    );

    // Best-effort audit of the simulation itself (not a regulated action —
    // the replay has no side effects on policy or data state).
    auditLog.record({
      actor: actor.name ?? "operator",
      ...(actor.role !== undefined ? { role: actor.role } : {}),
      action: "policy.replay",
      target: "candidate",
      outcome: "success",
      details: { evaluated: result.summary.evaluated, changed: result.summary.changed },
    });

    return ctx.json(result);
  });

  // ── POST /admin/policy-replay/stream ──────────────────────────────────────
  // Same run streamed over SSE: `progress` events while replaying, one
  // `result` event with the full diff, then a `done` event (design.md: the
  // evaluation runs as a job with progress over SSE).
  router.post("/stream", async (ctx) => {
    const actor = await guard(ctx);
    if (actor === null) return unauthorized(ctx);

    const body = await parseBody(ctx);
    if (body === null) {
      return ctx.json(
        { error: { message: "Request body must be valid JSON.", type: "invalid_request_error" } },
        400,
      );
    }

    const policies = toReplayPolicies(body, { policyLoader, toolAuthzLoader });
    const validationErrors = validateCandidatePolicies(policies);
    if (validationErrors.length > 0) {
      return ctx.json(
        { error: { message: validationErrors.join("; "), type: "invalid_request_error" } },
        400,
      );
    }

    return streamSSE(ctx, async (s: SSEStreamingApi) => {
      const options = toReplayOptions(body);
      const result = await simulatePolicyReplay(
        executionSource,
        policies,
        {
          ...options,
          onProgress: async (done: number, total: number) => {
            await s.writeSSE({
              event: "progress",
              data: JSON.stringify({ done, total }),
            });
          },
        },
        deps.inputGuardrail,
      );
      await s.writeSSE({ event: "result", data: JSON.stringify(result) });
      await s.writeSSE({ event: "done", data: "{}" });
      auditLog.record({
        actor: actor.name ?? "operator",
        ...(actor.role !== undefined ? { role: actor.role } : {}),
        action: "policy.replay",
        target: "candidate",
        outcome: "success",
        details: {
          evaluated: result.summary.evaluated,
          changed: result.summary.changed,
          streamed: true,
        },
      });
    });
  });

  return router;
}
