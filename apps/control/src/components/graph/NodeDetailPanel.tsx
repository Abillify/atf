"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * NodeDetailPanel — slide-in side panel that shows full execution details for
 * a selected graph node. Each node type gets a structured, type-specific
 * display with collapsible sections for input, evaluation, and output data.
 *
 * Requirements: 11.2
 * Split out (Req 9.3, Task 13.4): shared building blocks, parsers and
 * type-specific renderers live under ./nodedetail/, without behavior change.
 */

import { useEffect, useRef } from "react";
import type React from "react";
import {
  nodeTypeColor,
  nodeTypeLabel,
  statusIndicator,
  formatCost,
  type NodeState,
} from "./graphUtils";
import { AccordionSection, KvGrid } from "./nodedetail/Shared";
import {
  ClassifierNodeDetail,
  GenericNodeDetail,
  LlmNodeDetail,
  ParallelNodeDetail,
  RequestNodeDetail,
  ResponseNodeDetail,
  RetrievalNodeDetail,
  RouterNodeDetail,
} from "./nodedetail/NodeDetailRenderers";
import { ErrorRecording, ToolCallEntry } from "./nodedetail/ErrorRecording";
import { CascadeSection } from "./nodedetail/CascadeSection";
import { ProgressSection } from "./nodedetail/ProgressSection";
import { translate, formatNumber, formatTime } from "../../lib/i18n";

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export interface NodeDetailPanelProps {
  state: NodeState;
  onClose: () => void;
}

/**
 * Prominent banner for a node whose run was stopped by an execution budget.
 * The runtime records the stop as a `budget_exceeded` diagnostic (the flow
 * finishes gracefully with the text produced so far, so there is no error);
 * the banner makes that stop visible wherever the node's details render.
 */
function BudgetStopBanner({ state }: { state: NodeState }) {
  const budgetDiag = state.diagnostics?.find(
    (d) => d.code === "budget_exceeded",
  );
  if (budgetDiag === undefined) return null;
  return (
    <div
      role="status"
      data-testid="budget-stop-banner"
      className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-xs font-semibold text-warning"
    >
      {translate("nodeDetailPanel.stoppedByExecutionBudget")}
      {budgetDiag.message !== "" && (
        <p className="mt-1 break-words font-normal">{budgetDiag.message}</p>
      )}
    </div>
  );
}

/**
 * NodeDetailContent — renders node detail body content without a wrapper.
 * Used by the combined sidebar panel (Details tab).
 */
export function NodeDetailContent({ state }: { state: NodeState }) {
  const fmt = (iso?: string | null) =>
    iso ? formatTime(new Date(iso)) : "—";

  function renderTypeDetail() {
    if (state.id === "__request__") return <RequestNodeDetail state={state} />;
    if (state.id === "__response__") return <ResponseNodeDetail state={state} />;
    switch (state.nodeType) {
      case "llm":
        return <LlmNodeDetail state={state} />;
      case "retrieval":
        return <RetrievalNodeDetail state={state} />;
      case "parallel":
        return <ParallelNodeDetail state={state} />;
      case "router":
        return <RouterNodeDetail state={state} />;
      case "classifier":
        return <ClassifierNodeDetail state={state} />;
      case "tool":
      case "memory":
      default:
        return <GenericNodeDetail state={state} />;
    }
  }

  return (
    <div className="space-y-3 text-sm text-foreground">
      {/* Execution-budget stop — when this node's run was cut short by it */}
      <BudgetStopBanner state={state} />

      {/* Timing — always shown */}
      <AccordionSection title={translate("nodeDetailPanel.timing")} defaultOpen>
        <KvGrid
          data={[
            ["Start", fmt(state.start_time)],
            ["End", fmt(state.end_time)],
            [
              "Latency",
              state.latency_ms != null ? `${state.latency_ms} ms` : "—",
            ],
            ...(state.sequence != null
              ? [
                  ["Sequence", `#${state.sequence}`] as [
                    string,
                    React.ReactNode,
                  ],
                ]
              : []),
          ]}
        />
      </AccordionSection>

      {/* Model, Tokens & Cost — when applicable */}
      {(state.model ||
        state.input_tokens != null ||
        state.output_tokens != null ||
        state.cost != null) && (
        <AccordionSection title={translate("nodeDetailPanel.modelTokensCost")} defaultOpen>
          <KvGrid
            data={[
              ...(state.model
                ? [
                    [
                      "Model",
                      <span key="m" className="font-mono">
                        {state.model}
                      </span>,
                    ] as [string, React.ReactNode],
                  ]
                : []),
              ...(state.input_tokens != null
                ? [
                    ["Input tokens", formatNumber(state.input_tokens)] as [
                      string,
                      React.ReactNode,
                    ],
                  ]
                : []),
              ...(state.output_tokens != null
                ? [
                    ["Output tokens", formatNumber(state.output_tokens)] as [
                      string,
                      React.ReactNode,
                    ],
                  ]
                : []),
              ...(state.input_tokens != null && state.output_tokens != null
                ? [
                    [
                      "Total tokens",
                      formatNumber((
                        state.input_tokens + state.output_tokens
                      )),
                    ] as [string, React.ReactNode],
                  ]
                : []),
              ...(state.cost != null
                ? [
                    [
                      "Est. cost",
                      <span key="c" className="font-semibold text-success">
                        {formatCost(state.cost)}
                      </span>,
                    ] as [string, React.ReactNode],
                  ]
                : []),
            ]}
          />
        </AccordionSection>
      )}

      {/* User info — when present */}
      {(state.user_name != null || state.user_prompt != null) && (
        <AccordionSection title={translate("nodeDetailPanel.user")}>
          <div className="space-y-1">
            {state.user_name && <KvGrid data={[["Name", state.user_name]]} />}
            {state.user_prompt && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted p-2 text-xs">
                {state.user_prompt}
              </pre>
            )}
          </div>
        </AccordionSection>
      )}

      {/* Type-specific detail */}
      {renderTypeDetail()}

      {/* Model cascade outcome — when the node ran with a cascade */}
      <CascadeSection cascade={state.cascade} />

      {/* Agent-harness progress — when the node emitted structured progress */}
      <ProgressSection progress={state.progress} />

      {/* Tool Calls — generic (non-retrieval nodes that have tool calls) */}
      {state.tool_calls &&
        state.tool_calls.length > 0 &&
        state.nodeType !== "retrieval" && (
          <AccordionSection title={translate("nodeDetailPanel.toolCallsLength", { length: state.tool_calls.length })}>
            <div className="space-y-2">
              {state.tool_calls.map((tc, i) => (
                <ToolCallEntry key={tc.id ?? i} tc={tc} />
              ))}
            </div>
          </AccordionSection>
        )}

      {/* Error — full recording (type, details, tool result, diagnostics) */}
      <ErrorRecording state={state} />
    </div>
  );
}

export function NodeDetailPanel({ state, onClose }: NodeDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const fmt = (iso?: string | null) =>
    iso ? formatTime(new Date(iso)) : "—";

  /** Selects the appropriate type-specific detail renderer */
  function renderTypeDetail() {
    // Boundary nodes
    if (state.id === "__request__") return <RequestNodeDetail state={state} />;
    if (state.id === "__response__") return <ResponseNodeDetail state={state} />;

    // By node type
    switch (state.nodeType) {
      case "llm":
        return <LlmNodeDetail state={state} />;
      case "retrieval":
        return <RetrievalNodeDetail state={state} />;
      case "parallel":
        return <ParallelNodeDetail state={state} />;
      case "router":
        return <RouterNodeDetail state={state} />;
      case "classifier":
        return <ClassifierNodeDetail state={state} />;
      // tool, memory, agent-harness, transform, trigger, unknown … all use the
      // findings-aware generic renderer (auto-detects findings vs JSON vs text).
      case "tool":
      case "memory":
      default:
        return <GenericNodeDetail state={state} />;
    }
  }

  return (
    <div
      ref={panelRef}
      className="absolute top-2 right-2 z-20 w-96 rounded-xl border border-border bg-card shadow-xl overflow-hidden"
      role="dialog"
      aria-label={translate("nodeDetailPanel.nodeDetailsLabel", { label: state.label })}
    >
      {/* Header */}
      <div
        className={`px-4 py-3 flex items-center justify-between text-on-solid ${nodeTypeColor(state.nodeType)}`}
      >
        <div>
          <div className="font-semibold text-sm truncate max-w-[260px]">
            {state.label}
          </div>
          <div className="flex items-center gap-1.5 text-xs opacity-90">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full border ${statusIndicator(state.status).dot}`}
              aria-hidden
            />
            <span className="capitalize">
              {nodeTypeLabel(state.nodeType)} · {state.status}
            </span>
          </div>
        </div>
        <button type="button"
          onClick={onClose}
          className="rounded-full p-1 hover:bg-card/20 focus:outline-none focus:ring-1 focus:ring-on-solid"
          aria-label={translate("nodeDetailPanel.closeDetailPanel")}
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto text-sm text-foreground">
        {/* Execution-budget stop — when this node's run was cut short by it */}
        <BudgetStopBanner state={state} />

        {/* Timing — always shown */}
        <AccordionSection title={translate("nodeDetailPanel.timing")} defaultOpen>
          <KvGrid
            data={[
              ["Start", fmt(state.start_time)],
              ["End", fmt(state.end_time)],
              [
                "Latency",
                state.latency_ms != null ? `${state.latency_ms} ms` : "—",
              ],
              ...(state.sequence != null
                ? [
                    ["Sequence", `#${state.sequence}`] as [
                      string,
                      React.ReactNode,
                    ],
                  ]
                : []),
            ]}
          />
        </AccordionSection>

        {/* Model, Tokens & Cost — when applicable */}
        {(state.model ||
          state.input_tokens != null ||
          state.output_tokens != null ||
          state.cost != null) && (
          <AccordionSection title={translate("nodeDetailPanel.modelTokensCost")} defaultOpen>
            <KvGrid
              data={[
                ...(state.model
                  ? [
                      [
                        "Model",
                        <span key="m" className="font-mono">
                          {state.model}
                        </span>,
                      ] as [string, React.ReactNode],
                    ]
                  : []),
                ...(state.input_tokens != null
                  ? [
                      ["Input tokens", formatNumber(state.input_tokens)] as [
                        string,
                        React.ReactNode,
                      ],
                    ]
                  : []),
                ...(state.output_tokens != null
                  ? [
                      [
                        "Output tokens",
                        formatNumber(state.output_tokens),
                      ] as [string, React.ReactNode],
                    ]
                  : []),
                ...(state.input_tokens != null && state.output_tokens != null
                  ? [
                      [
                        "Total tokens",
                        formatNumber((
                          state.input_tokens + state.output_tokens
                        )),
                      ] as [string, React.ReactNode],
                    ]
                  : []),
                ...(state.cost != null
                  ? [
                      [
                        "Est. cost",
                        <span
                          key="c"
                          className="font-semibold text-success"
                        >
                          {formatCost(state.cost)}
                        </span>,
                      ] as [string, React.ReactNode],
                    ]
                  : []),
              ]}
            />
          </AccordionSection>
        )}

        {/* User info — when present */}
        {(state.user_name != null || state.user_prompt != null) && (
          <AccordionSection title={translate("nodeDetailPanel.user")}>
            <div className="space-y-1">
              {state.user_name && <KvGrid data={[["Name", state.user_name]]} />}
              {state.user_prompt && (
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted p-2 text-xs">
                  {state.user_prompt}
                </pre>
              )}
            </div>
          </AccordionSection>
        )}

        {/* Type-specific detail */}
        {renderTypeDetail()}

        {/* Model cascade outcome — when the node ran with a cascade */}
        <CascadeSection cascade={state.cascade} />

        {/* Agent-harness progress — when the node emitted structured progress */}
        <ProgressSection progress={state.progress} />

        {/* Tool Calls — generic (non-retrieval nodes that have tool calls) */}
        {state.tool_calls &&
          state.tool_calls.length > 0 &&
          state.nodeType !== "retrieval" && (
            <AccordionSection title={translate("nodeDetailPanel.toolCallsLength", { length: state.tool_calls.length })}>
              <div className="space-y-2">
                {state.tool_calls.map((tc, i) => (
                  <ToolCallEntry key={tc.id ?? i} tc={tc} />
                ))}
              </div>
            </AccordionSection>
          )}

        {/* Error — full recording (type, details, tool result, diagnostics) */}
        <ErrorRecording state={state} />
      </div>
    </div>
  );
}
