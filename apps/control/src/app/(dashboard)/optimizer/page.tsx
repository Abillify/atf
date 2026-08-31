"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /optimizer — Self-Optimizing Flows route (Req. 9.1, 9.2, 9.3, 12.3).
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useOptimizer } from "../../../hooks/useOptimizer";
import { useFlows } from "../../../hooks/useFlows";
import { SloPanel } from "../../../components/SloPanel";

// Heavy panel — loaded client-side only (Req. 12.3).
const OptimizerPanel = dynamic(
  () =>
    import("../../../components/OptimizerPanel").then((m) => m.OptimizerPanel),
  { ssr: false },
);

export default function OptimizerPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  const { flows } = useFlows({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const [optimizerFlowId, setOptimizerFlowId] = useState<string>("");

  // Deep-link support: /optimizer?flow=<id> preselects a flow (e.g. after
  // "Create variant" from the History trace-analysis panel starts a run).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flow = new URLSearchParams(window.location.search).get("flow");
    if (flow !== null && flow !== "") setOptimizerFlowId(flow);
  }, []);

  const optimizer = useOptimizer({
    enabled: ready,
    ...(optimizerFlowId !== "" ? { flowId: optimizerFlowId } : {}),
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <OptimizerPanel
        flows={flows.map((f) => ({ id: f.id, name: f.name }))}
        selectedFlowId={optimizerFlowId}
        onSelectFlow={setOptimizerFlowId}
        runs={optimizer.runs}
        isLoading={optimizer.isLoading}
        error={optimizer.error}
        isTriggering={optimizer.isTriggering}
        onRun={(flowId, options) => void optimizer.run(flowId, options)}
        onPromote={(runId, label) => void optimizer.promote(runId, label)}
      />
      <SloPanel />
    </div>
  );
}
