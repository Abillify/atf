// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tenant + API-key management API (`src/routes/tenants.ts`)
 *
 * Admin-plane CRUD over tenants and their API keys, plus the usage/billing
 * reporting and Stripe-compatible export endpoints. Gated by the operator
 * authorizer at `admin` role (creation/deletion/revocation) or `operator`
 * role (usage reads).
 *
 *   POST   /admin/tenants               — create tenant
 *   GET    /admin/tenants               — list tenants
 *   GET    /admin/tenants/:id           — get tenant
 *   PATCH  /admin/tenants/:id           — update name/plan/budget/metadata
 *   DELETE /admin/tenants/:id           — delete tenant
 *
 *   POST   /admin/tenants/:id/keys      — create API key (returns rawKey once)
 *   GET    /admin/tenants/:id/keys      — list keys (no raw values)
 *   DELETE /admin/tenants/:id/keys/:kid — revoke key
 *
 *   GET    /admin/tenants/:id/usage     — daily usage (last N days)
 *   GET    /admin/tenants/:id/usage/summary  — aggregated summary
 *   GET    /admin/tenants/:id/usage/export   — Stripe-compatible usage record
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { TenantStore } from "../graph/tenant-manager.js";
import { TenantNotFoundError } from "../graph/tenant-manager.js";
import type { UsageMeter } from "../observability/billing.js";
import { toStripeUsageRecord } from "../observability/billing.js";
import type { AuditLog } from "../observability/audit-log.js";
import {
  isByokProvider,
  type TenantProviderKeyStore,
  type ByokResolver,
} from "../graph/tenant-provider-keys.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
  type OperatorIdentity,
} from "../middleware/operator-rbac.js";

export interface TenantsRouterDeps {
  tenantStore: TenantStore;
  usageMeter: UsageMeter;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  auditLog?: AuditLog;
  /** Optional BYOK provider-key store (per-tenant provider credentials). */
  providerKeyStore?: TenantProviderKeyStore;
  /** Resolver whose cache is invalidated when a BYOK key changes. */
  byokResolver?: ByokResolver;
}

export function createTenantsRouter(deps: TenantsRouterDeps): Hono {
  const router = new Hono();
  const { tenantStore, usageMeter, auditLog } = deps;
  const providerKeyStore = deps.providerKeyStore;
  const byokResolver = deps.byokResolver;
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  const guard = async (
    ctx: {
      req: {
        header: (k: string) => string | undefined;
        query: (k: string) => string | undefined;
      };
    },
    perm: Parameters<OperatorAuthorizer["authorize"]>[2],
  ): Promise<OperatorIdentity | null> => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      perm,
    );
    return r.ok
      ? (r.actor ?? { name: "admin", role: "admin", via: "open" })
      : null;
  };

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized — admin access required.",
          type: "authentication_error",
        },
      },
      401,
    );

  const notFound = (ctx: import("hono").Context, id: string) =>
    ctx.json(
      {
        error: {
          message: `Tenant '${id}' not found.`,
          type: "not_found_error",
        },
      },
      404,
    );

  // -------------------------------------------------------------------------
  // Tenant CRUD
  // -------------------------------------------------------------------------
  router.post("/admin/tenants", async (ctx) => {
    const actor = await guard(ctx, "flows:write"); // "admin" permission maps to flows:write
    if (!actor) return unauthorized(ctx);
    let body: {
      name?: string;
      plan?: string;
      dailyBudget?: number;
      metadata?: Record<string, unknown>;
    };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return ctx.json(
        {
          error: {
            message: "Field 'name' is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const tenant = await tenantStore.createTenant({
      name: body.name.trim(),
      ...(body.plan !== undefined ? { plan: body.plan } : {}),
      ...(typeof body.dailyBudget === "number"
        ? { dailyBudget: body.dailyBudget }
        : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "tenant.create",
      target: tenant.id,
    });
    return ctx.json({ tenant }, 201);
  });

  router.get("/admin/tenants", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
    const limit = Number.parseInt(ctx.req.query("limit") ?? "100", 10);
    const tenants = await tenantStore.listTenants(
      Number.isFinite(limit) ? limit : 100,
    );
    return ctx.json({ tenants });
  });

  router.get("/admin/tenants/:id", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
    const id = ctx.req.param("id");
    const tenant = await tenantStore.getTenant(id);
    if (tenant === undefined) return notFound(ctx, id);
    return ctx.json({ tenant });
  });

  router.patch("/admin/tenants/:id", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    const id = ctx.req.param("id");
    let body: {
      name?: string;
      plan?: string;
      dailyBudget?: number;
      metadata?: Record<string, unknown>;
    };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const tenant = await tenantStore.updateTenant(id, body);
    if (tenant === undefined) return notFound(ctx, id);
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "tenant.update",
      target: id,
    });
    return ctx.json({ tenant });
  });

  router.delete("/admin/tenants/:id", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    const id = ctx.req.param("id");
    const ok = await tenantStore.deleteTenant(id);
    if (!ok) return notFound(ctx, id);
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "tenant.delete",
      target: id,
    });
    return ctx.json({ id, deleted: true });
  });

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------
  router.post("/admin/tenants/:id/keys", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    const tenantId = ctx.req.param("id");
    let body: { name?: string; expiresAt?: string; expiresInDays?: number };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : "default";

    // `expiresAt` (explicit ISO-8601) takes precedence over `expiresInDays`
    // (a convenience so a caller does not have to compute a timestamp
    // client-side). Neither is required — omitting both creates a
    // never-expiring key, matching the pre-expiry behaviour exactly.
    let expiresAt: string | undefined;
    if (typeof body.expiresAt === "string" && body.expiresAt.trim().length > 0) {
      const parsed = Date.parse(body.expiresAt);
      if (Number.isNaN(parsed)) {
        return ctx.json(
          {
            error: {
              message: `expiresAt "${body.expiresAt}" is not a valid ISO-8601 timestamp.`,
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      expiresAt = new Date(parsed).toISOString();
    } else if (
      typeof body.expiresInDays === "number" &&
      Number.isFinite(body.expiresInDays) &&
      body.expiresInDays > 0
    ) {
      expiresAt = new Date(
        Date.now() + body.expiresInDays * 86_400_000,
      ).toISOString();
    }

    try {
      const key = await tenantStore.createApiKey(tenantId, name, expiresAt);
      auditLog?.record({
        actor: actor.name,
        role: actor.role,
        action: "api_key.create",
        target: key.id,
        details: { tenantId, ...(expiresAt !== undefined ? { expiresAt } : {}) },
      });
      return ctx.json({ key }, 201);
    } catch (err) {
      if (err instanceof TenantNotFoundError) return notFound(ctx, tenantId);
      throw err;
    }
  });

  router.get("/admin/tenants/:id/keys", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
    const tenantId = ctx.req.param("id");
    const keys = await tenantStore.listApiKeys(tenantId);
    return ctx.json({ keys });
  });

  router.delete("/admin/tenants/:id/keys/:kid", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    const kid = ctx.req.param("kid");
    const ok = await tenantStore.revokeApiKey(kid);
    if (!ok)
      return ctx.json(
        {
          error: {
            message: `API key '${kid}' not found or already revoked.`,
            type: "not_found_error",
          },
        },
        404,
      );
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "api_key.revoke",
      target: kid,
      details: { tenantId: ctx.req.param("id") },
    });
    return ctx.json({ id: kid, revoked: true });
  });

  // -------------------------------------------------------------------------
  // Usage / billing — operator-readable (monitoring:read)
  // -------------------------------------------------------------------------
  router.get("/admin/tenants/:id/usage", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
    const tenantId = ctx.req.param("id");
    const days = Number.parseInt(ctx.req.query("days") ?? "30", 10);
    const usage = await usageMeter.getTenantUsage(
      tenantId,
      Number.isFinite(days) ? days : 30,
    );
    return ctx.json({ tenantId, usage });
  });

  router.get("/admin/tenants/:id/usage/summary", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
    const tenantId = ctx.req.param("id");
    const from =
      ctx.req.query("from") ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = ctx.req.query("to");
    const summary = await usageMeter.getSummary(tenantId, from, to);
    return ctx.json({ summary });
  });

  router.get("/admin/tenants/:id/usage/export", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
    const tenantId = ctx.req.param("id");
    const from =
      ctx.req.query("from") ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = ctx.req.query("to");
    const summary = await usageMeter.getSummary(tenantId, from, to);
    const stripeRecord = toStripeUsageRecord(summary);
    return ctx.json({ stripe_usage_record: stripeRecord, summary });
  });

  // -------------------------------------------------------------------------
  // BYOK provider keys — per-tenant provider credentials (admin only).
  // Only mounted with effect when a provider-key store is configured.
  // -------------------------------------------------------------------------
  const byokUnavailable = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "BYOK is not enabled on this deployment (set BYOK_ENABLED).",
          type: "not_found_error",
        },
      },
      404,
    );

  router.get("/admin/tenants/:id/provider-keys", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
    if (providerKeyStore === undefined) return byokUnavailable(ctx);
    const tenantId = ctx.req.param("id");
    const keys = await providerKeyStore.list(tenantId);
    return ctx.json({ tenantId, providerKeys: keys });
  });

  router.put("/admin/tenants/:id/provider-keys/:provider", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    if (providerKeyStore === undefined) return byokUnavailable(ctx);
    const tenantId = ctx.req.param("id");
    const provider = ctx.req.param("provider");
    if (!isByokProvider(provider)) {
      return ctx.json(
        {
          error: {
            message: `Unsupported BYOK provider '${provider}'. Supported: openai, google, azure, bedrock.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    let body: { key?: unknown };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Invalid JSON body.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (typeof body.key !== "string" || body.key.trim().length === 0) {
      return ctx.json(
        {
          error: {
            message: "Body must include a non-empty 'key'.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    // Ensure the tenant exists before attaching credentials to it.
    if ((await tenantStore.getTenant(tenantId)) === undefined)
      return notFound(ctx, tenantId);

    await providerKeyStore.setKey(tenantId, provider, body.key.trim());
    byokResolver?.invalidate(tenantId);
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "byok.set",
      target: tenantId,
      details: { provider },
    });
    return ctx.json({ tenantId, provider, configured: true });
  });

  router.delete("/admin/tenants/:id/provider-keys/:provider", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    if (providerKeyStore === undefined) return byokUnavailable(ctx);
    const tenantId = ctx.req.param("id");
    const provider = ctx.req.param("provider");
    if (!isByokProvider(provider)) {
      return ctx.json(
        {
          error: {
            message: `Unsupported BYOK provider '${provider}'.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const removed = await providerKeyStore.removeKey(tenantId, provider);
    byokResolver?.invalidate(tenantId);
    if (!removed) {
      return ctx.json(
        {
          error: {
            message: `No BYOK key for provider '${provider}'.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "byok.remove",
      target: tenantId,
      details: { provider },
    });
    return ctx.json({ tenantId, provider, removed: true });
  });

  return router;
}
