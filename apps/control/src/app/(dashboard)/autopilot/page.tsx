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

const AutopilotPanel = dynamic(
  () =>
    import("../../../components/AutopilotPanel").then((m) => m.AutopilotPanel),
  { ssr: false, loading: () => <div className="p-6 text-sm text-muted-foreground">Loading…</div> },
);

export default function AutopilotPage() {
  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-foreground">
          Continuous Safety & Quality Autopilot
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Closed feedback loop: Red-Team bypass detected → Optimizer generates
          hardened prompt variants → best variant auto-promoted → Canary rollout
          with automatic rollback on regression.
        </p>
      </div>
      <AutopilotPanel limit={30} />
    </div>
  );
}
