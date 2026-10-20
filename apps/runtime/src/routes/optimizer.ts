// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Self-optimizing flow routes (`src/routes/optimizer.ts`)
 *
 * Operator-plane endpoints for the flow optimization loop. Mounted under
 * `/optimizer` and gated by the same operator auth as the rest of the control
 * plane (MONITORING_AUTH token or RBAC role).
 *
 *   POST /optimizer/:flowId/run
 *     Triggers one optimization cycle for a flow. Accepts optional config body
 *     (targetNodeId, variantCount, minSamples, optimizationGoal, autoPromote,
 *     async). Default (sync) awaits the full cycle and returns the final run.
 *     With `{ "async": true }` it returns 202 immediately with the run in a
 *     running state; poll GET /optimizer/runs/:runId for progress + result.
 *
 *   GET  /optimizer/:flowId/runs
 *     Lists past optimization runs for a flow, newest first.
 *
 *   GET  /optimizer/runs/:runId
 *     Returns a single run record.
 *
 *   POST /optimizer/runs/:runId/promote
 *     Manually promotes a variant from a completed run to the flow store as a
 *     new published version.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type {
  FlowOptimizer,
  OptimizerConfig,
} from "../graph/flow-optimizer.js";
import type { StructuralEdit } from "../graph/prompt-variant-generator.js";
import type { TraceAnalyzer } from "../graph/trace-analyzer.js";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { FlowRegistry } from "../graph/flow-parser.js";
import { materializeFlowSource, validateFlowDefinition } from "../graph/flow-parser.js";
import type { FlowDefinition, LlmConfig } from "../types/flow.js";
import type { ModelQualityRegistry } from "../graph/model-quality.js";
import {
  collectRoutingCandidates,
  computeRoutingRecommendations,
  buildCanaryInstruction,
} from "../graph/routing-advisor.js";
import { normalizeExecutionId } from "../util/execution-id.js";

export interface OptimizerRouterDeps {
  /**
   * The self-optimizing loop (OPTIMIZER_ENABLED). Optional: routing advice and
   * trace analysis work without it; its own endpoints answer 501 then.
   */
  optimizer?: FlowOptimizer;
  operatorAuth?: OperatorAuthorizer;
  auditLog?: AuditLog;
  /**
   * Optional trace analyzer enabling `POST /optimizer/analyze/:executionId`.
   * When omitted, that endpoint returns 501 (feature not configured).
   */
  traceAnalyzer?: TraceAnalyzer;
  /**
   * Loaded flows, enabling `GET /optimizer/routing-advice`. When omitted that
   * endpoint returns 501 (there is nothing to advise on).
   */
  flowRegistry?: FlowRegistry;
  /** Global default model, used as a node's current model when it declares none. */
  defaultLlm?: LlmConfig;
  /**
   * Flows directory: resolves shortcuts, variables and includes of a
   * source-form definition posted to `POST /optimizer/routing-advice`, the
   * same way a flow file is loaded. Without it the posted definition must
   * already be in runtime form.
   */
  flowsDir?: string;
  /**
   * Observed per-model judge quality. Without it recommendations are cost-only
   * and report `source: "unknown"`, which is reported honestly rather than
   * presented as a quality-checked suggestion.
   */
  modelQuality?: ModelQualityRegistry;
}

/**
 * Loose runtime guard for a client-supplied structural edit. Only shape is
 * checked here — the optimizer applies each edit and re-validates the resulting
 * flow (unknown node ids, bad providers, broken routing) before evaluating it,
 * so a malformed edit is dropped there rather than executed.
 */
function isStructuralEditLike(v: unknown): v is StructuralEdit {
  if (typeof v !== "object" || v === null) return false;
  const e = v as { nodes?: unknown; edges?: unknown };
  const nodesOk = e.nodes === undefined || Array.isArray(e.nodes);
  const edgesOk = e.edges === undefined || Array.isArray(e.edges);
  return nodesOk && edgesOk && (Array.isArray(e.nodes) || Array.isArray(e.edges));
}

/**
 * Per-request audit actor, filled by the auth middleware from the authorizer's
 * RESOLVED identity (token label / JWT subject: a display name, never a
 * credential). The raw `Authorization` header must never reach the hash-chained
 * audit log: it is readable via `GET /monitoring/audit` and exported to log
 * shippers, and a chained row cannot be removed without breaking the chain.
 * Keyed by the request object so concurrent requests cannot see each other.
 */
const resolvedActors = new WeakMap<Request, string>();

export function createOptimizerRouter(deps: OptimizerRouterDeps): Hono {
  const app = new Hono();
  const {
    optimizer,
    operatorAuth,
    auditLog,
    traceAnalyzer,
    flowRegistry,
    defaultLlm,
    modelQuality,
    flowsDir,
  } = deps;

  const optimizerDisabled = (c: import("hono").Context) =>
    c.json(
      {
        error: {
          message:
            "The flow optimizer is not enabled on this runtime (OPTIMIZER_ENABLED=true plus a replay store, a flow store and a generator/judge model).",
          type: "not_configured",
        },
      },
      501,
    );

  // -------------------------------------------------------------------------
  // Auth middleware
  // -------------------------------------------------------------------------
  app.use("*", async (c, next) => {
    if (operatorAuth === undefined) {
      await next();
      return;
    }
    const authHeader = c.req.header("Authorization");
    const queryToken = c.req.query("token");
    const result = await operatorAuth.authorize(
      authHeader,
      queryToken,
      "flows:write",
    );
    if (!result.ok) {
      return c.json(
        { error: { message: "Unauthorized", type: "auth_error" } },
        401,
      );
    }
    resolvedActors.set(c.req.raw, result.actor?.name ?? "unknown");
    await next();
  });
  /** Audit actor for this request: the resolved identity, never the token. */
  const auditActor = (c: import("hono").Context): string =>
    operatorAuth === undefined
      ? "anonymous"
      : (resolvedActors.get(c.req.raw) ?? "unknown");

  // -------------------------------------------------------------------------
  // GET /optimizer/routing-advice
  //   Cost/quality routing recommendations across all loaded flows: for every
  //   node that declares a cost-router candidate pool, the cheapest candidate
  //   whose expected quality loss stays inside the configured budget.
  //
  //   Read-only by design. Each recommendation carries the exact `canary` entry
  //   an operator would add to flows/canary.yaml to trial it, rather than the
  //   endpoint starting a rollout itself — opening a dashboard tab must never
  //   divert production traffic to a different model.
  //
  //   Query: ?minCostSavingPct=10&maxQualityLossPct=5
  // -------------------------------------------------------------------------
  app.get("/routing-advice", (c) => {
    if (flowRegistry === undefined) {
      return c.json(
        {
          error: {
            message:
              "Routing advice is unavailable — no flow registry is wired into the optimizer router.",
            type: "not_configured",
          },
        },
        501,
      );
    }

    return c.json(
      routingAdvice(
        flowRegistry.list(),
        c.req.query("minCostSavingPct"),
        c.req.query("maxQualityLossPct"),
      ),
    );
  });

  // -------------------------------------------------------------------------
  // POST /optimizer/routing-advice
  //   The same advice for ONE definition that is not loaded (yet): the Studio
  //   canvas or a draft, in source form (shortcuts, {{vars.*}}, includes are
  //   resolved like a flow file). Nothing is registered or saved.
  //
  //   Body: { definition, minCostSavingPct?, maxQualityLossPct? }
  // -------------------------------------------------------------------------
  app.post("/routing-advice", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { message: "Request body must be valid JSON.", type: "invalid_request_error" } },
        400,
      );
    }
    const b = (body ?? {}) as {
      definition?: unknown;
      minCostSavingPct?: unknown;
      maxQualityLossPct?: unknown;
    };
    if (b.definition === null || typeof b.definition !== "object" || Array.isArray(b.definition)) {
      return c.json(
        {
          error: {
            message: "`definition` must be a flow definition object.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const materialized =
      flowsDir !== undefined
        ? materializeFlowSource(b.definition, flowsDir, "optimizer:definition")
        : validateFlowDefinition(b.definition);
    if (!materialized.success) {
      return c.json(
        {
          error: {
            message: `The definition is not a valid flow: ${materialized.error.reason}`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const raw = (v: unknown): string | undefined =>
      typeof v === "number" || typeof v === "string" ? String(v) : undefined;
    return c.json(
      routingAdvice([materialized.data], raw(b.minCostSavingPct), raw(b.maxQualityLossPct)),
    );
  });

  /** Advice for `flows`; thresholds as raw query/body values (percent, 0–100). */
  function routingAdvice(
    flows: readonly FlowDefinition[],
    minCostRaw: string | undefined,
    maxLossRaw: string | undefined,
  ) {
    const num = (raw: string | undefined): number | undefined => {
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
    };
    const minCostSavingPct = num(minCostRaw);
    const maxQualityLossPct = num(maxLossRaw);

    const nodes = collectRoutingCandidates(flows, defaultLlm);
    const recommendations = computeRoutingRecommendations({
      nodes,
      ...(minCostSavingPct !== undefined || maxQualityLossPct !== undefined
        ? {
            thresholds: {
              ...(minCostSavingPct !== undefined ? { minCostSavingPct } : {}),
              ...(maxQualityLossPct !== undefined
                ? { maxQualityLossPct }
                : {}),
            },
          }
        : {}),
      // Observed judge quality per model, when the registry is available — that
      // is what turns "cheaper" into "cheaper and still good enough".
      ...(modelQuality !== undefined
        ? { qualityLookup: modelQuality.lookup() }
        : {}),
    });

    return {
      // Surfaced so an empty result is interpretable: zero candidates examined
      // means no flow declares a routing pool, which is different from "no
      // cheaper model clears the quality bar".
      nodesExamined: nodes.length,
      qualityDataAvailable: modelQuality !== undefined,
      recommendations: recommendations.map((recommendation) => ({
        ...recommendation,
        canary: buildCanaryInstruction({
          recommendation,
          candidateFlowId: `${recommendation.flowId}-${recommendation.suggestedModel.replace(
            /[^a-zA-Z0-9-]/g,
            "-",
          )}`,
        }),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // POST /optimizer/analyze/:executionId
  //   LLM post-mortem of a captured execution trace: why it failed/degraded,
  //   plus efficiency/performance/logic/cost findings and machine-actionable
  //   improvement suggestions. Optional body:
  //     { scopeNodeIds?: string[], goal?: string }
  //   `scopeNodeIds` restricts the analysis to a sub-section of the flow.
  // -------------------------------------------------------------------------
  app.post("/analyze/:executionId", async (c) => {
    if (traceAnalyzer === undefined) {
      return c.json(
        {
          error: {
            message:
              "Trace analysis is not configured (no analyzer model / debug-trace store).",
            type: "not_implemented",
          },
        },
        501,
      );
    }
    // Accept the bare uuid or the `chatcmpl-<uuid>` id the chat endpoints report.
    const executionId = normalizeExecutionId(c.req.param("executionId"));
    let body: { scopeNodeIds?: string[]; goal?: string } = {};
    try {
      body = await c.req.json<{ scopeNodeIds?: string[]; goal?: string }>();
    } catch {
      // No body — analyse the whole trace.
    }
    const options: { scopeNodeIds?: string[]; goal?: string } = {
      ...(Array.isArray(body.scopeNodeIds) &&
      body.scopeNodeIds.every((s) => typeof s === "string")
        ? { scopeNodeIds: body.scopeNodeIds }
        : {}),
      ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
    };

    let analysis: Awaited<ReturnType<typeof traceAnalyzer.analyze>>;
    try {
      analysis = await traceAnalyzer.analyze(executionId, options);
    } catch (err) {
      return c.json(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "analysis_error",
          },
        },
        500,
      );
    }
    if (analysis === undefined) {
      return c.json(
        {
          error: {
            message: `No debug trace found for execution "${executionId}" (it may have aged out of the in-memory buffer).`,
            type: "not_found",
          },
        },
        404,
      );
    }

    auditLog?.record({
      actor: auditActor(c),
      role: "operator",
      action: "optimizer.analyze",
      target: executionId,
      ...(options.scopeNodeIds !== undefined
        ? { details: { scopeNodeIds: options.scopeNodeIds } }
        : {}),
    });

    return c.json({ analysis });
  });

  // -------------------------------------------------------------------------
  // POST /optimizer/:flowId/run
  // -------------------------------------------------------------------------
  app.post("/:flowId/run", async (c) => {
    if (optimizer === undefined) return optimizerDisabled(c);
    const flowId = c.req.param("flowId");
    let body: Partial<OptimizerConfig> & { async?: boolean } = {};
    try {
      body = await c.req.json<Partial<OptimizerConfig> & { async?: boolean }>();
    } catch {
      // No body or invalid JSON — use defaults.
    }

    const config: OptimizerConfig = {
      flowId,
      targetNodeId:
        typeof body.targetNodeId === "string" ? body.targetNodeId : undefined,
      // Allow 0 to skip LLM generation (a seed-only run that evaluates just the
      // supplied `seedEdits`); otherwise clamp to 1–10, defaulting to 3.
      variantCount:
        typeof body.variantCount === "number" && body.variantCount >= 0
          ? Math.min(10, Math.floor(body.variantCount))
          : 3,
      minSamples:
        typeof body.minSamples === "number" && body.minSamples >= 1
          ? Math.floor(body.minSamples)
          : 5,
      maxSamples:
        typeof body.maxSamples === "number" && body.maxSamples >= 1
          ? Math.min(100, Math.floor(body.maxSamples))
          : 20,
      minScoreImprovement:
        typeof body.minScoreImprovement === "number"
          ? Math.max(0, Math.min(1, body.minScoreImprovement))
          : 0.05,
      autoPromote: body.autoPromote === true,
      optimizationGoal:
        typeof body.optimizationGoal === "string"
          ? body.optimizationGoal
          : undefined,
      suggestTemperature: body.suggestTemperature === true,
      evalConcurrency:
        typeof body.evalConcurrency === "number"
          ? Math.max(1, Math.min(8, body.evalConcurrency))
          : 2,
      // Partial / sub-graph optimization: restrict to a flow sub-section.
      ...(Array.isArray(body.scopeNodeIds) &&
      body.scopeNodeIds.every((s) => typeof s === "string") &&
      body.scopeNodeIds.length > 0
        ? { scopeNodeIds: body.scopeNodeIds }
        : {}),
      // Structural variants (model / temperature / maxTokens / tools / routing).
      allowStructural: body.allowStructural === true,
      allowEdgeEdits: body.allowEdgeEdits === true,
      ...(Array.isArray(body.modelCandidates)
        ? {
            modelCandidates: body.modelCandidates.filter(
              (m): m is { provider: string; model: string } =>
                typeof m === "object" &&
                m !== null &&
                typeof (m as { provider?: unknown }).provider === "string" &&
                typeof (m as { model?: unknown }).model === "string",
            ),
          }
        : {}),
      // Seed generation from a captured trace's analysis.
      ...(typeof body.analysisExecutionId === "string"
        ? { analysisExecutionId: body.analysisExecutionId }
        : {}),
      // Ready-made structural edits to evaluate as variants (e.g. one-click
      // "create variant from this suggestion" out of a trace analysis).
      ...(Array.isArray(body.seedEdits)
        ? { seedEdits: body.seedEdits.filter(isStructuralEditLike) }
        : {}),
    };

    auditLog?.record({
      actor: auditActor(c),
      role: "operator",
      action: "optimizer.run",
      target: flowId,
      details: {
        variantCount: config.variantCount,
        autoPromote: config.autoPromote,
        async: body.async === true,
      },
    });

    // Async mode: start the run in the background and return 202 immediately with
    // the initial run record. The client polls GET /optimizer/runs/:runId for
    // progress + the final result. Default (sync) awaits the full cycle.
    if (body.async === true) {
      try {
        const run = optimizer.start(config);
        return c.json(run, 202);
      } catch (err) {
        return c.json(
          {
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "optimizer_error",
            },
          },
          500,
        );
      }
    }

    try {
      const run = await optimizer.run(config);
      return c.json(run);
    } catch (err) {
      return c.json(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "optimizer_error",
          },
        },
        500,
      );
    }
  });

  // -------------------------------------------------------------------------
  // GET /optimizer/:flowId/runs
  // -------------------------------------------------------------------------
  app.get("/:flowId/runs", (c) => {
    if (optimizer === undefined) return optimizerDisabled(c);
    const flowId = c.req.param("flowId");
    const runs = optimizer.listRuns(flowId);
    return c.json({ runs });
  });

  // -------------------------------------------------------------------------
  // GET /optimizer/runs/:runId
  // -------------------------------------------------------------------------
  app.get("/runs/:runId", (c) => {
    if (optimizer === undefined) return optimizerDisabled(c);
    const runId = c.req.param("runId");
    const run = optimizer.getRun(runId);
    if (run === undefined) {
      return c.json(
        { error: { message: `Run "${runId}" not found`, type: "not_found" } },
        404,
      );
    }
    return c.json(run);
  });

  // -------------------------------------------------------------------------
  // POST /optimizer/runs/:runId/promote
  // -------------------------------------------------------------------------
  app.post("/runs/:runId/promote", async (c) => {
    if (optimizer === undefined) return optimizerDisabled(c);
    const runId = c.req.param("runId");
    let variantLabel: string | undefined;
    try {
      const body = await c.req.json<{ variantLabel?: string }>();
      variantLabel =
        typeof body.variantLabel === "string" ? body.variantLabel : undefined;
    } catch {
      // ignore
    }

    if (variantLabel === undefined || variantLabel.trim() === "") {
      return c.json(
        {
          error: {
            message: "variantLabel is required",
            type: "invalid_request",
          },
        },
        400,
      );
    }

    const actor = auditActor(c);
    auditLog?.record({
      actor,
      role: "operator",
      action: "optimizer.promote",
      target: runId,
      details: { variantLabel },
    });

    try {
      const run = await optimizer.promote(runId, variantLabel, actor);
      return c.json(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("not found") ? 404 : 400;
      return c.json(
        { error: { message: msg, type: "optimizer_error" } },
        status as 404 | 400,
      );
    }
  });

  return app;
}
