// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant management API (`src/routes/assistants.ts`)
 *
 * The surface a user manages their own assistants through: list them, set their
 * directives, review learned procedures, grant delegation, and open a message
 * channel to a peer.
 *
 * ## Every route is scoped to the caller
 *
 * There is no assistant id in a path that is not resolved against the AUTHENTICATED
 * user. A user cannot read, configure or grant anything for another user's assistant,
 * and the check is not a filter applied afterwards — the scope is built from the
 * token and the path only supplies the assistant segment. That is why none of these
 * handlers take a user id.
 *
 * ## Write classes are enforced by the route, not by the caller
 *
 * The soul has three write classes (`soul-document.ts`). This API exposes only the
 * user's: `PATCH /directives`. Identity is the assistant's own (via its
 * `soul_update` tool) and constraints are the operator's (via the operator plane),
 * so neither has a route here. A single "patch the soul" endpoint would have made the
 * class boundary a matter of request-body validation instead of a matter of which
 * endpoint exists.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AuthContext } from "../middleware/auth.js";
import { AUTH_PRINCIPAL_KEY, TOKEN_KEY } from "../middleware/auth.js";
import type { Logger } from "../observability/logger.js";
import type { AssistantRuntime } from "../assistants/assistant-runtime.js";
import type { AssistantSessionIndex } from "../assistants/session-index.js";
import { AssistantParentRunNotFoundError } from "../assistants/run-store.js";
import {
  RocketChatBindingConflictError,
  type RocketChatChannel,
} from "../assistants/rocketchat-channel.js";
import {
  resolveAssistantScope,
  sanitizeIdentitySegment,
  type AssistantScope,
} from "../assistants/types.js";
import {
  SoulRevisionConflictError,
  SoulWriteClassError,
} from "../assistants/soul-store.js";
import {
  ProposalConflictError,
  ProposalScanBlockedError,
  ProposalTransitionError,
} from "../assistants/proposal-store.js";
import {
  DelegationConsentError,
  DelegationEncryptionUnavailableError,
} from "../assistants/credential-store.js";
import { decideGrantCreation } from "../assistants/messaging-policy.js";
import { OrgSkillScanBlockedError, installOrgSkill, OrgSkillNotInstallableError } from "../assistants/org-skill-registry.js";
import { resolveAssistantCaller } from "./assistant-caller.js";

// ---------------------------------------------------------------------------
// Identity extraction
// ---------------------------------------------------------------------------

/** JSON error body matching the platform's existing shape. */
function errorBody(message: string, type = "invalid_request_error") {
  return { error: { message, type } };
}

function assistantRunPayload(
  payload: Record<string, unknown>,
  delivery?: "rocket-chat",
  bindingId?: string,
): Record<string, unknown> {
  const sanitized = { ...payload };
  delete sanitized.delivery;
  delete sanitized.bindingId;
  return {
    ...sanitized,
    ...(delivery !== undefined ? { delivery } : {}),
    ...(bindingId !== undefined ? { bindingId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSchema = z.object({
  assistantId: z.string().min(1).max(64),
  displayName: z.string().max(120).optional(),
  autonomy: z.enum(["supervised", "assisted", "autonomous"]).optional(),
});

const updateSchema = z.object({
  displayName: z.string().max(120).optional(),
  autonomy: z.enum(["supervised", "assisted", "autonomous"]).optional(),
  status: z.enum(["active", "suspended", "archived"]).optional(),
});

/**
 * Directive patch.
 *
 * `null` clears a field. Chosen over an explicit sentinel string because this is a
 * JSON API where `null` is the natural "remove" and the sentinel would leak an
 * internal representation into a public contract.
 */
const directivesSchema = z.object({
  instructions: z.string().max(2_000).nullable().optional(),
  style: z.string().max(2_000).nullable().optional(),
  about: z.string().max(2_000).nullable().optional(),
  avoid: z.string().max(2_000).nullable().optional(),
  /** Revision hash read before editing, for conflict detection. */
  expectedRevisionHash: z.string().optional(),
});

const skillWriteSchema = z.object({
  name: z.string().min(1).max(64),
  triggerLine: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
});

/** Publishing to the org registry — the user's own decision about their own skill. */
const publishSkillSchema = z.object({
  summary: z.string().max(500).optional(),
  evidence: z.string().max(2_000).optional(),
});

/** Installing a catalog entry names WHICH of the caller's own assistants receives it. */
const installOrgSkillSchema = z.object({
  assistantId: z.string().min(1).max(64),
});

const proposalDecisionSchema = z.object({
  expectedRevisionHash: z.string().optional(),
  reason: z.string().max(500).optional(),
  /** Apply as a canary rather than straight to full injection. */
  asCanary: z.boolean().optional(),
});

const grantDelegationSchema = z.object({
  issuer: z.string().url(),
  refreshToken: z.string().min(10),
  scope: z.string().max(500).optional(),
  subject: z.string().max(200).optional(),
});

const messageGrantSchema = z.object({
  /** Assistant that may write to this one. */
  fromAssistantId: z.string().min(1).max(64),
  /** Owning user of the sending assistant. Same tenant only. */
  fromUserId: z.string().min(1).max(320),
  scope: z.enum(["message", "message+read"]).optional(),
  note: z.string().max(500).optional(),
  expiresAt: z.string().datetime().optional(),
});

const rocketChatBindingSchema = z.object({
  rocketUserId: z.string().min(1).max(256),
  rocketUsername: z.string().min(1).max(256).optional(),
  roomId: z.string().min(1).max(256),
  flowId: z.string().min(1).max(256),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface AssistantsRouterDeps {
  /** Global business-authorization switch. */
  authorizationEnabled?: boolean;
  runtime: AssistantRuntime;
  /** Optional secure bidirectional Rocket.Chat transport. */
  rocketChat?: RocketChatChannel;
  /** Optional MCP-backed Vectorsearch projection; absent means durable browsing still works. */
  sessionIndex?: AssistantSessionIndex;
  logger?: Logger;
}

export function createAssistantsRouter(
  deps: AssistantsRouterDeps,
): Hono<AuthContext> {
  const app = new Hono<AuthContext>();
  const { runtime } = deps;
  const sessionIndex = deps.sessionIndex;

  /**
   * Resolves the scope for a request, or writes the error response.
   *
   * Returns a discriminated result rather than throwing so each handler stays a
   * straight line, and so the 401/400 distinction is made once: a missing identity is
   * an auth problem, a malformed assistant id is a request problem.
   */
  const resolveScope = (
    headers: Headers,
    principal: import("../middleware/auth.js").AuthPrincipal | undefined,
    assistantIdRaw: string,
  ):
    | { ok: true; scope: AssistantScope; userName?: string }
    | { ok: false; status: 400 | 401; message: string } => {
    const identity = resolveAssistantCaller(headers, principal);
    const assistantId = sanitizeIdentitySegment(assistantIdRaw);
    const resolution = resolveAssistantScope({
      userId: identity.userId,
      assistantId,
      tenantId: identity.tenantId,
    });
    if (!resolution.ok) {
      const status =
        resolution.reason === "no-user-identity" ||
        resolution.reason === "invalid-user-identity"
          ? 401
          : 400;
      return { ok: false, status, message: resolution.detail };
    }
    return {
      ok: true,
      scope: resolution.scope,
      ...(identity.userName !== undefined ? { userName: identity.userName } : {}),
    };
  };

  // -- Listing and provisioning --------------------------------------------

  app.get("/v1/assistants", async (ctx) => {
    const identity = resolveAssistantCaller(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY));
    if (identity.userId === undefined) {
      return ctx.json(
        errorBody("No authenticated user identity.", "authentication_error"),
        401,
      );
    }
    const summaries = await runtime.stores.assistants.listForUser(
      identity.tenantId ?? "_",
      identity.userId,
    );
    return ctx.json({
      assistants: summaries.map((summary) => ({
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

  app.post("/v1/assistants", async (ctx) => {
    const identity = resolveAssistantCaller(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY));
    if (identity.userId === undefined) {
      return ctx.json(
        errorBody("No authenticated user identity.", "authentication_error"),
        401,
      );
    }
    const parsed = createSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), parsed.data.assistantId);
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);

    const record = await runtime.stores.assistants.ensure({
      scope: scoped.scope,
      ...(parsed.data.displayName !== undefined
        ? { displayName: parsed.data.displayName }
        : {}),
      ...(parsed.data.autonomy !== undefined
        ? { autonomy: parsed.data.autonomy }
        : {}),
    });
    return ctx.json(
      {
        assistantId: record.scope.assistantId,
        displayName: record.displayName,
        status: record.status,
        autonomy: record.autonomy,
        createdAt: record.createdAt,
      },
      201,
    );
  });

  app.get("/v1/assistants/:id", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const record = await runtime.stores.assistants.get(scoped.scope);
    if (record === undefined) {
      return ctx.json(errorBody("Assistant not found.", "not_found"), 404);
    }
    const soul = await runtime.stores.souls.get(scoped.scope);
    return ctx.json({
      assistantId: record.scope.assistantId,
      displayName: record.displayName,
      status: record.status,
      autonomy: record.autonomy,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      soul: {
        // Identity is shown but not writable here: it belongs to the assistant.
        identity: soul.identity,
        directives: soul.directives,
        // Constraints are shown so a user understands why their assistant refuses
        // things, but they are operator-owned and read-only on this API.
        constraints: soul.constraints,
        revision: soul.revision,
        revisionHash: soul.revisionHash,
      },
    });
  });

  app.patch("/v1/assistants/:id", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const parsed = updateSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    try {
      const record = await runtime.stores.assistants.update(
        scoped.scope,
        parsed.data,
      );
      return ctx.json({
        assistantId: record.scope.assistantId,
        displayName: record.displayName,
        status: record.status,
        autonomy: record.autonomy,
      });
    } catch (err) {
      return ctx.json(
        errorBody(err instanceof Error ? err.message : String(err), "not_found"),
        404,
      );
    }
  });

  // -- Durable session lifecycle -------------------------------------------

  const requireSessionStore = (ctx: { json: (body: unknown, status?: 404) => Response }) => {
    const store = runtime.stores.sessionStore;
    if (store !== undefined) return store;
    ctx.json(
      errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"),
      404,
    );
    return undefined;
  };

  app.get("/v1/assistants/:id/sessions", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    const limit = Number(ctx.req.query("limit") ?? "50");
    const sessions = await store.listSessions(scoped.scope, {
      includeDeleted: ctx.req.query("includeDeleted") === "true",
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    return ctx.json({ sessions });
  });

  app.post("/v1/assistants/:id/sessions/:conversationId/fork", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    const parsed = z.object({ conversationId: z.string().min(1).max(512), sequence: z.number().int().min(0).optional(), title: z.string().max(240).optional() }).safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    try {
      const session = await store.forkSession({
        scope: scoped.scope,
        sourceConversationId: ctx.req.param("conversationId"),
        conversationId: parsed.data.conversationId,
        ...(parsed.data.sequence !== undefined ? { sequence: parsed.data.sequence } : {}),
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      });
      return ctx.json({ session }, 201);
    } catch (err) {
      return ctx.json(errorBody(err instanceof Error ? err.message : String(err), "conflict"), 409);
    }
  });

  app.delete("/v1/assistants/:id/sessions/:conversationId", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    const deleted = await store.softDeleteSession(scoped.scope, ctx.req.param("conversationId"));
    return deleted ? ctx.json({ deleted: true }) : ctx.json(errorBody("Session not found.", "not_found"), 404);
  });

  app.post("/v1/assistants/:id/sessions/:conversationId/restore", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    const restored = await store.restoreSession(scoped.scope, ctx.req.param("conversationId"));
    return restored ? ctx.json({ restored: true }) : ctx.json(errorBody("Session not found.", "not_found"), 404);
  });

  app.get("/v1/assistants/:id/sessions/:conversationId/snapshots", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    return ctx.json({ snapshots: await store.listSnapshots(scoped.scope, ctx.req.param("conversationId")) });
  });

  app.post("/v1/assistants/:id/sessions/:conversationId/snapshots", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    const parsed = z.object({ sequence: z.number().int().min(0), kind: z.enum(["summary", "checkpoint"]), content: z.string().min(1).max(200_000), sourceFromSequence: z.number().int().min(0).optional(), sourceToSequence: z.number().int().min(0).optional() }).safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    const snapshot = await store.createSnapshot({ scope: scoped.scope, conversationId: ctx.req.param("conversationId"), ...parsed.data });
    if (sessionIndex !== undefined) {
      try {
        await sessionIndex.ingestEvent({
          scope: scoped.scope,
          conversationId: snapshot.conversationId,
          documentId: snapshot.id,
          content: snapshot.content,
          kind: "snapshot",
          sequence: snapshot.sequence,
          token: ctx.get(TOKEN_KEY) ?? "",
        });
      } catch (error) {
        deps.logger?.warn("Assistant snapshot Vectorsearch projection failed after persistence", {
          assistantId: scoped.scope.assistantId,
          snapshotId: snapshot.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ctx.json({ snapshot }, 201);
  });

  app.get("/v1/assistants/:id/tool-recovery", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    const rawLimit = Number(ctx.req.query("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
    await store.recoverExpired?.(scoped.scope, limit);
    return ctx.json({ entries: await store.listRecoverable?.(scoped.scope, limit) ?? [] });
  });

  app.post("/v1/assistants/:id/tool-recovery/:conversationId/:toolCallId/reconcile", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireSessionStore(ctx);
    if (store === undefined) return ctx.json(errorBody("Durable assistant sessions require PostgreSQL persistence.", "not_found"), 404);
    const parsed = z.object({
      status: z.enum(["completed", "failed", "cancelled"]),
      result: z.unknown().optional(),
      reason: z.string().min(1).max(4_000).optional(),
    }).safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    const entry = await store.reconcileUnknown?.({
      scope: scoped.scope,
      conversationId: ctx.req.param("conversationId"),
      toolCallId: ctx.req.param("toolCallId"),
      ...parsed.data,
    });
    return entry === undefined
      ? ctx.json(errorBody("Unknown tool action was not found or has already been reconciled.", "conflict"), 409)
      : ctx.json({ entry });
  });

  // Hybrid retrieval is delegated to the configured Vectorsearch MCP server.
  // No filesystem/SQL substring fallback is provided here: callers either get
  // scoped hybrid retrieval or an explicit degraded-mode response.
  app.get("/v1/assistants/:id/sessions/search", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    if (sessionIndex === undefined) {
      return ctx.json(errorBody("Assistant session search requires the configured Vectorsearch MCP integration.", "service_unavailable"), 503);
    }
    const query = (ctx.req.query("q") ?? "").trim();
    if (query.length === 0 || query.length > 2_000) {
      return ctx.json(errorBody("Query must contain 1 to 2000 characters."), 400);
    }
    const token = ctx.get(TOKEN_KEY) ?? "";
    if (token === "") return ctx.json(errorBody("No authenticated user identity.", "authentication_error"), 401);
    try {
      const rawLimit = Number(ctx.req.query("limit") ?? "20");
      const result = await sessionIndex.search({
        scope: scoped.scope,
        query,
        ...(ctx.req.query("conversationId") !== undefined ? { conversationId: ctx.req.query("conversationId") } : {}),
        ...(Number.isFinite(rawLimit) ? { limit: rawLimit } : {}),
        token,
      });
      return ctx.json({ result });
    } catch (error) {
      deps.logger?.warn("Assistant session Vectorsearch query failed", { assistantId: scoped.scope.assistantId, error: error instanceof Error ? error.message : String(error) });
      return ctx.json(errorBody("Assistant session search is temporarily unavailable.", "service_unavailable"), 503);
    }
  });

  // -- Durable runs and schedules ------------------------------------------

  const requireRunStore = () => runtime.stores.runStore;
  app.get("/v1/assistants/:id/runs", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id")); if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireRunStore(); if (store === undefined) return ctx.json(errorBody("Durable assistant runs require PostgreSQL persistence.", "not_found"), 404);
    return ctx.json({ runs: await store.list(scoped.scope, Number(ctx.req.query("limit") ?? "50")) });
  });
  app.post("/v1/assistants/:id/runs", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id")); if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireRunStore(); if (store === undefined) return ctx.json(errorBody("Durable assistant runs require PostgreSQL persistence.", "not_found"), 404);
    const parsed = z.object({
      idempotencyKey: z.string().min(1).max(256),
      parentRunId: z.string().uuid().optional(),
      resumePayload: z.record(z.string(), z.unknown()),
      maxAttempts: z.number().int().min(1).max(20).optional(),
      delivery: z.literal("rocket-chat").optional(),
    }).safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    try {
      const { delivery, ...input } = parsed.data;
      if (delivery !== undefined && deps.rocketChat === undefined) {
        return ctx.json(errorBody("Rocket.Chat is not configured on this deployment.", "service_unavailable"), 503);
      }
      const deliveryBinding = delivery === undefined
        ? undefined
        : await deps.rocketChat?.bindings.getActive(scoped.scope);
      if (delivery !== undefined && deliveryBinding === undefined) {
        return ctx.json(errorBody("An active, verified Rocket.Chat binding is required.", "conflict"), 409);
      }
      const run = await store.start(scoped.scope, {
        ...input,
        resumePayload: assistantRunPayload(input.resumePayload, delivery, deliveryBinding?.id),
      });
      return ctx.json({ run }, 202);
    } catch (error) {
      if (error instanceof AssistantParentRunNotFoundError) {
        return ctx.json(errorBody("Parent run not found in this assistant scope.", "not_found"), 404);
      }
      throw error;
    }
  });
  app.get("/v1/assistants/:id/runs/:runId", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id")); if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireRunStore(); if (store === undefined) return ctx.json(errorBody("Durable assistant runs require PostgreSQL persistence.", "not_found"), 404);
    const run = await store.get(scoped.scope, ctx.req.param("runId")); return run === undefined ? ctx.json(errorBody("Run not found.", "not_found"), 404) : ctx.json({ run });
  });
  app.get("/v1/assistants/:id/schedules", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id")); if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireRunStore(); if (store === undefined) return ctx.json(errorBody("Durable assistant schedules require PostgreSQL persistence.", "not_found"), 404);
    return ctx.json({ schedules: await store.listSchedules(scoped.scope) });
  });
  app.post("/v1/assistants/:id/schedules", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id")); if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireRunStore(); if (store === undefined) return ctx.json(errorBody("Durable assistant schedules require PostgreSQL persistence.", "not_found"), 404);
    const parsed = z.object({
      dueAt: z.string().datetime().optional(),
      slot: z.string().min(1).max(256).optional(),
      cronExpression: z.string().min(9).max(256).optional(),
      timezone: z.literal("UTC").optional(),
      resumePayload: z.record(z.string(), z.unknown()),
      delivery: z.literal("rocket-chat").optional(),
    }).refine((value) => value.dueAt !== undefined || value.cronExpression !== undefined, {
      message: "dueAt or cronExpression is required.",
    }).safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    try {
      const { delivery, ...input } = parsed.data;
      if (delivery !== undefined && deps.rocketChat === undefined) {
        return ctx.json(errorBody("Rocket.Chat is not configured on this deployment.", "service_unavailable"), 503);
      }
      const deliveryBinding = delivery === undefined
        ? undefined
        : await deps.rocketChat?.bindings.getActive(scoped.scope);
      if (delivery !== undefined && deliveryBinding === undefined) {
        return ctx.json(errorBody("An active, verified Rocket.Chat binding is required.", "conflict"), 409);
      }
      return ctx.json({
        schedule: await store.createSchedule(scoped.scope, {
          ...input,
          resumePayload: assistantRunPayload(input.resumePayload, delivery, deliveryBinding?.id),
        }),
      }, 201);
    } catch (error) {
      return ctx.json(errorBody(error instanceof Error ? error.message : "Invalid schedule."), 400);
    }
  });
  app.delete("/v1/assistants/:id/schedules/:scheduleId", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id")); if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const store = requireRunStore(); if (store === undefined) return ctx.json(errorBody("Durable assistant schedules require PostgreSQL persistence.", "not_found"), 404);
    return (await store.deleteSchedule(scoped.scope, ctx.req.param("scheduleId"))) ? ctx.json({ deleted: true }) : ctx.json(errorBody("Schedule not found.", "not_found"), 404);
  });

  // -- Directives (the user's write class) ---------------------------------

  app.patch("/v1/assistants/:id/directives", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const parsed = directivesSchema.safeParse(
      await ctx.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    // `null` from the API maps onto the store's clear sentinel. The translation lives
    // here so the sentinel stays an internal representation.
    const { CLEAR_FIELD } = await import("../assistants/soul-document.js");
    const directives: Record<string, string> = {};
    for (const field of ["instructions", "style", "about", "avoid"] as const) {
      const value = parsed.data[field];
      if (value === null) directives[field] = CLEAR_FIELD;
      else if (value !== undefined) directives[field] = value;
    }
    if (Object.keys(directives).length === 0) {
      return ctx.json(errorBody("No directive fields supplied."), 400);
    }
    try {
      const result = await runtime.stores.souls.mutate({
        scope: scoped.scope,
        actorType: "user",
        actorId: scoped.scope.userId,
        ...(parsed.data.expectedRevisionHash !== undefined
          ? { expectedRevisionHash: parsed.data.expectedRevisionHash }
          : {}),
        patch: { directives },
      });
      return ctx.json({
        changed: result.changed,
        revision: result.record.revision,
        revisionHash: result.record.revisionHash,
        directives: result.record.directives,
      });
    } catch (err) {
      if (err instanceof SoulRevisionConflictError) {
        // 409 with the current revision so the client can re-read and retry without
        // a second round trip to discover what it should have sent.
        return ctx.json(
          {
            ...errorBody(err.message, "conflict"),
            currentRevision: err.currentRevision,
            currentRevisionHash: err.currentRevisionHash,
          },
          409,
        );
      }
      if (err instanceof SoulWriteClassError) {
        return ctx.json(errorBody(err.message, "forbidden"), 403);
      }
      throw err;
    }
  });

  app.get("/v1/assistants/:id/soul/history", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const limitRaw = Number(ctx.req.query("limit") ?? "50");
    const history = await runtime.stores.souls.history(
      scoped.scope,
      Number.isFinite(limitRaw) ? limitRaw : 50,
    );
    return ctx.json({
      revisions: history.map((entry) => ({
        revision: entry.revision,
        writeClass: entry.writeClass,
        actorType: entry.actorType,
        actorId: entry.actorId,
        reason: entry.reason,
        createdAt: entry.createdAt,
      })),
    });
  });

  // -- Skills ---------------------------------------------------------------

  app.get("/v1/assistants/:id/skills", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const includeRetired = ctx.req.query("includeRetired") === "true";
    const skills = await runtime.stores.skills.listAll(scoped.scope, {
      includeRetired,
    });
    return ctx.json({
      skills: skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        triggerLine: skill.triggerLine,
        body: skill.body,
        version: skill.version,
        status: skill.status,
        origin: skill.origin,
        useCount: skill.useCount,
        lastUsedAt: skill.lastUsedAt,
        updatedAt: skill.updatedAt,
      })),
    });
  });

  app.put("/v1/assistants/:id/skills", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const parsed = skillWriteSchema.safeParse(
      await ctx.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    try {
      const skill = await runtime.stores.skills.upsert({
        scope: scoped.scope,
        name: parsed.data.name,
        triggerLine: parsed.data.triggerLine,
        body: parsed.data.body,
        // Authored by a person, so it goes live directly. Only a LEARNED skill needs
        // a canary — the question a canary answers is whether the model's own
        // generalisation helps, and a person writing a procedure has already decided.
        origin: "user",
        status: "active",
      });
      return ctx.json({ id: skill.id, name: skill.name, version: skill.version });
    } catch (err) {
      return ctx.json(
        errorBody(err instanceof Error ? err.message : String(err)),
        400,
      );
    }
  });

  app.delete("/v1/assistants/:id/skills/:name", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    // Retired, not deleted: the proposal that created it and the audit trail both
    // still reference the row.
    await runtime.stores.skills.retire(
      scoped.scope,
      ctx.req.param("name"),
      "Retired by user",
    );
    return ctx.json({ retired: true });
  });

  // -- Org Skill Registry -----------------------------------------------------
  //
  // Publishing is reached from a specific assistant (the source) and is that
  // assistant's own user's decision, mirroring PUT .../skills (a user-authored
  // skill going live directly). Browsing and installing are reached without an
  // assistant in the path — the catalog is tenant-wide, not scoped to one
  // assistant — but installing still resolves the DESTINATION assistant
  // through the caller's own identity, so a request naming a foreign
  // assistant id is refused exactly like every other route on this router.

  app.post("/v1/assistants/:id/skills/:name/publish", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const orgSkills = runtime.stores.orgSkills;
    if (orgSkills === undefined) {
      return ctx.json(
        errorBody("The org skill registry is not available on this deployment.", "not_found"),
        404,
      );
    }
    const skill = await runtime.stores.skills.getByName(scoped.scope, ctx.req.param("name"));
    if (skill === undefined) {
      return ctx.json(errorBody("Skill not found.", "not_found"), 404);
    }
    // Only a proven, live skill may be published — a skill still under canary
    // has not yet been decided to actually help, and publishing an unproven
    // procedure would spread that uncertainty to every assistant that installs
    // it instead of resolving it first for the assistant that learned it.
    if (skill.status !== "active") {
      return ctx.json(
        errorBody(
          `Only an "active" skill can be published (this one is "${skill.status}"). ` +
            "A skill under canary must first be promoted or the canary allowed to conclude.",
        ),
        409,
      );
    }
    const parsed = publishSkillSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    try {
      const entry = await orgSkills.publish({
        tenantId: scoped.scope.tenantId,
        sourceScope: scoped.scope,
        publishedBy: scoped.scope.userId,
        name: skill.name,
        triggerLine: skill.triggerLine,
        body: skill.body,
        ...(parsed.data.summary !== undefined ? { summary: parsed.data.summary } : {}),
        ...(parsed.data.evidence !== undefined ? { evidence: parsed.data.evidence } : {}),
      });
      return ctx.json(
        {
          id: entry.id,
          name: entry.name,
          status: entry.status,
          createdAt: entry.createdAt,
        },
        201,
      );
    } catch (err) {
      if (err instanceof OrgSkillScanBlockedError) {
        return ctx.json(errorBody(err.message, "unprocessable"), 422);
      }
      throw err;
    }
  });

  app.get("/v1/org-skills", async (ctx) => {
    const identity = resolveAssistantCaller(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY));
    if (identity.userId === undefined) {
      return ctx.json(
        errorBody("No authenticated user identity.", "authentication_error"),
        401,
      );
    }
    const orgSkills = runtime.stores.orgSkills;
    if (orgSkills === undefined) {
      return ctx.json({ total: 0, skills: [] });
    }
    const limitRaw = Number(ctx.req.query("limit") ?? "");
    const offsetRaw = Number(ctx.req.query("offset") ?? "");
    const page = await orgSkills.list({
      tenantId: identity.tenantId ?? "_",
      ...(ctx.req.query("q") !== undefined ? { query: ctx.req.query("q") as string } : {}),
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      ...(Number.isFinite(offsetRaw) ? { offset: offsetRaw } : {}),
    });
    return ctx.json({
      total: page.total,
      skills: page.skills.map((s) => ({
        id: s.id,
        name: s.name,
        triggerLine: s.triggerLine,
        summary: s.summary,
        evidence: s.evidence,
        installCount: s.installCount,
        publishedBy: s.publishedBy,
        sourceAssistantId: s.sourceScope.assistantId,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        // The body is included: an installer should be able to review the full
        // procedure before pulling it into their own assistant's proposal
        // queue, the same transparency a user gets over their own learned
        // proposals.
        body: s.body,
      })),
    });
  });

  app.post("/v1/org-skills/:orgSkillId/install", async (ctx) => {
    const identity = resolveAssistantCaller(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY));
    if (identity.userId === undefined) {
      return ctx.json(
        errorBody("No authenticated user identity.", "authentication_error"),
        401,
      );
    }
    const orgSkills = runtime.stores.orgSkills;
    if (orgSkills === undefined) {
      return ctx.json(
        errorBody("The org skill registry is not available on this deployment.", "not_found"),
        404,
      );
    }
    const parsed = installOrgSkillSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    // The destination is resolved through the CALLER's own identity, exactly
    // like every other route here — a request cannot name a foreign
    // assistant, even to install a shared catalog entry into it.
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), parsed.data.assistantId);
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const entry = await orgSkills.get(scoped.scope.tenantId, ctx.req.param("orgSkillId"));
    if (entry === undefined) {
      return ctx.json(errorBody("Catalog entry not found.", "not_found"), 404);
    }
    try {
      const existingSkills = await runtime.stores.skills.listAll(scoped.scope, {
        includeRetired: false,
      });
      const result = await installOrgSkill({
        entry,
        destinationScope: scoped.scope,
        proposals: runtime.stores.proposals,
        existingSkillNames: new Set(existingSkills.map((s) => s.name.toLowerCase())),
      });
      await orgSkills.recordInstall(scoped.scope.tenantId, entry.id);
      return ctx.json({ proposalId: result.proposalId }, 201);
    } catch (err) {
      if (err instanceof OrgSkillNotInstallableError) {
        return ctx.json(errorBody(err.message, "unprocessable"), 422);
      }
      return ctx.json(...proposalErrorResponse(err));
    }
  });

  // -- Learned proposals ----------------------------------------------------

  app.get("/v1/assistants/:id/proposals", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const statusRaw = ctx.req.query("status");
    const status =
      statusRaw === "pending" ||
      statusRaw === "applied" ||
      statusRaw === "rejected" ||
      statusRaw === "quarantined" ||
      statusRaw === "stale"
        ? statusRaw
        : undefined;
    const proposals = await runtime.stores.proposals.list(scoped.scope, {
      ...(status !== undefined ? { status } : {}),
    });
    return ctx.json({
      proposals: proposals.map((proposal) => ({
        id: proposal.id,
        kind: proposal.kind,
        status: proposal.status,
        targetSkill: proposal.targetSkill,
        title: proposal.title,
        triggerLine: proposal.triggerLine,
        body: proposal.body,
        goal: proposal.goal,
        evidence: proposal.evidence,
        autonomousCapture: proposal.autonomousCapture,
        scanState: proposal.scanState,
        scanFindings: proposal.scanFindings,
        revisionHash: proposal.revisionHash,
        createdAt: proposal.createdAt,
        decidedAt: proposal.decidedAt,
      })),
    });
  });

  app.post("/v1/assistants/:id/proposals/:proposalId/apply", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const parsed = proposalDecisionSchema.safeParse(
      await ctx.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    try {
      const result = await runtime.stores.proposals.apply({
        scope: scoped.scope,
        proposalId: ctx.req.param("proposalId"),
        actorType: "user",
        actorId: scoped.scope.userId,
        ...(parsed.data.expectedRevisionHash !== undefined
          ? { expectedRevisionHash: parsed.data.expectedRevisionHash }
          : {}),
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.asCanary === true ? { asCanary: true } : {}),
      });
      if (parsed.data.asCanary === true) {
        await runtime.stores.canaries.start({
          scope: scoped.scope,
          skillId: result.skill.id,
        });
      }
      return ctx.json({
        applied: true,
        skillId: result.skill.id,
        skillName: result.skill.name,
        canary: parsed.data.asCanary === true,
      });
    } catch (err) {
      return ctx.json(...proposalErrorResponse(err));
    }
  });

  app.post("/v1/assistants/:id/proposals/:proposalId/reject", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const parsed = proposalDecisionSchema.safeParse(
      await ctx.req.json().catch(() => ({})),
    );
    try {
      const proposal = await runtime.stores.proposals.reject({
        scope: scoped.scope,
        proposalId: ctx.req.param("proposalId"),
        actorType: "user",
        actorId: scoped.scope.userId,
        ...(parsed.success && parsed.data.expectedRevisionHash !== undefined
          ? { expectedRevisionHash: parsed.data.expectedRevisionHash }
          : {}),
        ...(parsed.success && parsed.data.reason !== undefined
          ? { reason: parsed.data.reason }
          : {}),
      });
      return ctx.json({ rejected: true, status: proposal.status });
    } catch (err) {
      return ctx.json(...proposalErrorResponse(err));
    }
  });

  // -- Delegation -----------------------------------------------------------

  app.post("/v1/assistants/:id/delegation", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const parsed = grantDelegationSchema.safeParse(
      await ctx.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    try {
      const summary = await runtime.stores.credentials.grant({
        scope: scoped.scope,
        issuer: parsed.data.issuer,
        refreshToken: parsed.data.refreshToken,
        consentedScope: parsed.data.scope ?? "openid offline_access",
        ...(parsed.data.subject !== undefined
          ? { subject: parsed.data.subject }
          : {}),
        // The consenting party is the caller, and the caller IS the owning user
        // because the scope was built from their token. The store re-checks this.
        grantedBy: scoped.scope.userId,
      });
      return ctx.json({
        issuer: summary.issuer,
        scope: summary.consentedScope,
        state: summary.state,
        grantedAt: summary.grantedAt,
      });
    } catch (err) {
      if (err instanceof DelegationEncryptionUnavailableError) {
        // 503, not 400: the request was valid and the deployment is not configured to
        // hold it. A 400 would send the user looking for a mistake in their input.
        return ctx.json(errorBody(err.message, "service_unavailable"), 503);
      }
      if (err instanceof DelegationConsentError) {
        return ctx.json(errorBody(err.message, "forbidden"), 403);
      }
      throw err;
    }
  });

  app.get("/v1/assistants/:id/delegation", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const grants = await runtime.stores.credentials.list(scoped.scope);
    // Summaries only — the refresh token is never returned by any route.
    return ctx.json({ delegations: grants });
  });

  app.delete("/v1/assistants/:id/delegation", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const issuer = ctx.req.query("issuer");
    if (issuer === undefined || issuer.length === 0) {
      return ctx.json(errorBody("An `issuer` query parameter is required."), 400);
    }
    await runtime.stores.credentials.revoke(scoped.scope, issuer);
    // A revoked grant must not go on working off an already-minted access
    // token still sitting in the minter's cache — see
    // AuthorityResolver.invalidateDelegatedToken for why this is not optional.
    runtime.stores.authority.invalidateDelegatedToken(scoped.scope, issuer);
    return ctx.json({ revoked: true });
  });

  // -- Rocket.Chat channel --------------------------------------------------

  app.get("/v1/assistants/:id/channels/rocketchat", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    if (deps.rocketChat === undefined) {
      return ctx.json(errorBody("Rocket.Chat is not configured on this deployment.", "not_found"), 404);
    }
    const binding = await deps.rocketChat.bindings.get(scoped.scope);
    return ctx.json({
      binding: binding === undefined ? null : {
        rocketUserId: binding.rocketUserId,
        rocketUsername: binding.rocketUsername,
        roomId: binding.roomId,
        flowId: binding.flowId,
        enabled: binding.enabled,
        pairingRequired: binding.pairingRequired,
        consentedAt: binding.consentedAt,
        verifiedAt: binding.verifiedAt,
        revokedAt: binding.revokedAt,
        updatedAt: binding.updatedAt,
      },
    });
  });

  app.put("/v1/assistants/:id/channels/rocketchat", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    if (deps.rocketChat === undefined) {
      return ctx.json(errorBody("Rocket.Chat is not configured on this deployment.", "not_found"), 404);
    }
    if (await runtime.stores.assistants.get(scoped.scope) === undefined) {
      return ctx.json(errorBody("Assistant not found.", "not_found"), 404);
    }
    const parsed = rocketChatBindingSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    try {
      const pairing = await deps.rocketChat.bindings.put(scoped.scope, parsed.data);
      const binding = pairing.binding;
      return ctx.json({
        binding: {
          rocketUserId: binding.rocketUserId,
          rocketUsername: binding.rocketUsername,
          roomId: binding.roomId,
          flowId: binding.flowId,
          enabled: binding.enabled,
          pairingRequired: binding.pairingRequired,
          consentedAt: binding.consentedAt,
        },
        pairingCode: pairing.pairingCode,
        pairingExpiresInSeconds: 900,
      }, 202);
    } catch (error) {
      if (error instanceof RocketChatBindingConflictError) {
        return ctx.json(errorBody(error.message, "conflict"), 409);
      }
      throw error;
    }
  });

  app.delete("/v1/assistants/:id/channels/rocketchat", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    if (deps.rocketChat === undefined) {
      return ctx.json(errorBody("Rocket.Chat is not configured on this deployment.", "not_found"), 404);
    }
    return await deps.rocketChat.bindings.revoke(scoped.scope)
      ? ctx.json({ revoked: true })
      : ctx.json(errorBody("Rocket.Chat binding not found.", "not_found"), 404);
  });

  // -- Peer message channels ------------------------------------------------

  app.get("/v1/assistants/:id/channels", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const [incoming, outgoing] = await Promise.all([
      runtime.stores.messaging.listIncomingGrants(scoped.scope),
      runtime.stores.messaging.listOutgoingGrants(scoped.scope),
    ]);
    return ctx.json({
      // Incoming shows who may write to this assistant — the grants this user
      // consented to. Outgoing shows where it may write.
      incoming: incoming.map((grant) => ({
        id: grant.id,
        fromAssistantId: grant.from.assistantId,
        scope: grant.scope,
        note: grant.note,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        revokedAt: grant.revokedAt,
      })),
      outgoing: outgoing.map((grant) => ({
        id: grant.id,
        toAssistantId: grant.to.assistantId,
        scope: grant.scope,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        revokedAt: grant.revokedAt,
      })),
    });
  });

  app.post("/v1/assistants/:id/channels", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const parsed = messageGrantSchema.safeParse(
      await ctx.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return ctx.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid body"), 400);
    }
    const fromAssistantId = sanitizeIdentitySegment(parsed.data.fromAssistantId);
    if (fromAssistantId === undefined) {
      return ctx.json(errorBody("`fromAssistantId` is not a valid identifier."), 400);
    }
    // The sender is addressed within the SAME tenant. Cross-tenant channels are not
    // openable through this API: they would need both organisations to agree, which
    // is an operator decision rather than a user one.
    const from: AssistantScope = {
      tenantId: scoped.scope.tenantId,
      userId: parsed.data.fromUserId,
      assistantId: fromAssistantId,
    };
    const decision = decideGrantCreation({
      from,
      to: scoped.scope,
      // The caller owns the RECEIVING assistant (the scope came from their token),
      // which is exactly who is allowed to consent.
      grantedBy: scoped.scope.userId,
      ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
    });
    if (!decision.allow && deps.authorizationEnabled !== false) {
      return ctx.json(errorBody(decision.detail, "forbidden"), 403);
    }
    const grant = await runtime.stores.messaging.createGrant({
      from,
      to: scoped.scope,
      scope: decision.allow
        ? decision.scope
        : parsed.data.scope ?? "message",
      grantedBy: scoped.scope.userId,
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      ...(parsed.data.expiresAt !== undefined
        ? { expiresAt: parsed.data.expiresAt }
        : {}),
    });
    return ctx.json(
      {
        id: grant.id,
        fromAssistantId: grant.from.assistantId,
        scope: grant.scope,
        createdAt: grant.createdAt,
      },
      201,
    );
  });

  app.delete("/v1/assistants/:id/channels/:grantId", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const grantId = ctx.req.param("grantId");
    // Only a grant this assistant RECEIVES may be revoked here: revocation is the
    // other half of consent, and consent belonged to the receiver.
    const incoming = await runtime.stores.messaging.listIncomingGrants(
      scoped.scope,
    );
    if (!incoming.some((grant) => grant.id === grantId)) {
      return ctx.json(
        errorBody(
          "No such channel into this assistant. Only channels you granted can be revoked here.",
          "not_found",
        ),
        404,
      );
    }
    await runtime.stores.messaging.revokeGrant(grantId);
    return ctx.json({ revoked: true });
  });

  // -- Inbox ----------------------------------------------------------------

  app.get("/v1/assistants/:id/inbox", async (ctx) => {
    const scoped = resolveScope(ctx.req.raw.headers, ctx.get(AUTH_PRINCIPAL_KEY), ctx.req.param("id"));
    if (!scoped.ok) return ctx.json(errorBody(scoped.message), scoped.status);
    const messages = await runtime.messenger.collectInbox(scoped.scope);
    return ctx.json({
      messages: messages.map((message) => ({
        id: message.id,
        // The sending assistant, not its user: the channel is between assistants and
        // must not become a directory of other people.
        fromAssistantId: message.from.assistantId,
        subject: message.subject,
        body: message.body,
        createdAt: message.createdAt,
      })),
    });
  });

  // Referenced so the token key stays imported and the middleware contract is
  // visible at this router: every route here runs behind `authMiddleware`, which puts
  // the validated credential under TOKEN_KEY.
  void TOKEN_KEY;

  return app;
}

/**
 * Maps a proposal error onto a status and body.
 *
 * Returns a tuple for `ctx.json(...)` so each call site stays one line. The mapping
 * matters: a conflict is retryable after a re-read, a scan block never is, and a
 * transition error means the proposal was already decided — three different things a
 * client must handle differently.
 */
function proposalErrorResponse(
  err: unknown,
): [Record<string, unknown>, 400 | 404 | 409 | 422] {
  if (err instanceof ProposalConflictError) {
    return [
      {
        ...errorBody(err.message, "conflict"),
        currentRevision: err.currentRevision,
        currentRevisionHash: err.currentRevisionHash,
      },
      409,
    ];
  }
  if (err instanceof ProposalScanBlockedError) {
    // 422: the request is well-formed and the resource exists, but its state forbids
    // the action and no amount of retrying changes that.
    return [errorBody(err.message, "unprocessable"), 422];
  }
  if (err instanceof ProposalTransitionError) {
    return [errorBody(err.message, "conflict"), 409];
  }
  const message = err instanceof Error ? err.message : String(err);
  return [
    errorBody(message, message.includes("not found") ? "not_found" : "invalid_request_error"),
    message.includes("not found") ? 404 : 400,
  ];
}
