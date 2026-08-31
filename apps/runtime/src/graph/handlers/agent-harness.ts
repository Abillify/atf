// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `agent-harness` node type. Unlike the other built-ins it ships a
 * `configSchema` (its allowlist/limits config), demonstrating the same
 * per-type config validation seam a plugin uses — there is no special-casing
 * left in the flow parser.
 */
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";
import { HarnessConfigSchema } from "../flow-parser.js";

export const nodeType: NodeHandlerRegistration = {
  type: "agent-harness",
  emitsLifecycle: true,
  factory: (node, ctx) => createAgentHarnessNodeHandler(node, ctx.nodeMap),
  configSchema: HarnessConfigSchema,
};
