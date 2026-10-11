// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Provider Testing route (Req. 9.6).
 */
export default function ProviderTestingLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading provider tests"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-56" height="h-6" />
      <div className="flex gap-2">
        <Skeleton height="h-9" className="flex-1" />
        <Skeleton width="w-24" height="h-9" />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <Skeleton width="w-40" height="h-5" />
            <Skeleton width="w-16" height="h-5" />
          </div>
          <Skeleton height="h-4" className="flex-1" />
        </div>
      ))}
    </div>
  );
}
