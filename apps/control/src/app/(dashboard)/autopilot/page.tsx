"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /autopilot — Continuous Safety & Quality Autopilot dashboard page.
 *
 * Shows all recent autopilot runs across all flows, with manual trigger and
 * live status polling.
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";
import { useFlows } from "../../../hooks/useFlows";
import { translate } from "../../../lib/i18n";

const AutopilotPanel = dynamic(
  () =>
    import("../../../components/AutopilotPanel").then((m) => m.AutopilotPanel),
  { ssr: false, loading: () => <div className="p-6 text-sm text-muted-foreground">{translate("autopilot.loading")}</div> },
);

export default function AutopilotPage() {
  const { token, ready } = useAuth();
  const { flows } = useFlows({
    enabled: ready,
    ...(token ? { token } : {}),
  });

  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-foreground">
          {translate("autopilot.continuousSafetyQualityAutopilot")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {translate("autopilot.closedFeedbackLoopRedTeam")}
        </p>
      </div>
      <AutopilotPanel limit={30} flows={flows.map((f) => ({ id: f.id, name: f.name }))} />
    </div>
  );
}
