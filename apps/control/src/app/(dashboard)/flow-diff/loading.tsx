// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

/**
 * Loading skeleton for the Flow Diff route (Req. 13.2).
 */
export default function FlowDiffLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={translate("flowDiff.loadingFlowDiff")}
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-44" height="h-6" />
      <div className="flex gap-2">
        <Skeleton height="h-9" className="flex-1" />
        <div className="h-9 w-24 animate-pulse rounded bg-muted-foreground/30" />
      </div>
      <div className="rounded-lg border border-border bg-card">
        <div className="flex justify-between border-b border-border px-4 py-3">
          <Skeleton width="w-40" />
          <Skeleton width="w-24" />
        </div>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className={`h-4 animate-pulse px-3 py-0.5 ${i % 3 === 0 ? "bg-success-soft" : i % 3 === 1 ? "bg-danger-soft" : "bg-card"}`}
          >
            <Skeleton width="w-3/4" height="h-3" />
          </div>
        ))}
      </div>
    </div>
  );
}
