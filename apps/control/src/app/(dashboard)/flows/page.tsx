"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /flows — Flows consolidated (Req. 9.1, 9.2, 9.3, 9.9, 12.3).
 *
 * Two tabs: "Registry" (the flow registry; Edit/Inspect open the flow in
 * /studio) and "Diff" (the Flow Diff Viewer formerly at /flow-diff, which now
 * redirects here). Deep-link: /flows?tab=diff opens the Diff tab directly.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../lib/ui";

// Flow registry — editing happens in Studio; loaded client-side only (Req. 12.3).
const FlowsTab = dynamic(
  () => import("../../../components/FlowsTab").then((m) => m.FlowsTab),
  { ssr: false },
);

// Diff viewer — loaded client-side only, and only when its tab is active
// (Req. 12.3).
const FlowDiffTab = dynamic(
  () => import("../../../components/FlowDiffTab").then((m) => m.FlowDiffTab),
  { ssr: false },
);

type FlowsPageTab = "registry" | "diff";

export default function FlowsPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;
  const [tab, setTab] = useState<FlowsPageTab>("registry");

  // Deep-link support: /flows?tab=diff opens the Diff tab (used by the
  // /flow-diff redirect, Req. 9.9).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const param = new URLSearchParams(window.location.search).get("tab");
    if (param === "diff") setTab("diff");
  }, []);

  return (
    <div className="h-full overflow-hidden p-4 sm:p-6">
      <Tabs value={tab} onValueChange={(v) => setTab(v as FlowsPageTab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="registry">Registry</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
        </TabsList>
        {/* Panels are wrapped in TabsContent so the tabs expose real
            role="tabpanel" targets (valid aria-controls); the heavy, code-split
            panels still only mount for the active tab. */}
        <TabsContent value="registry">
          {tab === "registry" && (
            <FlowsTab
              enabled={ready}
              {...(tokenOpt !== undefined ? { token: tokenOpt } : {})}
            />
          )}
        </TabsContent>
        <TabsContent value="diff">
          {tab === "diff" && <FlowDiffTab />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
