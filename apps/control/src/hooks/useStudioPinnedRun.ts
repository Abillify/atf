// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
"use client";

/**
 * Pinned run and formula evaluation of the StudioBuilder (Req 9.3, Task 13.4).
 *
 * Split out of `components/StudioBuilder.tsx`; the code is taken over
 * unchanged, only state and setters are passed through as parameters.
 * The backend call for variable evaluation lives in lib/studio-flow-api.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunsContext } from "../components/FormulaEditor";
import {
  evaluateFlowVariables,
} from "../lib/studio-flow-api";
import {
  fetchRunSample,
  loadPinnedRun,
  savePinnedRun,
  type PinnedRun,
} from "../lib/run-samples";

export function useStudioPinnedRun({
  flowId,
  token,
}: {
  flowId: string;
  token: string | undefined;
}): {
  pinnedRun: PinnedRun | null;
  setPinnedRun: (run: PinnedRun | null) => void;
  pinRun: (executionId: string) => Promise<void>;
  evaluateVariables: (
    variables: Record<string, unknown>,
  ) => Promise<{
    values: Record<string, unknown>;
    errors: Array<{ name: string; message: string }>;
  }>;
  runsCtx: RunsContext | undefined;
} {
  // Run data pinned for the expression builder's previews, per flow.
  const [pinnedRun, setPinnedRunState] = useState<PinnedRun | null>(null);
  useEffect(() => {
    setPinnedRunState(flowId ? loadPinnedRun(flowId) : null);
  }, [flowId]);
  const setPinnedRun = useCallback(
    (run: PinnedRun | null) => {
      setPinnedRunState(run);
      if (flowId) savePinnedRun(flowId, run);
    },
    [flowId],
  );
  const pinRun = useCallback(
    async (executionId: string) =>
      setPinnedRun(await fetchRunSample(executionId, token)),
    [setPinnedRun, token],
  );
  // Formula previews in the variables table: evaluated by the runtime, so
  // the result is exactly what a flow load produces.
  const evaluateVariables = useCallback(
    async (variables: Record<string, unknown>) =>
      evaluateFlowVariables(token, variables),
    [token],
  );
  const runsCtx = useMemo<RunsContext | undefined>(
    () =>
      flowId
        ? { flowId, pinned: pinnedRun, onPin: setPinnedRun, token }
        : undefined,
    [flowId, pinnedRun, setPinnedRun, token],
  );

  return { pinnedRun, setPinnedRun, pinRun, evaluateVariables, runsCtx };
}
