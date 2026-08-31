"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /approvals — Human-in-the-Loop Approvals route (Req. 9.1, 9.2, 9.3, 12.3).
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";
import { useApprovals } from "../../../hooks/useApprovals";

// Heavy panel — loaded client-side only (Req. 12.3).
const ApprovalsPanel = dynamic(
  () =>
    import("../../../components/ApprovalsPanel").then((m) => m.ApprovalsPanel),
  { ssr: false },
);

export default function ApprovalsPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  const {
    pending,
    error: approvalsError,
    resolve,
  } = useApprovals({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <ApprovalsPanel
        pending={pending}
        error={approvalsError}
        onResolve={resolve}
      />
    </div>
  );
}
