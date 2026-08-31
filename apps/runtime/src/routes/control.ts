// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Control plane routes (`src/routes/control.ts`)
 *
 * Operator/reviewer endpoints for the three stateful features. They live in the
 * observability/operator plane under `/monitoring/*` and share the SAME token
 * gate as the rest of monitoring (`MONITORING_AUTH`), so the dashboard reaches
 * them with one auth model — never the per-end-user `/v1` JWT:
 *
 *   GET  /monitoring/approvals          — list currently-pending tool approvals
 *   POST /monitoring/approvals/:id      — approve/deny a pending tool call
 *   POST /monitoring/replay             — re-run a past execution (time-travel)
 *   GET  /monitoring/canary             — current canary rollout status
 *
 * Each route is only registered when its backing service is configured, so the
 * surface area exactly matches the enabled feature set.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type {
  ApprovalRegistry,
  PendingApproval,
  ResolvedApproval,
} from "../graph/approval-gate.js";
import type { ReplayService, ReplayOverrides } from "../graph/replay.js";
import { ReplayNotFoundError } from "../graph/replay.js";
import type { CanaryManager } from "../graph/canary.js";
import type { ChatMessage } from "../types/openai.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";
import { verifyApprovalLinkToken } from "../graph/approval-link.js";
import type { AuditLog } from "../observability/audit-log.js";

export interface ControlRouterDeps {
  approvalGate?: ApprovalRegistry;
  replayService?: ReplayService;
  canaryManager?: CanaryManager;
  /** Require a valid token (header or ?token=) — mirrors MONITORING_AUTH. */
  authRequired?: boolean;
  /** Operator RBAC authorizer (defaults to a back-compat one from authRequired). */
  operatorAuth?: OperatorAuthorizer;
  /**
   * HMAC secret used to verify per-approval capability tokens (`?token=`) that
   * the in-chat approval widget/links carry. Lets the end user's browser
   * authorize exactly the one approval it was shown — without holding an
   * operator credential — on an auth-gated monitoring plane. When unset,
   * capability tokens are ignored and only operator RBAC applies. Must match
   * the secret used to mint the links (see graph-engine `onApprovalRequired`).
   */
  approvalLinkSecret?: string;
  /** Optional audit log for recording approvals/replay actions. */
  auditLog?: AuditLog;
  /** Browser origins allowed to embed approval HTML; defaults to same-origin only. */
  approvalFrameAncestors?: readonly string[];
}

interface ResolveBody {
  approved?: boolean;
  reason?: string;
  by?: string;
}

interface ReplayBody {
  execution_id?: string;
  flow_id?: string;
  messages?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

/** Bearer header or ?token= query — used as the replay run's identity token. */
function extractToken(
  authHeader: string | undefined,
  queryToken: string | undefined,
): string {
  if (authHeader !== undefined) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m !== null) return (m[1] ?? "").trim();
  }
  return queryToken ?? "";
}

/** Escapes text for safe interpolation into HTML element content. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Shared HTML document shell for the approval iframe (no scripts — Open WebUI
 * sandboxes the frame without `allow-scripts`, so everything must work with
 * plain markup). `headExtra` injects extra `<head>` markup (e.g. a
 * `<meta http-equiv="refresh">` so a pending widget reloads itself when the
 * countdown ends — JS-free environments cannot reload on their own). */
function approvalShell(body: string, headExtra = ""): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    headExtra +
    `<style>` +
    `:root{color-scheme:light dark}` +
    `*{box-sizing:border-box}` +
    `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;` +
    `margin:0;padding:12px;font-size:14px;line-height:1.4}` +
    `.tool{font-weight:600;margin-bottom:6px}` +
    `.message{margin:0 0 8px;white-space:pre-wrap}` +
    `.head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}` +
    `.head .tool{margin-bottom:6px}` +
    `code{background:rgba(127,127,127,.18);padding:1px 5px;border-radius:4px}` +
    `.args{color:#6b7280;font-size:12.5px;word-break:break-word;margin-bottom:10px}` +
    `.row{display:flex;gap:8px}` +
    `.btn{flex:1;display:block;text-align:center;text-decoration:none;` +
    `padding:9px 12px;border-radius:8px;border:1px solid transparent;` +
    `font-size:14px;font-weight:600;cursor:pointer}` +
    `.approve{background:#16a34a;color:#fff}` +
    `.deny{background:#dc2626;color:#fff}` +
    `.btn.done{cursor:default;opacity:.95}` +
    `.note{margin-top:8px;color:#6b7280;font-size:12px}` +
    `</style></head><body>${body}</body></html>`
  );
}

/** Renders the final, single-button state (only the decision that was taken). */
function renderResolvedState(resolved: ResolvedApproval | undefined): string {
  if (resolved === undefined) {
    return approvalShell(
      `<div class="tool">⏳ Approval</div>` +
        `<div class="note">This request is no longer available ` +
        `(already handled or expired).</div>`,
    );
  }
  const cls = resolved.approved ? "approve" : "deny";
  const label = resolved.approved ? "✅ Approved" : "🚫 Denied";
  const note =
    resolved.timedOut === true
      ? `<div class="note">Automatically denied (timed out).</div>`
      : resolved.by !== undefined
        ? `<div class="note">by ${escapeHtml(resolved.by)}</div>`
        : "";
  return approvalShell(
    `<div class="row"><span class="btn ${cls} done">${label}</span></div>${note}`,
  );
}

/**
 * Renders a script-free countdown — a draining ring plus the remaining whole
 * seconds — shown inside the approval iframe. Open WebUI sandboxes the frame
 * WITHOUT `allow-scripts`, so this is pure CSS: an SVG ring whose stroke drains
 * over `remainingMs`, and a number driven by an animated registered custom
 * property (`@property` + a CSS counter). Both reach zero exactly when the
 * gate's auto-deny fires.
 *
 * The remaining time is computed from `requestedAt` + `timeoutMs`, so the
 * animation stays accurate even when the widget is (re)loaded partway through
 * the window. The literal duration/step values are baked into a per-widget
 * `<style>` because CSS `steps()` does not accept custom properties.
 */
function renderCountdown(requestedAt: string, timeoutMs: number): string {
  const startedAt = Date.parse(requestedAt);
  const elapsed = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const remainingMs = Math.max(0, timeoutMs - elapsed);
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const C = 100.531; // 2π·16 — the ring circumference for r=16
  // When (about to be) expired, render a static, fully-drained ring at 0.
  const animated = remainingMs > 0 && remainingSec > 0;
  const dur = `${remainingMs}ms`;
  const steps = Math.max(1, remainingSec);
  return (
    `<style>` +
    `@property --cd{syntax:"<integer>";inherits:false;initial-value:0}` +
    `.cd{position:relative;width:44px;height:44px;flex:0 0 auto}` +
    `.cd svg{width:44px;height:44px;transform:rotate(-90deg)}` +
    `.cd circle{fill:none;stroke-width:4}` +
    `.cd .trk{stroke:rgba(127,127,127,.25)}` +
    `.cd .prg{stroke:#dc2626;stroke-linecap:round;stroke-dasharray:${C};` +
    (animated
      ? `stroke-dashoffset:0;animation:cd-drain ${dur} linear forwards}`
      : `stroke-dashoffset:${C}}`) +
    (animated ? `@keyframes cd-drain{to{stroke-dashoffset:${C}}}` : "") +
    `.cd .num{position:absolute;inset:0;display:flex;align-items:center;` +
    `justify-content:center;font-size:13px;font-weight:700;` +
    `font-variant-numeric:tabular-nums;color:#dc2626;` +
    (animated
      ? `counter-reset:cd var(--cd);animation:cd-tick ${dur} steps(${steps}) forwards}`
      : `counter-reset:cd 0}`) +
    (animated ? `@keyframes cd-tick{from{--cd:${steps}}}` : "") +
    `.cd .num::after{content:counter(cd)}` +
    `</style>` +
    `<div class="cd" title="Automatic denial in ${remainingSec}s" ` +
    `aria-label="Automatic denial in ${remainingSec} seconds">` +
    `<svg viewBox="0 0 44 44" aria-hidden="true">` +
    `<circle class="trk" cx="22" cy="22" r="16"></circle>` +
    `<circle class="prg" cx="22" cy="22" r="16"></circle></svg>` +
    `<span class="num"></span></div>`
  );
}

/**
 * Renders the self-contained HTML document loaded inside the in-chat approval
 * `<iframe>`. Open WebUI loads it in a sandboxed frame WITHOUT `allow-scripts`,
 * so the controls are plain `<a>` links — no JavaScript. Clicking a link
 * navigates the iframe's own browsing context (always allowed under sandbox)
 * to the decide endpoint, which resolves the approval and renders only the
 * chosen button. On a later reload the widget re-renders the final state from
 * the retained decision. While pending it also shows a CSS-only countdown (see
 * {@link renderCountdown}) that mirrors the gate's auto-deny timeout.
 */
function renderApprovalWidget(
  pending: PendingApproval | undefined,
  resolved: ResolvedApproval | undefined,
  timeoutMs: number,
  linkToken?: string,
): string {
  // Already resolved (or resolved meanwhile): show only the chosen button.
  if (pending === undefined) return renderResolvedState(resolved);

  const toolLabel = escapeHtml(pending.tool.split("/").pop() ?? pending.tool);
  const title = escapeHtml(pending.title ?? `Approval required: ${pending.tool.split("/").pop() ?? pending.tool}`);
  const message = pending.message !== undefined
    ? `<div class="message">${escapeHtml(pending.message)}</div>`
    : "";
  const displayEntries = pending.fields !== undefined
    ? pending.fields.map((field) => [field.label, field.value] as const)
    : Object.entries(pending.args ?? {});
  const argSummary =
    displayEntries.length > 0
      ? displayEntries
          .map(
            ([label, value]) =>
              `<strong>${escapeHtml(label)}</strong>: ${escapeHtml(
                JSON.stringify(value),
              )}`,
          )
          .join(", ")
      : "<em>no arguments</em>";

  // The decide endpoint sits next to this one (…/:id/decide). A relative href
  // keeps the navigation on the backend origin that served the iframe document,
  // and a plain link targets the iframe itself — no new tab, no script needed.
  //
  // A relative href does NOT inherit the current URL's query string, so the
  // per-approval capability token that authorized loading this widget must be
  // carried forward explicitly onto the decide links — otherwise the click
  // would hit the operator-gated decide endpoint unauthenticated.
  const decideTokenQuery =
    linkToken !== undefined && linkToken !== ""
      ? `&token=${encodeURIComponent(linkToken)}`
      : "";
  //
  // The sandboxed frame cannot run JS, so when the auto-deny timeout fires the
  // widget cannot react on its own. A `<meta http-equiv="refresh">` makes it
  // reload itself just after the deadline; on that reload the pending record is
  // gone and {@link renderResolvedState} shows the "timed out / denied" state.
  const startedAt = Date.parse(pending.requestedAt);
  const elapsed = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const remainingSec = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
  // +1s buffer so the gate's server-side auto-deny has certainly fired before
  // the reload re-queries the (now resolved) state.
  const refreshMeta = `<meta http-equiv="refresh" content="${remainingSec + 1}">`;

  return approvalShell(
    `<div class="head">` +
      `<div class="tool">⏳ ${title} <code>${toolLabel}</code></div>` +
      renderCountdown(pending.requestedAt, timeoutMs) +
      `</div>` +
      message +
      `<div class="args">${argSummary}</div>` +
      `<div class="row">` +
      `<a class="btn approve" href="decide?decision=approved${decideTokenQuery}" rel="nofollow">✅ Approve</a>` +
      `<a class="btn deny" href="decide?decision=denied${decideTokenQuery}" rel="nofollow">🚫 Deny</a>` +
      `</div>`,
    refreshMeta,
  );
}

export function createControlRouter(deps: ControlRouterDeps): Hono {
  const router = new Hono();
  const { approvalGate, replayService, canaryManager, auditLog } = deps;
  const approvalFrameAncestors = [
    "'self'",
    ...(deps.approvalFrameAncestors ?? []),
  ];
  const approvalWidgetHeaders = (ctx: import("hono").Context): void => {
    ctx.header(
      "Content-Security-Policy",
      `frame-ancestors ${[...new Set(approvalFrameAncestors)].join(" ")};`,
    );
  };
  const authRequired = deps.authRequired ?? false;
  const approvalLinkSecret = deps.approvalLinkSecret;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  /** Permission-aware guard: returns the actor when allowed, else null. */
  const guard = async (
    ctx: {
      req: {
        header: (k: string) => string | undefined;
        query: (k: string) => string | undefined;
      };
    },
    perm: Parameters<OperatorAuthorizer["authorize"]>[2],
  ): Promise<
    import("../middleware/operator-rbac.js").OperatorIdentity | null
  > => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      perm,
    );
    return r.ok
      ? (r.actor ?? { name: "operator", role: "admin", via: "open" })
      : null;
  };

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
   * Authorizes an approval decision for `id` from a per-approval capability
   * token (`?token=`) minted for the in-chat widget/links. Returns true only
   * when a signing secret is configured AND the token is valid and bound to
   * this exact approval id. This lets the end user (whose browser cannot send
   * an operator bearer) act on the one approval they were shown, without any
   * broader operator access. Falls through to operator RBAC otherwise.
   */
  const approvalLinkAuthorized = (
    ctx: { req: { query: (k: string) => string | undefined } },
    id: string,
  ): boolean => {
    if (approvalLinkSecret === undefined) return false;
    return verifyApprovalLinkToken(
      ctx.req.query("token"),
      id,
      approvalLinkSecret,
    );
  };

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------
  if (approvalGate !== undefined) {
    router.get("/monitoring/approvals", async (ctx) => {
      if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
      return ctx.json({
        pending: await approvalGate.listPending(),
        resolved: await approvalGate.listResolved(),
      });
    });

    // GET /monitoring/approvals/:id/widget
    // Self-contained HTML widget embedded in the chat via an <iframe>. Renders
    // Approve/Deny link-buttons while pending; clicking navigates the iframe to
    // the decide endpoint (no script, no new window) which renders only the
    // chosen button. Re-renders the final state on reload.
    router.get("/monitoring/approvals/:id/widget", async (ctx) => {
      approvalWidgetHeaders(ctx);
      const id = ctx.req.param("id");
      // The widget is loaded by the end user's browser (an <iframe> in the
      // chat) which cannot send an operator bearer. Accept the per-approval
      // capability token bound to this id; otherwise require operator RBAC.
      if (!approvalLinkAuthorized(ctx, id)) {
        const actor = await guard(ctx, "approvals:write");
        if (!actor) return unauthorized(ctx);
      }
      const pending = (await approvalGate.listPending()).find(
        (p) => p.id === id,
      );
      const resolved =
        pending === undefined ? await approvalGate.getResolved(id) : undefined;
      return ctx.html(
        renderApprovalWidget(
          pending,
          resolved,
          approvalGate.timeoutMs,
          ctx.req.query("token"),
        ),
      );
    });

    // GET /monitoring/approvals/:id/decide?decision=approved|denied&by=name
    // One-click approve/deny link — designed for embedding in chat messages.
    // No JSON body required; decision comes from the query parameter.
    // Renders the shared approval shell so it looks identical to the widget
    // (the iframe navigates here on click). Shows only the chosen button.
    router.get("/monitoring/approvals/:id/decide", async (ctx) => {
      approvalWidgetHeaders(ctx);
      const id = ctx.req.param("id");
      // Authorize either via the per-approval capability token (the end user
      // clicking the in-chat widget/link, whose browser holds no operator
      // bearer) or via operator RBAC (the dashboard). The capability token is
      // scoped to this exact approval id and expires, so it grants no broader
      // access. A link-authorized actor is treated as the "open" reviewer so
      // the decision is attributed to the user who triggered the request.
      let actor:
        | import("../middleware/operator-rbac.js").OperatorIdentity
        | null;
      if (approvalLinkAuthorized(ctx, id)) {
        actor = { name: "approval-link", role: "operator", via: "open" };
      } else {
        actor = await guard(ctx, "approvals:write");
        if (!actor) return unauthorized(ctx);
      }
      const decision = ctx.req.query("decision");
      if (decision !== "approved" && decision !== "denied") {
        return ctx.html(
          approvalShell(
            `<div class="tool">❌ Invalid decision</div>` +
              `<div class="note">Parameter <code>decision</code> must be ` +
              `<code>approved</code> or <code>denied</code>.</div>`,
          ),
          400,
        );
      }
      // Reviewer identity for the audit trail / widget. Precedence: an explicit
      // ?by= override; then — on the OPEN plane (no RBAC), where the reviewer is
      // the end user clicking their own in-chat widget — the user who triggered
      // the request; then the authenticated operator identity. This replaces the
      // generic "anonymous" fallback with the real person whenever we know them.
      const pending = (await approvalGate.listPending()).find(
        (p) => p.id === id,
      );
      const by =
        ctx.req.query("by") ??
        (actor.via === "open" ? pending?.requestedBy : undefined) ??
        actor.name;
      const approved = decision === "approved";
      const ok = await approvalGate.resolve(id, { approved, by });
      if (!ok) {
        // Already resolved (or expired): re-render the retained final state so
        // a double-click / reload still shows just the decision that was taken.
        const prior = await approvalGate.getResolved(id);
        return ctx.html(renderResolvedState(prior), prior ? 200 : 404);
      }
      auditLog?.record({
        actor: by,
        role: actor.role,
        action: "approvals.resolve",
        target: id,
        details: { approved, via: "link" },
      });
      return ctx.html(
        renderResolvedState({
          id,
          approved,
          by,
          decidedAt: new Date().toISOString(),
        }),
      );
    });

    router.post("/monitoring/approvals/:id", async (ctx) => {
      const actor = await guard(ctx, "approvals:write");
      if (!actor) return unauthorized(ctx);
      const id = ctx.req.param("id");
      let body: ResolveBody;
      try {
        body = await ctx.req.json<ResolveBody>();
      } catch {
        return ctx.json(
          {
            error: {
              message: "Request body must be valid JSON.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      if (typeof body.approved !== "boolean") {
        return ctx.json(
          {
            error: {
              message: "Field 'approved' (boolean) is required.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      const ok = await approvalGate.resolve(id, {
        approved: body.approved,
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        // With real RBAC the authenticated operator is authoritative; on the
        // open plane (no RBAC) honour a client-supplied `by`, else fall back to
        // the user who triggered the request (known from the pending record)
        // before the generic "anonymous" actor name.
        by:
          actor.via === "open"
            ? typeof body.by === "string"
              ? body.by
              : ((await approvalGate.listPending()).find((p) => p.id === id)
                  ?.requestedBy ?? actor.name)
            : actor.name,
      });
      if (!ok) {
        return ctx.json(
          {
            error: {
              message: `Approval '${id}' not found or already resolved.`,
              type: "not_found_error",
            },
          },
          404,
        );
      }
      auditLog?.record({
        actor: actor.name,
        role: actor.role,
        action: "approvals.resolve",
        target: id,
        details: {
          approved: body.approved,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        },
      });
      return ctx.json({ id, approved: body.approved, status: "resolved" });
    });
  }

  // -------------------------------------------------------------------------
  // Replay (time-travel)
  // -------------------------------------------------------------------------
  if (replayService !== undefined) {
    router.post("/monitoring/replay", async (ctx) => {
      const actor = await guard(ctx, "replay:write");
      if (!actor) return unauthorized(ctx);
      let body: ReplayBody;
      try {
        body = await ctx.req.json<ReplayBody>();
      } catch {
        return ctx.json(
          {
            error: {
              message: "Request body must be valid JSON.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      if (!body.execution_id || body.execution_id.trim() === "") {
        return ctx.json(
          {
            error: {
              message: "Field 'execution_id' is required.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      // The replay run executes with the operator's token (passed via a reserved
      // metadata key the executor strips before building the request context —
      // it never lands in a snapshot).
      const token = extractToken(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
      );
      const overrides: ReplayOverrides = {
        ...(typeof body.flow_id === "string" ? { flowId: body.flow_id } : {}),
        ...(Array.isArray(body.messages) ? { messages: body.messages } : {}),
        metadata: { ...(body.metadata ?? {}), __token: token },
      };
      try {
        const result = await replayService.replay(body.execution_id, overrides);
        auditLog?.record({
          actor: actor.name,
          role: actor.role,
          action: "replay.run",
          target: body.execution_id,
          ...(typeof body.flow_id === "string"
            ? { details: { flowId: body.flow_id } }
            : {}),
        });
        return ctx.json(result);
      } catch (err) {
        if (err instanceof ReplayNotFoundError) {
          return ctx.json(
            { error: { message: err.message, type: "not_found_error" } },
            404,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        return ctx.json({ error: { message, type: "execution_error" } }, 500);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Canary status
  // -------------------------------------------------------------------------
  if (canaryManager !== undefined) {
    router.get("/monitoring/canary", async (ctx) => {
      if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);
      return ctx.json({ deployments: canaryManager.status() });
    });
  }

  return router;
}
