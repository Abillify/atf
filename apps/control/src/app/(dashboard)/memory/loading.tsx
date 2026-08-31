// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Memory route (Req. 13.3).
 */
export default function MemoryLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading memory sessions"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-44" height="h-6" />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <div className="mb-2 flex justify-between">
            <Skeleton width="w-48" />
            <Skeleton width="w-14" height="h-6" />
          </div>
          <Skeleton width="w-64" height="h-3" />
        </div>
      ))}
    </div>
  );
}
