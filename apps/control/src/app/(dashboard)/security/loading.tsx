// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Security route (Req. 12.3).
 */
export default function SecurityLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading security posture"
      className="flex flex-col gap-4 p-6"
    >
      <Skeleton width="w-48" height="h-6" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <Skeleton width="w-20" height="h-3" />
            <Skeleton width="w-16" height="h-8" className="mt-2" />
            <Skeleton height="h-1.5" className="mt-2 rounded-full" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <Skeleton width="w-36" className="mb-3" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height="h-12" className="mb-2" />
        ))}
      </div>
    </div>
  );
}
