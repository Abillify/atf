"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GraphLegend — compact legend overlay showing which node types and statuses
 * are present in the current graph view.
 *
 * Requirements: 11.2
 */

import type React from "react";
import {
  nodeTypeHex,
  statusIndicator,
  type NodeVisualType,
} from "./graphUtils";

const LEGEND_TYPES: Array<{ type: NodeVisualType; label: string }> = [
  { type: "boundary", label: "Request / Response" },
  { type: "llm", label: "LLM" },
  { type: "classifier", label: "Classifier" },
  { type: "router", label: "Router" },
  { type: "parallel", label: "Parallel" },
  { type: "retrieval", label: "Retrieval / RAG" },
  { type: "memory", label: "Memory" },
  { type: "tool", label: "Tool" },
  { type: "unknown", label: "Other" },
];

interface GraphLegendProps {
  /** Set of node visual types that are actually present in the graph. */
  present: Set<NodeVisualType>;
}

export function GraphLegend({ present }: GraphLegendProps) {
  const types = LEGEND_TYPES.filter((t) => present.has(t.type));
  if (types.length === 0) return null;
  return (
    <div className="absolute top-2 left-2 z-10 rounded-lg border border-border bg-card/90 px-3 py-2 text-[11px] shadow-sm backdrop-blur-sm">
      <div className="mb-1 font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
        Node type
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {types.map((t) => (
          <div key={t.type} className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded-sm border border-black/10 shrink-0"
              style={{ backgroundColor: nodeTypeHex(t.type) }}
            />
            <span className="text-foreground">{t.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 mb-1 font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
        Status
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {(["completed", "running", "error", "pending"] as const).map((s) => {
          const ind = statusIndicator(s);
          return (
            <div key={s} className="flex items-center gap-1.5">
              {s === "running" ? (
                // Running nodes carry a rotating border, not a dot (NodeCard).
                <span data-testid="legend-running" className="relative inline-block h-3 w-3">
                  <span
                    className="node-running-border"
                    style={{ inset: 0, padding: 2, "--node-spin-radius": "9999px" } as React.CSSProperties}
                  />
                </span>
              ) : (
                <span
                  className={`inline-block w-3 h-3 rounded-full border text-[8px] leading-none flex items-center justify-center ${ind.dot}`}
                >
                  {ind.glyph}
                </span>
              )}
              <span className="capitalize text-foreground">{s}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
