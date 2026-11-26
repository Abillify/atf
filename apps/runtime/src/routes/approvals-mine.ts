// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Caller-scoped approvals API (`src/routes/approvals-mine.ts`)
 *
 * The operator plane (`/monitoring/approvals*`) requires operator RBAC or a
 * per-approval capability token (approvalLinkSecret). An embedded chat client
 * — e.g. the abiliware ERP assistant, whose approval gate blocks the
 * in-flight `/v1/chat/completions` request while a tool call awaits human
 * review — has neither. It DOES hold the same user bearer that opened the
 * chat request, and every pending approval now carries `ownerKey` =
 * SHA-256 of that bearer (see approval-gate.ts).
 *
 * These routes live under `/v1/*`, so the standard auth middleware has
 * already validated the caller; we hash the caller's bearer (TOKEN_KEY) and
 * match it against `ownerKey`. A caller can therefore only ever list and
 * decide its OWN approvals — no operator rights, no capability secret, no
 * cross-user visibility.
 *
 *   GET  /v1/approvals/mine            — pending approvals owned by the caller
 *   POST /v1/approvals/mine/:id/decide — body { decision: "approved"|"denied" }
 */
import { Hono } from "hono";
import crypto from "node:crypto";
import type { ApprovalRegistry } from "../graph/approval-gate.js";
import { TOKEN_KEY } from "../middleware/auth.js";
import type { AuthContext } from "../middleware/auth.js";

export interface ApprovalsMineRouterDeps {
  approvalGate: ApprovalRegistry;
}

function ownerKeyOf(token: string | undefined): string | undefined {
  if (token === undefined || token === "") return undefined;
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createApprovalsMineRouter(
  deps: ApprovalsMineRouterDeps,
): Hono<AuthContext> {
  const router = new Hono<AuthContext>();
  const { approvalGate } = deps;

  // GET /v1/approvals/mine
  // Pending approvals opened by THIS caller (bearer-hash match). The chat UI
  // polls this while its completions request is in flight and renders each
  // entry as a native confirm dialog.
  router.get("/v1/approvals/mine", async (ctx) => {
    const key = ownerKeyOf(ctx.get(TOKEN_KEY));
    if (key === undefined) {
      return ctx.json({ error: "unauthenticated" }, 401);
    }
    const pending = (await approvalGate.listPending()).filter(
      (p) => p.ownerKey === key,
    );
    return ctx.json({
      pending: pending.map((p) => ({
        id: p.id,
        tool: p.tool,
        args: p.args,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.message !== undefined ? { message: p.message } : {}),
        ...(p.fields !== undefined ? { fields: p.fields } : {}),
        ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
        requestedAt: p.requestedAt,
      })),
      timeoutMs: approvalGate.timeoutMs,
    });
  });

  // POST /v1/approvals/mine/:id/decide  { decision: "approved" | "denied" }
  // Decides one of the caller's own pending approvals. Unknown id, or an id
  // owned by a different caller, answers 404 — deliberately indistinguishable
  // so the route cannot be used to probe for other users' approval ids.
  router.post("/v1/approvals/mine/:id/decide", async (ctx) => {
    const key = ownerKeyOf(ctx.get(TOKEN_KEY));
    if (key === undefined) {
      return ctx.json({ error: "unauthenticated" }, 401);
    }
    let body: { decision?: unknown };
    try {
      body = await ctx.req.json<{ decision?: unknown }>();
    } catch {
      return ctx.json({ error: "invalid JSON body" }, 400);
    }
    const decision = body.decision;
    if (decision !== "approved" && decision !== "denied") {
      return ctx.json(
        { error: `decision must be "approved" or "denied"` },
        400,
      );
    }
    const id = ctx.req.param("id");
    const pending = (await approvalGate.listPending()).find(
      (p) => p.id === id && p.ownerKey === key,
    );
    if (pending === undefined) {
      return ctx.json({ error: "not found" }, 404);
    }
    const ok = await approvalGate.resolve(id, {
      approved: decision === "approved",
      by: pending.requestedBy ?? "chat-user",
    });
    if (!ok) {
      // Settled between the list and the resolve (timeout / operator decided).
      return ctx.json({ error: "already resolved" }, 409);
    }
    return ctx.json({ ok: true, id, decision });
  });

  return router;
}
