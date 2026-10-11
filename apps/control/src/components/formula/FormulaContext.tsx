"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: FormulaContext, FormulaProvider and useVocabulary, moved out of
// FormulaEditor.tsx without behavior change.

import type React from "react";
import { createContext, useContext, useMemo } from "react";
import type { FlowReference } from "../../lib/node-types";
import type { PinnedRun } from "../../lib/run-samples";
import {
  buildVocabulary,
  type FormulaGroup,
  type FormulaKind,
  type VocabularyCatalog,
} from "../../lib/formula";
import type { FlowDefinition } from "../../types/flow";

/** Evaluates a variables map like the runtime (POST /flows/variables/evaluate). */
export type VariablesEvaluator = (
  variables: Record<string, unknown>,
) => Promise<{ values: Record<string, unknown>; errors: Array<{ name: string; message: string }> }>;

interface FormulaContextValue {
  flow: Pick<FlowDefinition, "nodes" | "variables">;
  /** Reference data, constants and public env from the node type catalog. */
  catalog: (VocabularyCatalog & { reference?: FlowReference }) | undefined;
  evaluateVariables: VariablesEvaluator | undefined;
  runs: RunsContext | undefined;
}

/** Recorded runs of the flow and the one pinned as sample data. */
export interface RunsContext {
  flowId: string;
  pinned: PinnedRun | null;
  onPin: (run: PinnedRun | null) => void;
  token?: string | undefined;
}

const FormulaContext = createContext<FormulaContextValue | null>(null);

export function FormulaProvider({
  flow,
  catalog,
  reference,
  evaluateVariables,
  runs,
  children,
}: {
  flow: Pick<FlowDefinition, "nodes" | "variables">;
  /** From the node type catalog; without it only flow-derived entries are offered. */
  catalog?: (VocabularyCatalog & { reference?: FlowReference }) | undefined;
  /** Shorthand for `catalog={{ reference }}`. */
  reference?: FlowReference | undefined;
  /** Lets the builder show what a field resolves to when the flow loads. */
  evaluateVariables?: VariablesEvaluator | undefined;
  /** Enables pinning a recorded run as sample data. */
  runs?: RunsContext | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo(
    () => ({
      flow,
      catalog: catalog ?? (reference ? { reference } : undefined),
      evaluateVariables,
      runs,
    }),
    [flow, catalog, reference, evaluateVariables, runs],
  );
  return <FormulaContext.Provider value={value}>{children}</FormulaContext.Provider>;
}

export function useVocabulary(kind: FormulaKind): {
  groups: FormulaGroup[];
  variables: Record<string, unknown> | undefined;
  reference: FlowReference | undefined;
  evaluateVariables: VariablesEvaluator | undefined;
  runs: RunsContext | undefined;
} {
  const ctx = useContext(FormulaContext);
  return useMemo(
    () => ({
      groups: buildVocabulary(ctx?.flow ?? { nodes: [] }, kind, ctx?.catalog),
      variables: ctx?.flow.variables,
      reference: ctx?.catalog?.reference,
      evaluateVariables: ctx?.evaluateVariables,
      runs: ctx?.runs,
    }),
    [ctx, kind],
  );
}
