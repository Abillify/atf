// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Edge data-flow records (`src/types/edge-flow.ts`)
 *
 * When a flow runs, data moves along the graph edges: the user query, images,
 * tool definitions, transcribed text, retrieval results. The Studio canvas
 * visualises this as colored parallel channel lines between nodes, and the
 * property panel lists the concrete payloads that crossed an edge.
 *
 * The runtime — not the frontend — is the source of truth: the engine knows
 * exactly which state crossed from node A to node B when the graph advanced
 * (conditional routers receive the full state; unconditional edges are known
 * from the flow definition). One {@link EdgeFlowRecord} is captured per edge
 * traversal; a loop over the same edge produces multiple records and the
 * consumer keeps the last one.
 *
 * Size contract mirrors the debug trace: metadata (kind, label, status, refs,
 * byte counts) is complete; free text in {@link EdgeFlowItem.content} is
 * byte-bounded on ingest (`monitoring/debug-trace-limits.ts`,
 * `DebugTraceLimits.edgeFlowBytes`).
 *
 * No `any` at module boundaries.
 */

/** What kind of payload crossed the edge. */
export type EdgeFlowItemKind = "text" | "image" | "tool" | "data";

/**
 * Lifecycle of an item on this edge:
 * - `passed`   — already present before the source node ran, forwarded onward
 *                (e.g. the user query, client tools).
 * - `produced` — created by the source node and handed to the target
 *                (e.g. a transcription, a retrieval result).
 * - `consumed` — the source node consumed it and it is NOT forwarded further
 *                (e.g. an image replaced by its transcription). Recorded on
 *                the edge INTO the consuming node so the canvas can drop the
 *                image channel after that node.
 */
export type EdgeFlowItemStatus = "passed" | "produced" | "consumed";

/** One payload item that crossed (or was consumed at) a graph edge. */
export interface EdgeFlowItem {
  kind: EdgeFlowItemKind;
  /** Human-readable channel label, e.g. "Query", "Bild", "Werkzeuge (3)". */
  label: string;
  /** Status of this item on this edge. */
  status: EdgeFlowItemStatus;
  /** Bounded excerpt of the payload text (text/data/tool-result items). */
  content?: string;
  /** MIME type for image items. */
  media_type?: string;
  /** Registry ref for image items (`img-N`), resolvable via the media store. */
  ref?: string;
  /** Byte size for image items. */
  bytes?: number;
  /** Tool name for tool items. */
  tool_name?: string;
}

/** Data that crossed one edge traversal during a run. */
export interface EdgeFlowRecord {
  /** Logical source id: node id or `__start__`. */
  source: string;
  /** Logical target id: node id or `__end__`. */
  target: string;
  /** Global edge counter (1-based) — order of traversals in the run. */
  sequence: number;
  /** Payload items observed on this traversal. */
  items: EdgeFlowItem[];
}
