"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /posture — Governance posture route.
 *
 * Shows which governance controls are active right now
 * (`GET /monitoring/posture`), grouped by area with an ok/warn/fail badge per
 * check. Read-only operator view; the prod-gate answer ("may this start?")
 * stays in `atf doctor`.
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";
import { usePosture } from "../../../hooks/usePosture";

// Posture table — loaded client-side only, like the other monitoring pages.
const PosturePanel = dynamic(
  () =>
    import("../../../components/PosturePanel").then((m) => m.PosturePanel),
  { ssr: false },
);

export default function PosturePage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  const { checks, status, generatedAt, isLoading, error, report } = usePosture({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <PosturePanel
        checks={checks}
        status={status}
        operationalProfile={report?.operationalProfile ?? null}
        generatedAt={generatedAt}
        isLoading={isLoading}
        error={error}
      />
    </div>
  );
}
