// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Provider key pool health routes (`src/routes/provider-keys.ts`)
 *
 * Read-only view of the in-memory {@link ProviderKeyPool} configured via the
 * `PROVIDER_KEYS_*` env vars (see `src/graph/provider-key-pool.ts`). Lets
 * operators see which providers have a rotating key pool configured and each
 * key's health (masked — never the raw key), without shell access to the
 * backend process.
 *
 * This is distinct from the per-tenant BYOK provider keys managed under
 * `/admin/tenants/:id/provider-keys` (`src/routes/tenants.ts`) — that is
 * tenant-scoped customer credentials; this is the operator's own global
 * key pool used to spread/rotate load across multiple keys per provider.
 *
 *   GET /admin/provider-keys — one row per configured provider + masked key health
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { ProviderKeyPool } from "../graph/provider-key-pool.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface ProviderKeysRouterDeps {
  providerKeyPool: ProviderKeyPool;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

export function createProviderKeysRouter(deps: ProviderKeysRouterDeps): Hono {
  const { providerKeyPool } = deps;
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  const router = new Hono();

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized operator access.",
          type: "authentication_error",
        },
      },
      401,
    );

  router.get("/admin/provider-keys", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);

    const health = providerKeyPool.health();
    const keys = Object.entries(health).flatMap(([provider, entries]) =>
      entries.map((h, i) => ({
        id: `${provider}-${i}`,
        provider,
        alias: h.keyMask,
        maskedKey: h.keyMask,
        status: h.healthy ? ("active" as const) : ("rotated" as const),
        successes: h.successes,
        failures: h.failures,
      })),
    );
    return ctx.json({ active: providerKeyPool.active, keys });
  });

  return router;
}
