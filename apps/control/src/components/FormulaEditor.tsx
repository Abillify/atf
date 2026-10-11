"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Formula editing for Studio fields.
 *
 *  - `FormulaInput`: a text input with an ƒx button on the right that opens a
 *    searchable picker; picking inserts the variable at the cursor (`{{path}}`
 *    in templates, the bare path in conditions). "Open editor" switches to the
 *    full editor.
 *  - `FormulaTextarea`: a textarea with an ƒx button that opens the full editor.
 *  - `FormulaEditorDialog`: large editor with a variable browser, operator
 *    palette (conditions), live syntax check and a preview with sample values —
 *    conditions are evaluated by the runtime itself
 *    (`POST /flows/expressions/evaluate`), templates are rendered locally.
 *
 * The vocabulary (flow variables, classification fields, node outputs, …)
 * comes from the flow on the canvas via `FormulaProvider`; without a provider
 * the editor still offers the generic entries.
 *
 * Req 9.3: the implementation is split up under ./formula/ (context,
 * browser, dialog, copilot, toolbar, help, result views, RunPicker,
 * inputs); this file is a barrel that leaves the previous import paths
 * unchanged, without behavior change.
 */

export { FormulaProvider } from "./formula/FormulaContext";
export type { VariablesEvaluator, RunsContext } from "./formula/FormulaContext";
export { FormulaEditorDialog } from "./formula/FormulaEditorDialog";
export { describeEditorSelection } from "./formula/ExpressionCopilot";
export { DiffView } from "./formula/DiffView";
export { RunPicker } from "./formula/RunPicker";
export {
  FxPicker,
  FormulaInput,
  FormulaTextarea,
} from "./formula/FormulaInputs";
