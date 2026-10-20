// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Red-Team API routes (`src/routes/red-team.ts`)
 *
 * Operator-plane endpoints for the AI Security Posture system, mounted under
 * `/security`. All routes require operator-level auth (same as /monitoring).
 *
 *   POST /security/red-team/:flowId/run
 *     Trigger one red-team run against a flow. Accepts optional body:
 *       { categories?, attacksPerRun? }
 *     Returns the full run record synchronously.
 *     Use the async job API for background runs on large attack sets.
 *
 *   GET  /security/red-team/runs
 *     List recent runs (newest first). ?flowId= to filter.
 *
 *   GET  /security/red-team/runs/:runId
 *     Full run record with all trials.
 *
 *   GET  /security/red-team/posture
 *     Per-flow posture score + current guardrail threshold.
 *
 *   GET  /security/red-team/attacks
 *     The full attack library (id, category, severity, description).
 *     Useful for understanding what the red-team harness tests.
 *
 * No `any` at module boundaries.
 */

import { Hono, type Context } from "hono";
import type {
  RedTeamEngine,
  RedTeamExecutor,
} from "../security/red-team-engine.js";
import { defaultAttackRegistry } from "../security/red-team-attack-registry.js";
import type {
  OperatorAuthorizer,
  OperatorIdentity,
} from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { ToolAuthzLoader } from "../graph/tool-authz-loader.js";
import type { FlowRegistry } from "../graph/flow-parser.js";

export interface RedTeamRouterDeps {
  engine?: RedTeamEngine;
  executor?: RedTeamExecutor;
  operatorAuth?: OperatorAuthorizer;
  auditLog?: AuditLog;
  /** Optional tool-authz loader so the UI can display the active policy. */
  toolAuthzLoader?: ToolAuthzLoader;
  /** Optional flow registry so the UI can list flows exposed as MCP tools. */
  flowRegistry?: FlowRegistry;
  /**
   * Optional live input guardrail — passed to a manual run so guardrail
   * auto-tuning (ADR-0010) also applies to manually-triggered runs, not only
   * the scheduled ones.
   */
  guardrail?: import("../graph/input-guardrails.js").InputGuardrail;
}

export function createRedTeamRouter(deps: RedTeamRouterDeps): Hono {
  const app = new Hono();
  const {
    engine,
    executor,
    operatorAuth,
    auditLog,
    toolAuthzLoader,
    flowRegistry,
    guardrail,
  } = deps;

  // ── Auth middleware ──────────────────────────────────────────────────────
  // Scope to /security/* ONLY. This router is mounted at the app root
  // (`app.route("/", …)`), so a `use("*")` here would run for EVERY request
  // (all of /monitoring/*, /flows/*, …) and shadow those planes' own auth —
  // rejecting expired/other tokens with a 403 before their handlers run (e.g.
  // blocking the in-chat approval widget's capability token, and turning the
  // operator plane's 401 — which the dashboard refreshes on — into a 403).
  app.use("/security/*", async (ctx, next) => {
    if (operatorAuth === undefined) return next();
    const authHeader = ctx.req.header("Authorization");
    const queryToken = ctx.req.query("token");
    const result = await operatorAuth.authorize(
      authHeader,
      queryToken,
      "monitoring:read",
    );
    if (!result.ok) {
      return ctx.json(
        { error: { message: "Forbidden", type: "auth_error" } },
        403,
      );
    }
    return next();
  });

  /**
   * Audit-safe actor label. The raw `Authorization` header (a bearer token /
   * JWT) must NEVER be written into the audit log — the log is readable via
   * `GET /monitoring/audit` and exported to log shippers, so persisting the
   * credential there would leak live operator credentials to anyone with
   * audit-read access. Instead the authorizer's resolved identity is used
   * (token label / JWT subject — a display name, not a secret).
   */
  const auditActor = (actor?: OperatorIdentity): string =>
    actor?.name ?? "unknown";

  interface WriteGate {
    /** 403 response when the caller lacks flows:write, else null. */
    forbidden: Response | null;
    /** Resolved operator identity from the authorizer (never a raw token). */
    actor?: OperatorIdentity;
  }

  /**
   * Write gate on top of the read gate above. Running attacks executes the
   * flow (LLM cost, tool calls) and refreshing replaces the attack library, so
   * both are flow writes (admin) — a viewer may only read results.
   */
  const forbidUnlessFlowWrite = async (ctx: Context): Promise<WriteGate> => {
    if (operatorAuth === undefined)
      return {
        forbidden: null,
        actor: { name: "anonymous", role: "admin", via: "open" },
      };
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "flows:write",
    );
    return {
      forbidden: r.ok
        ? null
        : ctx.json(
            {
              error: {
                message: "Forbidden: flows:write required",
                type: "auth_error",
              },
            },
            403,
          ),
      ...(r.actor !== undefined ? { actor: r.actor } : {}),
    };
  };

  // ── POST /security/red-team/:flowId/run ─────────────────────────────────
  app.post("/security/red-team/:flowId/run", async (ctx) => {
    const { forbidden, actor } = await forbidUnlessFlowWrite(ctx);
    if (forbidden !== null) return forbidden;
    if (engine === undefined || executor === undefined) {
      return ctx.json(
        {
          error: {
            message: "Red-team engine is disabled. Set RED_TEAM_ENABLED=true.",
            type: "disabled",
          },
        },
        503,
      );
    }
    const flowId = ctx.req.param("flowId");
    let body: { categories?: unknown; attacksPerRun?: unknown } = {};
    try {
      body = (await ctx.req.json().catch(() => ({}))) as typeof body;
    } catch {
      /* ignore — body is optional */
    }

    try {
      const run = await engine.run(flowId, executor, {
        triggeredBy: "manual",
        ...(guardrail !== undefined ? { guardrail } : {}),
      });
      void auditLog?.record({
        action: "red_team.run",
        target: flowId,
        actor: auditActor(actor),
        details: { runId: run.id, trials: run.trials.length },
        outcome: "success",
      });
      return ctx.json(run, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return ctx.json({ error: { message, type: "execution_error" } }, 500);
    }
  });

  // ── GET /security/red-team/runs ──────────────────────────────────────────
  app.get("/security/red-team/runs", (ctx) => {
    const flowId = ctx.req.query("flowId");
    const runs = engine?.listRuns(flowId) ?? [];
    return ctx.json({ runs, enabled: engine !== undefined });
  });

  // ── GET /security/red-team/runs/:runId ──────────────────────────────────
  app.get("/security/red-team/runs/:runId", (ctx) => {
    const runId = ctx.req.param("runId");
    const run = engine?.getRun(runId);
    if (run === undefined) {
      return ctx.json(
        { error: { message: `Run '${runId}' not found`, type: "not_found" } },
        404,
      );
    }
    return ctx.json(run);
  });

  // ── GET /security/red-team/posture ───────────────────────────────────────
  app.get("/security/red-team/posture", (ctx) => {
    return ctx.json({
      enabled: engine !== undefined,
      posture: engine?.postureByFlow() ?? {},
      guardrailThreshold: engine?.currentGuardrailThreshold() ?? 0.8,
    });
  });

  // ── GET /security/red-team/attacks ──────────────────────────────────────
  app.get("/security/red-team/attacks", (ctx) => {
    // Use the registry so custom + remote attacks are included.
    const all = defaultAttackRegistry.getAll();
    const attacks = all.map(({ id, category, severity, description }) => ({
      id,
      category,
      severity,
      description,
    }));
    return ctx.json({
      attacks,
      count: attacks.length,
      stats: defaultAttackRegistry.stats(),
    });
  });

  // ── POST /security/red-team/attacks/refresh ──────────────────────────────
  // Manually trigger a remote attack-library refresh (pulls from RED_TEAM_ATTACKS_URL).
  // Useful after pushing new attack templates without waiting for the next poll.
  app.post("/security/red-team/attacks/refresh", async (ctx) => {
    const { forbidden } = await forbidUnlessFlowWrite(ctx);
    if (forbidden !== null) return forbidden;
    await defaultAttackRegistry.refreshRemote();
    return ctx.json({ refreshed: true, stats: defaultAttackRegistry.stats() });
  });

  // ── POST /security/red-team/attacks/register ─────────────────────────────
  // Register a custom attack template at runtime (admin only).
  app.post("/security/red-team/attacks/register", async (ctx) => {
    const { forbidden, actor } = await forbidUnlessFlowWrite(ctx);
    if (forbidden !== null) return forbidden;
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const t = body as Record<string, unknown>;
    if (
      typeof t.id !== "string" ||
      typeof t.category !== "string" ||
      typeof t.severity !== "number" ||
      typeof t.description !== "string" ||
      typeof t.payload !== "string"
    ) {
      return ctx.json(
        {
          error: {
            message:
              "Body must include: id (string), category (string), severity (number 0-1), description (string), payload (string)",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const payload = t.payload as string;
    defaultAttackRegistry.register({
      id: t.id as string,
      category:
        t.category as import("../security/red-team-attacks.js").AttackCategory,
      severity: t.severity as number,
      description: t.description as string,
      render: () => payload,
    });
    auditLog?.record({
      actor: auditActor(actor),
      action: "red_team.attack.register",
      target: t.id as string,
      outcome: "success",
      details: { category: t.category, severity: t.severity },
    });
    return ctx.json({
      registered: true,
      id: t.id,
      stats: defaultAttackRegistry.stats(),
    });
  });

  // ── GET /security/tool-authz ─────────────────────────────────────────────
  // Read-only view of the active tool-authorization policy (edited via
  // flows/tool-authz.json, hot-reloaded). Lets the dashboard show operators
  // exactly which rules are enforced without shell access to the flows dir.
  app.get("/security/tool-authz", (ctx) => {
    if (toolAuthzLoader === undefined) {
      return ctx.json({
        active: false,
        ruleCount: 0,
        defaultAction: "allow",
        rules: [],
      });
    }
    return ctx.json(toolAuthzLoader.engine.describe());
  });

  // ── PUT /security/tool-authz ─────────────────────────────────────────────
  // Persists an edited policy to flows/tool-authz.json (validated + atomic
  // write + hot-reload). Requires flows:write (admin). Lets operators author
  // rules from the dashboard without shell access to the flows directory.
  app.put("/security/tool-authz", async (ctx) => {
    if (toolAuthzLoader === undefined) {
      return ctx.json(
        {
          error: {
            message: "Tool authorization is not configured on this server.",
            type: "disabled",
          },
        },
        503,
      );
    }
    // Elevated permission check (write) beyond the read gate above.
    const { forbidden, actor } = await forbidUnlessFlowWrite(ctx);
    if (forbidden !== null) return forbidden;
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const result = toolAuthzLoader.save(body);
    if (!result.ok) {
      return ctx.json(
        {
          error: {
            message: result.error ?? "invalid policy",
            type: "validation_error",
          },
        },
        400,
      );
    }
    void auditLog?.record({
      action: "tool_authz.update",
      actor: auditActor(actor),
      outcome: "success",
    });
    return ctx.json(toolAuthzLoader.engine.describe());
  });

  // ── GET /security/mcp ────────────────────────────────────────────────────
  // Lists the flows currently exposed as MCP tools at POST /mcp, so operators
  // can see what external agents can call and copy the connection details.
  app.get("/security/mcp", (ctx) => {
    const flows = flowRegistry
      ? flowRegistry.list().map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description ?? f.name,
        }))
      : [];
    return ctx.json({ endpoint: "/mcp", transport: "streamable-http", flows });
  });

  return app;
}
