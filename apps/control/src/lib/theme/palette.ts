// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * palette: resolves the design tokens from `globals.css` at runtime.
 *
 * SVG presentation attributes (React Flow edges, MiniMap nodes, Recharts
 * `stroke`/`fill`) cannot resolve `var(--token)`, unlike inline styles.
 * This module translates token names into resolved `hsl(…)` colors and
 * updates them when the theme (`dark` class on `<html>`) changes.
 *
 * The fallback values only apply where CSS variables cannot be resolved
 * (SSR, jsdom); in the browser all colors come from the tokens.
 *
 * Requirements: 9.8 (design tokens instead of fixed colors)
 */

import { useEffect, useState } from "react";

/** Reads a CSS variable from the document and wraps it as `hsl(…)`. */
export function resolveVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw ? `hsl(${raw})` : fallback;
}

/** Observes the `dark` class on `<html>` (theme switch without context). */
function useThemeClass(): string {
  const [cls, setCls] = useState<string>(() =>
    typeof document === "undefined" ? "" : document.documentElement.className,
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setCls(document.documentElement.className),
    );
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);
  return cls;
}

/** All token names + SSR/jsdom fallbacks (only outside the browser). */
const CHART_VARS = {
  grid: ["--chart-grid", "#d8dee9"],
  tooltipBg: ["--chart-tooltip-bg", "#ffffff"],
  tooltipLabel: ["--chart-tooltip-label", "#55627a"],
  tooltipItem: ["--chart-tooltip-item", "#0a1420"],
  c1: ["--chart-1", "#2563eb"],
  c2: ["--chart-2", "#7c3aed"],
  c3: ["--chart-3", "#0891b2"],
  c4: ["--chart-4", "#16a34a"],
  c5: ["--chart-5", "#ca8a04"],
  c6: ["--chart-6", "#dc2626"],
  run: ["--chart-run", "#3b82f6"],
  cost: ["--chart-cost", "#f59e0b"],
  promptLight: ["--chart-prompt-light", "#93c5fd"],
} as const;

const EDGE_VARS = {
  used: ["--edge-used", "#10b981"],
  parallel: ["--edge-parallel", "#8b5cf6"],
  parallelLight: ["--edge-parallel-light", "#c4b5fd"],
  verifies: ["--edge-verifies", "#e11d48"],
  delegates: ["--edge-delegates", "#0d9488"],
  tool: ["--edge-tool", "#14b8a6"],
  boundary: ["--edge-boundary", "#2563eb"],
  active: ["--edge-active", "#f59e0b"],
  idle: ["--edge-idle", "#94a3b8"],
  idleSoft: ["--edge-idle-soft", "#d1d5db"],
  added: ["--edge-added", "#16a34a"],
  removed: ["--edge-removed", "#f87171"],
  error: ["--edge-error", "#dc2626"],
  canvasDots: ["--canvas-dots", "#e5e7eb"],
} as const;

const NODE_VARS = {
  llm: ["--node-llm", "#4f46e5"],
  classifier: ["--node-classifier", "#9333ea"],
  router: ["--node-router", "#f59e0b"],
  parallel: ["--node-parallel", "#7c3aed"],
  retrieval: ["--node-retrieval", "#0e7490"],
  memory: ["--node-memory", "#c026d3"],
  tool: ["--node-tool", "#0d9488"],
  agentHarness: ["--node-agent-harness", "#e11d48"],
  transform: ["--node-transform", "#4d7c0f"],
  trigger: ["--node-trigger", "#ea580c"],
  assistant: ["--node-assistant", "#0284c7"],
  boundary: ["--node-boundary", "#475569"],
  default: ["--node-default", "#6b7280"],
} as const;

export type ChartPalette = { [K in keyof typeof CHART_VARS]: string };
export type EdgePalette = { [K in keyof typeof EDGE_VARS]: string };
export type NodePalette = { [K in keyof typeof NODE_VARS]: string };

function readAll<T extends Record<string, readonly [string, string]>>(
  spec: T,
): { [K in keyof T]: string } {
  const out: Record<string, string> = {};
  for (const [key, [name, fallback]] of Object.entries(spec)) {
    out[key] = resolveVar(name, fallback);
  }
  return out as { [K in keyof T]: string };
}

/** Chart colors, reactive to theme switches. */
export function useChartPalette(): ChartPalette {
  const cls = useThemeClass();
  const [palette, setPalette] = useState<ChartPalette>(() =>
    readAll(CHART_VARS),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme class is the re-read trigger; the effect body intentionally does not read it
  useEffect(() => {
    setPalette(readAll(CHART_VARS));
  }, [cls]);
  return palette;
}

/** Edge/canvas colors, reactive to theme switches. */
export function useEdgePalette(): EdgePalette {
  const cls = useThemeClass();
  const [palette, setPalette] = useState<EdgePalette>(() => readAll(EDGE_VARS));
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme class is the re-read trigger; the effect body intentionally does not read it
  useEffect(() => {
    setPalette(readAll(EDGE_VARS));
  }, [cls]);
  return palette;
}

/** Node category colors, reactive to theme switches. */
export function useNodePalette(): NodePalette {
  const cls = useThemeClass();
  const [palette, setPalette] = useState<NodePalette>(() => readAll(NODE_VARS));
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme class is the re-read trigger; the effect body intentionally does not read it
  useEffect(() => {
    setPalette(readAll(NODE_VARS));
  }, [cls]);
  return palette;
}

/**
 * One-off resolution of a node category color (for callbacks outside React
 * renders, e.g. MiniMap `nodeColor`). From the token in the browser,
 * otherwise the fallback.
 */
export function nodeTypeVarColor(kind: keyof typeof NODE_VARS): string {
  const [name, fallback] = NODE_VARS[kind];
  return resolveVar(name, fallback);
}
