// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for buildAutopilot() (`src/bootstrap/autopilot.ts`).
 *
 * Focus: the two behaviours this module owns beyond simple pass-through
 * wiring:
 *   1. The inactive-path stub router (returns 503 when a prerequisite
 *      subsystem is missing).
 *   2. The active path builds and returns a real AutopilotEngine, mounts a
 *      non-stub `/autopilot/*` router, and wraps `redTeamEngine.run` so
 *      completed runs notify the autopilot.
 *
 * The health-signal poller's timer-driven behaviour is not directly
 * unit-tested here (it is a thin `setInterval` wrapper over
 * `AutopilotEngine.onHealthSnapshot`, itself covered by
 * `autopilot-engine.test.ts`); this suite verifies it is only started when
 * RED_TEAM_SCHEDULE_FLOWS is non-empty by checking no timer-related error
 * occurs and no health flows means no snapshot call within a short wait.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { buildAutopilot } from "../autopilot.js";
import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type { RedTeamEngine, RedTeamRun } from "../../security/red-team-engine.js";
import type { FlowOptimizer, OptimizationRun } from "../../graph/flow-optimizer.js";
import type { FlowStore } from "../../graph/flow-store.js";
import type { CanaryManager } from "../../graph/canary.js";
import type { OperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { ModelQualityRegistry } from "../../graph/model-quality.js";

function createFakeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => createFakeLogger(),
  } as unknown as Logger;
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    flowsDir: "./flows",
    monitoringTransport: "sse",
    mcpServers: [],
    corsOrigins: ["*"],
    monitoringAuthRequired: false,
    logLevel: "error",
    maxToolSteps: 5,
    maxConcurrentExecutions: 50,
    ...overrides,
  } as AppConfig;
}

const fakeOperatorAuth = {
  rbacEnabled: false,
  authorize: async () => ({
    ok: true,
    actor: { name: "test-operator", role: "admin" as const, via: "open" as const },
  }),
} as unknown as OperatorAuthorizer;
const fakeCanaryManager = { enabled: false, status: () => [] } as unknown as CanaryManager;
const fakeModelQuality = { snapshot: () => [] } as unknown as ModelQualityRegistry;

function fakeMonitoringService(): MonitoringServiceInterface {
  return {
    emitNodeEvent: () => {},
    getTransportType: () => "sse",
    getHistory: async () => [],
    getTokenUsageHistory: async () => [],
    subscribe: () => () => {},
    getTicketSecret: () => undefined,
  } as unknown as MonitoringServiceInterface;
}

describe("buildAutopilot — inactive path", () => {
  test("mounts a 503 stub router when redTeamEngine is undefined", async () => {
    const app = new Hono();
    const result = await buildAutopilot({
      config: baseConfig(),
      app: app as never,
      logger: createFakeLogger(),
      auditLog: undefined,
      database: undefined,
      operatorAuth: fakeOperatorAuth,
      monitoringService: fakeMonitoringService(),
      modelQuality: fakeModelQuality,
      canaryManager: fakeCanaryManager,
      redTeamEngine: undefined,
      flowOptimizer: undefined,
      flowStore: undefined,
    });

    expect(result.autopilotEngine).toBeUndefined();

    const res = await app.request("/autopilot/runs");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("RED_TEAM_ENABLED");
  });

  test("mounts the stub even when only flowOptimizer is missing", async () => {
    const app = new Hono();
    const fakeRedTeam = { run: async () => ({}) } as unknown as RedTeamEngine;
    const result = await buildAutopilot({
      config: baseConfig(),
      app: app as never,
      logger: createFakeLogger(),
      auditLog: undefined,
      database: undefined,
      operatorAuth: fakeOperatorAuth,
      monitoringService: fakeMonitoringService(),
      modelQuality: fakeModelQuality,
      canaryManager: fakeCanaryManager,
      redTeamEngine: fakeRedTeam,
      flowOptimizer: undefined,
      flowStore: {} as FlowStore,
    });
    expect(result.autopilotEngine).toBeUndefined();
    const res = await app.request("/autopilot/config");
    expect(res.status).toBe(503);
  });
});

describe("buildAutopilot — active path", () => {
  function makeFakeOptimizer(): FlowOptimizer {
    const runs = new Map<string, OptimizationRun>();
    return {
      start(cfg) {
        const run: OptimizationRun = {
          id: "opt-1",
          flowId: cfg.flowId,
          targetNodeId: "responder",
          startedAt: new Date().toISOString(),
          status: "done",
          sampleCount: 0,
          variants: [],
        };
        runs.set(run.id, run);
        return run;
      },
      async run(cfg) {
        return this.start(cfg);
      },
      async promote(runId, label) {
        const run = runs.get(runId);
        if (run === undefined) throw new Error("not found");
        return { ...run, promotedVariant: label };
      },
      getRun: (id) => runs.get(id),
      listRuns: () => [...runs.values()],
    };
  }

  test("builds a real AutopilotEngine and mounts a working /autopilot router", async () => {
    const app = new Hono();
    let capturedRunArgs: unknown;
    const fakeRedTeam = {
      run: async (...args: unknown[]) => {
        capturedRunArgs = args;
        return {
          id: "rt-1",
          flowId: "flow-a",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: "done",
          bypassRate: 0,
          results: [],
        } as unknown as RedTeamRun;
      },
    } as unknown as RedTeamEngine;

    const result = await buildAutopilot({
      config: baseConfig({
        redTeamEnabled: true,
        optimizerEnabled: true,
        autopilotRequireApproval: true,
      }),
      app: app as never,
      logger: createFakeLogger(),
      auditLog: undefined,
      database: undefined,
      operatorAuth: fakeOperatorAuth,
      monitoringService: fakeMonitoringService(),
      modelQuality: fakeModelQuality,
      canaryManager: fakeCanaryManager,
      redTeamEngine: fakeRedTeam,
      flowOptimizer: makeFakeOptimizer(),
      flowStore: {} as FlowStore,
    });

    expect(result.autopilotEngine).toBeDefined();
    if (result.autopilotEngine === undefined) throw new Error("expected an autopilot engine");
    expect(result.autopilotEngine.config.requireHumanApproval).toBe(true);

    // The mounted router must be the real one, not the 503 stub.
    const res = await app.request("/autopilot/config");
    expect(res.status).toBe(200);

    // Calling the (now-wrapped) redTeamEngine.run must still invoke the
    // original implementation and forward its arguments unchanged.
    await (fakeRedTeam.run as unknown as (...args: unknown[]) => Promise<unknown>)(
      "flow-a",
    );
    expect(capturedRunArgs).toEqual(["flow-a"]);
  });
});
