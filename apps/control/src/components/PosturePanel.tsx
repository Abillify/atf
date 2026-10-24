"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import type { PostureCheck, PostureStatus } from "../types/posture";
import { Badge } from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { translate, formatDateTime } from "../lib/i18n";

export interface PosturePanelProps {
  checks: PostureCheck[];
  /** Overall report status (worst check), null until the first report. */
  status?: PostureStatus | null;
  /** Effective operational profile from the report. */
  operationalProfile?: string | null;
  generatedAt?: string | null;
  isLoading?: boolean;
  error?: string | null;
}

const STATUS_BADGE: Record<PostureStatus, BadgeVariant> = {
  ok: "success",
  warn: "warning",
  fail: "destructive",
};

const STATUS_LABEL_KEY: Record<PostureStatus, "posturePanel.statusOk" | "posturePanel.statusWarn" | "posturePanel.statusFail"> = {
  ok: "posturePanel.statusOk",
  warn: "posturePanel.statusWarn",
  fail: "posturePanel.statusFail",
};

/** Status badge — the status word is always visible, never color alone. */
function StatusBadge({ status }: { status: PostureStatus }): React.JSX.Element {
  return <Badge variant={STATUS_BADGE[status]}>{translate(STATUS_LABEL_KEY[status])}</Badge>;
}

/** Checks grouped by area, in first-seen report order. */
function groupByArea(checks: PostureCheck[]): Map<string, PostureCheck[]> {
  const groups = new Map<string, PostureCheck[]>();
  for (const check of checks) {
    const list = groups.get(check.area);
    if (list) list.push(check);
    else groups.set(check.area, [check]);
  }
  return groups;
}

export function PosturePanel({
  checks,
  status,
  operationalProfile,
  generatedAt,
  isLoading,
  error,
}: PosturePanelProps): React.JSX.Element {
  const groups = groupByArea(checks);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {translate("posturePanel.title")}{" "}
          <span className="font-normal text-muted-foreground">
            ({checks.length})
          </span>
        </h3>
        {status && <StatusBadge status={status} />}
        {operationalProfile && (
          <span className="text-xs text-muted-foreground">
            {translate("posturePanel.profile", { value: operationalProfile })}
          </span>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>

      {isLoading && checks.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {translate("posturePanel.loading")}
        </p>
      ) : checks.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {translate("posturePanel.noChecks")}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-xs">
            <caption className="px-3 py-2 text-left text-muted-foreground">
              {translate("posturePanel.tableCaption")}
              {generatedAt
                ? ` — ${translate("posturePanel.generatedAt", {
                    value: formatDateTime(generatedAt),
                  })}`
                : ""}
            </caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("posturePanel.colStatus")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("posturePanel.colCheck")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("posturePanel.colExplanation")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...groups.entries()].map(([area, areaChecks]) => (
                <AreaRows
                  key={area}
                  area={area}
                  checks={areaChecks}
                  columnCount={3}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AreaRows({
  area,
  checks,
  columnCount,
}: {
  area: string;
  checks: PostureCheck[];
  columnCount: number;
}): React.JSX.Element {
  return (
    <>
      <tr className="border-y border-border bg-muted/40">
        <th
          scope="colgroup"
          colSpan={columnCount}
          className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {area}
        </th>
      </tr>
      {checks.map((check) => (
        <tr key={check.id} className="border-b border-border/60 align-top">
          <td className="px-3 py-2">
            <StatusBadge status={check.status} />
          </td>
          <td className="px-3 py-2 font-mono text-foreground">{check.id}</td>
          <td className="px-3 py-2 text-muted-foreground">{check.message}</td>
        </tr>
      ))}
    </>
  );
}
