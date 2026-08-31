// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/*
 * Models route (`src/routes/models.ts`)
 *
 * OpenAI-compatible model discovery. Open WebUI (and other OpenAI clients) call
 * `GET /v1/models` to populate their model picker; each loaded flow is exposed
 * as a selectable "model" whose `id` is the flow ID used in
 * `POST /v1/chat/completions`.
 *
 *   GET /v1/models       — list flows visible to the authenticated caller
 *   GET /v1/models/:id   — a single visible flow/model, or 404
 *
 * Registered under `/v1/*`, so the standard auth middleware applies.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { FlowRegistry } from "../graph/flow-parser.js";
import {
  decideFlowAccess,
  type FlowAuthorizer,
} from "../graph/flow-authorizer.js";
import type { AuthContext } from "../middleware/auth.js";
import { AUTH_PRINCIPAL_KEY, TOKEN_KEY } from "../middleware/auth.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { RequestContext } from "../types/monitoring.js";
import type { AssistantStore } from "../assistants/assistant-store.js";
import { normalizeTenantId } from "../assistants/types.js";
import { buildRequestContext } from "./chat/handler.js";

interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Non-standard convenience field: the flow's human-readable name. */
  name?: string;
  /** Open WebUI reads this to decide whether to show a reasoning/thinking block. */
  info?: {
    meta?: {
      capabilities?: {
        reasoning?: boolean;
      };
    };
  };
}

/**
 * Prefix that makes an assistant addressable as a model.
 *
 * Kept in step with the `^assistant-…$` dispatch rule and with
 * `assistantIdFromModelName` in the `assistant-context` node handler: this listing
 * only makes the names DISCOVERABLE, the dispatcher routes them, and the handler
 * turns the suffix back into an assistant id. All three must agree on the prefix.
 */
const ASSISTANT_MODEL_PREFIX = "assistant-";

export interface ModelsRouterDeps {
  /** Present only when the assistant subsystem is enabled. */
  assistants?: AssistantStore;
  /** Verifier used after auth middleware accepted the bearer credential. */
  jwtVerifier?: JwtVerifier;
  /** Existing access.json policy, applied in addition to requiredScopes. */
  authorizer?: FlowAuthorizer;
  /** Global business-authorization switch. */
  authzEnabled?: boolean;
  /** JWT claim names used to resolve declarative flow scopes. */
  flowScopeClaims?: readonly string[];
}

export function createModelsRouter(
  flowRegistry: FlowRegistry,
  deps: ModelsRouterDeps = {},
): Hono<AuthContext> {
  const router = new Hono<AuthContext>();
  // Stable-ish creation timestamp (process start) — OpenAI clients only need it present.
  const created = Math.floor(Date.now() / 1000);

  const toModel = (id: string, name?: string): ModelObject => ({
    id,
    object: "model",
    created,
    owned_by: "aiperator",
    ...(name !== undefined ? { name } : {}),
    info: { meta: { capabilities: { reasoning: true } } },
  });

  const requestContext = (ctx: {
    get: {
      (key: typeof TOKEN_KEY): string | undefined;
      (key: typeof AUTH_PRINCIPAL_KEY): import("../middleware/auth.js").AuthPrincipal | undefined;
    };
  }) => {
    const ssoToken = ctx.get(TOKEN_KEY) ?? "";
    const principal = ctx.get(AUTH_PRINCIPAL_KEY);
    return buildRequestContext({
      ssoToken,
      claims: principal?.claims ?? null,
      metadata: {},
      ...(principal?.tenantId !== undefined
        ? { verifiedTenantId: principal.tenantId }
        : {}),
    });
  };

  const canAccessFlow = (
    flow: ReturnType<FlowRegistry["get"]>,
    requestCtx: RequestContext,
  ): boolean =>
    flow !== undefined &&
    decideFlowAccess(
      flow,
      requestCtx,
      deps.authorizer,
      deps.flowScopeClaims,
      deps.authzEnabled ?? true,
    ).allowed;

  /** Lists the caller's own assistants as selectable models. */
  const listAssistantModels = async (requestCtx: RequestContext): Promise<ModelObject[]> => {
    const store = deps.assistants;
    if (store === undefined) return [];
    if (requestCtx.userId === undefined || requestCtx.clientId === undefined) return [];
    try {
      const summaries = await store.listForUser(
        normalizeTenantId(requestCtx.clientId),
        requestCtx.userId,
      );
      return summaries
        .filter((summary) => summary.status === "active")
        .map((summary) =>
          toModel(
            `${ASSISTANT_MODEL_PREFIX}${summary.scope.assistantId}`,
            summary.displayName ?? summary.scope.assistantId,
          ),
        );
    } catch {
      return [];
    }
  };

  router.get("/v1/models", async (ctx) => {
    const requestCtx = requestContext(ctx);
    const flows = flowRegistry
      .list()
      .filter((flow) => canAccessFlow(flow, requestCtx))
      .map((flow) => toModel(flow.id, flow.name));
    const assistantModels = await listAssistantModels(requestCtx);
    return ctx.json({ object: "list", data: [...flows, ...assistantModels] });
  });

  router.get("/v1/models/:id", async (ctx) => {
    const id = ctx.req.param("id");
    const flow = flowRegistry.get(id);
    const requestCtx = requestContext(ctx);
    if (flow === undefined || !canAccessFlow(flow, requestCtx)) {
      // An `assistant-<id>` name is not a flow. It is answered from the caller's own
      // assistants so a client that probes a name it just listed gets 200, not 404.
      if (flow === undefined && id.startsWith(ASSISTANT_MODEL_PREFIX)) {
        const own = await listAssistantModels(requestCtx);
        const match = own.find((model) => model.id === id);
        if (match !== undefined) return ctx.json(match);
      }
      return ctx.json(
        {
          error: {
            message: `Model '${id}' not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    return ctx.json(toModel(flow.id, flow.name));
  });

  return router;
}
