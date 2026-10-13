// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Providers route (Req. 13.5).
 */
export default function ProvidersLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading provider keys"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-44" height="h-6" />
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border bg-muted px-4 py-3">
          <div className="flex gap-6">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} width="w-16" height="h-3" />
            ))}
          </div>
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-6 border-b border-border px-4 py-3">
            <Skeleton width="w-20" />
            <Skeleton width="w-24" />
            <Skeleton width="w-32" />
            <Skeleton width="w-14" height="h-5" />
            <Skeleton width="w-24" />
            <Skeleton width="w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
