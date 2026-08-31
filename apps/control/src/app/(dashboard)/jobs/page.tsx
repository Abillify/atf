"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /jobs — Async/batch job status lookup route.
 */

import dynamic from "next/dynamic";
import { useAuth } from "../../../lib/auth/useAuth";

const JobsPanel = dynamic(
  () => import("../../../components/JobsPanel").then((m) => m.JobsPanel),
  { ssr: false },
);

export default function JobsPage() {
  const { token, ready } = useAuth();

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <JobsPanel token={token} ready={ready} />
    </div>
  );
}
