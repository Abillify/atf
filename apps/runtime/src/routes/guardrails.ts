// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Guardrail policy routes (`src/routes/guardrails.ts`)
 *
 * Read-only view of the per-flow guardrail policy (`guardrails.json` /
 * `guardrails.yaml` in FLOWS_DIR, see `src/graph/guardrail-policy.ts`).
 * Policy authoring stays file-based (edited + hot-reloaded like other
 * flows-dir config); this route lets operators see the active rules from the
 * dashboard without shell access.
 *
 *   GET /admin/guardrails — configured rules, in evaluation order
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { GuardrailPolicyService } from "../graph/guardrail-policy.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface GuardrailsRouterDeps {
  guardrailPolicy: GuardrailPolicyService;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

export function createGuardrailsRouter(deps: GuardrailsRouterDeps): Hono {
  const { guardrailPolicy } = deps;
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

  router.get("/admin/guardrails", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);

    const rules = guardrailPolicy.listRules().map((rule, i) => ({
      id: `rule-${i}`,
      flow: rule.flow,
      input: rule.input,
      output: rule.output,
      egress: rule.egress,
    }));
    return ctx.json({
      hasPolicy: guardrailPolicy.hasPolicy(),
      rules,
    });
  });

  return router;
}
