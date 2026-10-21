// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Durable delegation runner for the agent harness (Req 13.6).
 *
 * Extracted verbatim from `loop.ts`: resolves the optional durable run-store
 * binding for the current run and wraps every `delegate()` call with
 * claim/heartbeat/settle lifecycle handling. Lifecycle and durable-store
 * failures are converted into a generic execution error at this boundary so
 * the outer graph/route catch cannot leak operational details.
 *
 * @module agent-harness/loop-delegation
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { resolveAssistantScope } from "../../assistants/types.js";
import type { FlowNode } from "../../types/flow.js";
import { NODE_INSTANCE_KEY } from "../graph-engine/node-instance.js";
import type { AgentState, ExecRuntime } from "../graph-engine.js";
import { delegate } from "./tools.js";

/** Registry override used by tests to inject handler factories. */
export type DelegationRegistry = {
  get(
    type: string,
  ):
    | {
        factory: (
          node: FlowNode,
          ctx: { nodeMap: Map<string, FlowNode> },
        ) => (
          state: AgentState,
          config?: LangGraphRunnableConfig,
        ) => Partial<AgentState> | Promise<Partial<AgentState>>;
      }
    | undefined;
};

export interface DelegationRunnerDeps {
  runtime: ExecRuntime;
  node: FlowNode;
  nodeMap: Map<string, FlowNode>;
  registry?: DelegationRegistry;
}

/**
 * Builds the harness `runDelegation` helper for one handler invocation.
 */
export const createDelegationRunner = ({
  runtime,
  node,
  nodeMap,
  registry,
}: DelegationRunnerDeps): {
  runDelegation: (
    target: string,
    taskKey: string,
    delegateState: AgentState,
    delegateConfig: LangGraphRunnableConfig,
  ) => Promise<{ update: Partial<AgentState>; ok: boolean }>;
} => {
  const durableBinding = (() => {
    const runStore = runtime.assistants?.stores.runStore;
    if (runStore === undefined) return undefined;
    const resolution = resolveAssistantScope({
      tenantId: runtime.ctx.clientId,
      userId: runtime.ctx.userId ?? runtime.ctx.userEmail,
      assistantId:
        typeof runtime.ctx.requestParams?.assistant_id === "string"
          ? runtime.ctx.requestParams.assistant_id
          : undefined,
    });
    if (!resolution.ok) return undefined;
    const requestedParent = runtime.ctx.requestParams?.assistant_run_id;
    const parentRunId =
      typeof requestedParent === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestedParent,
      )
        ? requestedParent
        : undefined;
    return { runStore, scope: resolution.scope, parentRunId };
  })();

  const delegationFailure = (
    target: string,
  ): { update: Partial<AgentState>; ok: false } => ({
    update: {
      errors: [
        {
          message: "Delegated task failed.",
          type: "execution_error",
          details: { node_id: target },
        },
      ],
    },
    ok: false,
  });

  const runDelegation = async (
    target: string,
    taskKey: string,
    delegateState: AgentState,
    delegateConfig: LangGraphRunnableConfig,
  ): Promise<{ update: Partial<AgentState>; ok: boolean }> => {
    // The task key names this delegation instance so the engine can keep the
    // target node's execution state separate from concurrent delegations.
    const configWithInstance: LangGraphRunnableConfig = {
      ...delegateConfig,
      configurable: {
        ...(delegateConfig.configurable ?? {}),
        [NODE_INSTANCE_KEY]: taskKey,
      },
    };
    try {
      if (durableBinding === undefined) {
        return await delegate(
          target,
          delegateState,
          configWithInstance,
          runtime,
          nodeMap,
          registry,
          {
            trigger: "harness-delegation",
            parent_node_id: node.id,
            delegation_id: taskKey,
          },
        );
      }
      const workerId = runtime.ctx.executionId;
      const child = await durableBinding.runStore.startClaimed(
        durableBinding.scope,
        {
          idempotencyKey: `harness:${runtime.ctx.executionId}:${node.id}:${taskKey}:${target}`,
          ...(durableBinding.parentRunId !== undefined
            ? { parentRunId: durableBinding.parentRunId }
            : {}),
          workerId,
          resumePayload: {
            kind: "harness-delegation",
            executionId: runtime.ctx.executionId,
            harnessNodeId: node.id,
            taskKey,
            target,
          },
        },
      );
      const heartbeat = setInterval(
        () =>
          void durableBinding.runStore
            .heartbeat(durableBinding.scope, child.id, workerId)
            .catch(() => undefined),
        20_000,
      );
      heartbeat.unref?.();
      try {
        const result = await delegate(
          target,
          delegateState,
          configWithInstance,
          runtime,
          nodeMap,
          registry,
          {
            trigger: "harness-delegation",
            parent_node_id: node.id,
            delegation_id: child.id,
          },
        );
        const error = result.ok
          ? undefined
          : "Delegated handler returned an execution error.";
        await durableBinding.runStore.settle(
          durableBinding.scope,
          child.id,
          result.ok,
          error,
          workerId,
        );
        return result;
      } finally {
        clearInterval(heartbeat);
      }
    } catch {
      // Lifecycle and durable-store failures are operational details. Convert
      // them at this boundary so the generic graph/route catch cannot expose
      // connection strings, endpoints, or payload excerpts.
      return delegationFailure(target);
    }
  };

  return { runDelegation };
};
