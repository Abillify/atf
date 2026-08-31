"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /canary — Canary Deployments route (Req. 9.1, 9.2, 9.3, 12.3).
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";
import { useCanary } from "../../../hooks/useCanary";

// Heavy panel — loaded client-side only (Req. 12.3).
const CanaryPanel = dynamic(
  () => import("../../../components/CanaryPanel").then((m) => m.CanaryPanel),
  { ssr: false },
);

export default function CanaryPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  const { deployments, error: canaryError } = useCanary({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <CanaryPanel deployments={deployments} error={canaryError} />
    </div>
  );
}
