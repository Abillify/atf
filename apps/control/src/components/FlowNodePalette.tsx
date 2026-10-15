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
import { translate } from "../lib/i18n";

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

/** Built per render so the labels follow the active language. */
function nodeCatalog(): PaletteEntry[] {
  return [
  {
    type: "llm",
    label: translate("flowNodePalette.node.LLM"),
    description: translate("flowNodePalette.node.LLMDescription"),
  },
  {
    type: "tool",
    label: translate("flowNodePalette.node.tool"),
    description: translate("flowNodePalette.node.toolDescription"),
  },
  {
    type: "router",
    label: translate("flowNodePalette.node.router"),
    description: translate("flowNodePalette.node.routerDescription"),
  },
  {
    type: "classifier",
    label: translate("flowNodePalette.node.classifier"),
    description: translate("flowNodePalette.node.classifierDescription"),
  },
  {
    type: "parallel",
    label: translate("flowNodePalette.node.parallel"),
    description: translate("flowNodePalette.node.parallelDescription"),
  },
  {
    type: "retrieval",
    label: translate("flowNodePalette.node.retrieval"),
    description: translate("flowNodePalette.node.retrievalDescription"),
  },
  {
    type: "memory",
    label: translate("flowNodePalette.node.memory"),
    description: translate("flowNodePalette.node.memoryDescription"),
  },
  {
    type: "agent-harness",
    label: translate("flowNodePalette.node.agentHarness"),
    description: translate("flowNodePalette.node.agentHarnessDescription"),
  },
  {
    type: "transform",
    label: translate("flowNodePalette.node.transform"),
    description: translate("flowNodePalette.node.transformDescription"),
  },
  {
    type: "assistant-context",
    label: translate("flowNodePalette.node.assistantContext"),
    description: translate("flowNodePalette.node.assistantContextDescription"),
  },
  {
    type: "assistant-learn",
    label: translate("flowNodePalette.node.assistantLearn"),
    description: translate("flowNodePalette.node.assistantLearnDescription"),
  },
  ];
}

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
    const catalog = nodeCatalog();
    if (!q) return catalog;
    return catalog.filter(
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
        {nodeCatalog().map((n) => (
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
            title={translate("flowNodePalette.labelDescriptionDragOrDouble", { label: n.label, description: n.description })}
            aria-label={translate("flowNodePalette.addLabelNode", { label: n.label })}
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
        placeholder={translate("flowNodePalette.searchNodes")}
        aria-label={translate("flowNodePalette.searchNodePalette")}
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
            title={translate("flowNodePalette.descriptionDragOntoTheCanvas", { description: n.description })}
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
            {translate("flowNodePalette.noMatches")}
          </p>
        )}
      </div>
    </div>
  );
}
