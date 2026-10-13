// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Traces route (Req. 13.1).
 */
export default function TracesLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading traces"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-48" height="h-6" />
      <div className="flex gap-2">
        <Skeleton height="h-9" className="flex-1" />
        <div className="h-9 w-20 animate-pulse rounded bg-muted-foreground/30" />
      </div>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton width="w-44" />
          <Skeleton height="h-5" className="flex-1" />
          <Skeleton width="w-16" />
          <Skeleton width="w-12" height="h-5" />
        </div>
      ))}
    </div>
  );
}
