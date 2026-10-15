// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

/**
 * Loading skeleton for the Flows route (Req. 12.3).
 */
export default function FlowsLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={translate("flows.loadingFlows")}
      className="flex h-full overflow-hidden p-6"
    >
      {/* Sidebar: flow list */}
      <aside className="w-56 shrink-0 border-r border-border pr-4">
        <Skeleton width="w-24" className="mb-3" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height="h-8" className="mb-2" />
        ))}
      </aside>
      {/* Main: editor area */}
      <div className="flex-1 pl-4">
        <Skeleton width="w-32" className="mb-3" />
        <Skeleton height="h-full" className="rounded-lg border border-border" />
      </div>
    </div>
  );
}
