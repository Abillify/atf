// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the control-plane routes (approvals, replay, canary) under
 * /monitoring/*, sharing the monitoring auth gate.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createControlRouter } from "../control.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import { createApprovalGate } from "../../graph/approval-gate.js";
import type {
  ApprovalGateConfig,
  ApprovalRegistry,
} from "../../graph/approval-gate.js";
import { signApprovalLinkToken } from "../../graph/approval-link.js";
import {
  createReplayService,
  InMemoryReplayStore,
} from "../../graph/replay.js";
import { createCanaryManager } from "../../graph/canary.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function app(deps: Parameters<typeof createControlRouter>[0]) {
  const a = new Hono();
  a.route("/", createControlRouter(deps));
  return a;
}

/** `createApprovalGate` for a config known to enable the gate (never undefined). */
function mustCreateApprovalGate(config: ApprovalGateConfig): ApprovalRegistry {
  const gate = createApprovalGate(config);
  if (gate === undefined)
    throw new Error("expected the approval gate to be enabled");
  return gate;
}

/** The id of the first pending approval, asserting one actually exists. */
async function firstPendingId(gate: ApprovalRegistry): Promise<string> {
  const pending = await gate.listPending();
  const first = pending[0];
  if (first === undefined) throw new Error("expected a first pending approval");
  return first.id;
}

describe("approvals routes", () => {
  test("GET /monitoring/approvals lists pending and POST resolves", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({ approvalGate: gate });

    const decision = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "demo-mcp/case_lookup",
      args: { reference: "A-123" },
    });

    const list = await a.request("/monitoring/approvals");
    const body = (await list.json()) as {
      pending: Array<{ id: string; tool: string }>;
    };
    expect(body.pending).toHaveLength(1);
    const firstPending = body.pending[0];
    if (firstPending === undefined)
      throw new Error("expected a first pending approval");
    expect(firstPending.tool).toBe("demo-mcp/case_lookup");

    const id = firstPending.id;
    const res = await a.request(`/monitoring/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, by: "alice" }),
    });
    expect(res.status).toBe(200);
    const decided = await decision;
    expect(decided.approved).toBe(true);
    expect(decided.by).toBe("alice");
  });

  test("POST with missing 'approved' is 400", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate });
    const res = await a.request("/monitoring/approvals/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST for an unknown id is 404", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate });
    const res = await a.request("/monitoring/approvals/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    expect(res.status).toBe(404);
  });

  test("401 when auth is required and no token is provided", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate, authRequired: true });
    const res = await a.request("/monitoring/approvals");
    expect(res.status).toBe(401);
  });

  test("a format-only token is rejected by default (fail-closed)", async () => {
    // `aaa.bbb.ccc` passes the SHAPE check but carries no verified identity.
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate, authRequired: true });
    const res = await a.request("/monitoring/approvals?token=aaa.bbb.ccc");
    expect(res.status).toBe(401);
  });

  test("authorised with a format-only token only when explicitly opted into", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      operatorAuth: createOperatorAuthorizer({
        authRequired: true,
        allowUnverifiedJwt: true,
      }),
    });
    const res = await a.request("/monitoring/approvals?token=aaa.bbb.ccc");
    expect(res.status).toBe(200);
  });
});

describe("approval-link capability token (in-chat widget)", () => {
  const SECRET = "control-test-secret-at-least-32-chars-long";

  test("GET /:id/widget is authorised by a valid capability token (no operator bearer)", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
      approvalFrameAncestors: ["https://chat.example.com"],
    });

    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);
    const res = await a.request(
      `/monitoring/approvals/${id}/widget?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://chat.example.com;",
    );
    const html = await res.text();
    // The decide buttons must carry the same token forward (relative hrefs drop the query).
    expect(html).toContain(
      `decide?decision=approved&token=${encodeURIComponent(token)}`,
    );
  });

  test("GET /:id/decide with a valid capability token resolves the approval as the requesting user", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });

    const decision = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const decided = await decision;
    expect(decided.approved).toBe(true);
    expect(decided.by).toBe("Example Contributor");
  });

  test("GET /:id/decide without a token is 401 when auth is required", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
    });
    const id = await firstPendingId(gate);
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved`,
    );
    expect(res.status).toBe(401);
  });

  test("a capability token for a different approval id is rejected", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
    });
    const id = await firstPendingId(gate);
    const wrongToken = signApprovalLinkToken(
      "some-other-id",
      SECRET,
      Date.now() + 60_000,
    );
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(wrongToken)}`,
    );
    expect(res.status).toBe(401);
  });
});

describe("replay route", () => {
  test("POST /monitoring/replay re-runs a captured snapshot", async () => {
    const store = new InMemoryReplayStore();
    const svc = createReplayService(store, async (_flow, msgs) => {
      const first = msgs[0];
      return {
        text: `echo:${typeof first?.content === "string" ? first.content : ""}`,
      };
    });
    await svc.capture({
      executionId: "exec-9",
      flowId: "helpdesk",
      messages: [{ role: "user", content: "hallo" }],
      responseText: "echo:hallo",
      createdAt: new Date().toISOString(),
    });
    const a = app({ replayService: svc });

    const res = await a.request("/monitoring/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_id: "exec-9" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; similarity: number };
    expect(body.changed).toBe(false);
    expect(body.similarity).toBe(1);
  });

  test("missing execution_id → 400", async () => {
    const store = new InMemoryReplayStore();
    const svc = createReplayService(store, async () => ({ text: "" }));
    const a = app({ replayService: svc });
    const res = await a.request("/monitoring/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("unknown execution → 404", async () => {
    const store = new InMemoryReplayStore();
    const svc = createReplayService(store, async () => ({ text: "" }));
    const a = app({ replayService: svc });
    const res = await a.request("/monitoring/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_id: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("canary status route", () => {
  test("GET /monitoring/canary returns deployment status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-route-"));
    fs.writeFileSync(
      path.join(dir, "canary.json"),
      JSON.stringify({
        deployments: [
          { flow: "prod", candidate: "prod-v2", trafficPercent: 25 },
        ],
      }),
    );
    const mgr = createCanaryManager(dir);
    const a = app({ canaryManager: mgr });

    const res = await a.request("/monitoring/canary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{ flow: string; trafficPercent: number }>;
    };
    expect(body.deployments).toHaveLength(1);
    const firstDeployment = body.deployments[0];
    if (firstDeployment === undefined)
      throw new Error("expected a first deployment");
    expect(firstDeployment.flow).toBe("prod");
    expect(firstDeployment.trafficPercent).toBe(25);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("MCP server approval display", () => {
  test("renders escaped server title, message and fields instead of raw args", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({ approvalGate: gate });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "bank/pay",
      args: { internal: "raw" },
      title: "Zahlung <freigeben>",
      message: "Kein <script>alert(1)</script> ausführen",
      fields: [
        { name: "amount", label: "Betrag", value: "10 & 20" },
        { name: "recipient", label: "Empfänger", value: "Ada" },
      ],
    });
    const id = await firstPendingId(gate);
    const response = await a.request(`/monitoring/approvals/${id}/widget`);
    const html = await response.text();
    expect(html).toContain("Zahlung &lt;freigeben&gt;");
    expect(html).toContain(
      "Kein &lt;script&gt;alert(1)&lt;/script&gt; ausführen",
    );
    expect(html).toContain("10 &amp; 20");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("internal");
  });
});
