// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dashboard-level loading skeleton (Req. 12.2).
 *
 * Next.js renders this component immediately while the route segment is
 * suspended (data fetching, lazy imports, etc.) — independent of how long the
 * load actually takes. This prevents layout shift by holding the space.
 *
 * Individual route segments can provide their own `loading.tsx` for more
 * contextual skeletons; this serves as the fallback for any segment that
 * does not define one.
 */
import { Skeleton } from "../../lib/ui";
import { translate } from "../../lib/i18n";

export default function DashboardLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={translate("loading.loadingContent")}
      className="flex h-full flex-col gap-4 p-6"
    >
      {/* Page-title skeleton */}
      <Skeleton width="w-48" height="h-6" />

      {/* Card grid skeleton — 3 summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <Skeleton width="w-24" />
            <Skeleton width="w-16" height="h-8" className="mt-3" />
          </div>
        ))}
      </div>

      {/* Main content area skeleton */}
      <div className="flex-1 rounded-lg border border-border bg-card shadow-sm">
        <div className="space-y-3 p-6">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} style={{ width: `${85 - i * 8}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
