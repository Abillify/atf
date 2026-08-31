// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant operator plane (`src/routes/assistants-admin.ts`)
 *
 * The counterpart to `src/routes/assistants.ts`. That router is reached with a
 * USER's identity and can only ever touch that user's own assistants. This one is
 * reached with an OPERATOR credential and spans users, because the questions it
 * answers are organisational: which assistants exist, which ones are learning things
 * nobody approved, and what limits apply to all of them.
 *
 * ## Why this is a second router and not a flag on the first
 *
 * The two planes authenticate differently. The user plane derives its scope from the
 * caller's own identity headers; the operator plane authorises a role and then names
 * a scope explicitly. Folding both into one router would mean a single handler where
 * "whose assistant is this?" depends on a branch — and a mistake in that branch is a
 * cross-user data leak. Two routers make the boundary structural: nothing here reads
 * caller identity, and nothing there accepts a foreign scope.
 *
 * ## Write classes
 *
 * The soul has three (`soul-document.ts`). This router exposes exactly one: the
 * operator's `constraints`. Identity belongs to the assistant, directives to the
 * user, and an operator who could rewrite a user's directives would be editing that
 * person's instructions to their own assistant behind their back.
 *
 *   GET   /admin/assistants                        — list across users (paged)
 *   GET   /admin/assistants/:tenantId/:userId/:id   — one assistant in full
 *   PATCH /admin/assistants/:tenantId/:userId/:id/constraints — operator write class
 *   PATCH /admin/assistants/:tenantId/:userId/:id   — status / autonomy
 *   GET   /admin/assistants/:tenantId/:userId/:id/proposals   — learned queue
 *   POST  /admin/assistants/:tenantId/:userId/:id/proposals/:proposalId/reject
 *
 * ## Identity Broker / Revocation Console
 *
 * `AssistantScope` is the platform's identity axis for delegated authority
 * (`execution-authority.ts`): a delegation grant lets an assistant act with a
 * fraction of its user's authority while that user is absent. The two routes
 * below are the operator's console over that primitive — spanning every
 * tenant/user/assistant, which the user-plane `DELETE /v1/assistants/:id/delegation`
 * (scoped to the caller's own assistant) cannot do:
 *
 *   GET    /admin/identity-broker/delegations                          — cross-scope listing
 *   DELETE /admin/assistants/:tenantId/:userId/:id/delegation?issuer=… — revoke + invalidate cache
 *
 * Revocation is two steps, both required: `CredentialStore.revoke` stops the
 * grant from being used to mint a NEW access token, and
 * `AuthorityResolver.invalidateDelegatedToken` drops any token already minted
 * and cached — without the second step a revoked assistant keeps working
 * until that cached token's own (short) TTL expires on its own.
 *
 * ## Org Skill Registry
 *
 * The operator plane's role over the tenant-wide skill catalog
 * (`org-skill-registry.ts`) is deliberately narrow, for the same reason it
 * has no proposal-apply route: publishing and installing are both USER
 * decisions (the source assistant's user chose to publish; the destination
 * assistant's user chose to install). The one thing an operator legitimately
 * does here is remove a bad entry from circulation:
 *
 *   GET  /admin/org-skills?tenantId=…             — cross-tenant browse (any status)
 *   POST /admin/org-skills/:id/deprecate          — hide a catalog entry from new installs
 *
 * `deprecate` never touches an assistant that already installed the entry —
 * an install is a copy into that assistant's own proposal pipeline (see the
 * module doc comment on `org-skill-registry.ts`), so there is nothing live
 * to retract; only future browsing/installing is affected.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createOperatorAuthorizer, type OperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { AssistantRuntime } from "../assistants/assistant-runtime.js";
import type { Logger } from "../observability/logger.js";
import type { AuditLog } from "../observability/audit-log.js";
import {
  normalizeTenantId,
  sanitizeIdentitySegment,
  type AssistantScope,
  type AssistantStatus,
} from "../assistants/types.js";
import { SoulRevisionConflictError } from "../assistants/soul-store.js";
import { ProposalTransitionError } from "../assistants/proposal-store.js";
import type { DelegationState } from "../assistants/execution-authority.js";
import type { OrgSkillStatus } from "../assistants/types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Operator constraints.
 *
 * `null` clears a field, mirroring the user-plane directive patch so a client that
 * knows one shape knows the other.
 */
const constraintsSchema = z
  .object({
    /** Non-negotiable rules ("never send external email"). */
    rules: z.string().max(4_000).nullable().optional(),
    /** Compliance/legal framing the assistant must respect. */
    compliance: z.string().max(4_000).nullable().optional(),
    /**
     * Tool ids the assistant may never call. A list, not prose — enforced by the
     * tool-authz layer, with the prompt copy existing only so the model knows why a
     * tool is absent instead of repeatedly attempting it.
     *
     * An empty array clears the list; `null` is not accepted for it because "no
     * denied tools" already has a representation.
     */
    deniedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
    expectedRevisionHash: z.string().optional(),
    reason: z.string().max(500).optional(),
  })
  // Closed, so a request naming a field this API does not have is REFUSED rather than
  // accepted-and-ignored. An operator who mistypes a constraint field must not get a
  // 200 back while the assistant keeps its old limits.
  .strict();

/** The prose constraint fields, in the order `soul-document.ts` declares them. */
const CONSTRAINT_TEXT_FIELDS = ["rules", "compliance"] as const;

const adminUpdateSchema = z.object({
  status: z.enum(["active", "suspended", "archived"]).optional(),
  autonomy: z.enum(["supervised", "assisted", "autonomous"]).optional(),
  reason: z.string().max(500).optional(),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface AssistantsAdminRouterDeps {
  runtime: AssistantRuntime;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  logger?: Logger;
  /** Records revocation-console actions. Optional — recording is best-effort. */
  auditLog?: AuditLog;
}

export function createAssistantsAdminRouter(deps: AssistantsAdminRouterDeps): Hono {
  const { runtime } = deps;
  const authRequired = deps.authRequired ?? false;
  const operatorAuth = deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });
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

  /**
   * Authorises the request for a permission, or writes 401.
   *
   * Reads are `monitoring:read`; every mutation below asks for `monitoring:write`,
   * so a read-only operator role can inspect the estate without being able to change
   * a single assistant's limits.
   */
  const authorize = async (
    ctx: import("hono").Context,
    permission: "monitoring:read" | "monitoring:write",
  ): Promise<boolean> => {
    const result = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      permission,
    );
    return result.ok;
  };

  /**
   * Builds the scope from the path.
   *
   * The operator names all three parts explicitly. Sanitising the assistant segment
   * (rather than trusting it) keeps the same guarantee the user plane has: no path
   * value ever reaches the workspace resolver as path syntax.
   */
  const scopeFromPath = (
    tenantIdRaw: string,
    userIdRaw: string,
    assistantIdRaw: string,
  ): AssistantScope | undefined => {
    const assistantId = sanitizeIdentitySegment(assistantIdRaw);
    const userId = userIdRaw.trim();
    if (assistantId === undefined || userId.length === 0) return undefined;
    return {
      tenantId: normalizeTenantId(tenantIdRaw),
      userId,
      assistantId,
    };
  };

  const badScope = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "Path does not name a valid (tenant, user, assistant).",
          type: "invalid_request_error",
        },
      },
      400,
    );

  // -- Estate listing -------------------------------------------------------

  router.get("/admin/assistants", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:read"))) return unauthorized(ctx);
    const statusRaw = ctx.req.query("status");
    const status: AssistantStatus | undefined =
      statusRaw === "active" || statusRaw === "suspended" || statusRaw === "archived"
        ? statusRaw
        : undefined;
    const limitRaw = Number(ctx.req.query("limit") ?? "");
    const offsetRaw = Number(ctx.req.query("offset") ?? "");
    const page = await runtime.stores.assistants.listForOperator({
      ...(ctx.req.query("tenantId") !== undefined
        ? { tenantId: normalizeTenantId(ctx.req.query("tenantId")) }
        : {}),
      ...(ctx.req.query("userId") !== undefined
        ? { userId: ctx.req.query("userId") as string }
        : {}),
      ...(status !== undefined ? { status } : {}),
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      ...(Number.isFinite(offsetRaw) ? { offset: offsetRaw } : {}),
    });
    return ctx.json({
      total: page.total,
      assistants: page.assistants.map((summary) => ({
        tenantId: summary.scope.tenantId,
        userId: summary.scope.userId,
        assistantId: summary.scope.assistantId,
        displayName: summary.displayName,
        status: summary.status,
        autonomy: summary.autonomy,
        updatedAt: summary.updatedAt,
        lastActiveAt: summary.lastActiveAt,
        skillCount: summary.skillCount,
        pendingProposalCount: summary.pendingProposalCount,
      })),
    });
  });

  // -- Identity Broker: cross-scope delegation listing (Revocation Console) --

  router.get("/admin/identity-broker/delegations", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:read"))) return unauthorized(ctx);
    const stateRaw = ctx.req.query("state");
    const state: DelegationState["status"] | undefined =
      stateRaw === "absent" ||
      stateRaw === "revoked" ||
      stateRaw === "broken" ||
      stateRaw === "usable"
        ? stateRaw
        : undefined;
    const limitRaw = Number(ctx.req.query("limit") ?? "");
    const offsetRaw = Number(ctx.req.query("offset") ?? "");
    const page = await runtime.stores.credentials.listForOperator({
      ...(ctx.req.query("tenantId") !== undefined
        ? { tenantId: normalizeTenantId(ctx.req.query("tenantId")) }
        : {}),
      ...(ctx.req.query("userId") !== undefined
        ? { userId: ctx.req.query("userId") as string }
        : {}),
      ...(ctx.req.query("assistantId") !== undefined
        ? { assistantId: ctx.req.query("assistantId") as string }
        : {}),
      ...(state !== undefined ? { state } : {}),
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      ...(Number.isFinite(offsetRaw) ? { offset: offsetRaw } : {}),
    });
    return ctx.json({
      total: page.total,
      delegations: page.delegations.map((summary) => ({
        tenantId: summary.scope.tenantId,
        userId: summary.scope.userId,
        assistantId: summary.scope.assistantId,
        issuer: summary.issuer,
        consentedScope: summary.consentedScope,
        subject: summary.subject,
        grantedAt: summary.grantedAt,
        grantedBy: summary.grantedBy,
        lastRefreshedAt: summary.lastRefreshedAt,
        refreshFailures: summary.refreshFailures,
        revoked: summary.revoked,
        state: summary.state,
        // Never the refresh token — no plane returns it, operator included.
      })),
    });
  });

  router.delete(
    "/admin/assistants/:tenantId/:userId/:id/delegation",
    async (ctx) => {
      const auth = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:write",
      );
      if (!auth.ok) return unauthorized(ctx);
      const scope = scopeFromPath(
        ctx.req.param("tenantId"),
        ctx.req.param("userId"),
        ctx.req.param("id"),
      );
      if (scope === undefined) return badScope(ctx);
      // A query param, not a path segment — an issuer is a URL (e.g.
      // "https://idp.example.com/realms/main") and would break path parsing
      // as a segment. Mirrors the user-plane DELETE .../delegation route.
      const issuer = ctx.req.query("issuer");
      if (issuer === undefined || issuer.length === 0) {
        return ctx.json(
          {
            error: {
              message: "An `issuer` query parameter is required.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      await runtime.stores.credentials.revoke(scope, issuer);
      // See the module doc comment: revocation is not complete until any
      // already-minted, still-cached access token is also dropped.
      runtime.stores.authority.invalidateDelegatedToken(scope, issuer);
      deps.logger?.info("Operator revoked assistant delegation", {
        tenantId: scope.tenantId,
        assistantId: scope.assistantId,
        issuer,
      });
      deps.auditLog?.record({
        actor: auth.actor?.name ?? "operator",
        ...(auth.actor?.role !== undefined ? { role: auth.actor.role } : {}),
        action: "assistant.delegation.revoke",
        target: `${scope.tenantId}/${scope.userId}/${scope.assistantId}`,
        details: { issuer },
      });
      return ctx.json({ revoked: true });
    },
  );

  // -- Org Skill Registry: cross-tenant browse + deprecate -------------------

  router.get("/admin/org-skills", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:read"))) return unauthorized(ctx);
    const orgSkills = runtime.stores.orgSkills;
    if (orgSkills === undefined) {
      return ctx.json({ total: 0, skills: [] });
    }
    const tenantIdRaw = ctx.req.query("tenantId");
    if (tenantIdRaw === undefined || tenantIdRaw.length === 0) {
      return ctx.json(
        {
          error: {
            message: "A `tenantId` query parameter is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const statusRaw = ctx.req.query("status");
    const status: OrgSkillStatus | undefined =
      statusRaw === "published" || statusRaw === "deprecated" ? statusRaw : undefined;
    const limitRaw = Number(ctx.req.query("limit") ?? "");
    const offsetRaw = Number(ctx.req.query("offset") ?? "");
    const page = await orgSkills.list({
      tenantId: normalizeTenantId(tenantIdRaw),
      ...(status !== undefined ? { status } : {}),
      ...(ctx.req.query("q") !== undefined ? { query: ctx.req.query("q") as string } : {}),
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      ...(Number.isFinite(offsetRaw) ? { offset: offsetRaw } : {}),
    });
    return ctx.json({
      total: page.total,
      skills: page.skills.map((s) => ({
        id: s.id,
        tenantId: s.tenantId,
        name: s.name,
        triggerLine: s.triggerLine,
        body: s.body,
        status: s.status,
        summary: s.summary,
        evidence: s.evidence,
        installCount: s.installCount,
        publishedBy: s.publishedBy,
        sourceUserId: s.sourceScope.userId,
        sourceAssistantId: s.sourceScope.assistantId,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
  });

  router.post("/admin/org-skills/:orgSkillId/deprecate", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:write"))) return unauthorized(ctx);
    const orgSkills = runtime.stores.orgSkills;
    if (orgSkills === undefined) {
      return ctx.json(
        {
          error: {
            message: "The org skill registry is not available on this deployment.",
            type: "not_found",
          },
        },
        404,
      );
    }
    const tenantIdRaw = ctx.req.query("tenantId");
    if (tenantIdRaw === undefined || tenantIdRaw.length === 0) {
      return ctx.json(
        {
          error: {
            message: "A `tenantId` query parameter is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const tenantId = normalizeTenantId(tenantIdRaw);
    const orgSkillId = ctx.req.param("orgSkillId");
    const entry = await orgSkills.get(tenantId, orgSkillId);
    if (entry === undefined) {
      return ctx.json({ error: { message: "Catalog entry not found.", type: "not_found" } }, 404);
    }
    await orgSkills.deprecate(tenantId, orgSkillId);
    deps.logger?.info("Operator deprecated an org skill catalog entry", {
      tenantId,
      orgSkillId,
      name: entry.name,
    });
    deps.auditLog?.record({
      actor: "operator",
      action: "org-skill.deprecate",
      target: `${tenantId}/${orgSkillId}`,
      details: { name: entry.name },
    });
    return ctx.json({ deprecated: true });
  });

  // -- One assistant --------------------------------------------------------

  router.get("/admin/assistants/:tenantId/:userId/:id", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:read"))) return unauthorized(ctx);
    const scope = scopeFromPath(
      ctx.req.param("tenantId"),
      ctx.req.param("userId"),
      ctx.req.param("id"),
    );
    if (scope === undefined) return badScope(ctx);
    const record = await runtime.stores.assistants.get(scope);
    if (record === undefined) {
      return ctx.json({ error: { message: "Assistant not found.", type: "not_found" } }, 404);
    }
    const [soul, skills, delegations] = await Promise.all([
      runtime.stores.souls.get(scope),
      runtime.stores.skills.listAll(scope, { includeRetired: false }),
      runtime.stores.credentials.list(scope),
    ]);
    return ctx.json({
      tenantId: scope.tenantId,
      userId: scope.userId,
      assistantId: scope.assistantId,
      displayName: record.displayName,
      status: record.status,
      autonomy: record.autonomy,
      workspacePath: record.workspacePath,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      soul: {
        // All three classes are READABLE here — an operator investigating a
        // misbehaving assistant needs to see what it was told, by whom. Only
        // `constraints` is writable.
        identity: soul.identity,
        directives: soul.directives,
        constraints: soul.constraints,
        revision: soul.revision,
        revisionHash: soul.revisionHash,
      },
      skills: skills.map((skill) => ({
        name: skill.name,
        triggerLine: skill.triggerLine,
        origin: skill.origin,
        status: skill.status,
        version: skill.version,
        useCount: skill.useCount,
      })),
      // Summaries only. The refresh token is not returned on any plane, operator
      // included: holding it would let an operator act as the user at their IdP.
      delegations,
    });
  });

  // -- Constraints: the operator's write class -------------------------------

  router.patch("/admin/assistants/:tenantId/:userId/:id/constraints", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:write"))) return unauthorized(ctx);
    const scope = scopeFromPath(
      ctx.req.param("tenantId"),
      ctx.req.param("userId"),
      ctx.req.param("id"),
    );
    if (scope === undefined) return badScope(ctx);
    const parsed = constraintsSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json(
        {
          error: {
            message: parsed.error.issues[0]?.message ?? "Invalid body",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const { CLEAR_FIELD } = await import("../assistants/soul-document.js");
    const constraints: Record<string, string | string[]> = {};
    for (const field of CONSTRAINT_TEXT_FIELDS) {
      const value = parsed.data[field];
      if (value === null) constraints[field] = CLEAR_FIELD;
      else if (value !== undefined) constraints[field] = value;
    }
    if (parsed.data.deniedTools !== undefined) {
      constraints.deniedTools = parsed.data.deniedTools;
    }
    if (Object.keys(constraints).length === 0) {
      return ctx.json(
        {
          error: {
            message: "No constraint fields supplied.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    try {
      const result = await runtime.stores.souls.mutate({
        scope,
        actorType: "operator",
        // The role, not a person: the operator credential authorises a role and
        // does not necessarily carry an identity. Recording "operator" is honest;
        // recording a guessed name would not be.
        actorId: "operator",
        ...(parsed.data.expectedRevisionHash !== undefined
          ? { expectedRevisionHash: parsed.data.expectedRevisionHash }
          : {}),
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        patch: { constraints },
      });
      deps.logger?.info("Operator updated assistant constraints", {
        tenantId: scope.tenantId,
        assistantId: scope.assistantId,
        revision: result.record.revision,
      });
      return ctx.json({
        changed: result.changed,
        revision: result.record.revision,
        revisionHash: result.record.revisionHash,
        constraints: result.record.constraints,
      });
    } catch (err) {
      if (err instanceof SoulRevisionConflictError) {
        return ctx.json(
          {
            error: { message: err.message, type: "conflict" },
            currentRevision: err.currentRevision,
            currentRevisionHash: err.currentRevisionHash,
          },
          409,
        );
      }
      throw err;
    }
  });

  // -- Status and autonomy --------------------------------------------------

  router.patch("/admin/assistants/:tenantId/:userId/:id", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:write"))) return unauthorized(ctx);
    const scope = scopeFromPath(
      ctx.req.param("tenantId"),
      ctx.req.param("userId"),
      ctx.req.param("id"),
    );
    if (scope === undefined) return badScope(ctx);
    const parsed = adminUpdateSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (
      !parsed.success ||
      (parsed.data.status === undefined && parsed.data.autonomy === undefined)
    ) {
      return ctx.json(
        {
          error: {
            message: "Supply `status` and/or `autonomy`.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    try {
      if (parsed.data.status === "archived") {
        // Archive rather than update-to-archived: archiving retains learned state
        // and records a reason, which a plain status write would not.
        await runtime.stores.assistants.archive(scope, parsed.data.reason);
        const record = await runtime.stores.assistants.get(scope);
        return ctx.json({ status: record?.status ?? "archived" });
      }
      const record = await runtime.stores.assistants.update(scope, {
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.autonomy !== undefined ? { autonomy: parsed.data.autonomy } : {}),
      });
      deps.logger?.info("Operator updated assistant", {
        tenantId: scope.tenantId,
        assistantId: scope.assistantId,
        status: record.status,
        autonomy: record.autonomy,
      });
      return ctx.json({ status: record.status, autonomy: record.autonomy });
    } catch (err) {
      return ctx.json(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "not_found",
          },
        },
        404,
      );
    }
  });

  // -- Learned-procedure queue ----------------------------------------------

  router.get("/admin/assistants/:tenantId/:userId/:id/proposals", async (ctx) => {
    if (!(await authorize(ctx, "monitoring:read"))) return unauthorized(ctx);
    const scope = scopeFromPath(
      ctx.req.param("tenantId"),
      ctx.req.param("userId"),
      ctx.req.param("id"),
    );
    if (scope === undefined) return badScope(ctx);
    const statusRaw = ctx.req.query("status");
    const status =
      statusRaw === "pending" ||
      statusRaw === "applied" ||
      statusRaw === "rejected" ||
      statusRaw === "quarantined" ||
      statusRaw === "stale"
        ? statusRaw
        : undefined;
    const proposals = await runtime.stores.proposals.list(scope, {
      ...(status !== undefined ? { status } : {}),
    });
    return ctx.json({
      proposals: proposals.map((proposal) => ({
        id: proposal.id,
        kind: proposal.kind,
        status: proposal.status,
        title: proposal.title,
        triggerLine: proposal.triggerLine,
        body: proposal.body,
        autonomousCapture: proposal.autonomousCapture,
        scanState: proposal.scanState,
        scanFindings: proposal.scanFindings,
        createdAt: proposal.createdAt,
      })),
    });
  });

  /**
   * Operator rejection.
   *
   * There is deliberately no operator APPLY. Approving a procedure into someone's
   * assistant is that person's call — an operator who could apply would be teaching
   * a user's assistant behaviour the user never agreed to. Rejecting is the opposite
   * direction and is squarely the operator's business: it removes something.
   */
  router.post(
    "/admin/assistants/:tenantId/:userId/:id/proposals/:proposalId/reject",
    async (ctx) => {
      if (!(await authorize(ctx, "monitoring:write"))) return unauthorized(ctx);
      const scope = scopeFromPath(
        ctx.req.param("tenantId"),
        ctx.req.param("userId"),
        ctx.req.param("id"),
      );
      if (scope === undefined) return badScope(ctx);
      const parsed = rejectSchema.safeParse(await ctx.req.json().catch(() => ({})));
      try {
        const proposal = await runtime.stores.proposals.reject({
          scope,
          proposalId: ctx.req.param("proposalId"),
          actorType: "operator",
          actorId: "operator",
          ...(parsed.success && parsed.data.reason !== undefined
            ? { reason: parsed.data.reason }
            : {}),
        });
        return ctx.json({ rejected: true, status: proposal.status });
      } catch (err) {
        if (err instanceof ProposalTransitionError) {
          return ctx.json({ error: { message: err.message, type: "conflict" } }, 409);
        }
        const message = err instanceof Error ? err.message : String(err);
        return ctx.json({ error: { message, type: "not_found" } }, 404);
      }
    },
  );

  return router;
}
