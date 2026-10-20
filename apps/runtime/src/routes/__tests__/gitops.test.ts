// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the GitOps webhook route (`src/routes/gitops.ts`).
 *
 * Focus: fail-closed signature verification (an unset secret must not turn
 * this flow-replacing endpoint into an unauthenticated one), branch matching,
 * and the rate limiter now being backed by the central, self-sweeping
 * {@link RateLimitStore} rather than an unbounded per-IP `Map`.
 */

import { describe, test, expect } from "bun:test";
import crypto from "node:crypto";
import { Hono } from "hono";
import { createGitopsRouter } from "../gitops.js";

const SECRET = "gitops-secret";

function githubSig(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function pushPayload(branch: string, overrides: Record<string, unknown> = {}) {
  return {
    ref: `refs/heads/${branch}`,
    repository: { full_name: "acme/aiperator-flows" },
    pusher: { name: "alice" },
    total_commits_count: 1,
    ...overrides,
  };
}

function buildApp(opts: {
  webhookSecret?: string;
  requireSignature?: boolean;
  triggerBranches?: string | string[];
  shadowedFlowIds?: () => string[];
}): { app: Hono; reloadCalls: number } {
  let reloadCalls = 0;
  const app = new Hono();
  app.route(
    "/",
    createGitopsRouter({
      reloadFlows: () => {
        reloadCalls++;
      },
      ...(opts.webhookSecret !== undefined
        ? { webhookSecret: opts.webhookSecret }
        : {}),
      ...(opts.requireSignature !== undefined
        ? { requireSignature: opts.requireSignature }
        : {}),
      ...(opts.triggerBranches !== undefined
        ? { triggerBranches: opts.triggerBranches }
        : {}),
      ...(opts.shadowedFlowIds !== undefined
        ? { shadowedFlowIds: opts.shadowedFlowIds }
        : {}),
    }),
  );
  return { app, reloadCalls };
}

describe("GitOps webhook — fail-closed signature verification", () => {
  test("no secret configured (default requireSignature) is rejected 401", async () => {
    const { app } = buildApp({});
    const body = JSON.stringify(pushPayload("main"));
    const res = await app.request("/webhooks/git", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(401);
  });

  test("requireSignature=false restores the open (unsigned) behaviour", async () => {
    const { app } = buildApp({ requireSignature: false });
    const body = JSON.stringify(pushPayload("main"));
    const res = await app.request("/webhooks/git", { method: "POST", body });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { triggered: boolean };
    expect(json.triggered).toBe(true);
  });

  test("a valid GitHub-style HMAC signature is accepted", async () => {
    const { app } = buildApp({ webhookSecret: SECRET });
    const body = JSON.stringify(pushPayload("main"));
    const res = await app.request("/webhooks/git", {
      method: "POST",
      headers: { "X-Hub-Signature-256": githubSig(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("an invalid signature is rejected", async () => {
    const { app } = buildApp({ webhookSecret: SECRET });
    const body = JSON.stringify(pushPayload("main"));
    const res = await app.request("/webhooks/git", {
      method: "POST",
      headers: { "X-Hub-Signature-256": githubSig(body, "wrong-secret") },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("a GitLab-style token header is accepted", async () => {
    const { app } = buildApp({ webhookSecret: SECRET });
    const body = JSON.stringify(pushPayload("main"));
    const res = await app.request("/webhooks/git", {
      method: "POST",
      headers: { "X-Gitlab-Token": SECRET },
      body,
    });
    expect(res.status).toBe(200);
  });
});

describe("GitOps webhook — branch matching", () => {
  test("a push to a trigger branch reloads flows", async () => {
    const { app } = buildApp({ requireSignature: false, triggerBranches: "main" });
    const res = await app.request("/webhooks/git", {
      method: "POST",
      body: JSON.stringify(pushPayload("main")),
    });
    const json = (await res.json()) as { triggered: boolean; branch: string };
    expect(json.triggered).toBe(true);
    expect(json.branch).toBe("main");
  });

  test("a push to a non-trigger branch does not reload", async () => {
    const { app } = buildApp({ requireSignature: false, triggerBranches: "main" });
    const res = await app.request("/webhooks/git", {
      method: "POST",
      body: JSON.stringify(pushPayload("feature/x")),
    });
    const json = (await res.json()) as { triggered: boolean };
    expect(json.triggered).toBe(false);
  });
});

describe("GitOps webhook — rate limiting (bounded, self-sweeping store)", () => {
  test("allows requests within the limit and rejects once exceeded", async () => {
    const { app } = buildApp({ requireSignature: false });
    const ip = "203.0.113.7";
    let lastStatus = 0;
    // The limit is 10/minute; send 12 and expect the last ones to be 429.
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/webhooks/git", {
        method: "POST",
        headers: { "X-Forwarded-For": ip },
        body: JSON.stringify(pushPayload("main")),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  test("different source IPs are rate-limited independently", async () => {
    const { app } = buildApp({ requireSignature: false });
    const res1 = await app.request("/webhooks/git", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.10" },
      body: JSON.stringify(pushPayload("main")),
    });
    const res2 = await app.request("/webhooks/git", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.11" },
      body: JSON.stringify(pushPayload("main")),
    });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});

describe("GitOps webhook — shadowed flows (ADR 0034)", () => {
  test("a reload whose file flows are DB-overridden reports shadowedFlows", async () => {
    const { app } = buildApp({
      requireSignature: false,
      triggerBranches: "main",
      shadowedFlowIds: () => ["alpha", "beta"],
    });
    const res = await app.request("/webhooks/git", {
      method: "POST",
      body: JSON.stringify(pushPayload("main")),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      triggered: boolean;
      reloadedFlows: string[];
      shadowedFlows?: string[];
      message: string;
    };
    expect(json.triggered).toBe(true);
    expect(json.reloadedFlows).toEqual(["*"]);
    expect(json.shadowedFlows).toEqual(["alpha", "beta"]);
    expect(json.message).toContain("overridden by online (DB) flows");
  });

  test("shadowedFlows is absent when no reloaded flow is overridden", async () => {
    const { app } = buildApp({
      requireSignature: false,
      triggerBranches: "main",
      shadowedFlowIds: () => [],
    });
    const res = await app.request("/webhooks/git", {
      method: "POST",
      body: JSON.stringify(pushPayload("main")),
    });
    const json = (await res.json()) as { shadowedFlows?: string[] };
    expect(json.shadowedFlows).toBeUndefined();
  });

  test("a non-trigger push never reports shadowed flows", async () => {
    const { app } = buildApp({
      requireSignature: false,
      triggerBranches: "main",
      shadowedFlowIds: () => ["alpha"],
    });
    const res = await app.request("/webhooks/git", {
      method: "POST",
      body: JSON.stringify(pushPayload("feature/x")),
    });
    const json = (await res.json()) as {
      triggered: boolean;
      shadowedFlows?: string[];
    };
    expect(json.triggered).toBe(false);
    expect(json.shadowedFlows).toBeUndefined();
  });
});

describe("GitOps webhook — health check", () => {
  test("GET /webhooks/git reports configured trigger branches and signature status", async () => {
    const { app } = buildApp({ webhookSecret: SECRET, triggerBranches: ["main", "release"] });
    const res = await app.request("/webhooks/git");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      triggerBranches: string[];
      signatureVerification: boolean;
    };
    expect(json.triggerBranches).toEqual(["main", "release"]);
    expect(json.signatureVerification).toBe(true);
  });
});
