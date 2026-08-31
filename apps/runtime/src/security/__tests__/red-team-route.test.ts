// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the Red-Team HTTP API routes.
 *
 * Covers:
 *   - GET /security/red-team/attacks — returns attack library
 *   - GET /security/red-team/runs — empty list initially
 *   - POST /security/red-team/:flowId/run — triggers a run and returns it
 *   - GET /security/red-team/runs/:runId — returns a specific run
 *   - GET /security/red-team/runs?flowId= — filters by flow
 *   - GET /security/red-team/posture — returns per-flow scores
 *   - POST runs/:nonexistent — 404
 *   - Auth gate (403 when operatorAuth denies)
 */

import { describe, it, expect, vi } from "bun:test";
import { Hono } from "hono";
import { createRedTeamEngine } from "../red-team-engine.js";
import { createRedTeamRouter } from "../../routes/red-team.js";
import type { RedTeamExecutor } from "../red-team-engine.js";
import type { OperatorAuthorizer } from "../../middleware/operator-rbac.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const blockAllExecutor: RedTeamExecutor = async () => ({
  response: "",
  blocked: true,
  inputScore: 0.9,
});

function buildApp(
  executor: RedTeamExecutor = blockAllExecutor,
  operatorAuth?: OperatorAuthorizer,
): Hono {
  const engine = createRedTeamEngine({ attacksPerRun: 2 });
  const router = createRedTeamRouter({ engine, executor, operatorAuth });
  const app = new Hono();
  app.route("/", router);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /security/red-team/attacks", () => {
  it("returns the full attack library", async () => {
    const app = buildApp();
    const res = await app.request("/security/red-team/attacks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attacks: unknown[]; count: number };
    expect(body.attacks.length).toBeGreaterThan(0);
    expect(body.count).toBe(body.attacks.length);
    const first = body.attacks[0] as {
      id: string;
      category: string;
      severity: number;
    };
    expect(typeof first.id).toBe("string");
    expect(typeof first.severity).toBe("number");
  });
});

describe("GET /security/red-team/runs", () => {
  it("returns empty list when no runs have been executed", async () => {
    const app = buildApp();
    const res = await app.request("/security/red-team/runs");
    const body = (await res.json()) as { runs: unknown[] };
    expect(res.status).toBe(200);
    expect(body.runs).toHaveLength(0);
  });
});

describe("POST /security/red-team/:flowId/run", () => {
  it("triggers a run and returns the completed run record", async () => {
    const app = buildApp();
    const res = await app.request("/security/red-team/test-flow/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const run = (await res.json()) as {
      id: string;
      flowId: string;
      status: string;
      trials: unknown[];
    };
    expect(run.status).toBe("completed");
    expect(run.flowId).toBe("test-flow");
    expect(run.trials.length).toBeGreaterThan(0);
  });

  it("run is immediately visible via GET /runs", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({ engine, executor: blockAllExecutor });
    const app = new Hono();
    app.route("/", router);

    await app.request("/security/red-team/my-flow/run", { method: "POST" });
    const res = await app.request("/security/red-team/runs");
    const body = (await res.json()) as { runs: Array<{ flowId: string }> };
    expect(body.runs.some((r) => r.flowId === "my-flow")).toBe(true);
  });
});

describe("GET /security/red-team/runs/:runId", () => {
  it("returns the full run with trials", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({ engine, executor: blockAllExecutor });
    const app = new Hono();
    app.route("/", router);

    // Trigger a run and capture the ID.
    const triggerRes = await app.request("/security/red-team/flow-a/run", {
      method: "POST",
    });
    const triggered = (await triggerRes.json()) as {
      id: string;
      trials: unknown[];
    };

    const res = await app.request(`/security/red-team/runs/${triggered.id}`);
    expect(res.status).toBe(200);
    const run = (await res.json()) as { id: string; trials: unknown[] };
    expect(run.id).toBe(triggered.id);
    expect(run.trials.length).toBe(triggered.trials.length);
  });

  it("returns 404 for an unknown runId", async () => {
    const app = buildApp();
    const res = await app.request("/security/red-team/runs/nonexistent-id");
    expect(res.status).toBe(404);
  });
});

describe("GET /security/red-team/runs?flowId=", () => {
  it("filters runs by flowId", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({ engine, executor: blockAllExecutor });
    const app = new Hono();
    app.route("/", router);

    await app.request("/security/red-team/alpha/run", { method: "POST" });
    await app.request("/security/red-team/beta/run", { method: "POST" });

    const res = await app.request("/security/red-team/runs?flowId=alpha");
    const body = (await res.json()) as { runs: Array<{ flowId: string }> };
    expect(body.runs.every((r) => r.flowId === "alpha")).toBe(true);
    expect(body.runs.length).toBe(1);
  });
});

describe("GET /security/red-team/posture", () => {
  it("returns posture scores after a run", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({ engine, executor: blockAllExecutor });
    const app = new Hono();
    app.route("/", router);

    await app.request("/security/red-team/my-flow/run", { method: "POST" });

    const res = await app.request("/security/red-team/posture");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      posture: Record<string, number>;
      guardrailThreshold: number;
    };
    expect(typeof body.guardrailThreshold).toBe("number");
    expect(body.posture["my-flow"]).toBeDefined();
  });
});

describe("Auth gate", () => {
  it("returns 403 when operatorAuth denies the request", async () => {
    const denyingAuth: OperatorAuthorizer = {
      rbacEnabled: true,
      authorize: async () => ({ ok: false }),
    };
    const app = buildApp(blockAllExecutor, denyingAuth);
    const res = await app.request("/security/red-team/attacks");
    expect(res.status).toBe(403);
  });

  it("allows requests when operatorAuth approves", async () => {
    const allowingAuth: OperatorAuthorizer = {
      rbacEnabled: true,
      authorize: async () => ({ ok: true }),
    };
    const app = buildApp(blockAllExecutor, allowingAuth);
    const res = await app.request("/security/red-team/attacks");
    expect(res.status).toBe(200);
  });
});

describe("GET /security/tool-authz", () => {
  it("returns an inactive policy when no loader is provided", async () => {
    const app = buildApp();
    const res = await app.request("/security/tool-authz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean; rules: unknown[] };
    expect(body.active).toBe(false);
    expect(body.rules).toHaveLength(0);
  });

  it("returns the loaded policy description when a loader is provided", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({
      engine,
      executor: blockAllExecutor,
      toolAuthzLoader: {
        engine: {
          active: true,
          evaluate: () => ({ allowed: true, ruleId: "default" }),
          describe: () => ({
            active: true,
            ruleCount: 1,
            defaultAction: "allow",
            rules: [{ id: "r1", tool: "billing/refund", action: "deny" }],
          }),
        },
        hasPolicy: true,
        reload: () => {},
        save: () => ({ ok: true }),
      },
    });
    const app = new Hono();
    app.route("/", router);

    const res = await app.request("/security/tool-authz");
    const body = (await res.json()) as {
      active: boolean;
      ruleCount: number;
      rules: Array<{ id: string }>;
    };
    expect(body.active).toBe(true);
    expect(body.ruleCount).toBe(1);
    const rule0 = body.rules[0];
    if (rule0 === undefined) throw new Error("expected a rule");
    expect(rule0.id).toBe("r1");
  });
});

describe("PUT /security/tool-authz", () => {
  function appWithSaveSpy(saveResult: { ok: boolean; error?: string }) {
    const save = vi.fn(() => saveResult);
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({
      engine,
      executor: blockAllExecutor,
      toolAuthzLoader: {
        engine: {
          active: true,
          evaluate: () => ({ allowed: true, ruleId: "default" }),
          describe: () => ({
            active: true,
            ruleCount: 1,
            defaultAction: "allow",
            rules: [{ id: "r1", tool: "*", action: "allow" }],
          }),
        },
        hasPolicy: true,
        reload: () => {},
        save,
      },
    });
    const app = new Hono();
    app.route("/", router);
    return { app, save };
  }

  it("persists a valid policy and returns the new description", async () => {
    const { app, save } = appWithSaveSpy({ ok: true });
    const res = await app.request("/security/tool-authz", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rules: [{ id: "r1", tool: "*", action: "allow" }],
        defaultAction: "allow",
      }),
    });
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when the loader rejects the policy", async () => {
    const { app } = appWithSaveSpy({
      ok: false,
      error: "rules.0.action: invalid",
    });
    const res = await app.request("/security/tool-authz", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rules: [{ id: "r1", tool: "*", action: "nope" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("invalid");
  });

  it("returns 400 on invalid JSON body", async () => {
    const { app } = appWithSaveSpy({ ok: true });
    const res = await app.request("/security/tool-authz", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no loader is configured", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({ engine, executor: blockAllExecutor });
    const app = new Hono();
    app.route("/", router);
    const res = await app.request("/security/tool-authz", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
  });

  it("returns 403 when operatorAuth denies flows:write", async () => {
    const save = vi.fn(() => ({ ok: true }));
    // Read gate passes (monitoring:read) but write gate denies (flows:write).
    const auth: OperatorAuthorizer = {
      rbacEnabled: true,
      authorize: async (_h, _q, perm) => ({ ok: perm === "monitoring:read" }),
    };
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({
      engine,
      executor: blockAllExecutor,
      operatorAuth: auth,
      toolAuthzLoader: {
        engine: {
          active: false,
          evaluate: () => ({ allowed: true, ruleId: "default" }),
          describe: () => ({
            active: false,
            ruleCount: 0,
            defaultAction: "allow",
            rules: [],
          }),
        },
        hasPolicy: false,
        reload: () => {},
        save,
      },
    });
    const app = new Hono();
    app.route("/", router);
    const res = await app.request("/security/tool-authz", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [], defaultAction: "allow" }),
    });
    expect(res.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("GET /security/mcp", () => {
  it("returns the MCP endpoint and exposed flows", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const router = createRedTeamRouter({
      engine,
      executor: blockAllExecutor,
      flowRegistry: {
        list: () => [
          {
            id: "helpdesk",
            name: "Helpdesk",
            description: "Support",
            nodes: [],
            edges: [],
          } as never,
        ],
        get: () => undefined,
      },
    });
    const app = new Hono();
    app.route("/", router);

    const res = await app.request("/security/mcp");
    const body = (await res.json()) as {
      endpoint: string;
      flows: Array<{ id: string }>;
    };
    expect(body.endpoint).toBe("/mcp");
    const flow0 = body.flows[0];
    if (flow0 === undefined) throw new Error("expected a flow");
    expect(flow0.id).toBe("helpdesk");
  });
});

describe("Red-team disabled state", () => {
  it("POST run returns 503 when engine is absent", async () => {
    const router = createRedTeamRouter({
      flowRegistry: { list: () => [], get: () => undefined },
    });
    const app = new Hono();
    app.route("/", router);
    const res = await app.request("/security/red-team/some-flow/run", {
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("GET posture reports enabled=false when engine is absent", async () => {
    const router = createRedTeamRouter({});
    const app = new Hono();
    app.route("/", router);
    const res = await app.request("/security/red-team/posture");
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });
});
