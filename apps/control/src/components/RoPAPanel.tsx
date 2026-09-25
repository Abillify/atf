"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * RoPAPanel — Record of Processing Activities (GDPR Art. 30) / data-flow map.
 *
 * Fetches GET /admin/compliance/ropa and shows, per flow, the declared data
 * classes, the LLM providers/models that process them (sub-processors), and a
 * residency assessment against the compliance policy's dataRules — turning the
 * platform's controls into a concrete auditor artefact focused on data lineage.
 */

import type React from "react";
import { useEffect, useState, useCallback } from "react";
import { Button } from "../lib/ui";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { downloadAuthenticated } from "../lib/authenticated-download";

interface FlowProcessor {
  provider: string;
  models: string[];
  nodeIds: string[];
  local: boolean;
}

interface RoPAEntry {
  flowId: string;
  flowName: string;
  description?: string;
  dataClasses: string[];
  processors: FlowProcessor[];
  status: "compliant" | "violation" | "undeclared" | "no-policy";
  warnings: string[];
}

interface DataFlowMap {
  generatedAt: string;
  entries: RoPAEntry[];
  summary: {
    flows: number;
    withDataClasses: number;
    violations: number;
    providers: string[];
    dataClasses: string[];
  };
}

const STATUS_STYLE: Record<RoPAEntry["status"], string> = {
  compliant: "border-green-200 bg-green-50 text-green-700",
  violation: "border-red-300 bg-red-50 text-red-700",
  undeclared: "border-amber-200 bg-amber-50 text-amber-700",
  "no-policy": "border-slate-200 bg-slate-50 text-slate-600",
};

export function RoPAPanel(): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();
  const [map, setMap] = useState<DataFlowMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadMarkdown = async (): Promise<void> => {
    if (!ready || !isAuthenticated) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadAuthenticated({
        url: backendUrl("/admin/compliance/ropa?format=markdown"),
        token,
        fallbackFilename: "ropa.md",
        accept: "text/markdown",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const fetchMap = useCallback(async () => {
    if (!ready || !isAuthenticated) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await authFetch(backendUrl("/admin/compliance/ropa"), token);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setMap((await resp.json()) as DataFlowMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, ready, isAuthenticated]);

  useEffect(() => {
    void fetchMap();
  }, [fetchMap]);

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            🗺️ Record of Processing Activities (Art. 30)
          </h2>
          <p className="text-xs text-muted-foreground">
            Per-flow data lineage: declared data classes → processing providers
            → residency assessment against the policy.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchMap()}
            disabled={loading}
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </Button>
          {isAuthenticated && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void downloadMarkdown()}
              disabled={downloading}
            >
              {downloading ? "Downloading…" : "↓ Download Markdown"}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {map && (
        <>
          <p className="text-xs text-muted-foreground">
            {map.summary.flows} flow(s), {map.summary.withDataClasses} with
            declared data classes,{" "}
            <span className={map.summary.violations > 0 ? "text-red-600 font-medium" : ""}>
              {map.summary.violations} residency violation(s)
            </span>
            . Providers: {map.summary.providers.join(", ") || "none"}.
          </p>

          <div className="flex flex-col gap-2">
            {map.entries.map((e) => (
              <div
                key={e.flowId}
                className="rounded border border-border bg-card px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs font-medium text-foreground">
                    {e.flowId}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[e.status]}`}
                  >
                    {e.status}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                  {e.dataClasses.length > 0 ? (
                    e.dataClasses.map((d) => (
                      <span
                        key={d}
                        className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                      >
                        {d}
                      </span>
                    ))
                  ) : (
                    <span className="text-muted-foreground italic">
                      no data classes declared
                    </span>
                  )}
                </div>
                {e.processors.length > 0 && (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Processors:{" "}
                    {e.processors
                      .map(
                        (p) =>
                          `${p.provider}${p.local ? " (local)" : ""} [${p.models.join(", ")}]`,
                      )
                      .join(" · ")}
                  </div>
                )}
                {e.warnings.map((w, i) => (
                  <div key={i} className="mt-1 text-[11px] text-amber-700">
                    ⚠ {w}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
