// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  classifyEdgeFlow,
  ZERO_EDGE_FLOW_COUNTERS,
  type EdgeFlowCounters,
} from "../edge-flow.js";
import type { AgentState } from "../graph-engine/state.js";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import type { ImageRefInfo } from "../image-reference.js";
import type { EdgeFlowItem } from "../../types/edge-flow.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const counters = (overrides: Partial<EdgeFlowCounters> = {}): EdgeFlowCounters => ({
  ...ZERO_EDGE_FLOW_COUNTERS,
  ...overrides,
});

const node = (overrides: Partial<FlowNode> = {}): FlowNode =>
  overrides as FlowNode;

/** Minimal valid LlmConfig for fixtures that only care about `parameters`. */
const llm = (parameters: Record<string, unknown>): LlmConfig =>
  ({ provider: "openai", model: "test-model", parameters }) as LlmConfig;

const ref = (
  refId: string,
  mediaType = "image/png",
  bytes = 1_024,
): ImageRefInfo => ({ ref: refId, mediaType, bytes });

const state = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    messages: [],
    context: {},
    citations: [],
    toolResults: [],
    errors: [],
    classification: {},
    ...overrides,
  }) as unknown as AgentState;

interface ClassifyArgs {
  source?: string;
  target?: string;
  sequence?: number;
  state?: AgentState;
  baseline?: EdgeFlowCounters;
  nodeMap?: ReadonlyMap<string, FlowNode>;
  imageRefs?: readonly ImageRefInfo[];
  inspectionToolAnnounced?: boolean;
  imageConsumedUpstream?: boolean;
  imageConsumerId?: string | undefined;
  redact?: (text: string) => string;
}

const classify = (args: ClassifyArgs) =>
  classifyEdgeFlow({
    source: args.source ?? "a",
    target: args.target ?? "b",
    sequence: args.sequence ?? 1,
    state: args.state ?? state(),
    baseline: args.baseline,
    nodeMap: args.nodeMap ?? new Map(),
    imageRefs: args.imageRefs ?? [],
    inspectionToolAnnounced: args.inspectionToolAnnounced ?? false,
    imageConsumedUpstream: args.imageConsumedUpstream ?? false,
    imageConsumerId: args.imageConsumerId ?? undefined,
    ...(args.redact !== undefined ? { redact: args.redact } : {}),
  });

const itemsOfKind = (
  items: EdgeFlowItem[],
  kind: EdgeFlowItem["kind"],
): EdgeFlowItem[] => items.filter((i) => i.kind === kind);

const findLabel = (items: EdgeFlowItem[], label: string): EdgeFlowItem | undefined =>
  items.find((i) => i.label === label);

// ---------------------------------------------------------------------------
// Query (passed)
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — query", () => {
  it("passes the latest human message forward", () => {
    const { record } = classify({
      state: state({
        messages: [
          new HumanMessage("erste frage"),
          new AIMessage("antwort"),
          new HumanMessage("folgefrage"),
        ],
      }),
    });
    const query = findLabel(record.items, "Query");
    expect(query?.kind).toBe("text");
    expect(query?.status).toBe("passed");
    expect(query?.content).toBe("folgefrage");
  });

  it("omits the query when there is no user message", () => {
    const { record } = classify({
      state: state({ messages: [new AIMessage("nur ki")] }),
    });
    expect(findLabel(record.items, "Query")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Produced texts (baseline diff)
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — produced answers", () => {
  it("marks AI messages appended since the baseline as produced", () => {
    const messages = [
      new HumanMessage("frage"),
      new AIMessage("alte antwort"),
      new AIMessage("neue antwort"),
    ];
    const { record } = classify({
      state: state({ messages }),
      // Baseline captured the first two messages (human + old AI).
      baseline: counters({ messageCount: 2 }),
    });
    const answer = findLabel(record.items, "Antwort");
    expect(answer?.status).toBe("produced");
    expect(answer?.content).toBe("neue antwort");
  });

  it("numbers multiple produced answers", () => {
    const messages = [
      new HumanMessage("frage"),
      new AIMessage("eins"),
      new AIMessage("zwei"),
    ];
    const { record } = classify({
      state: state({ messages }),
      baseline: counters({ messageCount: 1 }),
    });
    expect(findLabel(record.items, "Antwort 1")?.content).toBe("eins");
    expect(findLabel(record.items, "Antwort 2")?.content).toBe("zwei");
  });

  it("collapses answers beyond the cap into a summary item", () => {
    const messages: BaseMessage[] = [new HumanMessage("frage")];
    for (let i = 0; i < 6; i++) messages.push(new AIMessage(`a${i}`));
    const { record } = classify({
      state: state({ messages }),
      baseline: counters({ messageCount: 1 }),
    });
    expect(findLabel(record.items, "weitere Antworten (2)")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Classification (classifier nodes → state.classification only)
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — classification payload", () => {
  it("surfaces a changed classification as a produced text item", () => {
    const { record } = classify({
      state: state({
        classification: { status: "ok", imageContext: "ein Diagramm" },
      }),
      baseline: counters({ classificationJson: "" }),
    });
    const klass = findLabel(record.items, "Klassifikation");
    expect(klass?.kind).toBe("text");
    expect(klass?.status).toBe("produced");
    expect(klass?.content).toContain("ein Diagramm");
  });

  it("does not repeat an unchanged classification", () => {
    const classification = { status: "ok" };
    const { record } = classify({
      state: state({ classification }),
      baseline: counters({ classificationJson: JSON.stringify(classification) }),
    });
    expect(findLabel(record.items, "Klassifikation")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Images: passed / consumed / upstream-consumed
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — images", () => {
  const visionTarget = new Map<string, FlowNode>([
    ["b", node({ llm: llm({ visionInput: true }) })],
  ]);

  it("marks a registry image as consumed when the target reads vision input", () => {
    const { record, imageConsumedUpstream } = classify({
      target: "b",
      nodeMap: visionTarget,
      imageRefs: [ref("img-1")],
      baseline: counters({ imageRefCount: 1 }),
    });
    const image = itemsOfKind(record.items, "image")[0];
    expect(image?.status).toBe("consumed");
    expect(image?.ref).toBe("img-1");
    expect(imageConsumedUpstream).toBe(true);
  });

  it("passes a registry image onward when the target has no vision input", () => {
    const { record, imageConsumedUpstream } = classify({
      target: "b",
      imageRefs: [ref("img-1")],
      baseline: counters({ imageRefCount: 1 }),
    });
    expect(itemsOfKind(record.items, "image")[0]?.status).toBe("passed");
    expect(imageConsumedUpstream).toBe(false);
  });

  it("marks a freshly registered image as produced", () => {
    const { record } = classify({
      imageRefs: [ref("img-1"), ref("img-2")],
      baseline: counters({ imageRefCount: 1 }),
    });
    const produced = itemsOfKind(record.items, "image").find(
      (i) => i.status === "produced",
    );
    expect(produced?.ref).toBe("img-2");
  });

  it("drops the image channel entirely once consumed upstream", () => {
    const { record } = classify({
      imageRefs: [ref("img-1")],
      imageConsumedUpstream: true,
    });
    expect(itemsOfKind(record.items, "image")).toHaveLength(0);
  });

  it("falls back to message image_url parts when no registry is configured", () => {
    const messages = [
      new HumanMessage({
        content: [
          { type: "text", text: "schau dir das an" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        ],
      }),
    ];
    const { record } = classify({ state: state({ messages }) });
    const image = itemsOfKind(record.items, "image")[0];
    expect(image?.media_type).toBe("image/jpeg");
  });
});

// ---------------------------------------------------------------------------
// inspect_image tool channel
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — inspect_image tool channel", () => {
  const inspectTarget = new Map<string, FlowNode>([
    ["b", node({ config: { imageInspection: { enabled: true } } })],
  ]);
  const visionTarget = new Map<string, FlowNode>([
    ["b", node({ llm: llm({ visionInput: true }) })],
  ]);

  it("announces the tool as produced on the first eligible edge", () => {
    const { record, inspectionToolAnnounced } = classify({
      target: "b",
      nodeMap: inspectTarget,
      imageRefs: [ref("img-1")],
    });
    const tool = findLabel(record.items, "Bild-Werkzeug (inspect_image)");
    expect(tool?.kind).toBe("tool");
    expect(tool?.status).toBe("produced");
    expect(inspectionToolAnnounced).toBe(true);
  });

  it("passes the tool along (not produced) once already announced", () => {
    const { record } = classify({
      target: "b",
      nodeMap: inspectTarget,
      imageRefs: [ref("img-1")],
      inspectionToolAnnounced: true,
    });
    expect(findLabel(record.items, "Bild-Werkzeug (weitergereicht)")?.status).toBe(
      "passed",
    );
  });

  it("does not announce the tool for a target that cannot inspect", () => {
    const { record } = classify({
      target: "b",
      imageRefs: [ref("img-1")],
    });
    expect(
      itemsOfKind(record.items, "tool").find((i) =>
        i.label.startsWith("Bild-Werkzeug"),
      ),
    ).toBeUndefined();
  });

  it("text-only run: a vision-capable target neither consumes images nor gets a tool", () => {
    const { record, imageConsumedUpstream, imageConsumerId } = classify({
      target: "b",
      nodeMap: visionTarget,
      // No imageRefs, no image_url parts — the run carries no picture at all.
    });
    expect(imageConsumedUpstream).toBe(false);
    expect(imageConsumerId).toBeUndefined();
    expect(itemsOfKind(record.items, "image")).toHaveLength(0);
    expect(
      itemsOfKind(record.items, "tool").find((i) =>
        i.label.startsWith("Bild-Werkzeug"),
      ),
    ).toBeUndefined();
  });

  it("the tool starts on the CONSUMER's outgoing edge, not its incoming one", () => {
    // Edge into the vision node: the picture is consumed here, but the tool
    // is only PROVIDED by that node — so it must NOT appear on this edge.
    const incoming = classify({
      source: "router",
      target: "vision",
      nodeMap: new Map<string, FlowNode>([
        ["vision", node({ llm: llm({ visionInput: true }) })],
      ]),
      imageRefs: [ref("img-1")],
      baseline: counters({ imageRefCount: 1 }),
    });
    expect(itemsOfKind(incoming.record.items, "image")[0]?.status).toBe(
      "consumed",
    );
    expect(
      incoming.record.items.find((i) =>
        i.label.startsWith("Bild-Werkzeug"),
      ),
    ).toBeUndefined();
    expect(incoming.imageConsumerId).toBe("vision");

    // Edge out of the vision node: now the tool is produced.
    const outgoing = classify({
      source: "vision",
      target: "answer",
      imageRefs: [ref("img-1")],
      imageConsumedUpstream: true,
      imageConsumerId: "vision",
    });
    const tool = findLabel(outgoing.record.items, "Bild-Werkzeug (inspect_image)");
    expect(tool?.status).toBe("produced");
    expect(outgoing.inspectionToolAnnounced).toBe(true);
  });

  it("carries the classifier's imageContext as the tool's content", () => {
    // A multimodal transcription flow writes the transcription to classification.imageContext;
    // the inspect_image channel must reveal that text in the edge panel.
    const { record } = classify({
      source: "vision",
      target: "answer",
      state: state({
        classification: { status: "enriched", imageContext: "Exam Report des Geräts 2WIN" },
      }),
      imageConsumedUpstream: true,
      imageConsumerId: "vision",
    });
    const tool = findLabel(record.items, "Bild-Werkzeug (inspect_image)");
    expect(tool?.content).toContain("Exam Report des Geräts 2WIN");
  });

  it("carries a `transcription` field too, and passes it along downstream", () => {
    const { record } = classify({
      source: "vision",
      target: "b",
      state: state({ classification: { transcription: "ein Diagramm" } }),
      nodeMap: new Map<string, FlowNode>([
        ["b", node({ config: { imageInspection: { enabled: true } } })],
      ]),
      imageConsumedUpstream: true,
      inspectionToolAnnounced: true,
    });
    expect(
      findLabel(record.items, "Bild-Werkzeug (weitergereicht)")?.content,
    ).toBe("ein Diagramm");
  });

  it("does not mistake a routing classification for a transcription", () => {
    const { record } = classify({
      source: "vision",
      target: "answer",
      state: state({ classification: { status: "enriched", route: "REKLAMATION" } }),
      imageConsumedUpstream: true,
      imageConsumerId: "vision",
    });
    const tool = findLabel(record.items, "Bild-Werkzeug (inspect_image)");
    expect(tool).toBeDefined();
    expect(tool?.content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Client tools (Open WebUI) — passed / opt-out
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — client tools", () => {
  const withClientTools = state({
    context: {
      clientTools: [
        { type: "function", function: { name: "get_weather" } },
        { type: "function", function: { name: "send_mail" } },
      ],
    },
  } as Partial<AgentState>);

  it("passes client tools to the target", () => {
    const { record } = classify({ state: withClientTools });
    const tools = findLabel(record.items, "Client-Werkzeuge (2)");
    expect(tools?.kind).toBe("tool");
    expect(tools?.status).toBe("passed");
    expect(tools?.content).toContain("get_weather");
  });

  it("omits client tools when the target opted out", () => {
    const nodeMap = new Map<string, FlowNode>([
      ["b", node({ config: { clientTools: false } })],
    ]);
    const { record } = classify({ state: withClientTools, nodeMap });
    expect(
      record.items.find((i) => i.label.startsWith("Client-Werkzeuge")),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Node MCP tools are NOT edge payloads (runtime binds them per node)
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — node MCP tools are not forwarded", () => {
  it("does not list the target node's own tools as edge items", () => {
    const nodeMap = new Map<string, FlowNode>([
      ["b", node({ tools: ["vectorsearch", "get_document"] })],
    ]);
    const { record } = classify({ nodeMap });
    expect(
      record.items.find((i) => i.label.startsWith("MCP-Werkzeuge")),
    ).toBeUndefined();
  });

  it("does not list the source node's own tools either", () => {
    const nodeMap = new Map<string, FlowNode>([
      ["a", node({ tools: ["vectorsearch/search"] })],
    ]);
    const { record } = classify({ source: "a", nodeMap });
    expect(
      record.items.some(
        (i) => i.kind === "tool" && (i.content ?? "").includes("vectorsearch"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool results & citations (produced)
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — tool results & citations", () => {
  it("marks tool results appended since the baseline as produced", () => {
    const toolResults = [
      {
        tool_call_id: "c1",
        tool_name: "vectorsearch",
        result: { hits: 3 },
        execution_time_seconds: 0.1,
      },
    ];
    const { record } = classify({
      state: state({ toolResults }),
      baseline: counters({ toolResultCount: 0 }),
    });
    const item = findLabel(record.items, "Ergebnis: vectorsearch");
    expect(item?.kind).toBe("data");
    expect(item?.status).toBe("produced");
    expect(item?.content).toContain("hits");
  });

  it("summarises new citations as a produced data item", () => {
    const citations = [
      { title: "Doku A", url: "http://a", snippet: "", similarity_score: 0.9 },
      { title: "Doku B", url: "http://b", snippet: "", similarity_score: 0.8 },
    ];
    const { record } = classify({
      state: state({ citations }),
      baseline: counters({ citationCount: 0 }),
    });
    const item = findLabel(record.items, "Quellen (2)");
    expect(item?.kind).toBe("data");
    expect(item?.content).toContain("Doku A");
  });
});

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — record shape", () => {
  it("carries source, target and sequence through to the record", () => {
    const { record } = classify({ source: "start", target: "end", sequence: 7 });
    expect(record.source).toBe("start");
    expect(record.target).toBe("end");
    expect(record.sequence).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Redaction / tokenization (Req 7.12)
// ---------------------------------------------------------------------------

describe("classifyEdgeFlow — redaction hook (Req 7.12)", () => {
  // Deterministic stand-in for the output guardrail: every e-mail becomes a
  // placeholder, everything else passes through.
  const redactEmails = (text: string): string =>
    text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[REDACTED_EMAIL]");

  const piiState = (): AgentState =>
    state({
      messages: [
        new HumanMessage("Schreib an jane.doe@example.com"),
        new AIMessage("OK, mail geht an jane.doe@example.com"),
      ],
      toolResults: [
        {
          tool_name: "crm",
          tool_call_id: "c-redact",
          result: { kontakt: "jane.doe@example.com" },
          execution_time_seconds: 0.1,
        },
      ],
      classification: { imageContext: "Transkript: jane.doe@example.com" },
    });

  it("scrubs every free-text item content through the redact hook", () => {
    const { record } = classify({
      state: piiState(),
      baseline: counters({ toolResultCount: 0 }),
      redact: redactEmails,
    });
    for (const item of record.items) {
      expect(item.content ?? "").not.toContain("jane.doe@example.com");
    }
    expect(findLabel(record.items, "Query")?.content).toBe(
      "Schreib an [REDACTED_EMAIL]",
    );
    expect(findLabel(record.items, "Antwort")?.content).toBe(
      "OK, mail geht an [REDACTED_EMAIL]",
    );
    expect(findLabel(record.items, "Ergebnis: crm")?.content).toContain(
      "[REDACTED_EMAIL]",
    );
    expect(findLabel(record.items, "Klassifikation")?.content).toContain(
      "[REDACTED_EMAIL]",
    );
  });

  it("redacts BEFORE excerpting (no half-PII at the excerpt boundary)", () => {
    // A long filler pushes the e-mail past the 2000-char excerpt cut: with
    // excerpt-then-redact the visible half would survive; redact-then-excerpt
    // leaves no raw PII anywhere in the content.
    const email = "jane.doe@example.com";
    const text = `${"x".repeat(1_990)}${email}`;
    const { record } = classify({
      state: state({ messages: [new HumanMessage(text)] }),
      redact: redactEmails,
    });
    const content = findLabel(record.items, "Query")?.content ?? "";
    expect(content).not.toContain(email);
    expect(content).toContain("[REDACTED_EMAIL]");
  });

  it("passes already-tokenized content through unchanged (vault mode)", () => {
    // PII-vault ingress tokenizes the state before the graph runs; the trace
    // must keep the [[PII:...]] placeholders as-is (they match no detector).
    const tokenized = "Kontakt: [[PII:0123456789abcdef]]";
    const { record } = classify({
      state: state({ messages: [new HumanMessage(tokenized)] }),
      redact: (t) => t,
    });
    expect(findLabel(record.items, "Query")?.content).toBe(tokenized);
  });

  it("keeps raw content when no redact hook is given (guardrails off)", () => {
    const { record } = classify({
      state: state({
        messages: [new HumanMessage("mail an jane.doe@example.com")],
      }),
    });
    expect(findLabel(record.items, "Query")?.content).toBe(
      "mail an jane.doe@example.com",
    );
  });
});
