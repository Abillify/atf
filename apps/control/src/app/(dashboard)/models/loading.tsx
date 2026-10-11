// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Models route (Req. 9.6).
 */
export default function ModelsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading models"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-48" height="h-6" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg p-4">
            <Skeleton width="w-32" height="h-5" />
            <Skeleton height="h-4" className="flex-1" />
            <Skeleton width="w-24" height="h-4" />
          </div>
        ))}
      </div>
    </div>
  );
}
