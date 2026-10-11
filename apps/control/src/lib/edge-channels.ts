// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Edge data-flow channels for the Studio canvas.
 *
 * A traced run records, for every edge it crossed, WHICH payloads went from
 * source to target (query text, images, tool definitions, produced answers,
 * tool results — see the runtime's `types/edge-flow.ts`). The canvas renders
 * each payload as its own colored parallel line next to the edge's base line;
 * clicking any of them opens the full list in the property panel.
 *
 * This module holds the pure parts — id scheme, colors, German labels and the
 * per-pair lookup — so both the canvas and the tests share one definition.
 */

import type {
  EdgeFlowItemKind,
  EdgeFlowItemStatus,
  EdgeFlowRecord,
} from "./run-samples";

/** Prefix of the synthetic channel edges (display-only, like the overlays). */
export const CHANNEL_EDGE_PREFIX = "edge-channel:";

export const isChannelEdgeId = (id: string): boolean =>
  id.startsWith(CHANNEL_EDGE_PREFIX);

/** Id of the `index`-th channel line of the logical edge `logicalId`. */
export const channelEdgeId = (logicalId: string, index: number): string =>
  `${CHANNEL_EDGE_PREFIX}${logicalId}::${index}`;

/** The logical edge a channel line belongs to (base or boundary edge id). */
export const channelLogicalEdgeId = (id: string): string =>
  id.slice(CHANNEL_EDGE_PREFIX.length, id.lastIndexOf("::"));

/** Pair key of an edge — the lookup key of the per-run flow records. */
export const pairKey = (source: string, target: string): string =>
  `${source}\u0000${target}`;

/** One color per payload kind — the parallel lines must stay distinguishable. */
export const CHANNEL_COLORS: Record<EdgeFlowItemKind, string> = {
  text: "var(--edge-used)",
  image: "var(--edge-active)",
  tool: "var(--edge-parallel)",
  data: "var(--info-solid)",
};

/** German kind names for the property panel's data list. */
export const CHANNEL_KIND_LABEL: Record<EdgeFlowItemKind, string> = {
  text: "Text",
  image: "Bild",
  tool: "Werkzeug",
  data: "Daten",
};

/** German status names: what happened to the payload on this edge. */
export const CHANNEL_STATUS_LABEL: Record<EdgeFlowItemStatus, string> = {
  passed: "weitergegeben",
  produced: "erzeugt",
  consumed: "verbraucht",
};

/** Tailwind classes of the status badge in the data list. */
export const CHANNEL_STATUS_BADGE: Record<EdgeFlowItemStatus, string> = {
  passed: "bg-info-soft text-info border-info-border",
  produced: "bg-success-soft text-success border-success-border",
  consumed: "bg-warning-soft text-warning border-warning-border",
};

/**
 * Newest record per (source, target): a looped edge is traversed several
 * times; the canvas renders the LAST traversal, which is what the operator
 * sees as the current state of the line.
 */
export function latestFlowsByPair(
  records: readonly EdgeFlowRecord[],
): Map<string, EdgeFlowRecord> {
  const map = new Map<string, EdgeFlowRecord>();
  for (const record of records) {
    const key = pairKey(record.source, record.target);
    const current = map.get(key);
    if (current === undefined || record.sequence >= current.sequence) {
      map.set(key, record);
    }
  }
  return map;
}
