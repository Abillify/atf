// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the MCP route (Req. 13.5).
 */
export default function McpLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading MCP servers"
      className="flex flex-col gap-4 p-6"
    >
      <Skeleton width="w-52" height="h-6" />
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card shadow-sm"
        >
          <div className="flex justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Skeleton width="w-28" />
              <Skeleton width="w-40" height="h-3" />
            </div>
            <Skeleton width="w-20" height="h-5" />
          </div>
          <div className="p-4">
            <Skeleton width="w-12" height="h-3" className="mb-2" />
            {[0, 1, 2].map((j) => (
              <div key={j} className="flex justify-between py-1">
                <Skeleton width="w-32" />
                <Skeleton width="w-20" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
