// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `trigger` node type handler.
 *
 * A `trigger` node is a **proactive entry point** for flows — it fires a flow
 * execution without an incoming HTTP chat request. Two trigger modes:
 *
 *   "webhook"  — a signed POST to `/triggers/:flowId` executes the flow
 *                immediately. The payload body becomes the initial user message.
 *                Supports synchronous (stream=false) and async (stream=true)
 *                modes.
 *
 *   "schedule" — the flow executes on a cron-like schedule (every N seconds,
 *                or a cron expression via `config.cron`). Driven by the
 *                TriggerScheduler service started in index.ts.
 *
 * A trigger node is a PASS-THROUGH at graph-execution time: it contributes no
 * messages and no state changes. Its purpose is declarative — to tell the
 * platform "this flow can be started by X", and to carry the configuration for
 * that trigger (webhook HMAC secret, cron interval, initial system prompt, etc.)
 * so the operator plane can discover and display registered triggers.
 *
 * No `any` at module boundaries.
 */

import { z } from "zod";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { FlowNode } from "../../types/flow.js";
import { getRuntime } from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";

// ---------------------------------------------------------------------------
// Trigger node config schema (for flow validation)
// ---------------------------------------------------------------------------

export const TriggerConfigSchema = z.object({
  /**
   * "webhook"  — fire on signed HTTP POST to /triggers/:flowId
   * "schedule" — fire on the configured interval/cron
   */
  mode: z.enum(["webhook", "schedule"]),
  /** HMAC-SHA256 secret for webhook signature verification. */
  webhookSecret: z.string().optional(),
  /** Template for the user message from webhook payload. Supports {{body.*}}. */
  messageTemplate: z.string().optional(),
  /** Wait for flow completion and return response synchronously. Default false. */
  synchronous: z.boolean().optional(),
  /** Fixed interval in seconds. Minimum 60. Mutually exclusive with cron. */
  intervalSeconds: z.number().int().min(60).optional(),
  /** 5-field cron expression. Mutually exclusive with intervalSeconds. */
  cron: z.string().optional(),
  /** Message for scheduled executions. Supports {{now.*}} placeholders. */
  scheduledMessage: z.string().optional(),
  /** Tenant context for scheduled executions. */
  tenantId: z.string().optional(),
  /** Max concurrent scheduled executions. Default 1. */
  maxConcurrent: z.number().int().min(1).max(100).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Node handler (pass-through at graph execution time)
// ---------------------------------------------------------------------------

/**
 * The trigger node contributes nothing to the graph state at execution time.
 * Its work happens BEFORE the graph runs (webhook routing or scheduler) or is
 * entirely declarative (schedule registration). At runtime it is a no-op.
 */
function createTriggerNodeHandler(
  node: FlowNode,
): (state: AgentState, config?: LangGraphRunnableConfig) => Partial<AgentState> {
  return (_state, config): Partial<AgentState> => {
    const runtime = getRuntime(config);
    if (runtime !== undefined) {
      runtime.onNodeStart(node.id);
    }
    // Pass-through: no state mutation, no messages added.
    return { currentNodeId: node.id };
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "trigger",
  emitsLifecycle: false, // No monitoring lifecycle — trigger is a boundary marker
  factory: (node) => createTriggerNodeHandler(node),
  configSchema: TriggerConfigSchema,
};
