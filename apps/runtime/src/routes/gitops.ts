// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GitOps Webhook Route (`src/routes/gitops.ts`)
 *
 * Exposes a `POST /webhooks/git` endpoint that receives Git push webhook
 * payloads (GitHub, GitLab, Gitea, or plain JSON) and triggers a hot-reload
 * of the flow registry — so a `git push` to the branch that contains the
 * flows directory is the deploy action, without requiring SSH or kubectl access.
 *
 * Security:
 *   - Optional HMAC-SHA256 signature verification (GitHub-style `X-Hub-Signature-256`
 *     / GitLab-style `X-Gitlab-Token` / generic `X-Webhook-Secret` header).
 *   - When GITOPS_WEBHOOK_SECRET is set, requests without a valid signature are
 *     rejected with 401. When unset, the endpoint is open (suitable only for
 *     internal networks / cluster-internal webhooks).
 *   - Rate-limited to 10 requests per minute per source IP (fixed window).
 *
 * Flow:
 *   1. Verify signature (when configured).
 *   2. Parse the payload to extract the branch that was pushed.
 *   3. If the pushed branch matches GITOPS_BRANCH (default: main/master),
 *      call flowParserService.reload() to re-scan FLOWS_DIR.
 *   4. Return a JSON summary { triggered: bool, branch, matchedFlows }.
 *
 * Environment variables:
 *   GITOPS_WEBHOOK_SECRET   HMAC secret for signature verification (recommended).
 *   GITOPS_BRANCH           Branch that triggers a reload (default: "main").
 *                           Comma-separated for multiple branches.
 *   GITOPS_ENABLED          Set to "true" to enable the route (default: false).
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import crypto from "node:crypto";
import type { Logger } from "../observability/logger.js";
import type { AuditLog } from "../observability/audit-log.js";
import { createInMemoryStore, type RateLimitStore } from "../middleware/rate-limit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitopsRouterDeps {
  /** Callback to trigger a flow registry reload (wraps flowParserService.reload). */
  reloadFlows: () => Promise<void> | void;
  /**
   * Current ids of file flows that a DB-published (online) flow overrides.
   * A git push reloads the FILES, but the composite registry keeps serving the
   * online version for these ids — so the webhook reports which reloaded flows
   * have no runtime effect instead of claiming blanket success (ADR 0034).
   * Optional: without a flow editor there are no online flows to shadow.
   */
  shadowedFlowIds?: () => string[];
  /** Optional audit log for webhook receipt events. */
  auditLog?: AuditLog;
  logger?: Logger;
  /** HMAC secret for signature verification. When undefined, verification is skipped. */
  webhookSecret?: string;
  /**
   * Refuse the webhook when no {@link webhookSecret} is configured (mirrors
   * `GITOPS_REQUIRE_SIGNATURE`, default true). Without this, an unset secret
   * turned a flow-replacing endpoint into an unauthenticated one.
   */
  requireSignature?: boolean;
  /**
   * Branch name(s) that trigger a reload (comma-separated or array).
   * Default: ["main", "master"].
   */
  triggerBranches?: string | string[];
  /**
   * Shared rate limit store — pass the one from `createHttpMiddleware` so the
   * webhook budget is shared across replicas when REDIS_URL is configured.
   * Defaults to a per-process in-memory store (tests, single-replica dev).
   * No key collision with the `/v1/*` limiter: that one keys `ip:<addr>`,
   * this route keys the bare address.
   */
  rateLimitStore?: RateLimitStore;
}

interface WebhookPayload {
  /** GitHub/GitLab/Gitea push event `ref` (e.g. "refs/heads/main"). */
  ref?: string;
  /** GitHub/Gitea `repository.name`. */
  repository?: { name?: string; full_name?: string };
  /** GitLab `project.name`. */
  project?: { name?: string; path_with_namespace?: string };
  /** GitHub `pusher.name`. */
  pusher?: { name?: string };
  /** GitLab `user_name`. */
  user_name?: string;
  /** Number of commits in the push. */
  total_commits_count?: number;
  commits?: unknown[];
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies a GitHub-style HMAC-SHA256 webhook signature.
 * `X-Hub-Signature-256: sha256=<hex>`
 */
function verifyHubSignature(body: string, secret: string, sigHeader: string | undefined): boolean {
  if (!sigHeader) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Verifies a GitLab-style token header: `X-Gitlab-Token: <secret>`.
 */
function verifyGitlabToken(secret: string, tokenHeader: string | undefined): boolean {
  if (!tokenHeader) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(tokenHeader), Buffer.from(secret));
  } catch {
    return false;
  }
}

function isSignatureValid(
  rawBody: string,
  secret: string,
  ctx: {
    hubSig: string | undefined;
    gitlabToken: string | undefined;
    genericSecret: string | undefined;
  },
): boolean {
  // Try GitHub-style HMAC first
  if (ctx.hubSig !== undefined) return verifyHubSignature(rawBody, secret, ctx.hubSig);
  // Try GitLab-style plain token
  if (ctx.gitlabToken !== undefined) return verifyGitlabToken(secret, ctx.gitlabToken);
  // Generic X-Webhook-Secret header
  if (ctx.genericSecret !== undefined) return verifyGitlabToken(secret, ctx.genericSecret);
  return false;
}

// ---------------------------------------------------------------------------
// Branch extraction
// ---------------------------------------------------------------------------

function extractBranch(payload: WebhookPayload): string | undefined {
  if (typeof payload.ref === "string") {
    // e.g. "refs/heads/main" → "main"
    const m = payload.ref.match(/^refs\/heads\/(.+)$/);
    return m ? m[1] : payload.ref;
  }
  return undefined;
}

function extractRepoName(payload: WebhookPayload): string {
  return (
    payload.repository?.full_name ??
    payload.repository?.name ??
    payload.project?.path_with_namespace ??
    payload.project?.name ??
    "unknown"
  );
}

function extractActor(payload: WebhookPayload): string {
  return payload.pusher?.name ?? payload.user_name ?? "unknown";
}

function extractCommitCount(payload: WebhookPayload): number {
  return (
    payload.total_commits_count ??
    (Array.isArray(payload.commits) ? payload.commits.length : 0)
  );
}

// ---------------------------------------------------------------------------
// Per-IP rate limiter
// ---------------------------------------------------------------------------

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

/**
 * Reuses the central sliding-window {@link RateLimitStore} — the same one
 * `middleware/rate-limit.ts` uses for `/v1/*` — instead of a bespoke
 * `Map<string, …>` with no eviction. This route is reachable by anyone who
 * knows the endpoint (its whole purpose is receiving unauthenticated-looking
 * requests before signature verification runs), so an unbounded per-IP map
 * was a straightforward memory-growth vector: an attacker sending requests
 * from many distinct source IPs (or a spoofed `X-Forwarded-For`) would grow
 * the map forever. `createInMemoryStore()` sweeps stale entries on an
 * interval and is already unit-tested independently.
 */
async function isRateLimited(
  store: RateLimitStore,
  ip: string,
): Promise<boolean> {
  const hit = await store.hit(ip, RATE_WINDOW_MS);
  return hit.count > RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createGitopsRouter(deps: GitopsRouterDeps): Hono {
  const router = new Hono();
  const { reloadFlows, auditLog, logger, webhookSecret } = deps;
  const requireSignature = deps.requireSignature ?? true;
  const rateLimitStore = deps.rateLimitStore ?? createInMemoryStore();

  const triggerBranches = new Set<string>(
    typeof deps.triggerBranches === "string"
      ? deps.triggerBranches.split(",").map((b) => b.trim()).filter(Boolean)
      : Array.isArray(deps.triggerBranches) && deps.triggerBranches.length > 0
        ? deps.triggerBranches
        : ["main", "master"],
  );

  router.post("/webhooks/git", async (ctx) => {
    // Rate limiting
    const clientIp =
      ctx.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      ctx.req.header("X-Real-IP") ??
      "unknown";

    if (await isRateLimited(rateLimitStore, clientIp)) {
      ctx.header("Retry-After", "60");
      return ctx.json(
        { error: { message: "Too many webhook requests.", type: "rate_limited" } },
        429,
      );
    }

    // Read raw body for HMAC verification
    let rawBody: string;
    try {
      rawBody = await ctx.req.text();
    } catch {
      return ctx.json(
        { error: { message: "Failed to read request body.", type: "invalid_request_error" } },
        400,
      );
    }

    // Signature verification. Fail-closed when no secret is configured: this
    // route replaces flow definitions from a remote repository, so an unsigned
    // variant lets any caller who reaches the endpoint swap the deployment's
    // flows. Opt out consciously with GITOPS_REQUIRE_SIGNATURE=false.
    if (webhookSecret === undefined || webhookSecret.length === 0) {
      if (requireSignature) {
        logger?.warn(
          "[GitOps] Rejected webhook: GITOPS_WEBHOOK_SECRET is not configured",
          { ip: clientIp },
        );
        return ctx.json(
          {
            error: {
              message:
                "GitOps webhook rejected: no GITOPS_WEBHOOK_SECRET is configured, so the request cannot be " +
                "authenticated. Set the secret (and the matching one in your Git provider), or set " +
                "GITOPS_REQUIRE_SIGNATURE=false to consciously accept unsigned flow syncs.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
    } else {
      const valid = isSignatureValid(rawBody, webhookSecret, {
        hubSig: ctx.req.header("X-Hub-Signature-256"),
        gitlabToken: ctx.req.header("X-Gitlab-Token"),
        genericSecret: ctx.req.header("X-Webhook-Secret"),
      });
      if (!valid) {
        logger?.warn("[GitOps] Webhook signature verification failed", { ip: clientIp });
        return ctx.json(
          { error: { message: "Webhook signature verification failed.", type: "authentication_error" } },
          401,
        );
      }
    }

    // Parse payload
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
      return ctx.json(
        { error: { message: "Invalid JSON payload.", type: "invalid_request_error" } },
        400,
      );
    }

    const branch = extractBranch(payload);
    const repo = extractRepoName(payload);
    const actor = extractActor(payload);
    const commitCount = extractCommitCount(payload);

    logger?.info("[GitOps] Webhook received", { branch, repo, actor, commitCount, ip: clientIp });

    // Check if this push targets a trigger branch
    const shouldReload = branch !== undefined && triggerBranches.has(branch);

    let reloadedFlows: string[] = [];
    let shadowedFlows: string[] = [];
    if (shouldReload) {
      try {
        await reloadFlows();
        // After the rescan: which reloaded file flows are shadowed by an
        // online (DB) flow? Those changes are live on disk but NOT served —
        // report them so a no-effect push is visible (ADR 0034).
        const shadowed = deps.shadowedFlowIds?.() ?? [];
        shadowedFlows = shadowed;
        logger?.info("[GitOps] Flow registry reloaded via git webhook", {
          branch,
          repo,
          actor,
          ...(shadowed.length > 0 ? { shadowedFlows: shadowed } : {}),
        });
        if (shadowed.length > 0) {
          logger?.warn(
            "[GitOps] Reloaded file flows are overridden by online (DB) flows — the pushed changes are not live",
            { flows: shadowed, count: shadowed.length },
          );
        }
        auditLog?.record({
          actor: actor ?? "git-webhook",
          role: "system",
          action: "gitops.reload",
          target: repo,
          outcome: "success",
          details: {
            branch,
            commitCount,
            repo,
            ip: clientIp,
            ...(shadowed.length > 0 ? { shadowedFlows: shadowed } : {}),
          },
        });
        reloadedFlows = ["*"]; // chokidar handles the actual file diff
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn("[GitOps] Flow reload failed", { error: msg });
        auditLog?.record({
          actor: actor ?? "git-webhook",
          role: "system",
          action: "gitops.reload",
          target: repo,
          outcome: "error",
          details: { branch, error: msg },
        });
        return ctx.json(
          { error: { message: `Flow reload failed: ${msg}`, type: "execution_error" } },
          500,
        );
      }
    }

    return ctx.json({
      triggered: shouldReload,
      branch: branch ?? null,
      repo,
      triggerBranches: [...triggerBranches],
      reloadedFlows,
      ...(shadowedFlows.length > 0 ? { shadowedFlows } : {}),
      message: shouldReload
        ? shadowedFlows.length > 0
          ? `Flow registry reload triggered for branch '${branch}'. ${shadowedFlows.length} reloaded flow(s) are overridden by online (DB) flows and are not live: ${shadowedFlows.join(", ")}.`
          : `Flow registry reload triggered for branch '${branch}'.`
        : `Branch '${branch ?? "unknown"}' is not in the trigger list — no reload.`,
    });
  });

  // Health check for the webhook endpoint
  router.get("/webhooks/git", (ctx) =>
    ctx.json({
      status: "ok",
      triggerBranches: [...triggerBranches],
      signatureVerification: webhookSecret !== undefined && webhookSecret.length > 0,
    })
  );

  return router;
}
