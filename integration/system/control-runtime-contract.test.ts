// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Contract tests: real Runtime HTTP routes vs. the Control consumer contracts.
 *
 * Req 9.10 requires a contract test against a real Runtime. Like
 * contract-flow.test.ts, this boots the ACTUAL Runtime route factories
 * (Hono in-process, no stubs) and asserts that every response body matches
 * the exact wire shape the Control UI parses — the same five operator
 * surfaces covered by apps/control/e2e/ops-pages.spec.ts:
 *
 *   GET  /flows                  → { flows, onlineEditing, fileWriting }
 *   GET  /monitoring/approvals   → { pending, resolved }
 *   POST /monitoring/approvals/:id → { ok } + queue drains
 *   GET  /monitoring/canary      → { deployments }
 *   GET  /admin/tenants          → { tenants }
 *
 * If the Runtime renames or drops one of these fields, these tests fail
 * before the Control UI silently renders empty panels.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createControlRouter } from "../../apps/runtime/src/routes/control.ts";
import { createFlowsRouter } from "../../apps/runtime/src/routes/flows.ts";
import { createTenantsRouter } from "../../apps/runtime/src/routes/tenants.ts";
import { createApprovalGate } from "../../apps/runtime/src/graph/approval-gate.ts";
import { createCanaryManager } from "../../apps/runtime/src/graph/canary.ts";
import { InMemoryTenantStore } from "../../apps/runtime/src/graph/tenant-manager.ts";
import { InMemoryUsageMeter } from "../../apps/runtime/src/observability/billing.ts";
import type { FlowRegistry } from "../../apps/runtime/src/graph/flow-parser.js";
import type { FlowDefinition } from "../../apps/runtime/src/types/flow.js";

// ---------------------------------------------------------------------------
// Control-side consumer validators (mirror apps/control/src parsing exactly).
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStr = (v: unknown): boolean => typeof v === "string" && v.length > 0;

/** First element of a JSON array — avoids non-null assertions under noUncheckedIndexedAccess. */
const first = (arr: Json[]): Json => arr[0] ?? {};

/** Control: fetchFlowList() → { flows: FlowSummary[], onlineEditing, fileWriting }. */
function expectFlowListContract(body: unknown): void {
  expect(isObj(body)).toBe(true);
  const b = body as Json;
  expect(Array.isArray(b.flows)).toBe(true);
  expect(typeof b.onlineEditing).toBe("boolean");
  expect(typeof b.fileWriting).toBe("boolean");
  for (const f of b.flows as Json[]) {
    expect(isStr(f.id)).toBe(true);
    expect(isStr(f.name)).toBe(true);
    expect(f.source === "file" || f.source === "online" || f.source === "db").toBe(true);
  }
}

/** Control: useApprovals → { pending: PendingApproval[], resolved: ResolvedApproval[] }. */
function expectApprovalsContract(body: unknown): void {
  expect(isObj(body)).toBe(true);
  const b = body as Json;
  expect(Array.isArray(b.pending)).toBe(true);
  expect(Array.isArray(b.resolved)).toBe(true);
}

/** Control: useCanary → { deployments: CanaryStatusEntry[] }. */
function expectCanaryContract(body: unknown): void {
  expect(isObj(body)).toBe(true);
  const b = body as Json;
  expect(Array.isArray(b.deployments)).toBe(true);
  for (const d of b.deployments as Json[]) {
    expect(isStr(d.flow)).toBe(true);
    expect(isStr(d.candidate)).toBe(true);
    expect(typeof d.trafficPercent).toBe("number");
    expect(typeof d.rolledBack).toBe("boolean");
    for (const side of ["stable", "canary"] as const) {
      const s = d[side];
      expect(isObj(s)).toBe(true);
      const stats = s as Json;
      for (const key of ["samples", "errors", "scoreSum", "scoreCount"]) {
        expect(typeof stats[key]).toBe("number");
      }
    }
  }
}

/** Control: Tenants page api.tenants → { tenants: Tenant[] }. */
function expectTenantsContract(body: unknown): void {
  expect(isObj(body)).toBe(true);
  const b = body as Json;
  expect(Array.isArray(b.tenants)).toBe(true);
  for (const t of b.tenants as Json[]) {
    expect(isStr(t.id)).toBe(true);
    expect(isStr(t.name)).toBe(true);
    expect(isStr(t.plan)).toBe(true);
    expect(isStr(t.createdAt)).toBe(true);
    expect(isStr(t.updatedAt)).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const def = (id: string, name = id): FlowDefinition => ({
  id,
  name,
  nodes: [
    { id: "n", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } },
  ],
  edges: [],
});

function fileRegistry(...flows: FlowDefinition[]): FlowRegistry {
  const m = new Map(flows.map((f) => [f.id, f]));
  return { get: (id) => m.get(id), list: () => [...m.values()] };
}

// ---------------------------------------------------------------------------
// Tests — real route factories, real response bodies.
// ---------------------------------------------------------------------------

describe("Control ↔ Runtime wire contracts (real route factories)", () => {
  test("GET /flows from the real flows router satisfies the Studio consumer", async () => {
    const router = createFlowsRouter({
      fileRegistry: fileRegistry(def("dispatch", "Dispatch Flow")),
    });
    const res = await router.request("/flows");
    expect(res.status).toBe(200);
    const body = await res.json();
    expectFlowListContract(body);
    const ids = (body as Json).flows as Json[];
    expect(ids.map((f) => f.id)).toContain("dispatch");
  });

  test("approvals list → POST resolve → queue drains, matching useApprovals", async () => {
    const gate = createApprovalGate({
      enabled: true,
      requireApprovalTools: ["send_email"],
      timeoutMs: 60_000,
    });
    if (!gate) throw new Error("approval gate must be enabled for this contract");
    const router = createControlRouter({ approvalGate: gate });

    // Register a pending approval through the real gate (do not await — the
    // decision promise settles only when the operator resolves it).
    void gate.request({
      executionId: "exec-contract-1",
      nodeId: "tool-node",
      tool: "send_email",
      args: { to: "customer@example.com" },
    });

    const listRes = await router.request("/monitoring/approvals");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Json;
    expectApprovalsContract(list);
    const pending = list.pending as Json[];
    expect(pending.length).toBe(1);
    const item = first(pending);
    // Field names the Control ApprovalsPanel renders:
    expect(isStr(item.id)).toBe(true);
    expect(item.executionId).toBe("exec-contract-1");
    expect(item.nodeId).toBe("tool-node");
    expect(item.tool).toBe("send_email");
    expect(isObj(item.args)).toBe(true);
    expect(isStr(item.requestedAt)).toBe(true);

    // Resolve exactly like the Control UI does: POST /monitoring/approvals/{id}
    // with { approved, by }.
    const resolveRes = await router.request(
      `/monitoring/approvals/${String(item.id)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, by: "dashboard" }),
      },
    );
    expect(resolveRes.status).toBe(200);

    const afterRes = await router.request("/monitoring/approvals");
    const after = (await afterRes.json()) as Json;
    expectApprovalsContract(after);
    expect((after.pending as Json[]).length).toBe(0);
    const resolved = after.resolved as Json[];
    expect(resolved.length).toBe(1);
    const resolvedItem = first(resolved);
    expect(resolvedItem.approved).toBe(true);
    expect(resolvedItem.by).toBe("dashboard");
  });

  test("GET /monitoring/canary from a real canary policy file matches useCanary", async () => {
    const flowsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atf-canary-"));
    try {
      fs.writeFileSync(
        path.join(flowsDir, "canary.yaml"),
        [
          "deployments:",
          "  - flow: dispatch",
          "    candidate: dispatch-v2",
          "    trafficPercent: 25",
          "",
        ].join("\n"),
        "utf8",
      );
      const manager = createCanaryManager(flowsDir);
      const router = createControlRouter({ canaryManager: manager });

      const res = await router.request("/monitoring/canary");
      expect(res.status).toBe(200);
      const body = await res.json();
      expectCanaryContract(body);
      const deployments = (body as Json).deployments as Json[];
      expect(deployments.length).toBe(1);
      const deployment = first(deployments);
      expect(deployment.flow).toBe("dispatch");
      expect(deployment.candidate).toBe("dispatch-v2");
      expect(deployment.trafficPercent).toBe(25);
      expect(deployment.rolledBack).toBe(false);
    } finally {
      fs.rmSync(flowsDir, { recursive: true, force: true });
    }
  });

  test("GET /admin/tenants from the real tenants router matches the Tenants page", async () => {
    const tenantStore = new InMemoryTenantStore({ pepper: "contract-test-pepper" });
    await tenantStore.createTenant({ name: "Acme GmbH", plan: "pro", dailyBudget: 25 });
    const router = createTenantsRouter({
      tenantStore,
      usageMeter: new InMemoryUsageMeter(),
    });

    const res = await router.request("/admin/tenants");
    expect(res.status).toBe(200);
    const body = await res.json();
    expectTenantsContract(body);
    const tenants = (body as Json).tenants as Json[];
    expect(tenants.length).toBe(1);
    const tenant = first(tenants);
    expect(tenant.name).toBe("Acme GmbH");
    expect(tenant.plan).toBe("pro");
    expect(tenant.dailyBudget).toBe(25);
  });
});
