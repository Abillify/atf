// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for GET /monitoring/posture (`src/routes/posture.ts`).
 *
 * Pins the monitoring auth contract (401 without credentials when
 * MONITORING_AUTH is active, 200 with a report when authenticated) and that
 * the runtime facts (policy loaded, flow load failures) reach the report.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createPostureRouter } from "../posture.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type { AppConfig } from "../../config/schema.js";

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    // Fields the production gate reads unconditionally (as in a loaded config).
    port: 3000,
    flowsDir: "./flows",
    monitoringTransport: "sse",
    mcpServers: [],
    corsOrigins: ["https://app.example.com"],
    appEnv: "production",
    evidenceSigningKey: "dGVzdC1lZDI1NTE5LXNlZWQtZm9yLXBvc3R1cmUtdGVzdHM=",
    auditAnchorFile: "/var/lib/atf/anchors.jsonl",
    egressAllowedHosts: ["api.openai.com"],
    taintWriteToolsRequireApproval: true,
    aiDisclosure: "field",
    decisionReceiptsEnabled: true,
    receiptSigningKey: "receipt-secret",
    redisUrl: "redis://127.0.0.1:6379",
    ...over,
  } as AppConfig;
}

function buildApp(opts: {
  authRequired?: boolean;
  policyLoaded?: boolean;
  flowLoadFailures?: number;
}): Hono {
  const app = new Hono();
  app.route(
    "/",
    createPostureRouter({
      config: config(),
      authRequired: opts.authRequired ?? false,
      ...(opts.authRequired === true
        ? {
            operatorAuth: createOperatorAuthorizer({
              authRequired: true,
              tokens: [{ token: "viewer-tok", role: "viewer" }],
            }),
          }
        : {}),
      policyLoaded: () => opts.policyLoaded ?? true,
      flowLoadFailures: () => opts.flowLoadFailures ?? 0,
    }),
  );
  return app;
}

describe("GET /monitoring/posture", () => {
  it("returns 401 without credentials when monitoring auth is required", async () => {
    const app = buildApp({ authRequired: true });
    const res = await app.request("/monitoring/posture");
    expect(res.status).toBe(401);
  });

  it("returns 200 with the posture report when authenticated", async () => {
    const app = buildApp({ authRequired: true });
    const res = await app.request("/monitoring/posture", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: unknown[];
    };
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it("rejects an unknown token", async () => {
    const app = buildApp({ authRequired: true });
    const res = await app.request("/monitoring/posture", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns the report when auth is not required", async () => {
    const app = buildApp({ authRequired: false });
    const res = await app.request("/monitoring/posture");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generatedAt: string;
      status: string;
      summary: { ok: number; warn: number; fail: number };
      checks: Array<{ id: string; status: string; message: string }>;
    };
    expect(typeof body.generatedAt).toBe("string");
    expect(body.checks.length).toBeGreaterThan(0);
    expect(
      body.checks.find((c) => c.id === "compliance_policy" || c.id === "policy"),
    ).toBeDefined();
    expect(body.summary.ok + body.summary.warn + body.summary.fail).toBe(
      body.checks.length,
    );
  });

  it("reflects runtime facts in the report", async () => {
    const app = buildApp({ authRequired: false, flowLoadFailures: 2 });
    const res = await app.request("/monitoring/posture");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checks: Array<{ id: string; status: string }>;
    };
    const flow = body.checks.find((c) => c.id.includes("flow"));
    expect(flow).toBeDefined();
    expect(flow?.status).toBe("fail");
  });

  it("renders a text table with format=table", async () => {
    const app = buildApp({ authRequired: false });
    const res = await app.request("/monitoring/posture?format=table");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ok,");
    expect(text).toContain("overall:");
  });
});
