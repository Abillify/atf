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
 * Erasure responses are honest per store (Req 2.10): every result carries
 * `store`, `status` (`ok`/`failed`/`not_configured`) and the failure cause.
 * The confirmation text is only used when no store reports `failed`; partial
 * results answer HTTP 207 (`ERASURE_PARTIAL`), a total failure HTTP 502.
 *
 * The forget body is `{ "tenantId"?: string, "userId"?: string }` — at least one
 * must be present (a blank subject would erase everything and is rejected 400).
 *
 * No `any` at module boundaries.
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ErasureRequest, ErasureStoreResult } from "@atf/erasure-contract";
import {
  subjectUserIds,
  type RetentionService,
  type ErasureSubject,
} from "../observability/retention.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import { resolveTenantClaim, TOKEN_KEY } from "../middleware/auth.js";
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
import {
  AUDIT_UNAVAILABLE_BODY,
  AUDIT_UNAVAILABLE_STATUS,
} from "../compliance/regulated-actions.js";
import {
  aggregateStatus,
  type ErasureOperationStatus,
  type ErasureOrchestrator,
} from "../compliance/erasure-orchestrator.js";
import {
  erasureSubjectHash,
  ERASURE_RECEIPT_TYPE,
} from "@atf/erasure-contract";
import type { ErasureReceiptEnvelope } from "../compliance/erasure-receipt.js";
import type { FlowRegistry } from "../graph/flow-parser.js";

export interface ComplianceRouterDeps {
  retention: RetentionService;
  /**
   * Optional DSAR erasure orchestrator (Req 2.9). When present, operator
   * erasures fan out to the remote `ERASURE_TARGETS` services as well and
   * every operation is persisted in `erasure_requests` (idempotent, with a
   * retry endpoint for failed stores). Without it the router keeps the
   * local-only `RetentionService` behaviour.
   */
  erasureOrchestrator?: ErasureOrchestrator;
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

  /**
   * Map an aggregate erasure status to its honest HTTP code (Req 2.10):
   * 200 when no store failed, 207 (`ERASURE_PARTIAL`) for a mixed outcome,
   * 502 when every store failed.
   */
  const erasureHttpStatus = (
    status: ErasureOperationStatus,
  ): 200 | 207 | 502 =>
    status === "complete" ? 200 : status === "partial" ? 207 : 502;

  /**
   * Turn a `RetentionService.forget` report into contract-shaped store
   * results so local-only and orchestrated responses share one honest shape.
   */
  const resultsFromReport = (
    report: { target: string; erased: number; error?: string }[],
  ): ErasureStoreResult[] =>
    report.map((entry) => ({
      store: entry.target,
      status: entry.error !== undefined ? "failed" : "ok",
      erased: entry.erased,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    }));

  /** Legacy report shape kept for existing consumers of the forget API. */
  const legacyReport = (results: ErasureStoreResult[]) =>
    results.map((r) => ({
      target: r.store,
      erased: r.erased,
      ...(r.error !== undefined ? { error: r.error } : {}),
    }));

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

    // Orchestrated path (Req 2.9/2.10): with a tenant in scope the erasure
    // fans out to the remote ERASURE_TARGETS services as well and the
    // operation is persisted for idempotent replay and the retry endpoint.
    // Without a tenant the contract request cannot be built — fall back to
    // the local-only retention sweep, which still reports honestly.
    let requestId: string | undefined;
    let results: ErasureStoreResult[];
    let status: ErasureOperationStatus;
    if (
      deps.erasureOrchestrator !== undefined &&
      subject.tenantId !== undefined
    ) {
      const request: ErasureRequest = {
        requestId: randomUUID(),
        tenantId: subject.tenantId,
        scope: subject.userId === undefined ? "tenant" : "subject",
        ...(subject.userId !== undefined
          ? { subject: { userId: subject.userId, externalIds: [] } }
          : {}),
        dryRun: false,
      };
      const operation = await deps.erasureOrchestrator.execute(request);
      requestId = operation.requestId;
      results = operation.results;
      status = operation.status;
    } else {
      results = resultsFromReport(await retention.forget(subject));
      status = aggregateStatus(results);
    }
    const erased = results.reduce((n, r) => n + r.erased, 0);
    // Regulierte Aktion (Req 1.4): an erasure is only reported once the
    // execution is durably audited — the trail is the legal evidence.
    if (auditLog !== undefined) {
      try {
        await auditLog.recordRequired({
          actor: actor.name ?? "admin",
          ...(actor.role !== undefined ? { role: actor.role } : {}),
          action: "compliance.forget",
          target: subject.tenantId ?? subject.userId,
          outcome: status === "complete" ? "success" : "error",
          details: {
            subject,
            erased,
            status,
            ...(requestId !== undefined ? { requestId } : {}),
            report: legacyReport(results),
          },
        });
      } catch {
        return ctx.json(AUDIT_UNAVAILABLE_BODY, AUDIT_UNAVAILABLE_STATUS);
      }
    }
    return ctx.json(
      {
        subject,
        ...(requestId !== undefined ? { requestId } : {}),
        status,
        results,
        report: legacyReport(results),
        erased,
        ...(status === "partial"
          ? {
              error: {
                code: "ERASURE_PARTIAL",
                message:
                  "The erasure completed only partially — see the per-store results.",
              },
            }
          : {}),
      },
      erasureHttpStatus(status),
    );
  });

  // POST /admin/compliance/erasures/{id}/retry — re-run ONLY the stores that
  // reported `failed` for a persisted erasure operation (Req 2.9). Stores that
  // already succeeded are not touched; a fully successful operation replays
  // its stored result unchanged.
  router.post("/admin/compliance/erasures/:id/retry", async (ctx) => {
    const actor = await guard(ctx);
    if (actor === null) return unauthorized(ctx);
    if (deps.erasureOrchestrator === undefined) {
      return ctx.json(
        {
          error: {
            message: "Erasure orchestrator is not configured.",
            type: "invalid_request_error",
            code: "erasure_not_configured",
          },
        },
        400,
      );
    }
    const requestId = ctx.req.param("id");
    const operation = await deps.erasureOrchestrator.retry(requestId);
    if (operation === null) {
      return ctx.json(
        {
          error: {
            message: `No erasure operation '${requestId}'.`,
            type: "invalid_request_error",
            code: "erasure_not_found",
          },
        },
        404,
      );
    }
    auditLog?.record({
      actor: actor.name ?? "admin",
      ...(actor.role !== undefined ? { role: actor.role } : {}),
      action: "compliance.erasure_retry",
      target: operation.tenantId,
      outcome: operation.status === "complete" ? "success" : "error",
      details: { requestId, status: operation.status },
    });
    return ctx.json({
      requestId: operation.requestId,
      status: operation.status,
      erased: operation.erased,
      results: operation.results,
    });
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
        const { parsePiiRecallDataset, evaluatePiiRecall } =
          await import("../eval/pii-recall.js");
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
        ...(deps.evalRunHistory !== undefined
          ? { evalRunHistory: deps.evalRunHistory }
          : {}),
        ...(deps.redTeamEngine !== undefined
          ? { redTeamEngine: deps.redTeamEngine }
          : {}),
        ...(deps.piiVaultPosture !== undefined
          ? { piiVaultPosture: deps.piiVaultPosture }
          : {}),
        ...(deps.auditAnchor !== undefined
          ? { auditAnchor: deps.auditAnchor }
          : {}),
        ...(deps.flowRegistry !== undefined
          ? { flows: deps.flowRegistry.list() }
          : {}),
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
      details: {
        format,
        windowStart: dossier.windowStart,
        windowEnd: dossier.windowEnd,
      },
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

  /**
   * The calling user's erasure identity, from a VERIFIED JWT only.
   *
   * The key is the token's `sub` under its `iss`: both must be present. Several
   * issuers can be trusted at once (JWT_ADDITIONAL_ISSUERS, token_or_oidc) and
   * many IdPs let users set their own email, so `email` is an identifier only
   * when the token also says `email_verified: true` — otherwise a token whose
   * `email` names someone else would erase that person's data. `iss` is
   * required and audited. The execution and usage-log stores record the issuer
   * next to the `sub` and match `(iss = issuer OR iss IS NULL)`, so another
   * issuer's colliding `sub` survives while legacy rows written before the
   * column existed still match by `sub`. Other stores record the bare
   * identifier only and cannot narrow by issuer.
   */
  const resolveCallerSubject = (
    ctx: Context<AuthContext>,
  ): { subject: ErasureSubject; issuer: string } | null => {
    const token = ctx.get(TOKEN_KEY as keyof AuthContext["Variables"]) as
      | string
      | undefined;
    if (token === undefined || token === "") return null;

    // Req 7.4: DSAR subjects act on erasure data, so they must come from a
    // verified credential only. `decodePayload` is an unverified base64 read;
    // with a disabled (Noop) verifier the payload is attacker-chosen and the
    // request resolves to no subject instead of a forged one. (The /v1/* auth
    // middleware has already verified this token's signature.)
    const claims =
      jwtVerifier?.enabled === true ? jwtVerifier.decodePayload(token) : null;
    const nonEmpty = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    const issuer = nonEmpty(claims?.iss);
    const sub = nonEmpty(claims?.sub);
    if (issuer === undefined || sub === undefined) return null;
    const email =
      claims?.email_verified === true ? nonEmpty(claims?.email) : undefined;
    const clientId = nonEmpty(claims?.client_id);

    // Same tenant-claim precedence as the auth middleware (tenant_id →
    // client_id → tid) so the DSAR subject matches the authenticated tenant.
    const tenantId = resolveTenantClaim(claims) ?? clientId;

    return {
      issuer,
      subject: {
        userId: sub,
        ...(email !== undefined && email !== sub ? { userAliases: [email] } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      },
    };
  };

  const noIdentity = (ctx: Context) =>
    ctx.json(
      {
        error: {
          message:
            "Cannot determine your identity from the provided token. " +
            "A verified token with 'iss' and 'sub' claims is required.",
          type: "authentication_error",
        },
      },
      401,
    );

  // GET /v1/me/data — summary of data held for the calling identity.
  // Returns capability metadata per retention target (what is stored and for
  // how long). Does NOT return the actual data rows — that requires a bespoke
  // export per store, which operators can implement via custom RetentionTargets.
  dsarRouter.get("/v1/me/data", async (ctx) => {
    const caller = resolveCallerSubject(ctx as unknown as Context<AuthContext>);
    if (caller === null) return noIdentity(ctx);
    const { subject } = caller;

    const targets = retention.describeTargets();
    return ctx.json({
      subject: { userId: subject.userId, tenantId: subject.tenantId },
      dataHeld: targets
        .filter((t) => t.subjectErase || t.erasureGap !== undefined)
        .map((t) =>
          t.erasureGap !== undefined
            ? {
                store: t.name,
                maxRetentionDays: t.maxAgeDays,
                erasable: false,
                description: `Data in '${t.name}' cannot be erased automatically: ${t.erasureGap}.`,
              }
            : {
                store: t.name,
                maxRetentionDays: t.maxAgeDays,
                erasable: true,
                description: `Data in '${t.name}' is retained for ${t.maxAgeDays ?? "an indefinite"} day(s) and can be erased on request.`,
              },
        ),
      requestErasureEndpoint: "DELETE /v1/me/data",
      note: "To receive a full export of your stored data, contact the platform operator.",
    });
  });

  // DELETE /v1/me/data — GDPR Art.17 right-to-erasure for the calling identity.
  dsarRouter.delete("/v1/me/data", async (ctx) => {
    const caller = resolveCallerSubject(ctx as unknown as Context<AuthContext>);
    if (caller === null) return noIdentity(ctx);
    const { subject, issuer } = caller;
    // Without a tenant claim the erasure would match the caller's identifiers
    // in every tenant. Self-service never erases across tenants.
    if (subject.tenantId === undefined) {
      return ctx.json(
        {
          error: {
            code: "TENANT_REQUIRED",
            message:
              "Self-service erasure requires a tenant claim in your token; " +
              "ask the platform operator to erase across tenants.",
            type: "permission_error",
          },
        },
        403,
      );
    }

    // Fan out through the orchestrator when configured (Req 2.9): remote
    // ERASURE_TARGETS services participate and the operation is persisted
    // for idempotent replay.
    let requestId: string | undefined;
    let results: ErasureStoreResult[];
    let status: ErasureOperationStatus;
    const verifiedEmail = subject.userAliases?.[0];
    if (deps.erasureOrchestrator !== undefined) {
      const request: ErasureRequest = {
        requestId: randomUUID(),
        tenantId: subject.tenantId,
        scope: "subject",
        subject: {
          userId: subject.userId ?? "",
          ...(verifiedEmail !== undefined ? { email: verifiedEmail } : {}),
          externalIds: [],
        },
        dryRun: false,
      };
      const operation = await deps.erasureOrchestrator.execute(request, {
        issuer,
      });
      requestId = operation.requestId;
      results = operation.results;
      status = operation.status;
    } else {
      results = resultsFromReport(
        await retention.forget({ ...subject, issuer }),
      );
      status = aggregateStatus(results);
    }
    const erased = results.reduce((n, r) => n + r.erased, 0);

    // Regulierte Aktion (Req 1.4): record the self-service erasure durably
    // in the operator audit log before confirming it to the data subject.
    if (auditLog !== undefined) {
      try {
        await auditLog.recordRequired({
          actor: subject.userId ?? "user",
          role: "user",
          action: "dsar.self_erasure",
          target: subject.userId ?? subject.tenantId,
          outcome: status === "complete" ? "success" : "error",
          details: {
            subject,
            issuer,
            erased,
            status,
            ...(requestId !== undefined ? { requestId } : {}),
            report: legacyReport(results),
          },
        });
      } catch {
        return ctx.json(AUDIT_UNAVAILABLE_BODY, AUDIT_UNAVAILABLE_STATUS);
      }
    }

    // Req 2.10: the confirmation text is only honest when no store failed.
    const message =
      status === "complete"
        ? "Your data has been erased across all applicable stores."
        : status === "partial"
          ? "Your data could only be erased partially — see the per-store results."
          : "Your data could not be erased — see the per-store results.";

    return ctx.json(
      {
        message,
        requestId,
        status,
        subject: { userId: subject.userId, tenantId: subject.tenantId },
        results,
        report: legacyReport(results),
        erased,
        ...(status === "partial"
          ? { error: { code: "ERASURE_PARTIAL", message } }
          : {}),
      },
      erasureHttpStatus(status),
    );
  });

  // GET /v1/me/data/erasures/{id} — the signed Erasure_Receipt for a DSAR the
  // calling identity performed (Req 2.11). Only receipts whose tenant AND a
  // subject hash derived from the caller's own identifiers match are
  // returned; the receipt itself never contains cleartext personal data.
  dsarRouter.get("/v1/me/data/erasures/:id", async (ctx) => {
    const caller = resolveCallerSubject(ctx as unknown as Context<AuthContext>);
    if (caller === null) return noIdentity(ctx);
    const { subject } = caller;
    if (
      deps.erasureOrchestrator === undefined ||
      subject.tenantId === undefined
    ) {
      return ctx.json(
        {
          error: {
            code: "ERASURE_NOT_CONFIGURED",
            message: "Erasure receipts are not available.",
          },
        },
        400,
      );
    }
    const operation = await deps.erasureOrchestrator.getByReceiptId(
      ctx.req.param("id"),
    );
    const envelope = operation?.receipt as ErasureReceiptEnvelope | undefined;
    if (
      operation === undefined ||
      envelope === undefined ||
      envelope.typ !== ERASURE_RECEIPT_TYPE ||
      envelope.payload.receiptId !== ctx.req.param("id")
    ) {
      return ctx.json(
        {
          error: {
            code: "ERASURE_RECEIPT_NOT_FOUND",
            message: "No such erasure receipt.",
          },
        },
        404,
      );
    }
    // Ownership: same tenant, and (for subject-scoped receipts) at least one
    // hash of the caller's own identifiers appears in the receipt.
    if (envelope.payload.tenantId !== subject.tenantId) {
      return ctx.json(
        {
          error: {
            code: "ERASURE_RECEIPT_NOT_FOUND",
            message: "No such erasure receipt.",
          },
        },
        404,
      );
    }
    if (envelope.payload.scope !== "tenant") {
      const callerHashes = new Set(
        subjectUserIds(subject).map((id) =>
          erasureSubjectHash(subject.tenantId as string, id),
        ),
      );
      const owns = envelope.payload.subjectHashes.some((h) =>
        callerHashes.has(h),
      );
      if (!owns) {
        return ctx.json(
          {
            error: {
              code: "ERASURE_RECEIPT_NOT_FOUND",
              message: "No such erasure receipt.",
            },
          },
          404,
        );
      }
    }
    return ctx.json({ receipt: envelope });
  });

  // Mount the DSAR router so its routes participate in the /v1/* auth gate.
  router.route("/", dsarRouter);

  return router;
}
