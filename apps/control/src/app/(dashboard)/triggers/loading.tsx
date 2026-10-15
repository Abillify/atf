// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

/**
 * Loading skeleton for the Triggers route (Req. 9.6).
 */
export default function TriggersLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={translate("triggers.loadingTriggers")}
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-48" height="h-6" />
      <div className="flex gap-2">
        <Skeleton height="h-9" className="flex-1" />
        <Skeleton width="w-24" height="h-9" />
      </div>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton width="w-44" />
          <Skeleton height="h-5" className="flex-1" />
          <Skeleton width="w-16" />
          <Skeleton width="w-12" height="h-5" />
        </div>
      ))}
    </div>
  );
}
