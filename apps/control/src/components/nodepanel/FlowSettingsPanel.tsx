"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: flow settings and
 * renameFlowVariable. Without behavior change.
 */

import type React from "react";
import type { FlowDefinition } from "../../types/flow";
import type { NodeTypeCatalog } from "../../lib/node-types";
import { FormulaInput, FormulaTextarea } from "../FormulaEditor";
import {
  type EvaluatedVariables,
  VariablesEditor,
  countVarUsages,
  varRefRe,
} from "../VariablesEditor";
import { Field, JsonEditor, inputCls, compact } from "../form-controls";

/** Top-level keys owned by the canvas or edited by dedicated fields. */
const FLOW_OWNED_KEYS = new Set([
  "id",
  "name",
  "description",
  "variables",
  "nodes",
  "edges",
  "metadata",
]);

/**
 * Renames a flow variable, keeping its position in the map, and rewrites every
 * `vars.<old>` reference in nodes, edges and the other flow fields.
 */
export function renameFlowVariable(
  flow: FlowDefinition,
  from: string,
  to: string,
): FlowDefinition {
  const re = varRefRe(from);
  // Walks the flow key by key so the top-level order (and thus the YAML diff)
  // stays as it was.
  return Object.fromEntries(
    Object.entries(flow).map(([key, value]) => [
      key,
      key === "variables"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [
              k === from ? to : k,
              v,
            ]),
          )
        : value === undefined
          ? value
          : JSON.parse(JSON.stringify(value).replace(re, `vars.${to}`)),
    ]),
  ) as FlowDefinition;
}

export function FlowSettingsPanel({
  flow,
  idEditable,
  onChange,
  catalog,
  evaluateVariables,
}: {
  flow: FlowDefinition;
  /** Runtime evaluation of the variables map (formula previews). */
  evaluateVariables?: (
    variables: Record<string, unknown>,
  ) => Promise<EvaluatedVariables>;
  /** Node type catalog — its model shortcuts/models feed the variables' ƒx. */
  catalog?: NodeTypeCatalog;
  /** Only a brand-new flow may still pick its id. */
  idEditable: boolean;
  onChange: (next: FlowDefinition) => void;
}): React.JSX.Element {
  const extra = Object.fromEntries(
    Object.entries(flow).filter(([k]) => !FLOW_OWNED_KEYS.has(k)),
  );
  const { variables: _vars, ...referencing } = flow;
  const usages = countVarUsages(
    Object.keys(flow.variables ?? {}),
    JSON.stringify(referencing),
  );

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-foreground">Flow settings</h4>
      <p className="text-[10px] text-muted-foreground">
        Nothing selected — select a node or edge on the canvas to edit it.
      </p>
      <Field
        label="Flow id"
        hint={idEditable ? "Lowercase letters, digits and dashes." : undefined}
      >
        <input
          className={`${inputCls} font-mono`}
          value={flow.id}
          disabled={!idEditable}
          onChange={(e) =>
            onChange({
              ...flow,
              id: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "-"),
            })
          }
        />
      </Field>
      <Field label="Name">
        <FormulaInput
          kind="vars"
          ariaLabel="Name"
          className={inputCls}
          value={flow.name}
          onChange={(v) => onChange({ ...flow, name: v })}
        />
      </Field>
      <Field label="Description">
        <FormulaTextarea
          kind="vars"
          ariaLabel="Description"
          title="Flow description"
          className={`${inputCls} w-full resize-y`}
          rows={3}
          value={flow.description ?? ""}
          onChange={(v) =>
            onChange(
              compact({
                ...flow,
                description: v || undefined,
              }),
            )
          }
        />
      </Field>
      <VariablesEditor
        value={flow.variables}
        usages={usages}
        onChange={(v) =>
          onChange(
            compact({
              ...flow,
              variables: v as FlowDefinition["variables"],
            }),
          )
        }
        onRename={(from, to) => onChange(renameFlowVariable(flow, from, to))}
        nodes={flow.nodes}
        {...(catalog ? { catalog } : {})}
        {...(evaluateVariables ? { evaluate: evaluateVariables } : {})}
      />
      <JsonEditor
        label="Other flow fields"
        hint="pricing, dataClasses, recovery, … — everything not edited above."
        rows={10}
        value={extra}
        onChange={(v) => {
          if (v === undefined || typeof v !== "object" || Array.isArray(v)) {
            return;
          }
          const owned = Object.fromEntries(
            Object.entries(flow).filter(([k]) => FLOW_OWNED_KEYS.has(k)),
          );
          onChange({ ...(v as object), ...owned } as FlowDefinition);
        }}
      />
    </div>
  );
}
