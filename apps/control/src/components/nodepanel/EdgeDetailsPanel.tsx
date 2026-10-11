"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: the edge selection type and
 * edge editing (condition, label, delete, data flow of the tracked run).
 * Taken over verbatim, without behavior change.
 */

import type React from "react";
import { Button } from "../../lib/ui";
import { FormulaInput, FormulaTextarea } from "../FormulaEditor";
import type { EdgeFlowItem, EdgeFlowRecord } from "../../lib/run-samples";
import {
  CHANNEL_COLORS,
  CHANNEL_KIND_LABEL,
  CHANNEL_STATUS_BADGE,
  CHANNEL_STATUS_LABEL,
} from "../../lib/edge-channels";
import { Field, inputCls } from "../form-controls";
import { formatNumber } from "../../lib/i18n";

export interface EdgeSelection {
  id: string;
  conditions: string;
  label: string;
  /**
   * Data flow of the traced run over this edge (newest traversal). The panel
   * lists every payload with its type and content. Empty/undefined when the
   * edge wasn't part of a traced run.
   */
  flows?: EdgeFlowRecord[];
  /** Implicit start/end link: shown read-only (it is not part of the flow). */
  readOnly?: boolean;
}

/**
 * One payload of the traced run's edge data flow: colored kind dot, label,
 * status badge and the content (images: media type/size/reference instead).
 */
function EdgeFlowItemRow({ item }: { item: EdgeFlowItem }): React.JSX.Element {
  const meta =
    item.kind === "image"
      ? [item.media_type, item.bytes !== undefined ? `${formatNumber(item.bytes)} Bytes` : undefined]
          .filter((s): s is string => s !== undefined)
          .join(" · ")
      : item.kind === "tool" && item.tool_name !== undefined
        ? item.tool_name
        : "";
  return (
    <li className="rounded border border-border bg-muted/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: CHANNEL_COLORS[item.kind] }}
        />
        <span className="truncate text-xs font-medium text-foreground" title={item.label}>
          {item.label}
        </span>
        <span
          className={`ml-auto shrink-0 rounded border px-1 py-px text-[10px] ${CHANNEL_STATUS_BADGE[item.status]}`}
        >
          {CHANNEL_STATUS_LABEL[item.status]}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {CHANNEL_KIND_LABEL[item.kind]}
        </span>
      </div>
      {meta !== "" && (
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={meta}>
          {meta}
        </div>
      )}
      {item.content !== undefined && item.content !== "" && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 px-1.5 py-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {item.content}
        </pre>
      )}
    </li>
  );
}

/**
 * Req 9.3: edge editing, formerly the `edge !== null` branch of
 * NodePropertyPanel, moved here unchanged.
 */
export function EdgeDetailsPanel({
  edge,
  onEdgeChange,
  onDeleteEdge,
}: {
  edge: EdgeSelection;
  onEdgeChange: (edge: EdgeSelection) => void;
  onDeleteEdge: (id: string) => void;
}): React.JSX.Element {
  const flow = edge.flows?.[edge.flows.length - 1];
  return (
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Edge</h4>
        {edge.readOnly ? (
          <p className="text-xs text-muted-foreground">
            Impliziter Start-/Ende-Übergang — gehört nicht zur Flow-Definition
            und kann nicht bearbeitet werden.
          </p>
        ) : (
          <>
            <Field
              label="Condition (routing expression)"
              hint="Empty = unconditional edge."
            >
              <FormulaTextarea
                kind="condition"
                ariaLabel="Condition (routing expression)"
                title="Edge condition"
                className={`${inputCls} resize-y font-mono text-xs`}
                rows={3}
                value={edge.conditions}
                placeholder="classification.route == 'RETOURE'"
                onChange={(v) => onEdgeChange({ ...edge, conditions: v })}
              />
            </Field>
            <Field label="Label">
              <FormulaInput
                kind="vars"
                ariaLabel="Edge label"
                className={inputCls}
                value={edge.label}
                onChange={(v) => onEdgeChange({ ...edge, label: v })}
              />
            </Field>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onDeleteEdge(edge.id)}
            >
              Delete edge
            </Button>
          </>
        )}
        {flow !== undefined && flow.items.length > 0 && (
          <section aria-label="Weitergegebene Daten" className="space-y-1.5">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Weitergegebene Daten
            </h5>
            <p className="text-[11px] text-muted-foreground">
              Beim letzten Run über diese Kante ({flow.source} → {flow.target}).
            </p>
            <ul className="space-y-1.5">
              {flow.items.map((item, index) => (
                <EdgeFlowItemRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: items have no id; the recorded order is fixed per traversal
                  key={`${index}:${item.kind}:${item.status}:${item.label}:${item.tool_name ?? ""}`}
                  item={item}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
  );
}
