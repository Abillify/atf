// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

/**
 * Loading skeleton for the Live Graph route (Req. 12.3).
 */
export default function GraphLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={translate("graph.loadingLiveGraph")}
      className="flex h-full overflow-hidden"
    >
      {/* Execution picker sidebar skeleton */}
      <aside className="w-64 shrink-0 border-r border-border bg-card p-3">
        <Skeleton width="w-32" className="mb-3" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="mb-2 rounded-lg border border-border p-3">
            <Skeleton width="w-24" height="h-3" />
            <Skeleton width="w-16" height="h-3" className="mt-2" />
          </div>
        ))}
      </aside>

      {/* Main graph area skeleton */}
      <div className="flex flex-1 flex-col overflow-hidden p-4">
        <Skeleton width="w-28" className="mb-2" />
        <Skeleton height="h-full" className="flex-1 rounded-lg border border-border" />
      </div>

      {/* Metrics sidebar skeleton */}
      <aside className="w-56 shrink-0 border-l border-border bg-card p-3">
        <Skeleton width="w-20" className="mb-3" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="mb-3">
            <Skeleton width="w-16" height="h-3" />
            <Skeleton width="w-12" height="h-6" className="mt-1" />
          </div>
        ))}
      </aside>
    </div>
  );
}
