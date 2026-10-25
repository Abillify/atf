// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow-health monitoring route (`src/routes/flow-health.ts`).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createFlowHealthRouter } from "../flow-health.js";
import type { FlowHealthRouterDeps } from "../flow-health.js";
import { InMemoryEvalRunHistory } from "../../eval/eval-run-history.js";
import type { EvalReport } from "../../eval/eval-runner.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import { signMonitoringTicket } from "../../monitoring/monitoring-ticket.js";
import {
  recordFlowLoadFailure,
  resetFlowLoadFailures,
} from "../../graph/flow-parser/validate.js";
import { FlowSloEvaluator } from "../../observability/flow-slo.js";
import type { FlowDefinition } from "../../types/flow.js";

const TICKET_SECRET = "flow-health-test-secret";

const adminAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "admin-tok", role: "admin", name: "alice" },
    { token: "viewer-tok", role: "viewer" },
  ],
});

function flow(id: string, extra?: Partial<FlowDefinition>): FlowDefinition {
  return {
    id,
    name: `Flow ${id}`,
    nodes: [],
    edges: [],
    ...extra,
  } as unknown as FlowDefinition;
}

const REPORT: EvalReport = {
  name: "flow-a",
  total: 5,
  passed: 4,
  failed: 1,
  passRate: 0.8,
  totalCost: 0.01,
  avgLatencyMs: 120,
  cases: [],
};

interface HealthResponse {
  generatedAt: string;
  flows: Array<{
    id: string;
    source: "file" | "db";
    file?: string;
    version?: string;
    digest?: string;
    shadowsFile: boolean;
    lastEval?: { runId: string; at: string; passed: number; failed: number };
    slo?: {
      window: number;
      objectives: Record<string, number>;
      samples: number;
      minSamples: number;
      breached: string[];
    };
  }>;
  loadFailures: Array<{ file: string; reason: string; since: string }>;
}

function buildApp(overrides?: Partial<FlowHealthRouterDeps>) {
  const fileFlow = flow("flow-a", { metadata: { version: "1.2.0" } });
  const dbFlow = flow("flow-b");
  const fileRegistry = {
    list: () => [fileFlow],
    getSource: (id: string) =>
      id === "flow-a"
        ? { definition: {}, fileName: "flow-a.yaml" }
        : undefined,
  };
  const dbSource = {
    get: (id: string) => (id === "flow-b" ? dbFlow : undefined),
    list: () => [dbFlow],
  };
  const flowRegistry = {
    list: () => [fileFlow, dbFlow],
  };
  const evalHistory = new InMemoryEvalRunHistory();
  const deps: FlowHealthRouterDeps = {
    flowRegistry,
    fileRegistry,
    dbSource,
    evalHistory,
    authRequired: true,
    operatorAuth: adminAuth,
    ticketSecret: TICKET_SECRET,
    ...overrides,
  };
  const app = new Hono();
  app.route("/", createFlowHealthRouter(deps));
  return { app, evalHistory };
}

describe("GET /monitoring/flow-health", () => {
  beforeEach(() => resetFlowLoadFailures());
  afterEach(() => resetFlowLoadFailures());

  it("returns 401 without a token when auth is required", async () => {
    const { app } = buildApp();
    const res = await app.request("/monitoring/flow-health");
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.message).toBe("Unauthorized monitoring access.");
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns the merged flow list with source, file, version and digest", async () => {
    const { app } = buildApp();
    const res = await app.request("/monitoring/flow-health", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(typeof body.generatedAt).toBe("string");
    expect(body.flows.map((f) => f.id)).toEqual(["flow-a", "flow-b"]);

    const a = body.flows[0];
    if (a === undefined) throw new Error("expected flow-a");
    expect(a.source).toBe("file");
    expect(a.file).toBe("flow-a.yaml");
    expect(a.version).toBe("1.2.0");
    expect(a.digest?.startsWith("sha256:")).toBe(true);
    expect(a.shadowsFile).toBe(false);

    const b = body.flows[1];
    if (b === undefined) throw new Error("expected flow-b");
    expect(b.source).toBe("db");
    expect(b.file).toBeUndefined();
    expect(b.version).toBeUndefined();
    expect(b.shadowsFile).toBe(false);
  });

  it("marks DB flows that shadow a same-id file flow", async () => {
    const shared = flow("flow-a");
    const { app } = buildApp({
      flowRegistry: { list: () => [shared] },
      fileRegistry: {
        list: () => [shared],
        getSource: () => ({ definition: {}, fileName: "flow-a.yaml" }),
      },
      dbSource: { get: () => shared, list: () => [shared] },
    });
    const res = await app.request("/monitoring/flow-health", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as HealthResponse;
    expect(body.flows).toHaveLength(1);
    const entry = body.flows[0];
    if (entry === undefined) throw new Error("expected flow-a");
    expect(entry.source).toBe("db");
    expect(entry.shadowsFile).toBe(true);
    expect(entry.file).toBeUndefined();
  });

  it("includes lastEval from the eval-run history when a record exists", async () => {
    const { app, evalHistory } = buildApp();
    const recorded = await evalHistory.record({
      name: "flow-a",
      source: "ci",
      report: REPORT,
    });
    const res = await app.request("/monitoring/flow-health", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as HealthResponse;
    const a = body.flows[0];
    if (a?.lastEval === undefined) throw new Error("expected lastEval");
    expect(a.lastEval.runId).toBe(recorded.id);
    expect(a.lastEval.at).toBe(recorded.recordedAt);
    expect(a.lastEval.passed).toBe(4);
    expect(a.lastEval.failed).toBe(1);
    const b = body.flows[1];
    if (b === undefined) throw new Error("expected flow-b");
    expect(b.lastEval).toBeUndefined();
  });

  it("omits lastEval entirely when no history is wired", async () => {
    const { app } = buildApp({ evalHistory: undefined });
    const res = await app.request("/monitoring/flow-health", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    const body = (await res.json()) as HealthResponse;
    for (const entry of body.flows) expect(entry.lastEval).toBeUndefined();
  });

  it("reports flow load failures from the ledger", async () => {
    recordFlowLoadFailure("broken.yaml", "schema validation failed");
    const { app } = buildApp();
    const res = await app.request("/monitoring/flow-health", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as HealthResponse;
    expect(body.loadFailures).toHaveLength(1);
    const failure = body.loadFailures[0];
    if (failure === undefined) throw new Error("expected a load failure");
    expect(failure.file).toBe("broken.yaml");
    expect(failure.reason).toBe("schema validation failed");
    expect(typeof failure.since).toBe("string");
  });

  it("accepts a valid short-lived monitoring ticket in ?token=", async () => {
    const { app } = buildApp();
    const { ticket } = signMonitoringTicket(TICKET_SECRET, "viewer", 60);
    const res = await app.request(
      `/monitoring/flow-health?token=${encodeURIComponent(ticket)}`,
    );
    expect(res.status).toBe(200);
  });

  it("rejects a ticket signed with the wrong secret", async () => {
    const { app } = buildApp();
    const { ticket } = signMonitoringTicket("other-secret", "admin", 60);
    const res = await app.request(
      `/monitoring/flow-health?token=${encodeURIComponent(ticket)}`,
    );
    expect(res.status).toBe(401);
  });

  it("is open when auth is not required", async () => {
    const { app } = buildApp({
      authRequired: false,
      operatorAuth: createOperatorAuthorizer({ authRequired: false }),
    });
    const res = await app.request("/monitoring/flow-health");
    expect(res.status).toBe(200);
  });

  it("reports declared slo with the evaluator's live state", async () => {
    const flowSlo = new FlowSloEvaluator({
      metrics: { recordCounter: () => {} },
    });
    const slo = { window: 20, p50LatencyMs: 500 };
    for (let i = 0; i < 12; i++) {
      flowSlo.recordExecution("flow-a", slo, {
        latencyMs: 5000,
        totalTokens: 10,
        errored: false,
      });
    }
    const { app } = buildApp({
      flowRegistry: {
        list: () => [flow("flow-a", { slo }), flow("flow-b")],
      },
      flowSlo,
    });
    const res = await app.request("/monitoring/flow-health", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    const a = body.flows[0];
    if (a?.slo === undefined) throw new Error("expected slo on flow-a");
    expect(a.slo.window).toBe(20);
    expect(a.slo.objectives).toEqual({ p50LatencyMs: 500 });
    expect(a.slo.samples).toBe(12);
    expect(a.slo.minSamples).toBe(10);
    expect(a.slo.breached).toEqual(["p50LatencyMs"]);
    // A flow without a declaration has no slo field at all.
    const b = body.flows[1];
    if (b === undefined) throw new Error("expected flow-b");
    expect(b.slo).toBeUndefined();
  });

  it("reports declared objectives with an empty state when no evaluator is wired", async () => {
    const { app } = buildApp({
      flowRegistry: {
        list: () => [flow("flow-a", { slo: { maxErrorRate: 0.05 } })],
      },
      flowSlo: undefined,
    });
    const res = await app.request("/monitoring/flow-health", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as HealthResponse;
    const a = body.flows[0];
    if (a?.slo === undefined) throw new Error("expected slo on flow-a");
    expect(a.slo.window).toBe(50);
    expect(a.slo.objectives).toEqual({ maxErrorRate: 0.05 });
    expect(a.slo.samples).toBe(0);
    expect(a.slo.breached).toEqual([]);
  });
});
