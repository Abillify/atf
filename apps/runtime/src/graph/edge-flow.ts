// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Edge data-flow classification (`src/graph/edge-flow.ts`)
 *
 * Pure classifier that turns the graph state at an edge traversal into the
 * channel items the Studio canvas renders as colored parallel lines: the user
 * query, images, tool definitions, produced answers, tool results and
 * citations. It is deliberately side-effect-free — the engine (handler
 * factories) owns the per-run counters and the debug-trace store, this module
 * only answers "what crossed from source to target, given what the source saw
 * at its entry?".
 *
 * Attribution model:
 *   - `baseline` = state counters captured when the SOURCE node started.
 *     Everything beyond the baseline (messages, tool results, citations, image
 *     refs) was PRODUCED by the source and is handed forward.
 *   - The query and the client tools (Open WebUI etc.) exist independently of
 *     the source run and are PASSED along. A node's own MCP tools are NOT an
 *     edge payload: the runtime binds them from the flow definition when the
 *     target executes, so they must not be shown as forwarded data.
 *   - Images are CONSUMED on the edge out of a node that reads them with
 *     vision input (`llm.parameters.visionInput`): the picture stops there and
 *     its transcription continues as a text channel — exactly the
 *     multimodal transcription case the visualization was built for.
 *
 * No `any` at module boundaries.
 */

import type { BaseMessage } from "@langchain/core/messages";
import type { FlowNode } from "../types/flow.js";
import type { EdgeFlowItem, EdgeFlowRecord } from "../types/edge-flow.js";
import type { ImageRefInfo } from "./image-reference.js";
import { IMAGE_INSPECTION_TOOL_NAME } from "./image-reference.js";
import type { AgentState } from "./graph-engine/state.js";

// ---------------------------------------------------------------------------
// Counters / interface
// ---------------------------------------------------------------------------

/** State counters captured at a node's entry — the baseline for "produced". */
export interface EdgeFlowCounters {
  messageCount: number;
  toolResultCount: number;
  citationCount: number;
  imageRefCount: number;
  /**
   * JSON of `state.classification` at entry ("" when empty). Classifier nodes
   * write their structured result (e.g. an image transcription) ONLY to
   * `classification`, never to `messages` — comparing the JSON is what makes
   * that produced payload visible on the outgoing edge.
   */
  classificationJson: string;
}

/** Counters for a source whose entry was never baselined (e.g. `__start__`). */
export const ZERO_EDGE_FLOW_COUNTERS: EdgeFlowCounters = {
  messageCount: 0,
  toolResultCount: 0,
  citationCount: 0,
  imageRefCount: 0,
  classificationJson: "",
};

export interface EdgeFlowClassificationInput {
  /** Logical source id: node id or `__start__`. */
  source: string;
  /** Logical target id: node id or `__end__`. */
  target: string;
  /** Global edge counter (1-based) for this traversal. */
  sequence: number;
  /** Full graph state at the moment the edge was crossed. */
  state: AgentState;
  /** Counters captured when the source node started (undefined → zero). */
  baseline: EdgeFlowCounters | undefined;
  /** Flow nodes by id — for labels, node tools and vision-input config. */
  nodeMap: ReadonlyMap<string, FlowNode>;
  /** Live image refs of this run (from the ImageRefRegistry), if any. */
  imageRefs: readonly ImageRefInfo[];
  /** Whether the inspect_image tool channel was announced on an earlier edge. */
  inspectionToolAnnounced: boolean;
  /**
   * Whether a vision-input node already consumed this run's images upstream.
   * After that, the picture itself no longer travels — only the transcription
   * (as text) and the `inspect_image` tool (for follow-up questions) do, which
   * is exactly what the canvas should show: the image line ends at the node
   * that read it.
   */
  imageConsumedUpstream: boolean;
  /**
   * Id of the node that consumed the images (the vision / transcription node).
   * That node is what makes follow-up questions about the picture possible, so
   * the `inspect_image` channel STARTS on its OUTGOING edge — never on the
   * incoming one.
   */
  imageConsumerId: string | undefined;
  /**
   * Optional content scrubber (Req 7.12): applied to every free-text item
   * content BEFORE excerpting, so an Edge-Data-Flow trace never persists raw
   * PII while output redaction is active — the engine passes the effective
   * output guardrail here. Content that is already tokenized (PII vault,
   * `[[PII:...]]` placeholders) passes through unchanged, so the trace
   * respects tokenization as well. Omitting it keeps the raw content
   * (guardrails disabled → trace shows what actually crossed the edge).
   */
  redact?: (text: string) => string;
}

export interface EdgeFlowClassificationResult {
  record: EdgeFlowRecord;
  /** Updated flag — set once the inspect_image channel has been announced. */
  inspectionToolAnnounced: boolean;
  /** Updated flag — set when THIS edge's target consumes the images. */
  imageConsumedUpstream: boolean;
  /** Updated consumer id — set when THIS edge's target consumed the images. */
  imageConsumerId: string | undefined;
}

// ---------------------------------------------------------------------------
// Caps (the store clamps content bytes; these keep the classifier from
// building absurd item lists before that).
// ---------------------------------------------------------------------------

const MAX_TEXT_ITEMS = 4;
const MAX_IMAGE_ITEMS = 4;
const MAX_RESULT_ITEMS = 4;
const CONTENT_EXCERPT_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/** LangChain message role ("human" | "ai" | "tool" | "system"), best-effort. */
function messageType(message: BaseMessage): string {
  return (
    (message as { _getType?: () => string })._getType?.() ??
    (typeof message.content === "string" ? "human" : "human")
  );
}

/** Plain text of a message content (string or content-part array). */
function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const p = part as { type?: string; text?: string };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter((t) => t.length > 0)
    .join("\n");
}

/** image_url part URLs of a message content (LangChain multimodal format). */
function messageImageUrls(content: BaseMessage["content"]): string[] {
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const part of content) {
    const p = part as {
      type?: string;
      image_url?: { url?: string };
    };
    if (p.type === "image_url" && typeof p.image_url?.url === "string") {
      urls.push(p.image_url.url);
    }
  }
  return urls;
}

/** MIME type from a data URL (`data:image/png;base64,…` → `image/png`). */
function mimeFromDataUrl(url: string): string | undefined {
  const match = /^data:([^;,]+)/.exec(url);
  return match?.[1];
}

function excerpt(text: string, max = CONTENT_EXCERPT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Does this node read images with vision input (→ consumes the image)? */
function nodeHasVisionInput(node: FlowNode | undefined): boolean {
  if (node === undefined) return false;
  return (
    node.llm?.parameters?.visionInput === true ||
    node.config?.visionInput === true
  );
}

/**
 * Can this node ask a picture questions — either by reading it directly
 * (vision input) or through the `inspect_image` tool
 * (`config.imageInspection`)? Only such targets get the tool channel on their
 * incoming edge.
 */
function nodeCanInspectImages(node: FlowNode | undefined): boolean {
  return (
    nodeHasVisionInput(node) || node?.config?.imageInspection !== undefined
  );
}

/**
 * The picture's transcription as a classifier node stored it in
 * `state.classification`. Flows conventionally name the field `imageContext`
 * or `transcription`; other string values are NOT guessed — a routing
 * classification (`route`, `status`) must not masquerade as picture content.
 * Shown on the `inspect_image` channel so the panel reveals what the image
 * was turned into: the text that carries the picture's content onward.
 */
function transcriptionFromClassification(
  classification: Record<string, unknown> | undefined,
): string {
  if (classification === undefined) return "";
  for (const key of ["imageContext", "transcription"]) {
    const value = classification[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify the payloads that crossed the edge `source → target`.
 *
 * The result is a complete {@link EdgeFlowRecord}; content strings are
 * already excerpted here (cheap) and byte-clamped again on store ingest
 * (`debug-trace-limits.ts`), so the trace stays bounded either way.
 */
export function classifyEdgeFlow(
  input: EdgeFlowClassificationInput,
): EdgeFlowClassificationResult {
  const {
    source,
    target,
    sequence,
    state,
    baseline,
    nodeMap,
    imageRefs,
    inspectionToolAnnounced,
    imageConsumedUpstream,
    imageConsumerId,
    redact,
  } = input;
  // (imageConsumerId: node that consumed the images upstream, if any)
  const base = baseline ?? ZERO_EDGE_FLOW_COUNTERS;
  const messages = state.messages ?? [];
  const items: EdgeFlowItem[] = [];
  // Req 7.12: scrub free text BEFORE excerpting — excerpting first could cut a
  // PII value in half at the excerpt boundary and let the visible half through
  // the detectors. Pure callback (see the input field docs), so the classifier
  // stays side-effect-free.
  const scrub = (text: string, max = CONTENT_EXCERPT_CHARS): string =>
    excerpt(redact !== undefined ? redact(text) : text, max);
  // The target reads pictures itself → the image channel ENDS on this edge.
  const consumedByTarget = nodeHasVisionInput(nodeMap.get(target));

  // --- Query (passed): the latest user message is forwarded to every node.
  const lastHuman = [...messages]
    .reverse()
    .find((m) => messageType(m) === "human");
  if (lastHuman !== undefined) {
    const queryText = messageText(lastHuman.content).trim();
    if (queryText.length > 0) {
      items.push({
        kind: "text",
        label: "Query",
        status: "passed",
        content: scrub(queryText),
      });
    }
  }

  // --- Produced texts: AI messages the source node appended.
  const newMessages = messages.slice(base.messageCount);
  const producedTexts = newMessages
    .filter((m) => messageType(m) === "ai")
    .map((m) => messageText(m.content).trim())
    .filter((t) => t.length > 0);
  producedTexts.slice(0, MAX_TEXT_ITEMS).forEach((text, idx) => {
    items.push({
      kind: "text",
      label: producedTexts.length > 1 ? `Antwort ${idx + 1}` : "Antwort",
      status: "produced",
      content: scrub(text),
    });
  });
  if (producedTexts.length > MAX_TEXT_ITEMS) {
    items.push({
      kind: "text",
      label: `weitere Antworten (${producedTexts.length - MAX_TEXT_ITEMS})`,
      status: "produced",
    });
  }

  // --- Images. Two sources: the run-scoped ref registry (bytes parked,
  // parts replaced by `[image ref=img-N …]`) and, when no registry is
  // configured, the image_url parts still present in the messages. Once a
  // vision node consumed them upstream they are no longer forwarded — the
  // transcription and the inspect_image tool carry the content onward.
  let imageConsumed = imageConsumedUpstream;
  if (!imageConsumedUpstream) {
    const partUrls: string[] = [];
    for (const m of messages) {
      for (const url of messageImageUrls(m.content)) partUrls.push(url);
    }
    const imageStatus: EdgeFlowItem["status"] = consumedByTarget
      ? "consumed"
      : "passed";
    // A vision target ENDS the image channel here — but only when the run
    // actually carries an image. A text-only run must not flip the flag just
    // because the target COULD read pictures.
    if (consumedByTarget && (imageRefs.length > 0 || partUrls.length > 0)) {
      imageConsumed = true;
    }
    if (imageRefs.length > 0) {
      imageRefs.slice(0, MAX_IMAGE_ITEMS).forEach((info, idx) => {
        items.push({
          kind: "image",
          label: `Bild ${info.ref}`,
          status: idx < base.imageRefCount ? imageStatus : "produced",
          media_type: info.mediaType,
          ref: info.ref,
          bytes: info.bytes,
        });
      });
      if (imageRefs.length > MAX_IMAGE_ITEMS) {
        items.push({
          kind: "image",
          label: `weitere Bilder (${imageRefs.length - MAX_IMAGE_ITEMS})`,
          status: imageStatus,
        });
      }
    } else {
      partUrls.slice(0, MAX_IMAGE_ITEMS).forEach((url, idx) => {
        const mime = mimeFromDataUrl(url);
        items.push({
          kind: "image",
          label: `Bild ${idx + 1}`,
          status: imageStatus,
          ...(mime !== undefined ? { media_type: mime } : {}),
        });
      });
      if (partUrls.length > MAX_IMAGE_ITEMS) {
        items.push({
          kind: "image",
          label: `weitere Bilder (${partUrls.length - MAX_IMAGE_ITEMS})`,
          status: imageStatus,
        });
      }
    }
  }

  // --- Produced classification (classifier nodes): the structured result —
  // e.g. an image transcription — lives ONLY in state.classification. A change
  // against the source's entry baseline means the source produced it.
  const classificationJson =
    state.classification && Object.keys(state.classification).length > 0
      ? JSON.stringify(state.classification)
      : "";
  if (
    classificationJson.length > 0 &&
    classificationJson !== base.classificationJson
  ) {
    items.push({
      kind: "text",
      label: "Klassifikation",
      status: "produced",
      content: scrub(classificationJson),
    });
  }

  // --- inspect_image tool. The run must actually carry an image: a
  // text-only query must not produce a tool channel just because some node
  // COULD read pictures. The node that consumed the picture (the vision /
  // transcription node) is what makes follow-up questions about it possible,
  // so the tool channel STARTS on that node's outgoing edge ("produced") —
  // never on its incoming one — and travels on ("weitergereicht") to every
  // downstream node that can inspect images (vision input or
  // `config.imageInspection`).
  let announced = inspectionToolAnnounced;
  let consumer = imageConsumerId;
  const targetNode = nodeMap.get(target);
  const targetCanInspect =
    target !== "__end__" && nodeCanInspectImages(targetNode);
  const imagePresent = imageRefs.length > 0 || imageConsumed;
  // The transcription the tool channel stands for: what the vision node read
  // out of the picture (still present in state.classification while no later
  // classifier overwrote it). Attached to every inspect_image item so the
  // panel shows the picture's text content wherever the tool travels.
  const transcription = imagePresent
    ? scrub(transcriptionFromClassification(state.classification))
    : "";
  const transcriptionPatch =
    transcription !== "" ? { content: transcription } : {};
  if (imagePresent && !announced && source === consumer) {
    items.push({
      kind: "tool",
      label: "Bild-Werkzeug (inspect_image)",
      status: "produced",
      tool_name: IMAGE_INSPECTION_TOOL_NAME,
      ...transcriptionPatch,
    });
    announced = true;
  } else if (
    imagePresent &&
    !announced &&
    targetNode?.config?.imageInspection !== undefined
  ) {
    // No vision consumer upstream (yet): the runtime injects the tool into
    // this node itself, so it appears on the node's incoming edge.
    items.push({
      kind: "tool",
      label: "Bild-Werkzeug (inspect_image)",
      status: "produced",
      tool_name: IMAGE_INSPECTION_TOOL_NAME,
      ...transcriptionPatch,
    });
    announced = true;
  } else if (announced && targetCanInspect) {
    items.push({
      kind: "tool",
      label: "Bild-Werkzeug (weitergereicht)",
      status: "passed",
      tool_name: IMAGE_INSPECTION_TOOL_NAME,
      ...transcriptionPatch,
    });
  }
  // The vision target consumed the picture on THIS edge → it provides the
  // tool from its own outgoing edge on.
  if (consumedByTarget && imagePresent) consumer = target;

  // --- Client tools (Open WebUI etc.): forwarded to LLM nodes as-is, unless
  // the target node opted out (`config.clientTools: false`).
  const clientTools = state.context?.clientTools;
  const targetOptsOutClientTools =
    target !== "__end__" && nodeMap.get(target)?.config?.clientTools === false;
  if (
    clientTools !== undefined &&
    clientTools.length > 0 &&
    !targetOptsOutClientTools
  ) {
    items.push({
      kind: "tool",
      label: `Client-Werkzeuge (${clientTools.length})`,
      status: "passed",
      content: scrub(
        clientTools
          .map((t) => t.function?.name ?? "?")
          .filter((n) => n !== "?")
          .join(", "),
        500,
      ),
    });
  }

  // NOTE: the target node's own MCP tools (`node.tools`) are deliberately NOT
  // an edge item. They are static flow configuration the runtime binds when
  // the target executes — nothing crosses the edge to provide them. Only
  // genuinely forwarded payloads appear here: the query, client tools (Open
  // WebUI etc.) and the inspect_image tool.

  // --- Tool results produced by the source node.
  const newResults = (state.toolResults ?? []).slice(base.toolResultCount);
  newResults.slice(0, MAX_RESULT_ITEMS).forEach((r) => {
    let resultText = "";
    try {
      resultText = JSON.stringify(r.result);
    } catch {
      resultText = "[nicht serialisierbar]";
    }
    items.push({
      kind: "data",
      label: `Ergebnis: ${r.tool_name}`,
      status: "produced",
      ...(resultText.length > 0 ? { content: scrub(resultText) } : {}),
    });
  });
  if (newResults.length > MAX_RESULT_ITEMS) {
    items.push({
      kind: "data",
      label: `weitere Tool-Ergebnisse (${newResults.length - MAX_RESULT_ITEMS})`,
      status: "produced",
    });
  }

  // --- Citations produced by the source node (retrieval/RAG).
  const newCitations = (state.citations ?? []).slice(base.citationCount);
  if (newCitations.length > 0) {
    items.push({
      kind: "data",
      label: `Quellen (${newCitations.length})`,
      status: "produced",
      content: scrub(
        newCitations.map((c) => c.title ?? c.url ?? "?").join(", "),
        500,
      ),
    });
  }

  return {
    record: { source, target, sequence, items },
    inspectionToolAnnounced: announced,
    imageConsumedUpstream: imageConsumed,
    imageConsumerId: consumer,
  };
}
