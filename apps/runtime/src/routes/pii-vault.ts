// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PII vault status route (`src/routes/pii-vault.ts`)
 *
 * Read-only visibility into the reversible PII tokenization vault
 * (`src/graph/pii-vault.ts`) for the operator dashboard — whether it's
 * enabled, which PII types it tokenizes, and whether it's backed by a durable
 * (encrypted Postgres) store or an in-memory (per-replica) one. No usage
 * metrics are exposed here: vault entries are deliberately short-lived
 * (released as soon as a run finishes streaming), so there is nothing
 * meaningful to count beyond "the run in progress right now".
 *
 *   GET /admin/pii-vault/status — configuration + backing store type
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface PiiVaultRouterDeps {
  enabled: boolean;
  durable: boolean;
  piiTypes: string[];
  /**
   * Active PII detector backends (ADR-0015), e.g. ["regex","ner"]. Empty means
   * the vault uses the legacy sync regex-only path (no configurable pipeline).
   */
  detectors?: string[];
  /**
   * Multimodal (image/file) PII handling mode (ADR-0016): "off" (attachments
   * pass through), "block" (attachments stripped before reaching the provider),
   * or "redact" (attachments redacted via an external service). Default "off".
   */
  multimodalMode?: "off" | "block" | "redact" | "describe";
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

export function createPiiVaultRouter(deps: PiiVaultRouterDeps): Hono {
  const { enabled, durable, piiTypes, detectors } = deps;
  const multimodalMode = deps.multimodalMode ?? "off";
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

  router.get("/admin/pii-vault/status", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);

    return ctx.json({
      enabled,
      durable,
      piiTypes: piiTypes.length > 0 ? piiTypes : "all",
      detectors:
        detectors !== undefined && detectors.length > 0
          ? detectors
          : ["regex (legacy sync)"],
      multimodalMode,
    });
  });

  return router;
}
