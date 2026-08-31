// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/** Loading skeleton for the Assistants route. */
export default function AssistantsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading assistants"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-40" height="h-6" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex gap-2">
            <Skeleton width="w-16" height="h-7" />
            <Skeleton width="w-20" height="h-7" />
            <Skeleton width="w-20" height="h-7" />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="mb-2 flex justify-between">
              <Skeleton width="w-56" height="h-4" />
              <Skeleton width="w-24" height="h-4" />
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <Skeleton width="w-full" height="h-4" />
        </div>
      </div>
    </div>
  );
}
