// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GraphLayoutEngine — pure, side-effect-free layout functions for the graph.
 *
 * Contains:
 *   - computeDagreLayout   : top-down hierarchical layout using dagre
 *   - computeChronologicalLayout : waterfall / timeline layout
 *
 * Both functions are pure (same input → same output) and carry no React imports,
 * which makes them straightforward to unit-test.
 *
 * Requirements: 11.2
 */

import dagre from "@dagrejs/dagre";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/**
 * Nominal node height used for Dagre layout spacing. The actual rendered box
 * uses this as a MIN height (it can grow for long labels/extra info rows) —
 * see NodeRenderer.tsx. Widened previously (72px) caused long node labels
 * (e.g. German multi-word titles) to render at a fixed, cramped height with
 * text clipped to 2 lines with no room to breathe.
 */
export const NODE_H = 96;
/**
 * Fixed node width used for Dagre layout and as min-width in timeline mode.
 * Widened from 180 to 220 so longer labels wrap to fewer lines before being
 * clamped/truncated.
 */
export const NODE_W = 220;
/** Vertical gap between lanes in timeline mode. */
const LANE_GAP = 30;
/** Minimum horizontal gap between two boxes sharing a lane in timeline mode. */
const MIN_X_GAP = 20;
/** Target pixel width for the full timeline span. */
const TARGET_TRACE_WIDTH = 1400;
/** Scale clamps for the timeline px-per-ms conversion. */
const MIN_PX_PER_MS = 0.02;
const MAX_PX_PER_MS = 2;

// ---------------------------------------------------------------------------
// Dagre layout
// ---------------------------------------------------------------------------

export interface DagrePosition {
  x: number;
  y: number;
}

/**
 * Computes a top-down hierarchical layout using Dagre.
 * Returns a map of nodeId → {x, y} (top-left corner, matching React Flow convention).
 *
 * This is a pure function: no global state is mutated; calling it twice with the
 * same arguments produces identical output.
 */
/** Compact card size used by the Studio editor canvas (see NodeCard `compact`). */
export const EDITOR_NODE_W = 200;
export const EDITOR_NODE_H = 56;

export interface DagreLayoutOptions {
  /** Per-node rendered size (e.g. React Flow's `measured`); falls back to `defaultSize`. */
  sizes?: Map<string, { width: number; height: number }>;
  /** Size for nodes without an entry in `sizes`. Default NODE_W × NODE_H. */
  defaultSize?: { width: number; height: number };
  nodesep?: number;
  ranksep?: number;
  /**
   * Edges carrying a text label get a label box so Dagre reserves room for it
   * between ranks instead of letting labels pile onto nodes.
   */
  labelSize?: { width: number; height: number };
  /**
   * Node id → cluster id. Nodes of one cluster (a sub-flow) are laid out as a
   * compact group so the box drawn around them doesn't cover other nodes.
   */
  clusters?: Map<string, string>;
}

export function computeDagreLayout(
  nodeIds: string[],
  edges: Array<{ source: string; target: string; label?: string }>,
  options: DagreLayoutOptions = {},
): Map<string, DagrePosition> {
  const fallback = options.defaultSize ?? { width: NODE_W, height: NODE_H };
  const clustered = options.clusters !== undefined && options.clusters.size > 0;
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: clustered });
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB", // top → bottom
    nodesep: options.nodesep ?? 70, // horizontal gap between nodes in the same rank
    ranksep: options.ranksep ?? 90, // vertical gap between ranks
    marginx: 40,
    marginy: 40,
  });

  const sizeOf = (id: string) => options.sizes?.get(id) ?? fallback;
  for (const id of nodeIds) {
    const { width, height } = sizeOf(id);
    g.setNode(id, { width, height });
  }
  if (clustered) {
    for (const [id, cluster] of options.clusters ?? []) {
      if (!g.hasNode(id)) continue;
      const key = `cluster:${cluster}`;
      // Cluster padding leaves room for the box label above the group.
      if (!g.hasNode(key)) g.setNode(key, { label: cluster, paddingTop: 34, paddingLeft: 20, paddingRight: 20, paddingBottom: 20 });
      g.setParent(id, key);
    }
  }
  edges.forEach((e, i) => {
    // Only add edges where both endpoints are in the graph (and skip self-loops,
    // which Dagre routes around the node and which add nothing to the ranking).
    if (!g.hasNode(e.source) || !g.hasNode(e.target) || e.source === e.target) {
      return;
    }
    const label =
      e.label && options.labelSize
        ? { width: options.labelSize.width, height: options.labelSize.height, labelpos: "c" }
        : {};
    g.setEdge(e.source, e.target, label, `e${i}`);
  });

  dagre.layout(g);

  const positions = new Map<string, DagrePosition>();
  for (const id of nodeIds) {
    const n = g.node(id);
    const { width, height } = sizeOf(id);
    if (n) {
      // Dagre returns centre coordinates; React Flow expects top-left
      positions.set(id, { x: n.x - width / 2, y: n.y - height / 2 });
    } else {
      positions.set(id, { x: 0, y: 0 });
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Chronological (waterfall / timeline) layout
// ---------------------------------------------------------------------------

export interface LayoutTiming {
  id: string;
  start: number | null;
  end: number | null;
}

export interface LayoutBox {
  x: number;
  y: number;
  /** Pixel width proportional to node duration (min: NODE_W). */
  width: number;
  /** True scaled duration without the NODE_W floor — drawn as top-edge bar. */
  barWidth: number;
}

export interface LayoutMeta {
  t0: number;
  pxPerMs: number;
  spanMs: number;
}

export interface ChronologicalLayoutResult {
  positions: Map<string, LayoutBox>;
  meta: LayoutMeta | null;
}

/**
 * Computes a chronological waterfall layout where each node's horizontal
 * position is proportional to its start time and its width reflects its
 * duration.  Nodes without timing info are stacked at the right edge.
 *
 * Pure function: no side effects, deterministic output.
 */
export function computeChronologicalLayout(
  nodes: LayoutTiming[],
): ChronologicalLayoutResult {
  const positions = new Map<string, LayoutBox>();
  const laneY = (lane: number): number => lane * (NODE_H + LANE_GAP);

  const timed = nodes.filter(
    (n): n is LayoutTiming & { start: number } => n.start != null,
  );
  const untimed = nodes.filter((n) => n.start == null);

  if (timed.length === 0) {
    nodes.forEach((n, i) =>
      positions.set(n.id, { x: 0, y: laneY(i), width: NODE_W, barWidth: 0 }),
    );
    return { positions, meta: null };
  }

  const t0 = Math.min(...timed.map((n) => n.start));
  const maxEnd = Math.max(...timed.map((n) => n.end ?? n.start));
  const spanMs = Math.max(0, maxEnd - t0);
  const pxPerMs =
    spanMs > 0
      ? Math.min(
          MAX_PX_PER_MS,
          Math.max(MIN_PX_PER_MS, TARGET_TRACE_WIDTH / spanMs),
        )
      : MAX_PX_PER_MS;

  const sorted = [...timed].sort(
    (a, b) => a.start - b.start || (a.end ?? a.start) - (b.end ?? b.start),
  );

  const lanes: Array<{ rightX: number }> = [];
  for (const n of sorted) {
    const end = n.end ?? n.start;
    const x = (n.start - t0) * pxPerMs;
    const barWidth = (end - n.start) * pxPerMs;
    const width = Math.max(NODE_W, barWidth);
    let laneIdx = lanes.findIndex((l) => x >= l.rightX + MIN_X_GAP);
    if (laneIdx === -1) {
      laneIdx = lanes.length;
      lanes.push({ rightX: -Infinity });
    }
    lanes[laneIdx]!.rightX = x + width;
    positions.set(n.id, { x, y: laneY(laneIdx), width, barWidth });
  }

  const maxRight = Math.max(
    0,
    ...[...positions.values()].map((p) => p.x + p.width),
  );
  const untimedX = maxRight + 120;
  untimed.forEach((n, i) =>
    positions.set(n.id, {
      x: untimedX,
      y: laneY(i),
      width: NODE_W,
      barWidth: 0,
    }),
  );

  return { positions, meta: { t0, pxPerMs, spanMs } };
}
