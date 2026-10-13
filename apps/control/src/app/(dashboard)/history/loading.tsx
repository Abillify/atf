// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the History route (Req. 12.3).
 */
export default function HistoryLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading execution history"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-44" height="h-6" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <Skeleton width="w-40" />
            <Skeleton width="w-16" />
          </div>
          <Skeleton width="w-64" height="h-3" className="mt-2" />
        </div>
      ))}
    </div>
  );
}
