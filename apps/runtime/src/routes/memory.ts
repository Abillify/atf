// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Long-term memory API (`src/routes/memory.ts`)
 *
 * Lets a client explicitly manage the calling identity's long-term memories —
 * store a durable fact, recall relevant ones, forget specific entries, or clear
 * the scope. The scope (tenant + user) is derived from the authenticated
 * request context, NOT from the URL, so a caller can only ever touch its own
 * memories.
 *
 * Routes (under the standard `/v1/*` auth gate):
 *   POST   /v1/memory            — remember { text, kind?, id?, metadata? }
 *   POST   /v1/memory/recall     — recall   { query, topK?, minScore? }
 *   DELETE /v1/memory            — forget   { ids: [...] }  (or clear all when ids omitted)
 *   GET    /v1/memory/count
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { AuthContext } from "../middleware/auth.js";
import { TOKEN_KEY } from "../middleware/auth.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { MemoryStore, MemoryScope } from "../graph/memory-store.js";
import { resolveMemoryScope, decodeScopeId } from "../graph/memory-store.js";
import type { RequestContext } from "../types/monitoring.js";
import type {
  OperatorAuthorizer,
} from "../middleware/operator-rbac.js";
import crypto from "node:crypto";

/** Builds a minimal RequestContext from the auth token + body metadata. */
function scopeFromRequest(
  token: string,
  jwtVerifier: JwtVerifier | undefined,
  metadata: Record<string, unknown>,
): MemoryScope | undefined {
  const claims = jwtVerifier?.decodePayload(token) ?? null;
  const userEmail =
    typeof claims?.email === "string"
      ? (claims.email as string)
      : undefined;
  const clientId =
    (typeof metadata.clientId === "string"
      ? (metadata.clientId as string)
      : undefined) ??
    (typeof claims?.client_id === "string"
      ? (claims.client_id as string)
      : undefined);
  const ctx: RequestContext = {
    ssoToken: token,
    executionId: crypto.randomUUID(),
    ...(userEmail !== undefined ? { userEmail } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    requestParams: metadata,
  };
  return resolveMemoryScope(ctx);
}

export function createMemoryRouter(
  memoryStore: MemoryStore,
  jwtVerifier?: JwtVerifier,
  operatorAuth?: OperatorAuthorizer,
): Hono<AuthContext> {
  const router = new Hono<AuthContext>();

  const anon = () => ({
    error: {
      message:
        "No user identity on this request — long-term memory requires an authenticated user (email claim), a user_id, or a conversation_id.",
      type: "invalid_request_error" as const,
    },
  });

  router.post("/v1/memory", async (ctx) => {
    let body: {
      text?: string;
      kind?: string;
      id?: string;
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
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      return ctx.json(
        {
          error: {
            message: "Field 'text' is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const scope = scopeFromRequest(
      ctx.get(TOKEN_KEY),
      jwtVerifier,
      (body.metadata ?? {}) as Record<string, unknown>,
    );
    if (scope === undefined) return ctx.json(anon(), 400);

    const id = await memoryStore.remember(scope, text, {
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });
    return ctx.json({ stored: id !== undefined, id });
  });

  router.post("/v1/memory/recall", async (ctx) => {
    let body: {
      query?: string;
      topK?: number;
      minScore?: number;
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
    const query = typeof body.query === "string" ? body.query : "";
    if (query.trim().length === 0) {
      return ctx.json(
        {
          error: {
            message: "Field 'query' is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const scope = scopeFromRequest(
      ctx.get(TOKEN_KEY),
      jwtVerifier,
      (body.metadata ?? {}) as Record<string, unknown>,
    );
    if (scope === undefined) return ctx.json(anon(), 400);

    const topK =
      typeof body.topK === "number" && body.topK > 0
        ? Math.floor(body.topK)
        : 5;
    const memories = await memoryStore.recall(
      scope,
      query,
      topK,
      body.minScore,
    );
    return ctx.json({ memories });
  });

  router.delete("/v1/memory", async (ctx) => {
    let body: { ids?: string[]; metadata?: Record<string, unknown> } = {};
    try {
      body = await ctx.req.json();
    } catch {
      // Empty/invalid body is allowed — means "clear all".
    }
    const scope = scopeFromRequest(
      ctx.get(TOKEN_KEY),
      jwtVerifier,
      (body.metadata ?? {}) as Record<string, unknown>,
    );
    if (scope === undefined) return ctx.json(anon(), 400);

    const ids = Array.isArray(body.ids)
      ? body.ids.filter((i) => typeof i === "string")
      : [];
    const removed =
      ids.length > 0
        ? await memoryStore.forget(scope, ids)
        : await memoryStore.clear(scope);
    return ctx.json({ removed });
  });

  router.get("/v1/memory/count", async (ctx) => {
    const scope = scopeFromRequest(ctx.get(TOKEN_KEY), jwtVerifier, {});
    if (scope === undefined) return ctx.json(anon(), 400);
    return ctx.json({ count: await memoryStore.count(scope) });
  });

  // -------------------------------------------------------------------------
  // Admin/operator plane — read-only session listing + clearing.
  // Distinct from the `/v1/memory` routes above (self-service, own scope): these
  // let an operator inspect ANY scope's memories from the dashboard.
  // -------------------------------------------------------------------------
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

  const requireOperatorRead = async (ctx: {
    req: {
      header: (k: string) => string | undefined;
      query: (k: string) => string | undefined;
    };
  }): Promise<boolean> => {
    if (operatorAuth === undefined) return true;
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    return r.ok;
  };

  router.get("/admin/memory/sessions", async (ctx) => {
    if (!(await requireOperatorRead(ctx))) return unauthorized(ctx);
    const scopes = await memoryStore.listScopes(200);
    const sessions = scopes.map((s) => ({
      id: s.id,
      userId: s.scope.userId,
      tenantId: s.scope.tenantId,
      entryCount: s.entryCount,
    }));
    return ctx.json({ sessions });
  });

  router.get("/admin/memory/sessions/:id", async (ctx) => {
    if (!(await requireOperatorRead(ctx))) return unauthorized(ctx);
    const scope = decodeScopeId(ctx.req.param("id"));
    if (scope === undefined) {
      return ctx.json(
        { error: { message: "Invalid session id.", type: "invalid_request_error" } },
        400,
      );
    }
    const entries = await memoryStore.listEntries(scope, 200);
    return ctx.json({
      id: ctx.req.param("id"),
      userId: scope.userId,
      tenantId: scope.tenantId,
      entries,
    });
  });

  router.delete("/admin/memory/sessions/:id", async (ctx) => {
    if (operatorAuth !== undefined) {
      const r = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:write",
      );
      if (!r.ok) return unauthorized(ctx);
    }
    const scope = decodeScopeId(ctx.req.param("id"));
    if (scope === undefined) {
      return ctx.json(
        { error: { message: "Invalid session id.", type: "invalid_request_error" } },
        400,
      );
    }
    const removed = await memoryStore.clear(scope);
    return ctx.json({ id: ctx.req.param("id"), removed });
  });

  return router;
}
