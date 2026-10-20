// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision-Provenance Explainability Card route (`src/routes/explain.ts`)
 *
 *   GET /monitoring/explain/:executionId
 *       Returns the assembled {@link ExplainCard} for one execution — the
 *       node path taken, models used, tool calls, routing decisions,
 *       groundedness verdict, PII vault actions, and any operator actions
 *       recorded against it. See `src/observability/explain.ts` for the
 *       aggregation logic and source degradation notes.
 *
 *       ?format=markdown returns a downloadable Markdown rendering (same
 *       one-click-artefact pattern as the compliance dossier / RoPA).
 *
 * Gated by `monitoring:read` (Operator RBAC) — same plane as `/monitoring/*`.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { DebugTraceStore } from "../monitoring/debug-trace-store.js";
import type { PiiVault } from "../graph/pii-vault.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { AuditAnchorService } from "../observability/audit-anchor.js";
import {
  buildExplainCard,
  renderExplainCardMarkdown,
  type ExplainHistorySource,
} from "../observability/explain.js";
import {
  buildEvidenceBundle,
  signEvidenceBundle,
  renderEvidenceBundleMarkdown,
} from "../observability/evidence-bundle.js";
import type { Ed25519EvidenceKey } from "../observability/evidence-key.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";
import { normalizeExecutionId } from "../util/execution-id.js";

export interface ExplainRouterDeps {
  history: ExplainHistorySource;
  debugTraceStore?: DebugTraceStore;
  piiVault?: PiiVault;
  auditLog?: AuditLog;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  /** Optional audit-anchor service — its status is embedded in a signed bundle. */
  auditAnchor?: AuditAnchorService;
  /**
   * Ed25519 evidence key (ADR 0030). When set, bundles are signed with it
   * (`algorithm: "ed25519"`) and third parties can verify offline via the
   * published JWKS — no shared secret needed. Preferred over
   * `evidenceBundleSecret`.
   */
  evidenceBundleKey?: Ed25519EvidenceKey;
  /**
   * HMAC secret for signing `GET /monitoring/explain/:executionId/bundle`. Falls
   * back to `AUDIT_ANCHOR_SECRET` when unset (see the route handler) so a
   * deployment that already anchors its audit chain does not need a SECOND
   * secret just to sign evidence bundles. When neither this nor
   * `evidenceBundleKey` is configured, the bundle endpoint is disabled (404)
   * rather than silently signing with an empty/default secret.
   */
  evidenceBundleSecret?: string;
}

function unauthorized(ctx: Context) {
  return ctx.json(
    {
      error: {
        message: "Unauthorized operator access.",
        type: "authentication_error",
      },
    },
    401,
  );
}

export function createExplainRouter(deps: ExplainRouterDeps): Hono {
  const router = new Hono();
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  router.get("/monitoring/explain/:executionId", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);

    // Accept either the bare execution uuid or the `chatcmpl-<uuid>` id the
    // chat endpoints report, so operators can paste whichever they have.
    const executionId = normalizeExecutionId(ctx.req.param("executionId"));
    const card = await buildExplainCard(
      {
        history: deps.history,
        ...(deps.debugTraceStore !== undefined
          ? { debugTraceStore: deps.debugTraceStore }
          : {}),
        ...(deps.piiVault !== undefined ? { piiVault: deps.piiVault } : {}),
        ...(deps.auditLog !== undefined ? { auditLog: deps.auditLog } : {}),
      },
      executionId,
    );

    if (card === undefined) {
      return ctx.json(
        {
          error: {
            message: `No execution history found for "${executionId}". It may not exist, or may have aged out of retention.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }

    if (ctx.req.query("format") === "markdown") {
      const markdown = renderExplainCardMarkdown(card);
      ctx.header("Content-Type", "text/markdown; charset=utf-8");
      ctx.header(
        "Content-Disposition",
        `attachment; filename="explain-${executionId}.md"`,
      );
      return ctx.body(markdown);
    }

    return ctx.json({ card });
  });

  // ── GET /monitoring/explain/:executionId/bundle ────────────────────────
  // The same ExplainCard, wrapped into a SIGNED Verifiable Evidence Bundle
  // (see observability/evidence-bundle.ts). ?format=markdown returns a
  // downloadable artefact that also documents how to verify it offline via
  // `bun run scripts/cli.ts verify-bundle`.
  router.get("/monitoring/explain/:executionId/bundle", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);

    // Prefer the asymmetric Ed25519 evidence key (ADR 0030): bundles signed
    // with it are verifiable by third parties via the published JWKS.
    const signingKey: Ed25519EvidenceKey | string | undefined =
      deps.evidenceBundleKey ??
      (deps.evidenceBundleSecret !== undefined &&
      deps.evidenceBundleSecret.trim().length > 0
        ? deps.evidenceBundleSecret
        : undefined);
    if (signingKey === undefined) {
      return ctx.json(
        {
          error: {
            message:
              "Evidence bundle signing is not configured. Set EVIDENCE_SIGNING_KEY " +
              "(recommended — Ed25519, third-party verifiable) or EVIDENCE_BUNDLE_SECRET " +
              "(or AUDIT_ANCHOR_SECRET, which it falls back to) to enable this endpoint.",
            type: "not_found_error",
          },
        },
        404,
      );
    }

    const executionId = normalizeExecutionId(ctx.req.param("executionId"));
    const card = await buildExplainCard(
      {
        history: deps.history,
        ...(deps.debugTraceStore !== undefined
          ? { debugTraceStore: deps.debugTraceStore }
          : {}),
        ...(deps.piiVault !== undefined ? { piiVault: deps.piiVault } : {}),
        ...(deps.auditLog !== undefined ? { auditLog: deps.auditLog } : {}),
      },
      executionId,
    );
    if (card === undefined) {
      return ctx.json(
        {
          error: {
            message: `No execution history found for "${executionId}". It may not exist, or may have aged out of retention.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }

    const auditAnchorStatus =
      deps.auditAnchor !== undefined ? deps.auditAnchor.status() : undefined;
    const bundle = buildEvidenceBundle(card, {
      ...(auditAnchorStatus !== undefined
        ? { auditAnchor: auditAnchorStatus }
        : {}),
    });
    const signed = signEvidenceBundle(bundle, signingKey);

    if (ctx.req.query("format") === "markdown") {
      const markdown = renderEvidenceBundleMarkdown(signed);
      ctx.header("Content-Type", "text/markdown; charset=utf-8");
      ctx.header(
        "Content-Disposition",
        `attachment; filename="evidence-bundle-${executionId}.md"`,
      );
      return ctx.body(markdown);
    }

    ctx.header(
      "Content-Disposition",
      `attachment; filename="evidence-bundle-${executionId}.json"`,
    );
    return ctx.json(signed);
  });

  return router;
}
