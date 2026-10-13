// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Canary route (Req. 12.3).
 */
export default function CanaryLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading canary deployments"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-44" height="h-6" />
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <div className="mb-2 flex justify-between">
            <Skeleton width="w-32" />
            <Skeleton width="w-16" />
          </div>
          <Skeleton height="h-3" />
          <Skeleton height="h-2" className="mt-2 rounded-full" />
        </div>
      ))}
    </div>
  );
}
