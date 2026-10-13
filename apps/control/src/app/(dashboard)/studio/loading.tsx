// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Studio route (Req. 12.3).
 */
export default function StudioLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading studio"
      className="flex h-full gap-3 p-6"
    >
      <Skeleton width="w-56" height="h-full" className="shrink-0 rounded-lg" />
      <div className="flex-1 animate-pulse rounded-lg border border-border bg-card" />
      <Skeleton width="w-72" height="h-full" className="shrink-0 rounded-lg" />
    </div>
  );
}
