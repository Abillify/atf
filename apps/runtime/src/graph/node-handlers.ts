// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Node handler factories — **Facade** (`src/graph/node-handlers.ts`)
 *
 * This file is the public-facing entry point for all built-in node handler
 * factories. The actual implementations live in `src/graph/handlers/*` (one
 * module per node type). This facade re-exports them so existing consumers
 * (`import { createLlmNodeHandler } from "./node-handlers.js"`) continue to
 * work unchanged.
 *
 * The `registerBuiltins` call is also available here for backward compat,
 * though the canonical import is now `./handlers/index.js`.
 *
 * @see ADR-0004 — modular graph engine
 */

// Re-export handler factories from their dedicated submodules
export { createLlmNodeHandler } from "./handlers/llm.js";
export { createToolNodeHandler } from "./handlers/tool.js";
export { createRetrievalNodeHandler } from "./handlers/retrieval.js";
export { createMemoryNodeHandler } from "./handlers/memory.js";
export { createRouterNodeHandler } from "./handlers/router.js";
export { createClassifierNodeHandler } from "./handlers/classifier.js";
export { createParallelNodeHandler } from "./handlers/parallel.js";

// Transform handler lives in its own top-level module; re-export for compat.
export {
  createTransformNodeHandler,
  parseTransformRules,
  applyTransformRule,
  type TransformDeriveRule,
} from "./transform-node.js";

// Re-export the registration utilities
export { registerBuiltins, builtinNodeTypes } from "./handlers/index.js";
