// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Compliance / data-retention API (`src/routes/compliance.ts`)
 *
 * Admin-plane control over the data-retention sweep and right-to-be-forgotten
 * (RTBF). Gated by the operator authorizer at `admin` role. Every mutation is
 * written to the audit log so an erasure or manual purge is accountable.
 *
 *   GET  /admin/compliance/status       — configured targets, windows, capabilities
 *   POST /admin/compliance/sweep        — run a retention sweep now (returns report)
 *   POST /admin/compliance/forget       — erase a subject across all stores (RTBF) [admin]
 *
 * Self-service DSAR (Data Subject Access Request) — authenticated user plane:
 *   GET  /v1/me/data                    — export all data held for the calling identity
 *   DELETE /v1/me/data                  — erase all data for the calling identity (RTBF)
 *
 * The forget body is `{ "tenantId"?: string, "userId"?: string }` — at least one
 * must be present (a blank subject would erase everything and is rejected 400).
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type {
  RetentionService,
  ErasureSubject,
} from "../observability/retention.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import { TOKEN_KEY } from "../middleware/auth.js";
import type { AuthContext } from "../middleware/auth.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
  type OperatorIdentity,
} from "../middleware/operator-rbac.js";
import type { CompliancePolicyLoader } from "../compliance/policy-loader.js";
import type { EvalRunHistory } from "../eval/eval-run-history.js";
import type { RedTeamEngine } from "../security/red-team-engine.js";
import {
  generateComplianceDossier,
  formatDossierAsMarkdown,
  type PiiVaultPosture,
} from "../compliance/dossier.js";
import {
  buildDataFlowMap,
  formatDataFlowMapAsMarkdown,
} from "../compliance/data-flow-map.js";
import type { FlowRegistry } from "../graph/flow-parser.js";

export interface ComplianceRouterDeps {
  retention: RetentionService;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  auditLog?: AuditLog;
  /** JWT verifier used to extract the calling user's identity for DSAR endpoints. */
  jwtVerifier?: JwtVerifier;
  /**
   * Optional deps for GET /admin/compliance/dossier. Absent deps degrade the
   * dossier gracefully (e.g. no policy loaded, no eval history, no red-team
   * engine) rather than disabling the endpoint.
   */
  policyLoader?: CompliancePolicyLoader;
  evalRunHistory?: EvalRunHistory;
  redTeamEngine?: RedTeamEngine;
  /** PII vault configuration posture, surfaced in the dossier as config evidence. */
  piiVaultPosture?: PiiVaultPosture;
  /**
   * Optional audit-anchor service (secret-gated). When present the dossier's
   * tamper-evidence claim is derived from a re-verified external anchor, and
   * `GET /admin/compliance/audit-anchor` exposes its status.
   */
  auditAnchor?: import("../observability/audit-anchor.js").AuditAnchorService;
  /**
   * Optional flow registry — powers GET /admin/compliance/ropa (the Art. 30
   * Record of Processing Activities / data-flow map) and the dossier's
   * data-flow section by cross-referencing each flow's declared dataClasses and
   * node providers against the residency policy.
   */
  flowRegistry?: FlowRegistry;
  /**
   * Optional path to a labeled PII-recall dataset. When set, the dossier embeds
   * measured DLP effectiveness (detector recall/precision) as evidence.
   */
  piiRecallDatasetPath?: string;
  /** RoPA residency options: provider→region map and local-provider set. */
  providerRegions?: Record<string, string>;
  localProviders?: readonly string[];
}

export function createComplianceRouter(deps: ComplianceRouterDeps): Hono {
  const router = new Hono();
  const { retention, auditLog } = deps;
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });
  const jwtVerifier = deps.jwtVerifier;

  const guard = async (ctx: Context): Promise<OperatorIdentity | null> => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "flows:write", // admin-level permission
    );
    return r.ok
      ? (r.actor ?? { name: "admin", role: "admin", via: "open" })
      : null;
  };

  const unauthorized = (ctx: Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized — admin access required.",
          type: "authentication_error",
        },
      },
      401,
    );

  // ── Admin-plane endpoints ─────────────────────────────────────────────────

  router.get("/admin/compliance/status", async (ctx) => {
    const actor = await guard(ctx);
    if (actor === null) return unauthorized(ctx);
    return ctx.json({ targets: retention.describeTargets() });
  });

  router.post("/admin/compliance/sweep", async (ctx) => {
    const actor = await guard(ctx);
    if (actor === null) return unauthorized(ctx);
    const report = await retention.sweep();
    const purged = report.reduce((n, e) => n + e.purged, 0);
    auditLog?.record({
      actor: actor.name ?? "admin",
      ...(actor.role !== undefined ? { role: actor.role } : {}),
      action: "compliance.sweep",
      outcome: "success",
      details: { purged, report },
    });
    return ctx.json({ report, purged });
  });

  router.post("/admin/compliance/forget", async (ctx) => {
    const actor = await guard(ctx);
    if (actor === null) return unauthorized(ctx);

    let body: { tenantId?: unknown; userId?: unknown };
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
    const subject: ErasureSubject = {};
    if (typeof body.tenantId === "string" && body.tenantId.trim().length > 0) {
      subject.tenantId = body.tenantId.trim();
    }
    if (typeof body.userId === "string" && body.userId.trim().length > 0) {
      subject.userId = body.userId.trim();
    }
    if (subject.tenantId === undefined && subject.userId === undefined) {
      return ctx.json(
        {
          error: {
            message:
              "Provide at least 'tenantId' or 'userId' to identify the subject.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const report = await retention.forget(subject);
    const erased = report.reduce((n, e) => n + e.erased, 0);
    auditLog?.record({
      actor: actor.name ?? "admin",
      ...(actor.role !== undefined ? { role: actor.role } : {}),
      action: "compliance.forget",
      target: subject.tenantId ?? subject.userId,
      outcome: "success",
      details: { subject, erased, report },
    });
    return ctx.json({ subject, report, erased });
  });

  // ── GET /admin/compliance/dossier ────────────────────────────────────────
  // Auto-generated EU AI Act / GDPR compliance dossier: ties the operator
  // audit report together with audit-chain integrity proof, right-to-be-
  // forgotten evidence, retention posture, model-quality (eval) evidence,
  // security posture, and the architectural guarantees the platform provides
  // — a single document an operator can hand to an auditor. See
  // src/compliance/dossier.ts for the aggregation logic.
  //
  //   GET /admin/compliance/dossier?format=json|markdown[&from=...&to=...]
  router.get("/admin/compliance/dossier", async (ctx) => {
    const actor = await guard(ctx);
    if (actor === null) return unauthorized(ctx);

    const format = ctx.req.query("format") === "markdown" ? "markdown" : "json";
    const windowStart = ctx.req.query("from");
    const windowEnd = ctx.req.query("to");
    const maxViolations = ctx.req.query("maxViolations")
      ? Number(ctx.req.query("maxViolations"))
      : undefined;

    // Measured DLP effectiveness (opt-in): run the PII-recall harness over the
    // configured labeled dataset so the dossier can cite detector recall.
    let dlpEffectiveness:
      | import("../compliance/dossier.js").ComplianceDossier["dlpEffectiveness"]
      | undefined;
    if (deps.piiRecallDatasetPath !== undefined) {
      try {
        const { readFileSync } = await import("node:fs");
        const { parsePiiRecallDataset, evaluatePiiRecall } = await import(
          "../eval/pii-recall.js"
        );
        const raw: unknown = JSON.parse(
          readFileSync(deps.piiRecallDatasetPath, "utf-8"),
        );
        const ds = parsePiiRecallDataset(raw);
        if (ds !== undefined && ds.cases.length > 0) {
          dlpEffectiveness = evaluatePiiRecall(ds);
        }
      } catch {
        /* missing/unreadable dataset — skip the section gracefully */
      }
    }

    const dossier = await generateComplianceDossier(
      {
        auditLog: auditLog ?? {
          record: () => {},
          recordRequired: async () => {},
          list: async () => [],
          verifyChain: async () => ({ valid: true, checked: 0 }),
        },
        retention,
        policy: deps.policyLoader?.policy,
        ...(deps.evalRunHistory !== undefined ? { evalRunHistory: deps.evalRunHistory } : {}),
        ...(deps.redTeamEngine !== undefined ? { redTeamEngine: deps.redTeamEngine } : {}),
        ...(deps.piiVaultPosture !== undefined ? { piiVaultPosture: deps.piiVaultPosture } : {}),
        ...(deps.auditAnchor !== undefined ? { auditAnchor: deps.auditAnchor } : {}),
        ...(deps.flowRegistry !== undefined ? { flows: deps.flowRegistry.list() } : {}),
        ...(dlpEffectiveness !== undefined ? { dlpEffectiveness } : {}),
        dataFlowOptions: {
          ...(deps.providerRegions !== undefined
            ? { providerRegions: deps.providerRegions }
            : {}),
          ...(deps.localProviders !== undefined
            ? { localProviders: new Set(deps.localProviders) }
            : {}),
        },
      },
      {
        ...(windowStart !== undefined ? { windowStart } : {}),
        ...(windowEnd !== undefined ? { windowEnd } : {}),
        ...(maxViolations !== undefined && !Number.isNaN(maxViolations)
          ? { maxRecentViolations: maxViolations }
          : {}),
      },
    );

    auditLog?.record({
      actor: actor.name ?? "admin",
      ...(actor.role !== undefined ? { role: actor.role } : {}),
      action: "compliance.dossier.generate",
      outcome: "success",
      details: { format, windowStart: dossier.windowStart, windowEnd: dossier.windowEnd },
    });

    if (format === "markdown") {
      return ctx.text(formatDossierAsMarkdown(dossier), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="compliance-dossier-${dossier.generatedAt.slice(0, 10)}.md"`,
      });
    }
    return ctx.json(dossier);
  });

  // ── Audit chain external anchor (admin) ──────────────────────────────────
  // GET  re-verifies the latest signed anchor against the current chain.
  // POST forces a new anchor of the current chain tip.
  router.get("/admin/compliance/audit-anchor", async (ctx: Context) => {
    const actor = await guard(ctx);
    if (actor === null) return ctx.json({ error: "forbidden" }, 403);
    if (deps.auditAnchor === undefined) {
      return ctx.json({
        active: false,
        reason:
          "Audit anchoring is not configured — set AUDIT_ANCHOR_SECRET to enable signed external checkpoints.",
      });
    }
    return ctx.json(await deps.auditAnchor.verifyLatest());
  });

  router.post("/admin/compliance/audit-anchor", async (ctx: Context) => {
    const actor = await guard(ctx);
    if (actor === null) return ctx.json({ error: "forbidden" }, 403);
    if (deps.auditAnchor === undefined) {
      return ctx.json(
        {
          error:
            "Audit anchoring is not configured — set AUDIT_ANCHOR_SECRET to enable it.",
        },
        400,
      );
    }
    const anchor = await deps.auditAnchor.anchorNow();
    auditLog?.record({
      actor: actor.name ?? "admin",
      ...(actor.role !== undefined ? { role: actor.role } : {}),
      action: "compliance.audit_anchor",
      outcome: anchor !== undefined ? "success" : "error",
      ...(anchor !== undefined ? { details: { uptoId: anchor.uptoId } } : {}),
    });
    return anchor !== undefined
      ? ctx.json({ ok: true, anchor })
      : ctx.json({ ok: false, reason: "empty chain or signing error" }, 200);
  });

  // ── Record of Processing Activities (Art. 30) / data-flow map (admin) ─────
  // Cross-references each flow's declared dataClasses + node providers against
  // the compliance policy's dataRules → a per-flow processing record with a
  // residency assessment. JSON (default) or ?format=markdown.
  router.get("/admin/compliance/ropa", async (ctx: Context) => {
    const actor = await guard(ctx);
    if (actor === null) return ctx.json({ error: "forbidden" }, 403);
    if (deps.flowRegistry === undefined) {
      return ctx.json(
        { error: "flow registry not available — cannot build the RoPA." },
        503,
      );
    }
    const map = buildDataFlowMap(
      deps.flowRegistry.list(),
      deps.policyLoader?.policy,
      Date.now,
      {
        ...(deps.providerRegions !== undefined
          ? { providerRegions: deps.providerRegions }
          : {}),
        ...(deps.localProviders !== undefined
          ? { localProviders: new Set(deps.localProviders) }
          : {}),
      },
    );
    auditLog?.record({
      actor: actor.name ?? "admin",
      ...(actor.role !== undefined ? { role: actor.role } : {}),
      action: "compliance.ropa.generate",
      outcome: "success",
      details: { flows: map.summary.flows, violations: map.summary.violations },
    });
    if (ctx.req.query("format") === "markdown") {
      return ctx.text(formatDataFlowMapAsMarkdown(map), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="ropa-${map.generatedAt.slice(0, 10)}.md"`,
      });
    }
    return ctx.json(map);
  });

  // ── Self-service DSAR endpoints (user-plane, under /v1/* auth gate) ───────
  //
  // GET  /v1/me/data    — Export a summary of all data held for the caller.
  // DELETE /v1/me/data  — Erase all data for the caller (GDPR Art.17 RTBF).
  //
  // Identity is derived from the authenticated JWT; the caller can only ever
  // act on their own data — there is no way to specify a different subject.
  // The operator audit log records every erasure for accountability.
  // ---------------------------------------------------------------------------

  const dsarRouter = new Hono<AuthContext>();

  /** Extracts the calling user's identity from their JWT. */
  const resolveCallerSubject = (ctx: Context<AuthContext>): ErasureSubject | null => {
    const token = ctx.get(TOKEN_KEY as keyof AuthContext["Variables"]) as string | undefined;
    if (token === undefined || token === "") return null;

    const claims = jwtVerifier?.decodePayload(token) ?? null;
    const email =
      typeof claims?.email === "string" ? (claims.email as string) : undefined;
    const sub =
      typeof claims?.sub === "string" ? (claims.sub as string) : undefined;
    const clientId =
      typeof claims?.client_id === "string"
        ? (claims.client_id as string)
        : undefined;

    const userId = email ?? sub;
    if (userId === undefined) return null;

    return {
      userId,
      ...(clientId !== undefined ? { tenantId: clientId } : {}),
    };
  };

  // GET /v1/me/data — summary of data held for the calling identity.
  // Returns capability metadata per retention target (what is stored and for
  // how long). Does NOT return the actual data rows — that requires a bespoke
  // export per store, which operators can implement via custom RetentionTargets.
  dsarRouter.get("/v1/me/data", async (ctx) => {
    const subject = resolveCallerSubject(ctx as unknown as Context<AuthContext>);
    if (subject === null) {
      return ctx.json(
        {
          error: {
            message:
              "Cannot determine your identity from the provided token. " +
              "Ensure your token contains an 'email' or 'sub' claim.",
            type: "authentication_error",
          },
        },
        401,
      );
    }

    const targets = retention.describeTargets();
    return ctx.json({
      subject: { userId: subject.userId, tenantId: subject.tenantId },
      dataHeld: targets
        .filter((t) => t.subjectErase)
        .map((t) => ({
          store: t.name,
          maxRetentionDays: t.maxAgeDays,
          erasable: true,
          description: `Data in '${t.name}' is retained for ${t.maxAgeDays ?? "an indefinite"} day(s) and can be erased on request.`,
        })),
      requestErasureEndpoint: "DELETE /v1/me/data",
      note: "To receive a full export of your stored data, contact the platform operator.",
    });
  });

  // DELETE /v1/me/data — GDPR Art.17 right-to-erasure for the calling identity.
  dsarRouter.delete("/v1/me/data", async (ctx) => {
    const subject = resolveCallerSubject(ctx as unknown as Context<AuthContext>);
    if (subject === null) {
      return ctx.json(
        {
          error: {
            message:
              "Cannot determine your identity from the provided token.",
            type: "authentication_error",
          },
        },
        401,
      );
    }

    const report = await retention.forget(subject);
    const erased = report.reduce((n, e) => n + e.erased, 0);

    // Record the self-service erasure in the operator audit log.
    auditLog?.record({
      actor: subject.userId ?? "user",
      role: "user",
      action: "dsar.self_erasure",
      target: subject.userId ?? subject.tenantId,
      outcome: "success",
      details: { subject, erased, report },
    });

    return ctx.json({
      message: "Your data has been erased across all applicable stores.",
      subject: { userId: subject.userId, tenantId: subject.tenantId },
      report,
      erased,
    });
  });

  // Mount the DSAR router so its routes participate in the /v1/* auth gate.
  router.route("/", dsarRouter);

  return router;
}
