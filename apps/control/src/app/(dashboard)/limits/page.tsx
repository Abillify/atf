"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /limits — Rate Limits route (Req. 9.1, 9.2, 9.3, 12.3).
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";

// Heavy panel with charts — loaded client-side only (Req. 12.3).
const LimitsPanel = dynamic(
  () => import("../../../components/LimitsPanel").then((m) => m.LimitsPanel),
  { ssr: false },
);

export default function LimitsPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <LimitsPanel
        enabled={ready}
        {...(tokenOpt !== undefined ? { token: tokenOpt } : {})}
      />
    </div>
  );
}
