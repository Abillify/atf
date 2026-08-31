// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Scheduled-run credentials.
 *
 * A scheduled run has no user request and therefore no user token. Before the
 * authority resolver existed, the scheduler passed the placeholder
 * `scheduled:<executionId>`, which is not a credential: every protected tool call in
 * the fired flow was refused by the MCP wrapper with "Missing required protected
 * parameter value: user_token". Flows using only unprotected tools were unaffected,
 * which is exactly why the defect stayed invisible — it surfaces the first time
 * someone schedules a flow that touches a protected tool.
 *
 * These tests pin the three outcomes: no resolver keeps the old behaviour byte for
 * byte, a resolver supplies the assistant's credential, and a failing resolver fails
 * CLOSED to an empty token rather than back to the placeholder.
 */
import { describe, expect, test } from "bun:test";
import { createTriggerScheduler } from "../trigger-scheduler.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { GraphEngineService } from "../graph-engine.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";

/** A flow with one schedule-mode trigger node. */
function scheduledFlow(config: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: "scheduled-flow",
    name: "Scheduled",
    nodes: [
      {
        id: "tick",
        type: "trigger",
        config: {
          mode: "schedule",
          intervalSeconds: 60,
          scheduledMessage: "run it",
          ...config,
        },
      },
    ],
    edges: [],
  };
}

function registryOf(flow: FlowDefinition): FlowRegistry {
  return {
    list: () => [flow],
    get: (id: string) => (id === flow.id ? flow : undefined),
  } as unknown as FlowRegistry;
}

/** Captures the RequestContext each fired execution was given. */
function recordingEngine(): {
  engine: GraphEngineService;
  contexts: RequestContext[];
} {
  const contexts: RequestContext[] = [];
  const engine = {
    executeFlow: async (_flowId: string, _messages: unknown, ctx: RequestContext) => {
      contexts.push(ctx);
    },
  } as unknown as GraphEngineService;
  return { engine, contexts };
}

/**
 * Fires the scheduler's single registered trigger without waiting for its interval.
 *
 * Reaches the private `fire` through the descriptor the scheduler holds: the
 * alternative is a 60-second real wait, and a shorter interval is clamped by the
 * scheduler's own minimum.
 */
async function fireOnce(scheduler: ReturnType<typeof createTriggerScheduler>): Promise<void> {
  const internals = scheduler as unknown as {
    triggers: Map<string, unknown>;
    fire: (trigger: unknown) => Promise<void>;
  };
  const trigger = [...internals.triggers.values()][0];
  await internals.fire.call(scheduler, trigger);
}

describe("without an authority resolver", () => {
  test("the previous placeholder behaviour is preserved exactly", async () => {
    const { engine, contexts } = recordingEngine();
    const scheduler = createTriggerScheduler(
      registryOf(scheduledFlow()),
      engine,
      undefined,
      undefined,
    );
    scheduler.sync();
    await fireOnce(scheduler);
    scheduler.stop();

    expect(contexts.length).toBe(1);
    // Deployments that schedule only unprotected flows must be untouched by the new
    // hook, so this is asserted rather than assumed.
    expect(contexts[0]?.ssoToken.startsWith("scheduled:")).toBe(true);
  });
});

describe("with an authority resolver", () => {
  test("the assistant's credential reaches the run", async () => {
    const { engine, contexts } = recordingEngine();
    const scheduler = createTriggerScheduler(
      registryOf(scheduledFlow({ assistantId: "molty", tenantId: "acme" })),
      engine,
      undefined,
      undefined,
      {
        resolveAuthority: async (params) => {
          expect(params.assistantId).toBe("molty");
          expect(params.tenantId).toBe("acme");
          return { token: "delegated-access-token" };
        },
      },
    );
    scheduler.sync();
    await fireOnce(scheduler);
    scheduler.stop();

    expect(contexts[0]?.ssoToken).toBe("delegated-access-token");
    // The assistant id is carried into the run so the assistant-context node resolves
    // the same assistant the schedule named.
    expect(contexts[0]?.requestParams?.assistant_id).toBe("molty");
  });

  test("no delegation yields an empty token and a stated reason", async () => {
    const { engine, contexts } = recordingEngine();
    const scheduler = createTriggerScheduler(
      registryOf(scheduledFlow({ assistantId: "molty" })),
      engine,
      undefined,
      undefined,
      {
        resolveAuthority: async () => ({
          token: "",
          notice: "This assistant holds no delegation grant.",
        }),
      },
    );
    scheduler.sync();
    await fireOnce(scheduler);
    scheduler.stop();

    // Empty, not a placeholder: the MCP wrapper refuses locally with a clear message
    // instead of sending a non-credential to an identity provider.
    expect(contexts[0]?.ssoToken).toBe("");
    expect(contexts[0]?.requestParams?.authority_notice).toContain("no delegation grant");
  });

  test("a failing resolver fails CLOSED, not back to the placeholder", async () => {
    const { engine, contexts } = recordingEngine();
    const scheduler = createTriggerScheduler(
      registryOf(scheduledFlow({ assistantId: "molty" })),
      engine,
      undefined,
      undefined,
      {
        resolveAuthority: async () => {
          throw new Error("identity provider unreachable");
        },
      },
    );
    scheduler.sync();
    await fireOnce(scheduler);
    scheduler.stop();

    // The schedule still runs — the flow may not need protected tools at all — but a
    // protected call is refused rather than misdirected.
    expect(contexts.length).toBe(1);
    expect(contexts[0]?.ssoToken).toBe("");
    expect(contexts[0]?.requestParams?.authority_notice).toContain("could not be resolved");
  });

  test("a schedule naming no assistant still fires", async () => {
    const { engine, contexts } = recordingEngine();
    const scheduler = createTriggerScheduler(
      registryOf(scheduledFlow()),
      engine,
      undefined,
      undefined,
      {
        resolveAuthority: async (params) => {
          expect(params.assistantId).toBeUndefined();
          return {
            token: "",
            notice: "Not bound to an assistant.",
          };
        },
      },
    );
    scheduler.sync();
    await fireOnce(scheduler);
    scheduler.stop();

    expect(contexts.length).toBe(1);
    expect(contexts[0]?.ssoToken).toBe("");
  });
});

describe("trigger identity", () => {
  test("changing the assistant id re-registers the trigger", () => {
    const flowA = scheduledFlow({ assistantId: "first" });
    const flowB = scheduledFlow({ assistantId: "second" });
    let current = flowA;
    const registry = {
      list: () => [current],
      get: () => current,
    } as unknown as FlowRegistry;
    const { engine } = recordingEngine();
    const scheduler = createTriggerScheduler(registry, engine, undefined, undefined);
    scheduler.sync();
    current = flowB;
    scheduler.sync();
    const internals = scheduler as unknown as {
      triggers: Map<string, { assistantId?: string }>;
    };
    // Without assistantId in the unchanged-comparison the scheduler would keep firing
    // with the old assistant's credentials after an operator retargeted the schedule.
    expect([...internals.triggers.values()][0]?.assistantId).toBe("second");
    scheduler.stop();
  });
});
