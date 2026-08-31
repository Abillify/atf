// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Token-limit + usage routes (`src/routes/limits.ts`).
 *
 *  GET    /monitoring/limits              — configured limits + live consumption
 *  POST   /monitoring/limits              — create/update a limit (upsert by combo)
 *  PUT    /monitoring/limits/:id          — update a limit by id
 *  DELETE /monitoring/limits/:id          — delete a limit
 *  GET    /monitoring/usage/timeseries    — bucketed token/cost series (free range)
 *  GET    /monitoring/usage/models        — distinct model names (for the picker)
 *
 * Reads require `monitoring:read`; writes require `monitoring:write`. Mirrors the
 * operator-plane auth used by the monitoring router. Aggregation spans tenants
 * by design (operator plane) — see docs/adr/0005-tenant-data-isolation.md.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";
import {
  parseLimitInput,
  isUsageBucket,
  isLimitScopeType,
  type TokenLimitStore,
  type TokenLimitService,
  type UsageAnalytics,
  type UsageBucket,
  type UsageFilter,
} from "../observability/token-limits.js";

/** Default look-back for the time-series when no explicit range is given (7d). */
const DEFAULT_SERIES_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on returned series buckets to protect the response size. */
const MAX_SERIES_POINTS = 2000;

function unauthorized(ctx: Context) {
  return ctx.json(
    {
      error: {
        message: "Unauthorized monitoring access.",
        type: "authentication_error",
      },
    },
    401,
  );
}

export function createLimitsRouter(deps: {
  service: TokenLimitService;
  store: TokenLimitStore;
  analytics: UsageAnalytics;
  operatorAuth: OperatorAuthorizer;
  auditLog?: AuditLog;
}): Hono {
  const { service, store, analytics, operatorAuth, auditLog } = deps;
  const router = new Hono();

  const authRead = (ctx: Context): Promise<{ ok: boolean }> =>
    operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );

  const authWrite = (
    ctx: Context,
  ): ReturnType<OperatorAuthorizer["authorize"]> =>
    operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:write",
    );

  // --- List configured limits with their current consumption ---------------
  router.get("/monitoring/limits", async (ctx) => {
    if (!(await authRead(ctx)).ok) return unauthorized(ctx);
    const limits = await service.listWithConsumption();
    return ctx.json({ limits });
  });

  // --- Create / upsert a limit ---------------------------------------------
  router.post("/monitoring/limits", async (ctx) => {
    const r = await authWrite(ctx);
    if (!r.ok) return unauthorized(ctx);
    const body = await ctx.req.json().catch(() => null);
    const parsed = parseLimitInput(body);
    if (!parsed.ok) {
      return ctx.json(
        { error: { message: parsed.error, type: "validation_error" } },
        400,
      );
    }
    const limit = await store.upsert(parsed.value);
    auditLog?.record({
      actor: r.actor?.name ?? "operator",
      ...(r.actor?.role !== undefined ? { role: r.actor.role } : {}),
      action: "monitoring.limits.upsert",
      outcome: "success",
      details: {
        id: limit.id,
        scopeType: limit.scopeType,
        period: limit.period,
      },
    });
    return ctx.json({ limit }, 200);
  });

  // --- Update a limit by id -------------------------------------------------
  router.put("/monitoring/limits/:id", async (ctx) => {
    const r = await authWrite(ctx);
    if (!r.ok) return unauthorized(ctx);
    const body = await ctx.req.json().catch(() => null);
    const parsed = parseLimitInput(body);
    if (!parsed.ok) {
      return ctx.json(
        { error: { message: parsed.error, type: "validation_error" } },
        400,
      );
    }
    const limit = await store.update(ctx.req.param("id"), parsed.value);
    if (limit === null) {
      return ctx.json(
        { error: { message: "Limit not found.", type: "not_found" } },
        404,
      );
    }
    auditLog?.record({
      actor: r.actor?.name ?? "operator",
      ...(r.actor?.role !== undefined ? { role: r.actor.role } : {}),
      action: "monitoring.limits.update",
      outcome: "success",
      details: { id: limit.id },
    });
    return ctx.json({ limit });
  });

  // --- Delete a limit -------------------------------------------------------
  router.delete("/monitoring/limits/:id", async (ctx) => {
    const r = await authWrite(ctx);
    if (!r.ok) return unauthorized(ctx);
    const id = ctx.req.param("id");
    const deleted = await store.remove(id);
    auditLog?.record({
      actor: r.actor?.name ?? "operator",
      ...(r.actor?.role !== undefined ? { role: r.actor.role } : {}),
      action: "monitoring.limits.delete",
      outcome: deleted ? "success" : "error",
      details: { id },
    });
    return ctx.json({ deleted });
  });

  // --- Time-series usage over a free [from, to) range ----------------------
  router.get("/monitoring/usage/timeseries", async (ctx) => {
    if (!(await authRead(ctx)).ok) return unauthorized(ctx);

    const bucketRaw = ctx.req.query("bucket") ?? "day";
    const bucket: UsageBucket = isUsageBucket(bucketRaw) ? bucketRaw : "day";

    const now = Date.now();
    const toIso =
      parseIsoParam(ctx.req.query("to")) ?? new Date(now).toISOString();
    const fromIso =
      parseIsoParam(ctx.req.query("from")) ??
      new Date(now - DEFAULT_SERIES_RANGE_MS).toISOString();

    // Guard against a range so fine it would return an unbounded series.
    const span = Date.parse(toIso) - Date.parse(fromIso);
    const bucketMs =
      bucket === "hour" ? 3.6e6 : bucket === "day" ? 8.64e7 : 6.048e8;
    if (span > 0 && span / bucketMs > MAX_SERIES_POINTS) {
      return ctx.json(
        {
          error: {
            message: `Range too wide for '${bucket}' buckets (max ${MAX_SERIES_POINTS} points). Choose a coarser bucket or a shorter range.`,
            type: "validation_error",
          },
        },
        400,
      );
    }

    const filter = readFilter((k) => ctx.req.query(k));
    const series = await analytics.series({
      fromIso,
      toIso,
      bucket,
      ...filter,
    });
    return ctx.json({ series, from: fromIso, to: toIso, bucket });
  });

  // --- Distinct models seen in the ledger (for the model picker) -----------
  router.get("/monitoring/usage/models", async (ctx) => {
    if (!(await authRead(ctx)).ok) return unauthorized(ctx);
    const models = await analytics.distinctModels();
    return ctx.json({ models });
  });

  return router;
}

/** Parses an ISO/epoch query param into an ISO string, or undefined if absent/invalid. */
function parseIsoParam(v: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  const epoch = Number(v);
  if (Number.isFinite(epoch)) return new Date(epoch).toISOString();
  return undefined;
}

/** Builds a {@link UsageFilter} from scopeType/scopeId/model query params. */
function readFilter(query: (k: string) => string | undefined): UsageFilter {
  const scopeRaw = query("scopeType");
  const filter: UsageFilter = {};
  if (isLimitScopeType(scopeRaw)) filter.scopeType = scopeRaw;
  const scopeId = query("scopeId");
  if (scopeId !== undefined && scopeId !== "") filter.scopeId = scopeId;
  const model = query("model");
  if (model !== undefined && model !== "") filter.model = model;
  return filter;
}
