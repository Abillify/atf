// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `transform` node type. A deterministic, data-driven pass-through
 * that derives extra `classification` fields from existing ones via lookup
 * tables declared in the flow YAML (`config.derive`). No LLM, no domain data in
 * code. `emitsLifecycle: false` — like `router`, it is a pass-through with no
 * standalone lifecycle event when run as a `parallel` child.
 */
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import { createTransformNodeHandler } from "../transform-node.js";

export {
  createTransformNodeHandler,
  parseTransformRules,
  applyTransformRule,
  applyTransformExtractRule,
  parseTransformExtractRules,
} from "../transform-node.js";
export type {
  TransformDeriveRule,
  TransformExtractRule,
} from "../transform-node.js";

export const nodeType: NodeHandlerRegistration = {
  type: "transform",
  emitsLifecycle: false,
  factory: (node) => createTransformNodeHandler(node),
};
