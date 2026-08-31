"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /flows — Flow Management route (Req. 9.1, 9.2, 9.3, 12.3).
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";

// Heavy panel with editor — loaded client-side only (Req. 12.3).
const FlowsTab = dynamic(
  () => import("../../../components/FlowsTab").then((m) => m.FlowsTab),
  { ssr: false },
);

export default function FlowsPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  return (
    <div className="h-full overflow-hidden p-4 sm:p-6">
      <FlowsTab
        enabled={ready}
        {...(tokenOpt !== undefined ? { token: tokenOpt } : {})}
      />
    </div>
  );
}
