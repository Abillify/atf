"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /cost — Cost & Tokens route (Req. 9.1, 9.2, 9.3, 12.3).
 *
 * Two tabs: "Spend & Tokens" (the existing CostPanel — past/current spend)
 * and "FinOps Forecast" (budget burn-rate projection + CO2/ESG accounting —
 * the forward-looking and sustainability counterpart).
 */

import { useState } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";
import { useMetrics } from "../../../hooks/useMetrics";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

// Heavy chart panel — loaded client-side only (Req. 12.3).
const CostPanel = dynamic(
  () => import("../../../components/CostPanel").then((m) => m.CostPanel),
  { ssr: false },
);
const FinOpsPanel = dynamic(
  () => import("../../../components/FinOpsPanel").then((m) => m.FinOpsPanel),
  { ssr: false },
);

type CostTab = "spend" | "finops";

export default function CostPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;
  const [tab, setTab] = useState<CostTab>("spend");

  const { summary } = useMetrics({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <Tabs value={tab} onValueChange={(v) => setTab(v as CostTab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="spend">{translate("cost.spendTokens")}</TabsTrigger>
          <TabsTrigger value="finops">{translate("cost.finOpsForecast")}</TabsTrigger>
        </TabsList>
        {/* Panels are wrapped in TabsContent so the tabs expose real
            role="tabpanel" targets (valid aria-controls); the heavy, code-split
            panels still only mount for the active tab. */}
        <TabsContent value="spend">
          {tab === "spend" && <CostPanel summary={summary} />}
        </TabsContent>
        <TabsContent value="finops">
          {tab === "finops" && <FinOpsPanel />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
