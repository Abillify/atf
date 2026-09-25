"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property panel for the canvas's Start / End (lib/flow-boundaries): what a
 * request brings into the flow and what the flow returns — from the pinned
 * run and from the run currently traced in Run & Trace.
 */

import type React from "react";
import type { FlowBoundaries } from "../lib/flow-boundaries";
import type { PinnedRun } from "../lib/run-samples";
import { answerText } from "../lib/run-attach";
import { RunPicker, type RunsContext } from "./FormulaEditor";
import type { NodeState } from "./graph/graphUtils";

export interface BoundaryPanelProps {
  kind: "start" | "end";
  boundaries: FlowBoundaries;
  /** Pinned run of this flow and how to change it (absent for an unsaved flow). */
  runs?: RunsContext;
  /** The traced run's request (`start`) or response (`end`) boundary. */
  current?: NodeState;
  onSelectNode?: (id: string) => void;
}

/** Context fields of the sample, in reading order, with their labels. */
const CONTEXT_FIELDS: Array<[key: string, label: string]> = [
  ["userName", "User"],
  ["userEmail", "E-mail"],
  ["userId", "User id"],
  ["role", "Role"],
  ["plan", "Plan"],
  ["language", "Language"],
  ["clientId", "Client"],
  ["chatId", "Chat"],
];

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-1.5 border-t border-border pt-3">
      <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h5>
      {children}
    </section>
  );
}

function Text({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    // The label sits on the section: <pre> has no role that carries a name.
    <section
      aria-label={label}
      className="max-h-56 overflow-auto rounded border border-border bg-muted p-2 text-[11px] text-foreground"
    >
      <pre className="whitespace-pre-wrap break-words">{value}</pre>
    </section>
  );
}

function NodeLink({ id, onSelect }: { id: string; onSelect?: ((id: string) => void) | undefined }): React.JSX.Element {
  return onSelect ? (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className="rounded bg-muted px-1 font-mono text-[11px] text-foreground hover:underline"
    >
      {id}
    </button>
  ) : (
    <code className="rounded bg-muted px-1 font-mono text-[11px]">{id}</code>
  );
}

function StartInput({ pinned }: { pinned: PinnedRun }): React.JSX.Element {
  const s = pinned.sample;
  const context = (s["context"] ?? {}) as Record<string, unknown>;
  const rows = CONTEXT_FIELDS.filter(([k]) => context[k] !== undefined && context[k] !== "");
  const claims = context["claims"];
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-0.5 flex items-baseline justify-between text-[11px]">
          <code className="font-mono text-foreground">{"{{query}}"}</code>
          {typeof s["messageCount"] === "number" && (
            <span className="text-muted-foreground">{s["messageCount"]} message(s) in the request</span>
          )}
        </div>
        <Text value={String(s["query"] ?? "")} label="Pinned query" />
      </div>
      {rows.length > 0 && (
        <table className="w-full text-[11px]">
          <tbody>
            {rows.map(([k, label]) => (
              <tr key={k} className="align-top">
                <td className="py-0.5 pr-2 text-muted-foreground" title={`{{context.${k}}}`}>
                  {label}
                </td>
                <td className="break-all py-0.5 font-mono text-foreground">{String(context[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {claims !== undefined && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">Token claims ({"{{context.claims}}"})</summary>
          <Text value={JSON.stringify(claims, null, 2)} label="Token claims" />
        </details>
      )}
    </div>
  );
}

export function BoundaryPanel({ kind, boundaries, runs, current, onSelectNode }: BoundaryPanelProps): React.JSX.Element {
  const pinned = runs?.pinned ?? null;
  const start = kind === "start";
  const currentText = start
    ? (current?.user_prompt ?? current?.prompt)
    : current?.response !== undefined
      ? answerText(current.response)
      : undefined;

  return (
    <div className="space-y-3" data-testid={`boundary-panel-${kind}`}>
      <div>
        <h4 className="text-sm font-semibold text-foreground">{start ? "▶ Start" : "■ End"}</h4>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {start
            ? "Where a chat request enters the flow. Not a node of the flow — drawn so the entry is visible."
            : "Where the flow hands its answer back to the caller. Not a node of the flow."}
        </p>
      </div>

      {start ? (
        <div className="text-[11px] text-foreground">
          {boundaries.entryId === null ? (
            <span className="text-muted-foreground">The flow has no nodes yet.</span>
          ) : (
            <>
              Runs start at <NodeLink id={boundaries.entryId} onSelect={onSelectNode} />
              <span className="text-muted-foreground">
                {" "}— the first node of the flow. Drag from Start to another node to make that the entry.
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-1 text-[11px] text-foreground">
          {boundaries.exits.length === 0 ? (
            <span className="text-muted-foreground">No node ends the run — check the flow for loops.</span>
          ) : (
            <>
              <div>The run can end after:</div>
              <ul className="space-y-0.5 pl-3">
                {boundaries.exits.map((x) => (
                  <li key={x.nodeId}>
                    <NodeLink id={x.nodeId} onSelect={onSelectNode} />{" "}
                    <span className="text-muted-foreground">
                      {x.kind === "last" ? "— no outgoing edge" : "— when none of its edge conditions matches"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">Its last assistant message is the answer.</p>
            </>
          )}
        </div>
      )}

      {currentText !== undefined && currentText !== "" && (
        <Section title={start ? "Current run — request" : "Current run — answer"}>
          <Text value={currentText} label={start ? "Current request" : "Current answer"} />
        </Section>
      )}

      <Section title={start ? "Pinned request — input" : "Pinned request — answer"}>
        {runs && <RunPicker runs={runs} className="" />}
        {!runs ? (
          <p className="text-[11px] text-muted-foreground">Save the flow to pin recorded requests.</p>
        ) : !pinned ? (
          <p className="text-[11px] text-muted-foreground">
            Pin a recorded request to see {start ? "what it brought into the flow" : "what the flow answered"}.
          </p>
        ) : start ? (
          <StartInput pinned={pinned} />
        ) : pinned.response !== undefined ? (
          <div className="space-y-1">
            {pinned.responseNodeId && (
              <div className="text-[11px] text-muted-foreground">
                Answered by <NodeLink id={pinned.responseNodeId} onSelect={onSelectNode} />
              </div>
            )}
            <Text value={pinned.response} label="Pinned answer" />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            This pin has no recorded answer (pinned before answers were kept, or the run returned none) — pin it
            again to fetch it.
          </p>
        )}
      </Section>
    </div>
  );
}
