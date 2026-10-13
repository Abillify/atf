// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Route tests for the Policy-Replay API (Req 16, Task 22.1).
 *
 * Covers RBAC gating (401), body/candidate validation (400), the JSON diff
 * endpoint (200), the SSE stream endpoint, and the audit entry written for a
 * successful replay.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createPolicyReplayRouter,
  replaySourceFromMonitoringService,
  type PolicyReplayRouterDeps,
} from "../policy-replay.js";
import { InMemoryExecutionStore } from "../../monitoring/execution-store.js";
import { createToolAuthzEngine } from "../../graph/tool-authz.js";
import type { AuditEntry, AuditLog } from "../../observability/audit-log.js";
import type { CompliancePolicyLoader } from "../../compliance/policy-loader.js";
import type { ToolAuthzLoader } from "../../graph/tool-authz-loader.js";
import type {
  AuthorizeResult,
  OperatorAuthorizer,
} from "../../middleware/operator-rbac.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function authorizer(ok: boolean): OperatorAuthorizer {
  return {
    rbacEnabled: true,
    authorize: async (): Promise<AuthorizeResult> =>
      ok
        ? { ok: true, actor: { name: "op", role: "admin", via: "open" } }
        : { ok: false },
  };
}

function seedStore(): InMemoryExecutionStore {
  const store = new InMemoryExecutionStore();
  const base = {
    start_time: "2026-01-01T10:00:00.000Z",
    end_time: "2026-01-01T10:00:00.000Z",
    latency_ms: 5,
  };
  store.recordEvent(
    { ...base, execution_id: "e1", node_id: "__request__", status: "completed" },
    { flowId: "flow-a", tenantId: "t1" },
  );
  const toolEvent: NodeExecutionEvent = {
    ...base,
    execution_id: "e1",
    node_id: "tool_node",
    status: "completed",
    tool_calls: [{ id: "c1", name: "search/query", args_json: "{}" }],
  };
  store.recordEvent(toolEvent, { flowId: "flow-a", tenantId: "t1" });
  store.recordEvent(
    { ...base, execution_id: "e1", node_id: "__flow_end__", status: "completed" },
    { flowId: "flow-a", tenantId: "t1" },
  );
  return store;
}

function makeDeps(overrides: Partial<PolicyReplayRouterDeps> = {}) {
  const auditEntries: AuditEntry[] = [];
  const store = seedStore();
  const deps: PolicyReplayRouterDeps = {
    executionSource: {
      listHistory: (q) => store.listHistory(q),
      listEvents: (id) => store.listEvents(id),
    },
    policyLoader: {
      policy: undefined,
      hasPolicy: false,
      reload() {},
    } satisfies CompliancePolicyLoader,
    toolAuthzLoader: {
      engine: createToolAuthzEngine(undefined),
      hasPolicy: false,
      policyStale: false,
      reload() {},
      save: () => ({ ok: true }) as ReturnType<ToolAuthzLoader["save"]>,
    } satisfies ToolAuthzLoader,
    operatorAuth: authorizer(true),
    auditLog: {
      record: (e: AuditEntry) => {
        auditEntries.push(e);
      },
    } as unknown as AuditLog,
    ...overrides,
  };
  return { deps, auditEntries };
}

function app(deps: PolicyReplayRouterDeps): Hono {
  return new Hono().route("/admin/policy-replay", createPolicyReplayRouter(deps));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /admin/policy-replay", () => {
  test("401 when the operator is not authorized", async () => {
    const { deps } = makeDeps({ operatorAuth: authorizer(false) });
    const res = await app(deps).request("/admin/policy-replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("400 on malformed JSON body", async () => {
    const { deps } = makeDeps();
    const res = await app(deps).request("/admin/policy-replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(400);
  });

  test("400 on an invalid candidate policy", async () => {
    const { deps } = makeDeps();
    const res = await app(deps).request("/admin/policy-replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateToolAuthzPolicy: { rules: [{ bad: 1 }] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("toolAuthz");
  });

  test("200 with old-vs-new diff and summary", async () => {
    const { deps, auditEntries } = makeDeps();
    const res = await app(deps).request("/admin/policy-replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateToolAuthzPolicy: {
          rules: [{ id: "deny-search", tool: "search/*", action: "deny" }],
          defaultAction: "allow",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors: string[];
      results: Array<{
        execution_id: string;
        old_outcome: string;
        new_outcome: string;
        tool_calls: Array<{ tool: string; changed: boolean }>;
      }>;
      summary: { evaluated: number; changed: number; newlyDenied: number };
    };
    expect(body.errors).toEqual([]);
    expect(body.summary.evaluated).toBe(1);
    expect(body.summary.changed).toBe(1);
    expect(body.summary.newlyDenied).toBe(1);
    expect(body.results[0]?.old_outcome).toBe("allow");
    expect(body.results[0]?.new_outcome).toBe("deny");
    expect(body.results[0]?.tool_calls[0]?.changed).toBe(true);

    const audit = auditEntries.find((e) => e.action === "policy.replay");
    expect(audit).toBeDefined();
    expect(audit?.actor).toBe("op");
    expect(audit?.outcome).toBe("success");
  });

  test("passes the live tool-authz engine as the OLD side", async () => {
    // Deny-all live engine + allow-all candidate → the stored call flips to allow.
    const { deps } = makeDeps();
    deps.toolAuthzLoader = {
      ...deps.toolAuthzLoader,
      engine: createToolAuthzEngine({
        rules: [{ id: "deny-all", tool: "*", action: "deny" }],
        defaultAction: "deny",
      }),
    };
    const res = await app(deps).request("/admin/policy-replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateToolAuthzPolicy: { rules: [], defaultAction: "allow" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ old_outcome: string; new_outcome: string }>;
    };
    expect(body.results[0]?.old_outcome).toBe("deny");
    expect(body.results[0]?.new_outcome).toBe("allow");
  });
});

describe("POST /admin/policy-replay/stream", () => {
  test("401 when unauthorized", async () => {
    const { deps } = makeDeps({ operatorAuth: authorizer(false) });
    const res = await app(deps).request("/admin/policy-replay/stream", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("streams progress, result, and done events", async () => {
    const { deps, auditEntries } = makeDeps();
    const res = await app(deps).request("/admin/policy-replay/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateToolAuthzPolicy: {
          rules: [{ id: "d", tool: "search/*", action: "deny" }],
          defaultAction: "allow",
        },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: progress");
    expect(text).toContain('"done":1,"total":1');
    expect(text).toContain("event: result");
    expect(text).toContain("event: done");
    const audit = auditEntries.find((e) => e.action === "policy.replay");
    expect(audit?.details?.["streamed"]).toBe(true);
  });
});

describe("replaySourceFromMonitoringService", () => {
  test("exposes only the two read methods", () => {
    const calls: string[] = [];
    const fake = {
      getHistoryPage: (q: unknown) => {
        calls.push(`page:${JSON.stringify(q)}`);
        return Promise.resolve({ executions: [], total: 0 });
      },
      getExecutionEvents: (id: string) => {
        calls.push(`events:${id}`);
        return Promise.resolve([]);
      },
    };
    const src = replaySourceFromMonitoringService(
      fake as unknown as Parameters<typeof replaySourceFromMonitoringService>[0],
    );
    expect(Object.keys(src).sort()).toEqual(["listEvents", "listHistory"]);
    void src.listHistory({ limit: 5 });
    void src.listEvents("e9");
    expect(calls).toEqual(['page:{"limit":5}', "events:e9"]);
  });
});
