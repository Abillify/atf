// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — Facade
 *
 * Re-exports the public API from submodules:
 *   graph-engine/state.ts         — AgentState definition, Reducer
 *   graph-engine/compile.ts       — Graph compilation, dispatch via registry
 *   graph-engine/handler-factories.ts — Runtime injection factories, service impl
 *
 * External consumers continue importing from "./graph-engine.js" unchanged.
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 20.1
 */

// ---------------------------------------------------------------------------
// Re-exports from exec-runtime (kept for backward compat)
// ---------------------------------------------------------------------------
export { QueueFullError } from "./semaphore.js";

export type {
  ExecRuntime,
  UsageAccumulator,
  ProviderResolution,
  LlmProviderFactory,
} from "./exec-runtime.js";
export {
  sanitizeSystemMessages,
  ensureValidConversationStart,
  ensureTrailingUserTurn,
  extractJsonFromText,
  extractXmlToJson,
  buildXmlSchemaHint,
} from "./exec-runtime.js";

export { defaultNodeHandlerRegistry } from "./node-handler-registry.js";

// ---------------------------------------------------------------------------
// Re-exports from graph-engine/state.ts
// ---------------------------------------------------------------------------
export { AgentStateAnnotation } from "./graph-engine/state.js";
export type { AgentState, CompiledAgentGraph } from "./graph-engine/state.js";
export type { GraphEngineService } from "./graph-engine/state.js";

// ---------------------------------------------------------------------------
// Re-exports from graph-engine/compile.ts
// ---------------------------------------------------------------------------
export {
  computeFlowChecksum,
  buildConditionContext,
  resolveNodeConfig,
  compileFlow,
} from "./graph-engine/compile.js";

// ---------------------------------------------------------------------------
// Re-exports from graph-engine/handler-factories.ts
// ---------------------------------------------------------------------------
export { createGraphEngine } from "./graph-engine/handler-factories.js";

// ---------------------------------------------------------------------------
// Re-exports from graph-engine/spans.ts
// ---------------------------------------------------------------------------
export { createFlowSpanManager } from "./graph-engine/spans.js";
export type {
  FlowSpanManager,
  FlowSpanOptions,
  NodeSpanAttributes,
} from "./graph-engine/spans.js";

// ---------------------------------------------------------------------------
// Re-exports from graph-engine/error-strategy.ts
// ---------------------------------------------------------------------------
export {
  createNodeErrorHandler,
  normaliseSemaphoreError,
  resolveNodeErrorConfig,
  QueueOverflowError,
} from "./graph-engine/error-strategy.js";
export type {
  ErrorStrategy,
  NodeErrorConfig,
  CapturedNodeError,
  NodeErrorHandler,
  ErrorHandlingResult,
} from "./graph-engine/error-strategy.js";
