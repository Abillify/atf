// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for GET /monitoring/providers.
 *
 * The route is an aggregation over four independent sources — the configured
 * PROVIDERS registry, the metrics summary, the capability registry and the
 * model-shortcut pools — so the tests pin the JOINS rather than any single
 * source: that a provider seen only in metrics still surfaces, that pool
 * membership is resolved through nested shortcut references, and that a pool
 * only counts as unreachable when every member is.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createProviderMonitoringRouter } from "../provider-monitoring.js";
import type { AppConfig } from "../../config/index.js";
import { setProviderRegistry } from "../../config/providers.js";
import { createMetrics, type Metrics } from "../../observability/metrics.js";
import {
  createProviderCircuitBreaker,
  type ProviderCircuitBreaker,
} from "../../graph/provider-circuit-breaker.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

const SHORTCUTS = `
engines:
  primary:
    provider: primary
  secondary:
    provider: secondary
  cloud:
    provider: cloudy
modelPresets:
  local:
    model: local-model
  hosted:
    model: hosted-model
shortcuts:
  rr:
    pool:
      strategy: round-robin
      members:
        - engine: primary
          model: local
        - engine: secondary
          model: local
  tiered:
    pool:
      strategy: fallback
      members:
        - shortcut: rr
        - engine: cloud
          model: hosted
  single:
    engine: cloud
    model: hosted
`;

let tmpDir: string;

function buildApp(options: {
  metrics: Metrics;
  breaker: ProviderCircuitBreaker;
  flowsDir?: string;
  authRequired?: boolean;
}) {
  const config = {
    port: 3000,
    flowsDir: options.flowsDir ?? tmpDir,
    monitoringTransport: "sse",
    mcpServers: [],
    corsOrigins: ["*"],
    monitoringAuthRequired: options.authRequired ?? false,
    logLevel: "error",
    maxToolSteps: 5,
    maxConcurrentExecutions: 50,
    migrateOnStart: true,
    defaultLlm: { provider: "primary", model: "local-model" },
  } as AppConfig;

  const app = new Hono();
  app.route(
    "/",
    createProviderMonitoringRouter({
      metrics: options.metrics,
      config,
      providerCircuitBreaker: options.breaker,
      ...(options.authRequired === true
        ? {
            operatorAuth: createOperatorAuthorizer({
              authRequired: true,
              tokens: [{ token: "viewer-tok", role: "viewer" }],
            }),
          }
        : {}),
    }),
  );
  return app;
}

interface MonitoringBody {
  providers: Array<{
    name: string;
    protocol?: string;
    configured: boolean;
    models: string[];
    capabilities: {
      reasoning: boolean;
      toolCalling: boolean;
      structuredOutput: string;
      visionInput: boolean;
      contextLength?: number;
    };
    status: { state: string; failure_count: number };
    calls: number;
    errors: number;
    tokens: number;
  }>;
  pools: Array<{
    name: string;
    strategy: string;
    providers: string[];
    calls: number;
    errors: number;
    unreachable: boolean;
  }>;
  global: { queueDepth: number; activeExecutions: number };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-monitoring-"));
  fs.writeFileSync(path.join(tmpDir, "model-shortcuts.yaml"), SHORTCUTS, "utf8");
  setProviderRegistry([
    { name: "primary", protocol: "openai", url: "http://127.0.0.1:1/v1", local: true },
    { name: "secondary", protocol: "openai", url: "http://127.0.0.1:2/v1", local: true },
    { name: "cloudy", protocol: "bedrock", region: "eu-central-1" },
  ]);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  // The registry is module-global; leave it as other suites expect to find it.
  setProviderRegistry([]);
});

describe("GET /monitoring/providers", () => {
  it("reports configured providers with protocol, capabilities and counters", async () => {
    const metrics = createMetrics(true);
    metrics.recordLlmCall("primary", "local-model", "ok", 10, 4, 0.01);
    metrics.recordLlmCall("primary", "local-model", "error", 0, 0, 0);
    metrics.setQueueDepth(3);
    metrics.setActiveExecutions(2);

    const res = await buildApp({
      metrics,
      breaker: createProviderCircuitBreaker(),
    }).request("/monitoring/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitoringBody;

    const primary = body.providers.find((p) => p.name === "primary");
    expect(primary).toMatchObject({
      protocol: "openai",
      configured: true,
      calls: 2,
      errors: 1,
      // 10 prompt + 4 completion, the error call contributing none.
      tokens: 14,
    });
    expect(primary?.models).toEqual(["local-model"]);
    // Capabilities are keyed by the resolved PROTOCOL, not the instance name.
    expect(primary?.capabilities).toMatchObject({
      toolCalling: true,
      structuredOutput: "response_format",
      reasoning: false,
    });

    // A bedrock instance inherits the Claude-family axes from its protocol.
    expect(
      body.providers.find((p) => p.name === "cloudy")?.capabilities,
    ).toMatchObject({ reasoning: true, toolCalling: true, visionInput: true });

    // Queue depth and active executions are process-wide, reported once.
    expect(body.global).toEqual({ queueDepth: 3, activeExecutions: 2 });
  });

  it("surfaces a provider that only appears in the metrics as not configured", async () => {
    const metrics = createMetrics(true);
    metrics.recordLlmCall("ghost", "ghost-model", "ok", 1, 1, 0);

    const res = await buildApp({
      metrics,
      breaker: createProviderCircuitBreaker(),
    }).request("/monitoring/providers");
    const body = (await res.json()) as MonitoringBody;

    const ghost = body.providers.find((p) => p.name === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.configured).toBe(false);
    expect(ghost?.calls).toBe(1);
    // Unknown provider name resolves to no protocol and fails closed.
    expect(ghost?.protocol).toBeUndefined();
    expect(ghost?.capabilities).toMatchObject({
      reasoning: false,
      toolCalling: false,
    });
  });

  it("reports the circuit-breaker state as the reachability signal", async () => {
    const breaker = createProviderCircuitBreaker({ failureThreshold: 2 });
    breaker.recordTransportFailure("primary", "ECONNREFUSED");
    breaker.recordTransportFailure("primary", "ECONNREFUSED");

    const res = await buildApp({
      metrics: createMetrics(true),
      breaker,
    }).request("/monitoring/providers");
    const body = (await res.json()) as MonitoringBody;

    expect(body.providers.find((p) => p.name === "primary")?.status).toMatchObject(
      { state: "open", failure_count: 2 },
    );
    expect(
      body.providers.find((p) => p.name === "secondary")?.status,
    ).toMatchObject({ state: "closed" });
  });

  it("resolves pool members through nested shortcut references", async () => {
    const res = await buildApp({
      metrics: createMetrics(true),
      breaker: createProviderCircuitBreaker(),
    }).request("/monitoring/providers");
    const body = (await res.json()) as MonitoringBody;

    expect(body.pools.find((p) => p.name === "rr")).toMatchObject({
      strategy: "round-robin",
      providers: ["primary", "secondary"],
    });
    // `tiered` references the `rr` pool plus a direct engine — all three
    // providers must be collected transitively.
    const tiered = body.pools.find((p) => p.name === "tiered");
    expect(tiered?.strategy).toBe("fallback");
    expect(tiered?.providers.sort()).toEqual(["cloudy", "primary", "secondary"]);
    // A non-pool shortcut is not a pool.
    expect(body.pools.some((p) => p.name === "single")).toBe(false);
  });

  it("aggregates pool counters and marks a pool unreachable only when every member is", async () => {
    const metrics = createMetrics(true);
    metrics.recordLlmCall("primary", "local-model", "ok", 1, 1, 0);
    metrics.recordLlmCall("secondary", "local-model", "error", 0, 0, 0);

    const breaker = createProviderCircuitBreaker({ failureThreshold: 1 });
    breaker.recordTransportFailure("primary", "ECONNREFUSED");

    const partiallyOpen = (await (
      await buildApp({ metrics, breaker }).request("/monitoring/providers")
    ).json()) as MonitoringBody;
    const rrPartial = partiallyOpen.pools.find((p) => p.name === "rr");
    // Pool counters are the sum over its members.
    expect(rrPartial).toMatchObject({ calls: 2, errors: 1 });
    // One reachable member still serves the pool.
    expect(rrPartial?.unreachable).toBe(false);

    breaker.recordTransportFailure("secondary", "ECONNREFUSED");
    const allOpen = (await (
      await buildApp({ metrics, breaker }).request("/monitoring/providers")
    ).json()) as MonitoringBody;
    expect(allOpen.pools.find((p) => p.name === "rr")?.unreachable).toBe(true);
    // `tiered` still has the untouched cloud member, so it stays reachable.
    expect(allOpen.pools.find((p) => p.name === "tiered")?.unreachable).toBe(
      false,
    );
  });

  it("reports no pools when the flows dir has no model shortcuts", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-shortcuts-"));
    try {
      const res = await buildApp({
        metrics: createMetrics(true),
        breaker: createProviderCircuitBreaker(),
        flowsDir: emptyDir,
      }).request("/monitoring/providers");
      const body = (await res.json()) as MonitoringBody;
      expect(body.pools).toEqual([]);
      // Providers still come from the registry.
      expect(body.providers.map((p) => p.name)).toContain("primary");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("requires monitoring:read when operator auth is enabled", async () => {
    const app = buildApp({
      metrics: createMetrics(true),
      breaker: createProviderCircuitBreaker(),
      authRequired: true,
    });

    expect((await app.request("/monitoring/providers")).status).toBe(401);
    expect(
      (
        await app.request("/monitoring/providers", {
          headers: { Authorization: "Bearer viewer-tok" },
        })
      ).status,
    ).toBe(200);
  });
});
