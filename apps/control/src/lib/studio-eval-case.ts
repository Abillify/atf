// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Studio eval-case helper — frontend copy (`frontend/src/lib/studio-eval-case.ts`)
 *
 * Mirror of the backend's `src/eval/studio-eval-case.ts` for use in the
 * frontend without a cross-package import.
 *
 * The Studio's "Save as Eval Case" action (Req. 16) creates a StudioEvalCase
 * from a Playground run (prompt + flow + result). This module provides:
 *
 * - `StudioEvalCase` type (Req. 16.1)
 * - `validateStudioEvalCase` (Req. 16.3) — dataset-addition validation that
 *   names missing required fields.
 * - `buildStudioEvalCase` — builds a StudioEvalCase from Playground output.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Studio-originated eval case (Req. 16.1).
 * `expected` is optional at creation time; required for dataset addition (Req. 16.3).
 */
export interface StudioEvalCase {
  id: string;
  flowId: string;
  prompt: string;
  expected?: unknown;
  actual?: unknown;
  createdBy: string;
  tenantId: string;
  createdAt: string;
}

/** Fields required to add a StudioEvalCase to the eval dataset. */
const REQUIRED_FOR_DATASET: Array<keyof StudioEvalCase> = [
  "prompt",
  "flowId",
  "expected",
  "createdBy",
  "tenantId",
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface EvalCaseValidationResult {
  valid: boolean;
  missingFields: string[];
}

/**
 * Validates whether a StudioEvalCase can be added to the eval/optimizer
 * dataset (Req. 16.3). Returns missing required field names.
 *
 * Creation is always allowed — only dataset-addition is gated here.
 */
export function validateStudioEvalCase(
  evalCase: Partial<StudioEvalCase>,
): EvalCaseValidationResult {
  const missingFields: string[] = [];
  for (const field of REQUIRED_FOR_DATASET) {
    const value = evalCase[field];
    const isMissing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");
    if (isMissing) missingFields.push(field);
  }
  return { valid: missingFields.length === 0, missingFields };
}

/**
 * Builds a StudioEvalCase from Playground output.
 */
export function buildStudioEvalCase(
  fields: Omit<StudioEvalCase, "id" | "createdAt">,
  id?: string,
): StudioEvalCase {
  return {
    ...fields,
    id: id ?? `eval-${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
}
