// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness Node — Facade
 *
 * The `agent-harness` node orchestrates over the existing graph by planning
 * a task list and delegating tasks to allowlisted worker nodes/subflows.
 *
 * This facade re-exports all public symbols from the submodules so that
 * existing imports continue to work unchanged. The implementation lives in:
 * - `agent-harness/types.ts` — Core types, constants, and pure helpers
 * - `agent-harness/tools.ts` — Planner LLM call and delegation executor
 * - `agent-harness/loop.ts`  — The execution loop handler factory
 *
 * @module agent-harness
 */

// --- Types & constants ---
export type {
  TaskStatus,
  Task,
  StopReason,
  HarnessProgress,
  HarnessConfig,
} from "./agent-harness/types.js";

export {
  DEFAULT_MAX_ITERATIONS,
  mergeHarnessProgress,
  resolveAllowlist,
  normalize,
  mergeReplan,
  checkLimits,
  renderTaskList,
  formatTaskReference,
  parseHarnessConfig,
} from "./agent-harness/types.js";

// --- Planning & delegation tools ---
export { plan, delegate } from "./agent-harness/tools.js";

// --- Handler factory ---
export { createAgentHarnessNodeHandler } from "./agent-harness/loop.js";
