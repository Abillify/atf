// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Skeleton } from "../../../lib/ui";

/**
 * Loading skeleton for the PII Tokenization Vault route.
 */
export default function PiiVaultLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading PII vault status"
      className="flex flex-col gap-3 p-6 max-w-2xl"
    >
      <Skeleton width="w-56" height="h-6" />
      <Skeleton height="h-3" />
      <Skeleton width="w-5/6" height="h-3" />
      <div className="mt-2 h-20 w-full animate-pulse rounded-lg border border-border bg-card" />
    </div>
  );
}
