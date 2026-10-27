"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Citation impact panel — answers whose cited sources changed.
 *
 * Renders the report of `GET /monitoring/citation-impact`: a summary of how
 * many executions were checked and how many cite a changed or removed chunk,
 * plus a table of the affected executions linking into the Trace Viewer.
 * The window (30/90/365 days) and an optional `base_ref` filter are controls
 * owned by the page; the panel stays presentational.
 */

import { useState } from "react";
import type React from "react";
import type {
  CitationChunkStatus,
  CitationImpactAffected,
  CitationImpactReport,
} from "../types/citation-impact";
import {
  CITATION_IMPACT_DAY_OPTIONS,
  type CitationImpactDays,
} from "../hooks/useCitationImpact";
import { Badge } from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { translate, formatDateTime } from "../lib/i18n";

export interface CitationImpactPanelProps {
  report: CitationImpactReport | null;
  affected: CitationImpactAffected[];
  signed: boolean;
  days: CitationImpactDays;
  onDaysChange: (days: CitationImpactDays) => void;
  baseRef: string;
  onBaseRefChange: (baseRef: string) => void;
  isLoading?: boolean;
  error?: string | null;
}

/** Substring of the runtime's 503 when CITATION_CHECK_URL is unset. */
const NOT_CONFIGURED_MARKER = "citation check is not configured";

const CHUNK_STATUS_BADGE: Record<"changed" | "removed", BadgeVariant> = {
  changed: "warning",
  removed: "destructive",
};

const CHUNK_STATUS_LABEL_KEY: Record<
  "changed" | "removed",
  "citationImpactPanel.statusChanged" | "citationImpactPanel.statusRemoved"
> = {
  changed: "citationImpactPanel.statusChanged",
  removed: "citationImpactPanel.statusRemoved",
};

/** Summary counters, in a fixed reading order. */
const SUMMARY_STATUSES: CitationChunkStatus[] = [
  "current",
  "carried",
  "changed",
  "removed",
  "unknown",
  "unverified",
];

const SUMMARY_STATUS_LABEL_KEY: Record<
  CitationChunkStatus,
  | "citationImpactPanel.statusCurrent"
  | "citationImpactPanel.statusCarried"
  | "citationImpactPanel.statusChanged"
  | "citationImpactPanel.statusRemoved"
  | "citationImpactPanel.statusUnknown"
  | "citationImpactPanel.statusUnverified"
> = {
  current: "citationImpactPanel.statusCurrent",
  carried: "citationImpactPanel.statusCarried",
  changed: "citationImpactPanel.statusChanged",
  removed: "citationImpactPanel.statusRemoved",
  unknown: "citationImpactPanel.statusUnknown",
  unverified: "citationImpactPanel.statusUnverified",
};

export function CitationImpactPanel({
  report,
  affected,
  signed,
  days,
  onDaysChange,
  baseRef,
  onBaseRefChange,
  isLoading,
  error,
}: CitationImpactPanelProps): React.JSX.Element {
  const [baseRefDraft, setBaseRefDraft] = useState(baseRef);
  const notConfigured =
    error !== null && error !== undefined
      ? error.includes(NOT_CONFIGURED_MARKER)
      : false;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {translate("citationImpactPanel.title")}
        </h3>
        {signed && (
          <Badge variant="success">{translate("citationImpactPanel.signed")}</Badge>
        )}
        {report && (
          <span className="text-xs text-muted-foreground">
            {translate("citationImpactPanel.generatedAt", {
              value: formatDateTime(report.generated_at),
            })}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {translate("citationImpactPanel.daysLabel")}
          <select
            aria-label={translate("citationImpactPanel.daysLabel")}
            value={days}
            onChange={(e) =>
              onDaysChange(Number(e.target.value) as CitationImpactDays)
            }
            className="rounded border border-border bg-card px-2 py-1 text-xs text-foreground"
          >
            {CITATION_IMPACT_DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {translate("citationImpactPanel.daysOption", { value: option })}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex flex-col gap-1 text-xs text-muted-foreground"
          onSubmit={(e) => {
            e.preventDefault();
            onBaseRefChange(baseRefDraft.trim());
          }}
        >
          <label htmlFor="citation-impact-base-ref">
            {translate("citationImpactPanel.baseRefLabel")}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="citation-impact-base-ref"
              type="text"
              value={baseRefDraft}
              placeholder={translate("citationImpactPanel.baseRefPlaceholder")}
              onChange={(e) => setBaseRefDraft(e.target.value)}
              className="rounded border border-border bg-card px-2 py-1 font-mono text-xs text-foreground"
            />
            <button
              type="submit"
              className="rounded border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
            >
              {translate("citationImpactPanel.apply")}
            </button>
          </div>
        </form>
      </div>

      {error && (
        <p className="text-xs text-danger" role="alert">
          {notConfigured
            ? translate("citationImpactPanel.notConfigured")
            : error}
        </p>
      )}

      {report && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            {translate("citationImpactPanel.checked", {
              value: report.summary.executions_checked,
            })}
          </span>
          <span className="font-medium text-foreground">
            {translate("citationImpactPanel.affected", {
              value: report.summary.executions_affected,
            })}
          </span>
          {SUMMARY_STATUSES.map((status) => (
            <span key={status} className="text-muted-foreground">
              {translate(SUMMARY_STATUS_LABEL_KEY[status])}{" "}
              <span className="font-mono text-foreground">
                {report.summary.chunks[status] ?? 0}
              </span>
            </span>
          ))}
        </div>
      )}

      {isLoading && report === null ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {translate("citationImpactPanel.loading")}
        </p>
      ) : affected.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {translate("citationImpactPanel.empty")}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-xs">
            <caption className="px-3 py-2 text-left text-muted-foreground">
              {translate("citationImpactPanel.tableCaption")}
            </caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("citationImpactPanel.colExecution")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("citationImpactPanel.colFlow")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("citationImpactPanel.colVersion")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("citationImpactPanel.colCreatedAt")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("citationImpactPanel.colChunks")}
                </th>
              </tr>
            </thead>
            <tbody>
              {affected.map((row) => (
                <tr
                  key={`${row.execution_id}:${row.chunks
                    .map((c) => `${c.base_ref}/${c.chunk_id}`)
                    .join(",")}`}
                  className="border-b border-border/60 align-top"
                >
                  <td className="px-3 py-2 font-mono">
                    <a
                      href={`/traces?execution=${encodeURIComponent(
                        row.execution_id,
                      )}`}
                      className="text-accent underline hover:no-underline"
                    >
                      {row.execution_id}
                    </a>
                  </td>
                  <td className="px-3 py-2 font-mono text-foreground">
                    {row.flow_id}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.flow_version ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDateTime(row.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <ul className="space-y-1">
                      {row.chunks.map((chunk) => (
                        <li
                          key={`${chunk.base_ref}/${chunk.chunk_id}`}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="font-mono text-foreground">
                            {chunk.base_ref}/{chunk.chunk_id}
                          </span>
                          <Badge variant={CHUNK_STATUS_BADGE[chunk.status]}>
                            {translate(CHUNK_STATUS_LABEL_KEY[chunk.status])}
                          </Badge>
                          {chunk.current_revision && (
                            <span className="text-muted-foreground">
                              {translate("citationImpactPanel.currentRevision", {
                                value: chunk.current_revision,
                              })}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
