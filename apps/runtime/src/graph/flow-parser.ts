// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Parser — Facade
 *
 * Re-exports all public symbols from the flow-parser submodules so that
 * existing import paths (`from "../flow-parser.js"`) continue to work
 * without any migration. Requirement 18.2: zero-migration refactoring.
 *
 * Submodules:
 *   - validate.ts  — Zod schemas, schema validation, semantic checks
 *   - normalize.ts — Include resolution, variable resolution
 *   - loader.ts    — FlowParserService, FlowRegistry, file loading, hot-reload
 */

// --- Validation (schemas + validate functions) ---
export {
  type ValidationError,
  type ValidationResult,
  logValidationError,
  validateFlowDefinition,
  LlmParametersSchema,
  LlmConfigSchema,
  HarnessConfigSchema,
  RagSourceSchema,
  ParallelConfigSchema,
  TransformConfigSchema,
  FlowNodeSchema,
  FlowEdgeSchema,
  FlowDefinitionSchema,
  VAR_PLACEHOLDER_RE,
} from "./flow-parser/validate.js";

// --- Normalization (includes + variables) ---
export {
  resolveFlowIncludes,
  resolveFlowSourceIncludes,
  resolveRawFlowVariables,
  applyFlowVariables,
} from "./flow-parser/normalize.js";

// --- validateFlowSource facade (preserves original no-arg signature) ---
import { validateFlowSource as _validateFlowSourceImpl } from "./flow-parser/validate.js";
import { resolveRawFlowVariables as _resolveRawFlowVars } from "./flow-parser/normalize.js";
import type { ValidationResult } from "./flow-parser/validate.js";

/**
 * Validates a raw flow object that may contain `{{vars.<name>}}` references.
 * Correctness is checked against the flow's *default* variable values.
 */
export function validateFlowSource(raw: unknown): ValidationResult {
  return _validateFlowSourceImpl(raw, _resolveRawFlowVars);
}

// --- Loader (service + registry) ---
export {
  type FlowRegistry,
  type FlowSourceRecord,
  materializeFlowSource,
  expandFlowSource,
  type FlowParserService,
  type FlowParserOptions,
  createFlowParserService,
} from "./flow-parser/loader.js";
