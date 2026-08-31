// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Approvals route (Req. 12.3).
 */
export default function ApprovalsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading approvals"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-36" height="h-6" />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-sm"
        >
          <div className="mb-2 h-4 w-48 animate-pulse rounded bg-amber-200" />
          <div className="h-3 w-full animate-pulse rounded bg-amber-100" />
          <div className="mt-3 flex gap-2">
            <div className="h-8 w-20 animate-pulse rounded bg-green-200" />
            <div className="h-8 w-20 animate-pulse rounded bg-red-200" />
          </div>
        </div>
      ))}
    </div>
  );
}
