"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowNodePalette — searchable, draggable node catalog for the Studio builder.
 *
 * Replaces the old "+ Add node…" dropdown with the drag-and-drop convention
 * every competing flow builder (n8n, Zapier, Make) uses: drag a card onto the
 * canvas to place a node there, or double-click to append it at a default
 * position. `FlowCanvas` reads the `application/x-aiperator-node-type`
 * dataTransfer payload on drop and reports the drop position in flow
 * coordinates via `onDropNodeType`.
 */

import type React from "react";
import { useMemo, useState } from "react";
import type { NodeType } from "../types/flow";
import { type SubflowActions, SubflowPalette } from "./SubflowPalette";
import { nodeTypeColor } from "./graph/graphUtils";
import { nodeTypeIcon } from "./graph/nodeIcons";

export interface FlowNodePaletteProps {
  onAddNode: (type: NodeType) => void;
  /** Sub-flow actions (file flows with write access only). */
  subflows?: SubflowActions | undefined;
  /** Icon-only rail (still draggable) to leave more room for the canvas. */
  collapsed?: boolean;
  /** Stretch to the container width (the Studio sidebar's Nodes section)
      instead of the fixed rail width used left of the canvas. */
  fullWidth?: boolean;
}

interface PaletteEntry {
  type: NodeType;
  label: string;
  description: string;
}

const NODE_CATALOG: PaletteEntry[] = [
  {
    type: "llm",
    label: "LLM",
    description: "Streaming model call with an optional tool loop",
  },
  {
    type: "tool",
    label: "Tool",
    description: "Deterministic MCP tool invocation",
  },
  {
    type: "router",
    label: "Router",
    description: "Routing-only — evaluates outgoing edge conditions",
  },
  {
    type: "classifier",
    label: "Classifier",
    description: "Structured output; writes state.classification",
  },
  {
    type: "parallel",
    label: "Parallel",
    description: "Fan-out to concurrently executed child nodes",
  },
  {
    type: "retrieval",
    label: "Retrieval",
    description: "RAG — embeds the query and fetches grounding context",
  },
  {
    type: "memory",
    label: "Memory",
    description: "Recalls long-term memories for personalisation",
  },
  {
    type: "agent-harness",
    label: "Agent harness",
    description: "Planner/worker loop with budgets, verification and delegation",
  },
  {
    type: "transform",
    label: "Transform",
    description: "Deterministic derive/extract rules on the flow state",
  },
  {
    type: "assistant-context",
    label: "Assistant context",
    description: "Loads a per-user assistant's context into the run",
  },
  {
    type: "assistant-learn",
    label: "Assistant learn",
    description: "Writes learnings back to the per-user assistant",
  },
];

/** The node type's icon on its canvas colour, as the card on the canvas shows it. */
function PaletteIcon({ type }: { type: NodeType }): React.JSX.Element {
  const Icon = nodeTypeIcon(type);
  return (
    <span
      aria-hidden
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-on-solid ${nodeTypeColor(type)}`}
    >
      <Icon size={13} strokeWidth={2.25} />
    </span>
  );
}

export const PALETTE_DND_TYPE = "application/x-aiperator-node-type";

export function FlowNodePalette({
  onAddNode,
  collapsed = false,
  subflows,
  fullWidth = false,
}: FlowNodePaletteProps): React.JSX.Element {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NODE_CATALOG;
    return NODE_CATALOG.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q) ||
        n.description.toLowerCase().includes(q),
    );
  }, [query]);

  if (collapsed) {
    return (
      <div className="flex h-full w-9 shrink-0 flex-col items-center gap-1 overflow-auto">
        {subflows && <SubflowPalette actions={subflows} collapsed />}
        {NODE_CATALOG.map((n) => (
          /* biome-ignore lint/a11y/useSemanticElements: draggable palette item with block layout content; <button> cannot host the drag payload markup and would fight the HTML5 drag API */
          <div
            key={n.type}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PALETTE_DND_TYPE, n.type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onDoubleClick={() => onAddNode(n.type)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAddNode(n.type);
            }}
            title={`${n.label} — ${n.description} (drag or double-click)`}
            aria-label={`Add ${n.label} node`}
            className="flex h-8 w-8 cursor-grab select-none items-center justify-center rounded-md border border-border bg-card text-sm hover:bg-accent/10 active:cursor-grabbing"
          >
            <PaletteIcon type={n.type} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`flex ${fullWidth ? "w-full" : "h-full w-56 shrink-0"} flex-col gap-2`}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search nodes…"
        aria-label="Search node palette"
        className="rounded border border-border bg-card px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex-1 space-y-1.5 overflow-auto pr-0.5">
        {subflows && !query.trim() && <SubflowPalette actions={subflows} />}
        {filtered.map((n) => (
          /* biome-ignore lint/a11y/useSemanticElements: draggable palette item with block layout content; <button> cannot host the drag payload markup and would fight the HTML5 drag API */
          <div
            key={n.type}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PALETTE_DND_TYPE, n.type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onDoubleClick={() => onAddNode(n.type)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAddNode(n.type);
            }}
            title={`${n.description} — drag onto the canvas or double-click to add`}
            className="cursor-grab select-none rounded-md border border-border bg-card px-2 py-1.5 text-xs transition-colors hover:border-accent/40 hover:bg-accent/10 active:cursor-grabbing"
          >
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <PaletteIcon type={n.type} />
              {n.label}
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
              {n.description}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="py-4 text-center text-[11px] text-muted-foreground">
            No matches.
          </p>
        )}
      </div>
    </div>
  );
}
