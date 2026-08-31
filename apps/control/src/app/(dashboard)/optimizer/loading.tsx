// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Optimizer route (Req. 12.3).
 */
export default function OptimizerLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading optimizer"
      className="flex flex-col gap-4 p-6"
    >
      <Skeleton width="w-44" height="h-6" />
      <Skeleton width="w-64" height="h-10" />
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <Skeleton width="w-32" className="mb-3" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height="h-16" className="mb-2" />
        ))}
      </div>
    </div>
  );
}
