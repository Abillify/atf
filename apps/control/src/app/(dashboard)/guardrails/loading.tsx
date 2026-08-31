// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the Guardrails route (Req. 13.5).
 */
export default function GuardrailsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading guardrail policies"
      className="flex flex-col gap-3 p-6"
    >
      <Skeleton width="w-44" height="h-6" />
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex items-start justify-between rounded-lg border border-border bg-card px-4 py-3 shadow-sm"
        >
          <div className="flex-1">
            <div className="mb-1 flex gap-2">
              <Skeleton width="w-32" />
              <Skeleton width="w-12" height="h-5" />
              <Skeleton width="w-12" height="h-5" />
            </div>
            <Skeleton width="w-48" height="h-3" />
          </div>
          <Skeleton width="w-20" height="h-3" />
        </div>
      ))}
    </div>
  );
}
