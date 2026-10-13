// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Limits route (Req. 12.3).
 */
export default function LimitsLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading limits"
      className="flex flex-col gap-4 p-6"
    >
      <Skeleton width="w-36" height="h-6" />
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <Skeleton width="w-48" className="mb-3" />
        <Skeleton height="h-48" />
      </div>
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <Skeleton width="w-40" className="mb-3" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height="h-8" className="mb-2" />
        ))}
      </div>
    </div>
  );
}
