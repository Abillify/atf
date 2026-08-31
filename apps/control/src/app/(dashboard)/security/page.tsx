"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /security — AI Security Posture route (Req. 9.1, 9.2, 9.3, 12.3).
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";
import { useSecurity } from "../../../hooks/useSecurity";
import { useFlows } from "../../../hooks/useFlows";

// Heavy panel — loaded client-side only (Req. 12.3).
const SecurityPanel = dynamic(
  () =>
    import("../../../components/SecurityPanel").then((m) => m.SecurityPanel),
  { ssr: false },
);

export default function SecurityPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  const security = useSecurity({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const { flows } = useFlows({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <SecurityPanel
        posture={security.posture}
        runs={security.runs}
        attacks={security.attacks}
        toolAuthz={security.toolAuthz}
        mcp={security.mcp}
        redTeamEnabled={security.redTeamEnabled}
        isLoading={security.isLoading}
        error={security.error}
        isRunning={security.isRunning}
        flows={flows.map((f) => ({ id: f.id, name: f.name }))}
        onRun={(flowId) => void security.runRedTeam(flowId)}
        onViewRun={security.getRun}
        onSaveToolAuthz={security.saveToolAuthz}
      />
    </div>
  );
}
