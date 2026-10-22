"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /flows/health — Flow health route.
 *
 * Shows every served flow with source (file/DB), version, digest and the
 * latest eval result, plus flow files that failed to load and DB flows that
 * shadow files.
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../../lib/auth/useAuth";
import { useFlowHealth } from "../../../../hooks/useFlowHealth";

// Health table — loaded client-side only (Req. 12.3).
const FlowHealthPanel = dynamic(
  () =>
    import("../../../../components/FlowHealthPanel").then(
      (m) => m.FlowHealthPanel,
    ),
  { ssr: false },
);

export default function FlowHealthPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  const { flows, loadFailures, generatedAt, isLoading, error } = useFlowHealth({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <FlowHealthPanel
        flows={flows}
        loadFailures={loadFailures}
        generatedAt={generatedAt}
        isLoading={isLoading}
        error={error}
      />
    </div>
  );
}
