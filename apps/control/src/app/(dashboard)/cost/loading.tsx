// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

/**
 * Loading skeleton for the Cost & Tokens route (Req. 12.3).
 */
export default function CostLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={translate("cost.loadingCostData")}
      className="flex flex-col gap-4 p-6"
    >
      <Skeleton width="w-40" height="h-6" />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <Skeleton width="w-32" className="mb-3" />
          <Skeleton height="h-32" />
        </div>
      ))}
    </div>
  );
}
