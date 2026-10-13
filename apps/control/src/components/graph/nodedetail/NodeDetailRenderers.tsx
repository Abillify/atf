"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Type-specific detail renderers per node type (Req 9.3, Task 13.4):
 * request/response boundary, LLM, retrieval, parallel, router, classifier
 * and generic node. Split out of `graph/NodeDetailPanel.tsx` without
 * behavior change.
 */

import type React from "react";
import type { NodeState } from "../graphUtils";
import { AccordionSection, JsonTree, KvGrid } from "./Shared";
import { MarkdownView } from "./MarkdownView";
import { FormattedOrRaw, MessageBubble } from "./MessageBubble";
import {
  isJsonString,
  parseLlmMessages,
  parseRequestSections,
  parseRetrievalResponse,
} from "./parsers";
import { FindingsTable, SmartValue } from "./SmartValue";
import { VariablesTable } from "./VariablesTable";
import { HeadersTable } from "./HeadersTable";
import { ToolCallEntry } from "./ErrorRecording";

// ---------------------------------------------------------------------------
// Per-node-type detail renderers
// ---------------------------------------------------------------------------

/** Request boundary node (__request__): variables, payload, headers, token */
export function RequestNodeDetail({ state }: { state: NodeState }) {
  const sections = state.prompt ? parseRequestSections(state.prompt) : {};
  const sectionNames = Object.keys(sections);

  // Map section names to user-friendly tab labels
  const labelMap: Record<string, string> = {
    "RESOLVED VARIABLES (set + usable downstream)": "Variables",
    "PAYLOAD (request body)": "Payload",
    HEADERS: "Headers",
    "DECODED TOKEN (JWT claims)": "JWT Claims",
    "RAW TOKEN": "Raw Token",
    Preamble: "Info",
  };

  // Filter out "RAW TOKEN" section entirely — only a masked value is shown
  const filteredSectionNames = sectionNames.filter(
    (name) => name !== "RAW TOKEN",
  );

  if (filteredSectionNames.length === 0 && !state.prompt) {
    return (
      <p className="text-xs text-muted-foreground italic">No request data available.</p>
    );
  }

  // If we couldn't parse sections, show fallback
  if (filteredSectionNames.length === 0 && state.prompt) {
    return (
      <AccordionSection title="Request Data" defaultOpen badge={`${state.prompt.length} chars`}>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground">
          {state.prompt}
        </pre>
      </AccordionSection>
    );
  }

  return (
    <div className="space-y-2">
      {filteredSectionNames.map((name) => (
        <AccordionSection
          key={name}
          title={labelMap[name] ?? name}
          defaultOpen={name.includes("VARIABLE")}
          badge={`${sections[name]!.length} chars`}
        >
          {name.includes("VARIABLE") ? (
            <FormattedOrRaw
              text={sections[name]!}
              renderFormatted={() => <VariablesTable text={sections[name]!} />}
            />
          ) : name === "HEADERS" ? (
            <HeadersTable text={sections[name]!} />
          ) : isJsonString(sections[name]!) ? (
            <FormattedOrRaw
              text={sections[name]!}
              renderFormatted={() => <SmartValue text={sections[name]!} />}
            />
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
              {sections[name]}
            </pre>
          )}
        </AccordionSection>
      ))}
    </div>
  );
}

/** LLM node: messages as dialog bubbles, structured response */
export function LlmNodeDetail({ state }: { state: NodeState }) {
  const messages = state.prompt ? parseLlmMessages(state.prompt) : null;

  return (
    <div className="space-y-2">
      {/* Prompt / Messages */}
      {state.prompt && (
        <AccordionSection
          title="Prompt (Messages)"
          defaultOpen
          badge={messages ? `${messages.length} messages` : `${state.prompt.length} chars`}
        >
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() =>
              messages ? (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {messages.map((m, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the message position in the prompt is its identity; the list is replaced atomically
                    <MessageBubble key={i} role={m.role} content={m.content} />
                  ))}
                </div>
              ) : (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {state.prompt}
                </pre>
              )
            }
          />
        </AccordionSection>
      )}

      {/* Response */}
      {state.response && (
        <AccordionSection
          title="Response"
          defaultOpen
          badge={`${state.response.length} chars`}
        >
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => {
              if (isJsonString(state.response!)) {
                try {
                  return <JsonTree data={JSON.parse(state.response!)} />;
                } catch {
                  /* fall through to markdown */
                }
              }
              // Treat as markdown
              return <MarkdownView text={state.response!} />;
            }}
          />
        </AccordionSection>
      )}
    </div>
  );
}

/** Retrieval / vectorsearch node: input query + structured findings output */
export function RetrievalNodeDetail({ state }: { state: NodeState }) {
  // The prompt for retrieval nodes is typically the search query
  // The response is the JSON result (or from tool_calls)
  const responseText = state.response ?? "";
  const findings = parseRetrievalResponse(responseText);

  // Also surface the underlying search tool call (retrieval/… or
  // vectorsearch/search) so its resolved args (collection, limit, …) are visible.
  const retrievalToolCall = state.tool_calls?.find((tc) =>
    /^retrieval\/|vectorsearch|search/i.test(tc.name),
  );

  return (
    <div className="space-y-2">
      {/* Input: search query or tool args */}
      {state.prompt && (
        <AccordionSection title="Input (Query / Args)" defaultOpen>
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() => <SmartValue text={state.prompt!} />}
          />
        </AccordionSection>
      )}

      {/* Output: findings table */}
      {findings && (
        <AccordionSection
          title="Output (Findings)"
          defaultOpen
          badge={`${findings.totalMatches} matches`}
        >
          <FindingsTable
            findings={findings.findings}
            totalMatches={findings.totalMatches}
          />
        </AccordionSection>
      )}

      {/* Fallback: raw response if no structured findings */}
      {!findings && responseText && (
        <AccordionSection title="Output (Raw)" defaultOpen badge={`${responseText.length} chars`}>
          <FormattedOrRaw
            text={responseText}
            renderFormatted={() => <SmartValue text={responseText} />}
          />
        </AccordionSection>
      )}

      {/* Tool call detail */}
      {retrievalToolCall && (
        <AccordionSection title="Tool Call" badge={retrievalToolCall.name}>
          <ToolCallEntry tc={retrievalToolCall} />
        </AccordionSection>
      )}
    </div>
  );
}

/** Parallel node (context-assembler): shows collected inputs and assembled output */
export function ParallelNodeDetail({ state }: { state: NodeState }) {
  const findings = state.response ? parseRetrievalResponse(state.response) : null;

  return (
    <div className="space-y-2">
      {/* Input: which children / RAG sources ran this turn */}
      {state.prompt && (
        <AccordionSection title="Input (Sources & Query)" defaultOpen>
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() => <SmartValue text={state.prompt!} />}
          />
        </AccordionSection>
      )}

      {/* Output: assembled findings (id/title/score + total) */}
      {findings && (
        <AccordionSection
          title="Output (Assembled Findings)"
          defaultOpen
          badge={`${findings.totalMatches} matches`}
        >
          <FindingsTable
            findings={findings.findings}
            totalMatches={findings.totalMatches}
          />
        </AccordionSection>
      )}

      {/* Output: raw assembled result (summary counts) */}
      {state.response && (
        <AccordionSection
          title="Output (Summary)"
          defaultOpen={!findings}
          badge={`${state.response.length} chars`}
        >
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}

      {/* If no data at all, show a hint */}
      {!state.prompt && !state.response && (
        <p className="text-xs text-muted-foreground italic">
          No I/O data captured for this node. The parallel node collects results
          from child nodes and passes the assembled context downstream.
        </p>
      )}
    </div>
  );
}

/** Router node: shows routing decision with candidates */
export function RouterNodeDetail({ state }: { state: NodeState }) {
  return (
    <div className="space-y-2">
      {state.routing_decision && (
        <AccordionSection title="Routing Decision" defaultOpen>
          <div className="space-y-2">
            <KvGrid
              data={[
                [
                  "Chosen",
                  <span key="t" className="font-mono font-semibold text-foreground">
                    {state.routing_decision.target === "__end__"
                      ? "— (no match → end)"
                      : state.routing_decision.target}
                  </span>,
                ],
                ...(state.routing_decision.matched_label
                  ? [["Branch", state.routing_decision.matched_label] as [string, React.ReactNode]]
                  : []),
                ...(state.routing_decision.matched_condition
                  ? [
                      [
                        "Condition",
                        <span key="c" className="font-mono">{state.routing_decision.matched_condition}</span>,
                      ] as [string, React.ReactNode],
                    ]
                  : []),
              ]}
            />
            {state.routing_decision.candidates.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase">
                  Candidates
                </div>
                {state.routing_decision.candidates.map((c, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: the same target can appear in several rules; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
                    key={`${c.target}-${i}`}
                    className={`rounded border px-2 py-1 text-xs ${
                      c.matched
                        ? "border-success-border bg-success-soft"
                        : "border-border bg-muted opacity-70"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono break-all">
                        {c.matched ? "→ " : ""}{c.target}
                      </span>
                      {c.matched && (
                        <span className="text-[10px] font-semibold text-success">
                          taken
                        </span>
                      )}
                    </div>
                    {c.label && (
                      <div className="text-muted-foreground break-words">{c.label}</div>
                    )}
                    {c.condition && (
                      <div className="font-mono text-[11px] text-muted-foreground break-all">
                        {c.condition}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </AccordionSection>
      )}

      {/* Input / Output fallback */}
      {state.prompt && (
        <AccordionSection title="Input" badge={`${state.prompt.length} chars`}>
          <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.prompt}</pre>
        </AccordionSection>
      )}
      {state.response && (
        <AccordionSection title="Output" badge={`${state.response.length} chars`}>
          <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.response}</pre>
        </AccordionSection>
      )}
    </div>
  );
}

/** Classifier node: shows prompt messages + classification output */
export function ClassifierNodeDetail({ state }: { state: NodeState }) {
  const messages = state.prompt ? parseLlmMessages(state.prompt) : null;

  return (
    <div className="space-y-2">
      {state.prompt && (
        <AccordionSection
          title="Input (Classifier Prompt)"
          defaultOpen
          badge={messages ? `${messages.length} messages` : `${state.prompt.length} chars`}
        >
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() =>
              messages ? (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {messages.map((m, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the message position in the prompt is its identity; the list is replaced atomically
                    <MessageBubble key={i} role={m.role} content={m.content} />
                  ))}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.prompt}</pre>
              )
            }
          />
        </AccordionSection>
      )}

      {state.response && (
        <AccordionSection title="Output (Classification)" defaultOpen badge={`${state.response.length} chars`}>
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}
    </div>
  );
}

/** Generic node: shows input + output in structured collapsible sections.
 * Output auto-detects findings (id/title/score) and renders a findings table
 * so tool, memory and any other node returning that shape display uniformly. */
export function GenericNodeDetail({ state }: { state: NodeState }) {
  const findings = state.response ? parseRetrievalResponse(state.response) : null;

  return (
    <div className="space-y-2">
      {state.prompt && (
        <AccordionSection title="Input" defaultOpen badge={`${state.prompt.length} chars`}>
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() => <SmartValue text={state.prompt!} />}
          />
        </AccordionSection>
      )}

      {findings && (
        <AccordionSection
          title="Output (Findings)"
          defaultOpen
          badge={`${findings.totalMatches} matches`}
        >
          <FindingsTable
            findings={findings.findings}
            totalMatches={findings.totalMatches}
          />
        </AccordionSection>
      )}

      {state.response && !findings && (
        <AccordionSection title="Output" defaultOpen badge={`${state.response.length} chars`}>
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}

      {!state.prompt && !state.response && (
        <p className="text-xs text-muted-foreground italic">No I/O data captured for this node.</p>
      )}
    </div>
  );
}

/** Response boundary node (__response__): shows payload */
export function ResponseNodeDetail({ state }: { state: NodeState }) {
  return (
    <div className="space-y-2">
      {state.response && (
        <AccordionSection title="Response Payload" defaultOpen badge={`${state.response.length} chars`}>
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}
      {state.prompt && (
        <AccordionSection title="Input" badge={`${state.prompt.length} chars`}>
          <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.prompt}</pre>
        </AccordionSection>
      )}
    </div>
  );
}
