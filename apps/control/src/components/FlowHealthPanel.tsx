"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import type {
  FlowHealthEntry,
  FlowLoadFailure,
} from "../hooks/useFlowHealth";
import { Badge } from "../lib/ui";
import { translate, formatDateTime } from "../lib/i18n";

export interface FlowHealthPanelProps {
  flows: FlowHealthEntry[];
  loadFailures: FlowLoadFailure[];
  generatedAt?: string | null;
  isLoading?: boolean;
  error?: string | null;
}

function SourceBadge({ source }: { source: FlowHealthEntry["source"] }): React.JSX.Element {
  return (
    <Badge variant={source === "db" ? "success" : "secondary"}>
      {source === "db"
        ? translate("flowHealthPanel.sourceDb")
        : translate("flowHealthPanel.sourceFile")}
    </Badge>
  );
}

/**
 * Service-objective cell: a destructive badge per breached objective, a
 * waiting note while the window is still filling, a plain OK once the
 * objectives hold — and an em dash for flows that declare no `slo`.
 */
function SloCell({ entry }: { entry: FlowHealthEntry }): React.JSX.Element {
  const slo = entry.slo;
  if (slo === undefined) return <span>—</span>;
  if (slo.breached.length > 0) {
    return (
      <span className="flex flex-wrap gap-1">
        {slo.breached.map((objective) => (
          <Badge key={objective} variant="destructive">
            {objective}
          </Badge>
        ))}
      </span>
    );
  }
  if (slo.samples < slo.minSamples) {
    return (
      <span>
        {translate("flowHealthPanel.sloPending", {
          samples: slo.samples,
          minSamples: slo.minSamples,
        })}
      </span>
    );
  }
  return (
    <span>
      <Badge variant="success">{translate("flowHealthPanel.sloOk")}</Badge>
      <span className="ml-2 tabular-nums">
        {translate("flowHealthPanel.sloSamples", {
          samples: slo.samples,
          window: slo.window,
        })}
      </span>
    </span>
  );
}

function LoadFailures({
  failures,
}: {
  failures: FlowLoadFailure[];
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-danger">
        {translate("flowHealthPanel.loadFailures")}{" "}
        <span className="font-normal">({failures.length})</span>
      </h4>
      <ul className="mt-2 space-y-2">
        {failures.map((f) => (
          <li key={f.file} className="text-xs">
            <span className="font-mono text-foreground">{f.file}</span>
            <span className="ml-2 text-danger">{f.reason}</span>
            <span className="ml-2 text-muted-foreground">
              {translate("flowHealthPanel.since", {
                value: formatDateTime(f.since),
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FlowHealthPanel({
  flows,
  loadFailures,
  generatedAt,
  isLoading,
  error,
}: FlowHealthPanelProps): React.JSX.Element {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {translate("flowHealthPanel.title")}{" "}
          <span className="font-normal text-muted-foreground">
            ({flows.length})
          </span>
        </h3>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>

      {loadFailures.length > 0 && <LoadFailures failures={loadFailures} />}

      {isLoading && flows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {translate("flowHealthPanel.loading")}
        </p>
      ) : flows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {translate("flowHealthPanel.noFlowsServed")}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-xs">
            <caption className="px-3 py-2 text-left text-muted-foreground">
              {translate("flowHealthPanel.tableCaption")}
              {generatedAt
                ? ` — ${translate("flowHealthPanel.generatedAt", {
                    value: formatDateTime(generatedAt),
                  })}`
                : ""}
            </caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("flowHealthPanel.colFlow")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("flowHealthPanel.colSource")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("flowHealthPanel.colFile")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("flowHealthPanel.colVersion")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("flowHealthPanel.colDigest")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("flowHealthPanel.colLastEval")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {translate("flowHealthPanel.colSlo")}
                </th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={`${f.source}:${f.id}`} className="border-b border-border/60">
                  <td className="px-3 py-2 font-mono text-foreground">
                    <span>{f.id}</span>
                    {f.shadowsFile && (
                      <span className="ml-2">
                        <Badge variant="destructive">
                          {translate("flowHealthPanel.shadowingFile")}
                        </Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <SourceBadge source={f.source} />
                  </td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">
                    {f.file ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">
                    {f.version ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">
                    {f.digest ? f.digest.slice(0, 12) : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {f.lastEval ? (
                      <span>
                        <span className="tabular-nums">
                          {translate("flowHealthPanel.evalCounts", {
                            passed: f.lastEval.passed,
                            failed: f.lastEval.failed,
                          })}
                        </span>
                        <span className="ml-2">
                          {formatDateTime(f.lastEval.at)}
                        </span>
                      </span>
                    ) : (
                      <span>{translate("flowHealthPanel.neverEvaluated")}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <SloCell entry={f} />
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
