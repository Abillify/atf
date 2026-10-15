// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

/**
 * Loading skeleton for the Autopilot route (Req. 12.3).
 */
export default function AutopilotLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={translate("autopilot.loadingAutopilot")}
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-40" height="h-6" />
      <Skeleton width="w-72" />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <div className="mb-2 flex justify-between">
            <Skeleton width="w-40" />
            <Skeleton width="w-20" />
          </div>
          <Skeleton height="h-3" />
        </div>
      ))}
    </div>
  );
}
