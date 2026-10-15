"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property panel for the canvas's Start / End (lib/flow-boundaries): what a
 * request brings into the flow and what the flow returns — from the pinned
 * run and from the run currently traced in Run & Trace.
 *
 * Start with a run (traced or pinned) shows that run's whole input: the
 * request's messages, the values templates and conditions see, and the
 * request metadata (session, user, claims, …) from the run's debug trace.
 */

import type React from "react";
import { useEffect, useState } from "react";
import type { FlowBoundaries } from "../lib/flow-boundaries";
import {
  fetchRunSample,
  fetchRunTrace,
  type PinnedRun,
  type RunTrace,
  type RunTraceMessage,
} from "../lib/run-samples";
import { answerText } from "../lib/run-attach";
import { RunPicker, type RunsContext } from "./FormulaEditor";
import type { NodeState } from "./graph/graphUtils";
import { translate, formatDateTime } from "../lib/i18n";

export interface BoundaryPanelProps {
  kind: "start" | "end";
  boundaries: FlowBoundaries;
  /** Pinned run of this flow and how to change it (absent for an unsaved flow). */
  runs?: RunsContext;
  /** The traced run's request (`start`) or response (`end`) boundary. */
  current?: NodeState;
  /** Execution of the run traced in Run & Trace (Start shows its input). */
  runExecutionId?: string | null;
  /** Bearer token for loading a run's trace (defaults to the one in `runs`). */
  token?: string | undefined;
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
const CONTEXT_LABELS = new Map(CONTEXT_FIELDS);

/** Trace metadata fields with a readable label; the rest show their key. */
const TRACE_CONTEXT_LABELS: Record<string, string> = {
  chat_id: "Chat",
  session_id: "Session",
  conversation_id: "Conversation",
  thread_key: "Thread",
  message_id: "Message",
  user_id: "User id",
  user_email: "E-mail",
  user_name: "User",
  client_id: "Client",
  language: "Language",
  role: "Role",
  plan: "Plan",
  trace_id: "Trace",
};

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

function Json({ value, label }: { value: unknown; label: string }): React.JSX.Element {
  return <Text value={JSON.stringify(value, null, 2)} label={label} />;
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

/** Key/value rows (values shown as text; objects as compact JSON). */
function KeyValues({ rows }: { rows: Array<{ key: string; label: string; value: unknown; hint?: string }> }): React.JSX.Element {
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="align-top">
            <td className="whitespace-nowrap py-0.5 pr-2 text-muted-foreground" title={r.hint ?? r.key}>
              {r.label}
            </td>
            <td className="break-all py-0.5 font-mono text-foreground">
              {typeof r.value === "object" && r.value !== null ? JSON.stringify(r.value) : String(r.value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/** The values templates (`{{query}}`, `{{context.*}}`) and conditions see. */
function StartInput({ sample, labelPrefix }: { sample: Record<string, unknown>; labelPrefix: string }): React.JSX.Element {
  const context = (sample["context"] ?? {}) as Record<string, unknown>;
  const known = CONTEXT_FIELDS.filter(([k]) => present(context[k])).map(([k, label]) => ({
    key: k,
    label,
    value: context[k],
    hint: translate("boundaryPanel.contextK", { k }),
  }));
  const others = Object.keys(context)
    .filter((k) => k !== "claims" && !CONTEXT_LABELS.has(k) && present(context[k]))
    .sort()
    .map((k) => ({ key: k, label: k, value: context[k], hint: translate("boundaryPanel.contextK", { k }) }));
  const rows = [...known, ...others];
  const claims = context["claims"];
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-0.5 flex items-baseline justify-between text-[11px]">
          <code className="font-mono text-foreground">{"{{query}}"}</code>
          {typeof sample["messageCount"] === "number" && (
            <span className="text-muted-foreground">{sample["messageCount"]} {translate("boundaryPanel.messageSInTheRequest")}</span>
          )}
        </div>
        <Text value={String(sample["query"] ?? "")} label={`${labelPrefix} query`} />
      </div>
      {rows.length > 0 && <KeyValues rows={rows} />}
      {claims !== undefined && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">{translate("boundaryPanel.tokenClaims")}{translate("boundaryPanel.contextClaims")})</summary>
          <Json value={claims} label={translate("boundaryPanel.tokenClaims2")} />
        </details>
      )}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted-foreground">{translate("boundaryPanel.allTemplateConditionValues")}</summary>
        <Json value={sample} label={translate("boundaryPanel.templateAndConditionValues")} />
      </details>
    </div>
  );
}

function messageText(content: RunTraceMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (p !== null && typeof p === "object") {
        if ("text" in p) return String((p as { text: unknown }).text);
        if ("type" in p) return `[${String((p as { type: unknown }).type)}]`;
      }
      return "";
    })
    .filter((s) => s !== "")
    .join("\n");
}

const ROLE_BADGE: Record<string, string> = {
  system: "bg-muted-foreground/15 text-muted-foreground",
  user: "bg-info-solid/15 text-info",
  assistant: "bg-info-solid/15 text-info",
  tool: "bg-subflow-solid/15 text-subflow",
};

function RequestMessages({ messages }: { messages: RunTraceMessage[] }): React.JSX.Element {
  if (messages.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{translate("boundaryPanel.theRequestCarriedNoMessages")}</p>;
  }
  return (
    <ol className="space-y-2">
      {messages.map((m, i) => {
        const text = messageText(m.content);
        const body = (
          <>
            {text !== "" && <Text value={text} label={translate("boundaryPanel.messageValueRole", { value: i + 1, role: m.role })} />}
            {(m.tool_calls ?? []).map((tc) => (
              <div key={tc.id} className="text-[11px] text-muted-foreground">
                {translate("boundaryPanel.calls")} <code className="font-mono text-foreground">{tc.function.name}</code>
                {tc.function.arguments && <span className="break-all font-mono"> {tc.function.arguments}</span>}
              </div>
            ))}
          </>
        );
        const header = (
          <span className="flex items-center gap-1.5 text-[11px]">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${ROLE_BADGE[m.role] ?? "bg-muted"}`}>
              {m.role}
            </span>
            {m.name && <span className="text-muted-foreground">{m.name}</span>}
            {m.tool_call_id && <code className="font-mono text-[10px] text-muted-foreground">{m.tool_call_id}</code>}
          </span>
        );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: messages have no id; the order is fixed
          <li key={i} className="space-y-1">
            {m.role === "system" ? (
              <details>
                <summary className="cursor-pointer">{header}</summary>
                <div className="mt-1 space-y-1">{body}</div>
              </details>
            ) : (
              <>
                {header}
                {body}
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function formatTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d);
}

function TraceMetadata({ trace }: { trace: RunTrace }): React.JSX.Element {
  const run = [
    { key: "execution_id", label: translate("boundaryPanel.execution"), value: trace.execution_id },
    { key: "flow_id", label: translate("boundaryPanel.flow"), value: trace.flow_id },
    { key: "flow_version", label: translate("boundaryPanel.flowVersion"), value: trace.flow_version },
    { key: "status", label: translate("boundaryPanel.status"), value: trace.status },
    { key: "started_at", label: translate("boundaryPanel.started"), value: formatTime(trace.started_at) },
    { key: "finished_at", label: translate("boundaryPanel.finished"), value: formatTime(trace.finished_at) },
  ].filter((r) => present(r.value));
  const ctx = trace.context ?? {};
  const { jwt_claims: jwtClaims } = ctx;
  const context = Object.keys(ctx)
    .filter((k) => k !== "jwt_claims" && present(ctx[k]))
    .sort((a, b) => {
      const order = Object.keys(TRACE_CONTEXT_LABELS);
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.localeCompare(b);
    })
    .map((k) => ({ key: k, label: TRACE_CONTEXT_LABELS[k] ?? k, value: ctx[k] }));
  return (
    <div className="space-y-2">
      <KeyValues rows={[...run, ...context]} />
      {jwtClaims !== undefined && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">{translate("boundaryPanel.tokenClaimsJwtClaims")}</summary>
          <Json value={jwtClaims} label={translate("boundaryPanel.traceTokenClaims")} />
        </details>
      )}
    </div>
  );
}

type Loaded<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

/** Loads a run's trace (and its sample values when not already at hand). */
function useRunInput(
  executionId: string,
  token: string | undefined,
  needSample: boolean,
  refreshKey: string | undefined,
): { trace: Loaded<RunTrace>; sample: Record<string, unknown> | null } {
  const [trace, setTrace] = useState<Loaded<RunTrace>>({ state: "loading" });
  const [sample, setSample] = useState<Record<string, unknown> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-fetches when the run moves on
  useEffect(() => {
    let alive = true;
    setTrace((t) => (t.state === "ok" && t.value.execution_id === executionId ? t : { state: "loading" }));
    fetchRunTrace(executionId, token).then(
      (value) => alive && setTrace({ state: "ok", value }),
      (e: unknown) => alive && setTrace({ state: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    if (needSample) {
      fetchRunSample(executionId, token).then(
        (r) => alive && setSample(r.sample),
        () => alive && setSample(null),
      );
    }
    return () => {
      alive = false;
    };
  }, [executionId, token, needSample, refreshKey]);
  return { trace, sample };
}

/** Everything a run brought into the flow. */
function RunInput({
  executionId,
  pinnedSample,
  labelPrefix,
  token,
  refreshKey,
}: {
  executionId: string;
  pinnedSample?: Record<string, unknown> | undefined;
  labelPrefix: string;
  token: string | undefined;
  refreshKey?: string | undefined;
}): React.JSX.Element {
  const { trace, sample: fetched } = useRunInput(executionId, token, pinnedSample === undefined, refreshKey);
  const sample = pinnedSample ?? fetched;
  return (
    <div className="space-y-3" data-testid="start-run-input">
      <Section
        title={
          trace.state === "ok"
            ? translate("boundaryPanel.requestLengthMessageS", { length: trace.value.input_messages.length })
            : translate("boundaryPanel.request")
        }
      >
        {trace.state === "loading" && <p className="text-[11px] text-muted-foreground">{translate("boundaryPanel.loadingTheRunSRequest")}</p>}
        {trace.state === "error" && (
          <p className="text-[11px] text-muted-foreground">
            {translate("boundaryPanel.theRunSFullTrace", { message: trace.message })}{sample ? translate("boundaryPanel.theRecordedInputValuesAre") : "."}
          </p>
        )}
        {trace.state === "ok" && <RequestMessages messages={trace.value.input_messages} />}
      </Section>

      {sample && (
        <Section title={translate("boundaryPanel.inputValues")}>
          <StartInput sample={sample} labelPrefix={labelPrefix} />
        </Section>
      )}

      {trace.state === "ok" && (
        <Section title={translate("boundaryPanel.metadata")}>
          <TraceMetadata trace={trace.value} />
        </Section>
      )}
    </div>
  );
}

export function BoundaryPanel({
  kind,
  boundaries,
  runs,
  current,
  runExecutionId,
  token,
  onSelectNode,
}: BoundaryPanelProps): React.JSX.Element {
  const pinned: PinnedRun | null = runs?.pinned ?? null;
  const start = kind === "start";
  const authToken = token ?? runs?.token;
  const currentText = start
    ? (current?.user_prompt ?? current?.prompt)
    : current?.response !== undefined
      ? answerText(current.response)
      : undefined;

  // Start: whose input to show — the traced run first, else the pinned one.
  const currentId = runExecutionId ?? null;
  const [source, setSource] = useState<"current" | "pinned">("current");
  useEffect(() => {
    if (currentId) setSource("current");
  }, [currentId]);
  const showCurrent = currentId !== null && (source === "current" || !pinned);
  const inputRun: { id: string; label: string; sample?: Record<string, unknown> } | null = !start
    ? null
    : showCurrent && currentId !== null
      ? { id: currentId, label: translate("boundaryPanel.current"), ...(pinned?.executionId === currentId ? { sample: pinned.sample } : {}) }
      : pinned
        ? { id: pinned.executionId, label: translate("boundaryPanel.pinned"), sample: pinned.sample }
        : null;
  const bothSources = start && currentId !== null && pinned !== null && pinned.executionId !== currentId;

  return (
    <div className="space-y-3" data-testid={`boundary-panel-${kind}`}>
      <div>
        <h4 className="text-sm font-semibold text-foreground">
          {start ? (inputRun ? translate("boundaryPanel.startRunInput") : translate("boundaryPanel.start")) : translate("boundaryPanel.end")}
        </h4>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {start
            ? inputRun
              ? translate("boundaryPanel.whatTheValueRunBrought", { value: inputRun.label.toLowerCase() })
              : translate("boundaryPanel.whereAChatRequestEnters")
            : translate("boundaryPanel.whereTheFlowHandsIts")}
        </p>
      </div>

      {bothSources && (
        <fieldset className="flex gap-0.5 rounded-md border border-border p-0.5 text-[11px]">
          <legend className="sr-only">{translate("boundaryPanel.showTheInputOf")}</legend>
          {(["current", "pinned"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={source === s}
              onClick={() => setSource(s)}
              className={`flex-1 rounded px-2 py-0.5 ${
                source === s ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {s === "current" ? translate("boundaryPanel.currentRun") : translate("boundaryPanel.pinnedRun")}
            </button>
          ))}
        </fieldset>
      )}

      {inputRun && (
        <RunInput
          key={inputRun.id}
          executionId={inputRun.id}
          pinnedSample={inputRun.sample}
          labelPrefix={inputRun.label}
          token={authToken}
          refreshKey={inputRun.label === "Current" ? current?.status : undefined}
        />
      )}

      {start ? (
        <Section title={translate("boundaryPanel.entry")}>
          <div className="text-[11px] text-foreground">
            {boundaries.entryId === null ? (
              <span className="text-muted-foreground">{translate("boundaryPanel.theFlowHasNoNodes")}</span>
            ) : (
              <>
                {translate("boundaryPanel.runsStartAt")} <NodeLink id={boundaries.entryId} onSelect={onSelectNode} />
                <span className="text-muted-foreground">
                  {" "}{translate("boundaryPanel.theFirstNodeOfThe")}
                </span>
              </>
            )}
          </div>
        </Section>
      ) : (
        <div className="space-y-1 text-[11px] text-foreground">
          {boundaries.exits.length === 0 ? (
            <span className="text-muted-foreground">{translate("boundaryPanel.noNodeEndsTheRun")}</span>
          ) : (
            <>
              <div>{translate("boundaryPanel.theRunCanEndAfter")}</div>
              <ul className="space-y-0.5 pl-3">
                {boundaries.exits.map((x) => (
                  <li key={x.nodeId}>
                    <NodeLink id={x.nodeId} onSelect={onSelectNode} />{" "}
                    <span className="text-muted-foreground">
                      {x.kind === "last" ? translate("boundaryPanel.noOutgoingEdge") : translate("boundaryPanel.whenNoneOfItsEdge")}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">{translate("boundaryPanel.itsLastAssistantMessageIs")}</p>
            </>
          )}
        </div>
      )}

      {!start && currentText !== undefined && currentText !== "" && (
        <Section title={translate("boundaryPanel.currentRunAnswer")}>
          <Text value={currentText} label={translate("boundaryPanel.currentAnswer")} />
        </Section>
      )}
      {start && !inputRun && currentText !== undefined && currentText !== "" && (
        <Section title={translate("boundaryPanel.currentRunRequest")}>
          <Text value={currentText} label={translate("boundaryPanel.currentRequest")} />
        </Section>
      )}

      <Section title={start ? translate("boundaryPanel.pinnedRequest") : translate("boundaryPanel.pinnedRequestAnswer")}>
        {runs && <RunPicker runs={runs} className="" />}
        {!runs ? (
          <p className="text-[11px] text-muted-foreground">{translate("boundaryPanel.saveTheFlowToPin")}</p>
        ) : !pinned ? (
          <p className="text-[11px] text-muted-foreground">
            {translate("boundaryPanel.pinARecordedRequestTo")} {start ? translate("boundaryPanel.whatItBroughtIntoThe") : translate("boundaryPanel.whatTheFlowAnswered")}.
          </p>
        ) : start ? (
          inputRun?.id !== pinned.executionId && (
            <p className="text-[11px] text-muted-foreground">
              {translate("boundaryPanel.pinned2")} {pinned.preview || translate("boundaryPanel.noMessage")} {translate("boundaryPanel.switchToPinnedRunAbove")}
            </p>
          )
        ) : pinned.response !== undefined ? (
          <div className="space-y-1">
            {pinned.responseNodeId && (
              <div className="text-[11px] text-muted-foreground">
                {translate("boundaryPanel.answeredBy")} <NodeLink id={pinned.responseNodeId} onSelect={onSelectNode} />
              </div>
            )}
            <Text value={pinned.response} label={translate("boundaryPanel.pinnedAnswer")} />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {translate("boundaryPanel.thisPinHasNoRecorded")}
          </p>
        )}
      </Section>
    </div>
  );
}
