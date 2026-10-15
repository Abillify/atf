"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useCanWrite } from "../lib/auth/useCanWrite";
import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  Button,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
  useConfirm,
} from "../lib/ui";
import { useLimits } from "../hooks/useLimits";
import { useUsageSeries, useUsageModels } from "../hooks/useUsageSeries";
import type {
  LimitConsumption,
  LimitPeriod,
  LimitScopeType,
  TokenLimitInput,
  UsageBucket,
} from "../types/limits";
import { formatNumber, formatDateTime } from "../lib/i18n";
import { useChartPalette } from "../lib/theme/palette";

export interface LimitsPanelProps {
  enabled: boolean;
  token?: string;
}

type RangePreset = "24h" | "7d" | "30d" | "custom";

const PRESET_MS: Record<Exclude<RangePreset, "custom">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Date → value for a <input type="datetime-local">. */
function toLocalInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scopeLabel(l: {
  scopeType: LimitScopeType;
  scopeId: string | null;
}): string {
  if (l.scopeType === "global") return "Global";
  return `${l.scopeType === "user" ? "User" : "Flow"}: ${l.scopeId ?? "—"}`;
}

function periodLabel(p: LimitPeriod): string {
  return p === "day" ? "per day" : p === "week" ? "per week" : "per month";
}

function barColor(fraction: number): string {
  if (fraction >= 1) return "bg-danger-solid";
  if (fraction >= 0.8) return "bg-warning-solid";
  return "bg-success-solid";
}

/**
 * "Limits" dashboard tab: configure token limits (period × scope × model),
 * see each limit's consumption for its period, and explore a free-range
 * token/cost time-series.
 */
export function LimitsPanel({
  enabled,
  token,
}: LimitsPanelProps): React.JSX.Element {
  const { confirm: confirmDialog } = useConfirm();
  const chart = useChartPalette();
  const { models } = useUsageModels(enabled, token);
  const {
    limits,
    error: limitsError,
    saveLimit,
    updateLimit,
    deleteLimit,
  } = useLimits({ enabled, ...(token !== undefined ? { token } : {}) });

  // ---- Time-series controls --------------------------------------------
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [bucket, setBucket] = useState<UsageBucket>("day");
  const [customFrom, setCustomFrom] = useState(() =>
    toLocalInput(new Date(Date.now() - PRESET_MS["7d"])),
  );
  const [customTo, setCustomTo] = useState(() => toLocalInput(new Date()));
  const [seriesScope, setSeriesScope] = useState<LimitScopeType>("global");
  const [seriesScopeId, setSeriesScopeId] = useState("");
  const [seriesModel, setSeriesModel] = useState("");

  const { fromIso, toIso } = useMemo(() => {
    if (preset === "custom") {
      return {
        fromIso: new Date(customFrom).toISOString(),
        toIso: new Date(customTo).toISOString(),
      };
    }
    const now = Date.now();
    return {
      fromIso: new Date(now - PRESET_MS[preset]).toISOString(),
      toIso: new Date(now).toISOString(),
    };
  }, [preset, customFrom, customTo]);

  const { series, error: seriesError } = useUsageSeries({
    fromIso,
    toIso,
    bucket,
    scopeType: seriesScope,
    ...(seriesScopeId !== "" ? { scopeId: seriesScopeId } : {}),
    ...(seriesModel !== "" ? { model: seriesModel } : {}),
    enabled,
    ...(token !== undefined ? { token } : {}),
  });

  const chartData = useMemo(
    () =>
      series.map((p) => ({
        ts: p.bucket,
        label: formatDateTime(p.bucket, {
          month: "short",
          day: "numeric",
          ...(bucket === "hour" ? { hour: "2-digit" } : {}),
        }),
        prompt: p.promptTokens,
        completion: p.completionTokens,
        total: p.totalTokens,
      })),
    [series, bucket],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Usage time-series */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            Token usage over time
          </h3>
          <div className="flex flex-wrap items-end gap-2 text-xs">
            {/* Range presets */}
            <div className="flex overflow-hidden rounded border border-border">
              {(["24h", "7d", "30d", "custom"] as RangePreset[]).map((p) => (
                <button type="button"
                  key={p}
                  onClick={() => setPreset(p)}
                  className={`px-2 py-1 ${
                    preset === p
                      ? "bg-accent text-accent-foreground"
                      : "bg-card text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {p === "custom" ? "Custom" : p}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <>
                <label className="flex flex-col text-muted-foreground">
                  From
                  <input
                    type="datetime-local"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="rounded border border-border px-1 py-0.5"
                  />
                </label>
                <label className="flex flex-col text-muted-foreground">
                  To
                  <input
                    type="datetime-local"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="rounded border border-border px-1 py-0.5"
                  />
                </label>
              </>
            )}
            {/* Bucket */}
            <label className="flex flex-col text-muted-foreground">
              Bucket
              <select
                value={bucket}
                onChange={(e) => setBucket(e.target.value as UsageBucket)}
                className="rounded border border-border px-1 py-0.5"
              >
                <option value="hour">Hourly</option>
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
              </select>
            </label>
            {/* Scope filter */}
            <label className="flex flex-col text-muted-foreground">
              Scope
              <select
                value={seriesScope}
                onChange={(e) => {
                  setSeriesScope(e.target.value as LimitScopeType);
                  setSeriesScopeId("");
                }}
                className="rounded border border-border px-1 py-0.5"
              >
                <option value="global">All</option>
                <option value="user">User</option>
                <option value="flow">Flow</option>
              </select>
            </label>
            {seriesScope !== "global" && (
              <label className="flex flex-col text-muted-foreground">
                {seriesScope === "user" ? "User id" : "Flow id"}
                <input
                  value={seriesScopeId}
                  onChange={(e) => setSeriesScopeId(e.target.value)}
                  placeholder="(all)"
                  className="rounded border border-border px-1 py-0.5"
                />
              </label>
            )}
            {/* Model filter */}
            <label className="flex flex-col text-muted-foreground">
              Model
              <select
                value={seriesModel}
                onChange={(e) => setSeriesModel(e.target.value)}
                className="rounded border border-border px-1 py-0.5"
              >
                <option value="">All models</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {seriesError !== null ? (
          <p className="py-8 text-center text-sm text-danger">{seriesError}</p>
        ) : chartData.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No usage recorded in this range.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ left: 8, right: 16, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 10 }} width={56} />
              <Tooltip
                formatter={(v) => formatNumber(Number(v ?? 0))}
                labelStyle={{ fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="total"
                name="Total tokens"
                stroke={chart.c1}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="prompt"
                name="Prompt"
                stroke={chart.c3}
                strokeWidth={1}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="completion"
                name="Completion"
                stroke={chart.c2}
                strokeWidth={1}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      {/* Configured limits + consumption */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Configured limits &amp; consumption
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Enforced at request admission: a request is rejected once a matching
          limit is exhausted for its window (soft cap — an in-flight request may
          slightly exceed it).
        </p>
        {limitsError !== null && (
          <p className="mb-2 text-xs text-danger">{limitsError}</p>
        )}
        {limits.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No limits configured yet. Add one below.
          </p>
        ) : (
          <Table>
            <TableHead>
              <TableRow className="uppercase tracking-wide">
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Period</TableHeaderCell>
                <TableHeaderCell className="text-right">
                  Used / Limit
                </TableHeaderCell>
                <TableHeaderCell className="pl-3">Consumption</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {limits.map((l) => (
                <LimitRow
                  key={l.id}
                  limit={l}
                  onDelete={async () => {
                    const ok = await confirmDialog({
                      title: "Delete token limit?",
                      message: "The limit stops applying immediately.",
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) await deleteLimit(l.id);
                  }}
                  onEdit={(input) => void updateLimit(l.id, input)}
                />
              ))}
            </TableBody>
          </Table>
        )}

        <AddLimitForm models={models} onSave={saveLimit} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Limit row (consumption + inline edit of the token value)
// ---------------------------------------------------------------------------

function LimitRow({
  limit,
  onDelete,
  onEdit,
}: {
  limit: LimitConsumption;
  onDelete: () => void;
  onEdit: (input: TokenLimitInput) => void;
}): React.JSX.Element {
  const writeGate = useCanWrite("operator");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(limit.limitTokens));

  const pct = Math.min(100, Math.round(limit.usedFraction * 100));
  const over = limit.usedFraction >= 1;

  return (
    <TableRow className="align-middle">
      <TableCell className="text-xs text-foreground">
        {scopeLabel(limit)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {limit.model ?? <span className="text-muted-foreground">all</span>}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {periodLabel(limit.period)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {editing ? (
          <span className="flex items-center justify-end gap-1">
            {formatNumber(limit.used.totalTokens)} /
            <input
              type="number"
              min={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-24 rounded border border-border px-1 py-0.5 text-right"
            />
          </span>
        ) : (
          <>
            {formatNumber(limit.used.totalTokens)} /{" "}
            {formatNumber(limit.limitTokens)}
          </>
        )}
      </TableCell>
      <TableCell className="pl-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className={`h-full ${barColor(limit.usedFraction)}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span
            className={`w-10 text-right text-[10px] tabular-nums ${over ? "font-semibold text-danger" : "text-muted-foreground"}`}
          >
            {pct}%
          </span>
        </div>
      </TableCell>
      <TableCell className="pl-2 text-right whitespace-nowrap">
        {editing ? (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const n = Number(value);
                if (Number.isFinite(n) && n > 0) {
                  onEdit({
                    scopeType: limit.scopeType,
                    scopeId: limit.scopeId,
                    model: limit.model,
                    period: limit.period,
                    limitTokens: Math.floor(n),
                  });
                }
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-1"
              onClick={() => {
                setValue(String(limit.limitTokens));
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={!writeGate.allowed}
              title={writeGate.title}
            >
              Edit
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="ml-1"
              onClick={onDelete}
              disabled={!writeGate.allowed}
              title={writeGate.title}
            >
              Delete
            </Button>
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Add-limit form
// ---------------------------------------------------------------------------

function AddLimitForm({
  models,
  onSave,
}: {
  models: string[];
  onSave: (input: TokenLimitInput) => Promise<void>;
}): React.JSX.Element {
  const writeGate = useCanWrite("operator");
  const [scopeType, setScopeType] = useState<LimitScopeType>("global");
  const [scopeId, setScopeId] = useState("");
  const [model, setModel] = useState("");
  const [period, setPeriod] = useState<LimitPeriod>("day");
  const [limitTokens, setLimitTokens] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    const n = Number(limitTokens);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive token limit.");
      return;
    }
    if (scopeType !== "global" && scopeId.trim() === "") {
      setError(`A ${scopeType} limit needs a ${scopeType} id.`);
      return;
    }
    setSaving(true);
    try {
      await onSave({
        scopeType,
        scopeId: scopeType === "global" ? null : scopeId.trim(),
        model: model === "" ? null : model,
        period,
        limitTokens: Math.floor(n),
      });
      setLimitTokens("");
      setScopeId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save limit.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Add / update a limit
      </div>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col text-muted-foreground">
          Scope
          <select
            value={scopeType}
            onChange={(e) => setScopeType(e.target.value as LimitScopeType)}
            className="rounded border border-border px-1 py-1"
          >
            <option value="global">Global</option>
            <option value="user">Per user</option>
            <option value="flow">Per flow</option>
          </select>
        </label>
        {scopeType !== "global" && (
          <label className="flex flex-col text-muted-foreground">
            {scopeType === "user" ? "User id" : "Flow id"}
            <input
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              className="rounded border border-border px-1 py-1"
            />
          </label>
        )}
        <label className="flex flex-col text-muted-foreground">
          Model
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded border border-border px-1 py-1"
          >
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-muted-foreground">
          Period
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as LimitPeriod)}
            className="rounded border border-border px-1 py-1"
          >
            <option value="day">Per day</option>
            <option value="week">Per week</option>
            <option value="month">Per month</option>
          </select>
        </label>
        <label className="flex flex-col text-muted-foreground">
          Limit (tokens)
          <input
            type="number"
            min={1}
            value={limitTokens}
            onChange={(e) => setLimitTokens(e.target.value)}
            placeholder="e.g. 1000000"
            className="w-32 rounded border border-border px-1 py-1"
          />
        </label>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void submit()}
          disabled={saving || !writeGate.allowed}
          title={writeGate.title}
        >
          {saving ? "Saving…" : "Save limit"}
        </Button>
      </div>
      {error !== null && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
