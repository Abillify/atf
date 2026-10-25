"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /citation-impact — Citation impact route.
 *
 * Lists answers whose cited sources changed or disappeared
 * (`GET /monitoring/citation-impact`): a reporting window (30/90/365 days),
 * an optional `base_ref` filter, summary counters per chunk status and a
 * table of affected executions linking into the Trace Viewer. Read-only
 * operator view; the report itself is produced by the runtime.
 */

import dynamic from "next/dynamic";
import { useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import {
  useCitationImpact,
  type CitationImpactDays,
} from "../../../hooks/useCitationImpact";

// Impact table — loaded client-side only, like the other monitoring pages.
const CitationImpactPanel = dynamic(
  () =>
    import("../../../components/CitationImpactPanel").then(
      (m) => m.CitationImpactPanel,
    ),
  { ssr: false },
);

export default function CitationImpactPage() {
  const { token, ready } = useAuth();
  const tokenOpt = token ?? undefined;

  const [days, setDays] = useState<CitationImpactDays>(90);
  const [baseRef, setBaseRef] = useState("");

  const { report, affected, signed, isLoading, error } = useCitationImpact({
    days,
    baseRef,
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <CitationImpactPanel
        report={report}
        affected={affected}
        signed={signed}
        days={days}
        onDaysChange={setDays}
        baseRef={baseRef}
        onBaseRefChange={setBaseRef}
        isLoading={isLoading}
        error={error}
      />
    </div>
  );
}
