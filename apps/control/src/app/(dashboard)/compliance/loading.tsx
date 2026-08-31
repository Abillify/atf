// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Compliance route (Req. 12.3).
 */
export default function ComplianceLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading compliance dossier"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-52" height="h-6" />
      <Skeleton width="w-80" />
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <Skeleton width="w-48" className="mb-2" />
          <Skeleton height="h-3" />
          <Skeleton width="w-5/6" height="h-3" className="mt-1" />
        </div>
      ))}
    </div>
  );
}
