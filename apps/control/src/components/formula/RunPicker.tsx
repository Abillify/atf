"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: RunPicker (pin recorded runs as sample data), moved out of
// FormulaEditor.tsx without behavior change.

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchFlowRuns,
  fetchRunSample,
  isStudioRun,
  type RunSummary,
} from "../../lib/run-samples";
import type { RunsContext } from "./FormulaContext";
import { translate, formatDateTime } from "../../lib/i18n";

/** Pick a recorded run of the flow whose values fill the previews (📌 pinned). */
export function RunPicker({ runs, className = "ml-4" }: { runs: RunsContext; className?: string }): React.JSX.Element {
  const [list, setList] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    fetchFlowRuns(runs.flowId, runs.token).then(setList, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [runs.flowId, runs.token]);
  useEffect(load, [load]);
  const choose = (id: string): void => {
    if (id === "") {
      runs.onPin(null);
      return;
    }
    setBusy(true);
    setError(null);
    fetchRunSample(id, runs.token).then(
      (run) => {
        runs.onPin(run);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };
  const label = (r: { started_at?: string; startedAt?: string; preview: string; flow_id?: string | null; flowId?: string | null }): string => {
    const at = formatDateTime(new Date(r.started_at ?? r.startedAt ?? ""), {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const studio = isStudioRun(r.flow_id ?? r.flowId ?? null) ? "Studio test · " : "";
    return `${studio}${at} · ${r.preview || "(no message)"}`;
  };
  const pinned = runs.pinned;
  const options = [...(list ?? [])];
  if (pinned && !options.some((r) => r.execution_id === pinned.executionId)) {
    options.unshift({
      execution_id: pinned.executionId,
      flow_id: pinned.flowId,
      started_at: pinned.startedAt,
      status: "completed",
      preview: pinned.preview,
    });
  }
  return (
    <div className={`${className} flex min-w-0 items-center gap-1.5 text-[11px]`}>
      <span className="shrink-0 text-muted-foreground" title={translate("runPicker.valuesOfARecordedRun")}>
        {translate("runPicker.sampleData")}
      </span>
      <select
        aria-label={translate("runPicker.pinnedRun")}
        value={pinned?.executionId ?? ""}
        disabled={busy}
        onChange={(e) => choose(e.target.value)}
        className="min-w-0 max-w-[26rem] truncate rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
      >
        <option value="">{translate("runPicker.noneSampleValues")}</option>
        {options.map((r) => (
          <option key={r.execution_id} value={r.execution_id}>
            {label(r)}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={load}
        title={translate("runPicker.reloadTheListOfRuns")}
        className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        ↻
      </button>
      {list !== null && list.length === 0 && !pinned && (
        <span className="text-muted-foreground">{translate("runPicker.noRunsYetRunThe")}</span>
      )}
      {error && <span role="alert" className="truncate text-danger">{error}</span>}
    </div>
  );
}
