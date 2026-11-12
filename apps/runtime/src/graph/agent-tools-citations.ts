// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Citation numbering for vectorsearch results the model fetched itself. Split out of
 * `agent-tools.ts` unchanged; that module re-exports it.
 */

import type { Citation, CitationEvidence } from "../types/openai.js";
import {
  parseVectorSearchResults,
  parseVectorSearchSummaries,
} from "./reranker.js";
import { buildCitationEntries } from "./rag-grounding.js";
import type {
  AgentCitationHooks,
} from "./agent-tools-hooks.js";

/**
 * Prepends a citation-numbering note to a vectorsearch tool result the model
 * fetched itself, so it can cite the self-fetched documents inline as `[n]` —
 * the same numbering scheme the injected grounding uses. Registers each
 * document under its stable key (base_ref → url → title) in the per-execution
 * registry, which assigns the GLOBAL `[n]` (reusing an existing number when the
 * document was already surfaced by a grounding node earlier in the stream).
 *
 * Returns the content UNCHANGED when it is not a vectorsearch document
 * payload. Search/get_summaries are identified from their response envelope;
 * get_document/get_documents/get_summary additionally use the called tool and
 * its reference arguments because full-document responses may omit identity.
 * The note is appended as an extra text part (MCP text-content array) or as a
 * text suffix (string content), preserving the original JSON at the front.
 *
 * Exported for unit testing.
 */
export async function annotateVectorSearchCitations(
  content: unknown,
  citations: AgentCitationHooks,
  context?: {
    toolRef: string;
    args: Record<string, unknown>;
  },
): Promise<unknown> {
  const chunks = parseVectorSearchResults(content);
  const summaries = parseVectorSearchSummaries(content);
  const parsedEntries = buildCitationEntries(chunks, summaries);

  // Full-document tools do not use the search/get_summaries envelope parsed
  // above. In particular, get_document commonly returns only {title, content};
  // its stable identity is the `reference` argument of the tool call. Without
  // this bridge the model sees the original text but no GLOBAL [n], invents a
  // local [1], and Open WebUI cannot match that marker to sources[index].
  const explicitEntries: { key: string; citation: Citation }[] = [];
  if (context?.toolRef.startsWith("vectorsearch/") === true) {
    let payload: unknown = content;
    try {
      if (
        Array.isArray(payload) &&
        payload.length > 0 &&
        payload[0] !== null &&
        typeof payload[0] === "object" &&
        typeof (payload[0] as { text?: unknown }).text === "string"
      ) {
        payload = JSON.parse((payload[0] as { text: string }).text);
      } else if (typeof payload === "string") {
        payload = JSON.parse(payload);
      }
    } catch {
      payload = undefined;
    }

    const payloadRecord =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
    const toolName = context.toolRef.slice("vectorsearch/".length);
    const argumentRefs = [
      context.args.reference,
      context.args.ref,
      context.args.base_ref,
    ].filter((value): value is string =>
      typeof value === "string" && value.trim() !== ""
    );
    const argumentRefLists = [context.args.references, context.args.refs]
      .filter(Array.isArray)
      .flat()
      .filter((value): value is string =>
        typeof value === "string" && value.trim() !== ""
      );

    let documents: Record<string, unknown>[] = [];
    if (toolName === "get_document" || toolName === "get_summary") {
      if (payloadRecord !== undefined) documents = [payloadRecord];
    } else if (toolName === "get_documents") {
      const candidates = payloadRecord?.documents ?? payloadRecord?.results;
      if (Array.isArray(candidates)) {
        documents = candidates.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item),
        );
      }
    }

    documents.forEach((document, index) => {
      if (
        document.error !== undefined ||
        document.isError === true ||
        document.success === false
      ) {
        return;
      }
      const referenceCandidates = [
        document.reference,
        document.base_ref,
        argumentRefs[index],
        argumentRefLists[index],
        argumentRefs[0],
      ];
      const reference = referenceCandidates.find(
        (value): value is string =>
          typeof value === "string" && value.trim() !== "",
      );
      if (reference === undefined) return;
      const titleCandidates = [document.title, document.name];
      const title =
        titleCandidates.find(
          (value): value is string =>
            typeof value === "string" && value.trim() !== "",
        ) ?? reference;
      const snippetCandidates = [
        document.content,
        document.text,
        document.summary,
      ];
      const snippet =
        snippetCandidates.find(
          (value): value is string =>
            typeof value === "string" && value.trim() !== "",
        ) ?? "";
      // A successful full-document/summary response must contain actual source
      // text. This prevents an object-shaped not-found/status response from
      // becoming a globally numbered, apparently citable source merely because
      // the request itself carried a valid reference.
      if (snippet === "") return;
      const urlCandidates = [document.url, document.link];
      const url =
        urlCandidates.find(
          (value): value is string => typeof value === "string",
        ) ?? "";
      const stringValue = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim() !== "" ? value : undefined;
      const nonNegativeInt = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? Math.floor(value)
          : undefined;
      const documentMetadata =
        document.metadata !== null &&
        typeof document.metadata === "object" &&
        !Array.isArray(document.metadata)
          ? (document.metadata as Record<string, unknown>)
          : {};
      const evidenceSpans = Array.isArray(document.evidence_spans)
        ? document.evidence_spans.filter(
            (span): span is Record<string, unknown> =>
              span !== null && typeof span === "object" && !Array.isArray(span),
          )
        : [];
      const evidence: CitationEvidence[] = evidenceSpans.map((span) => {
        const rawPage = span.page ?? span.page_start;
        const page =
          typeof rawPage === "number" && Number.isFinite(rawPage) && rawPage >= 0
            ? Math.floor(rawPage)
            : stringValue(rawPage);
        const section =
          stringValue(span.section) ??
          (Array.isArray(span.section_path)
            ? span.section_path
                .filter((value): value is string => typeof value === "string")
                .join(" > ") || undefined
            : undefined);
        const spanVersion =
          stringValue(span.version) ??
          stringValue(document.version) ??
          stringValue(documentMetadata.version);
        const spanText =
          stringValue(span.text) ??
          stringValue(span.content) ??
          stringValue(span.snippet);
        const documentId =
          stringValue(span.document_id) ??
          stringValue(document.document_id) ??
          stringValue(documentMetadata.document_id) ??
          reference;
        const charStart =
          nonNegativeInt(span.char_start) ?? nonNegativeInt(span.original_start);
        const charEnd =
          nonNegativeInt(span.char_end) ?? nonNegativeInt(span.original_end);
        return {
          ...(stringValue(span.citation_id) !== undefined
            ? { citation_id: stringValue(span.citation_id) }
            : {}),
          document_id: documentId,
          ...(spanVersion !== undefined ? { version: spanVersion } : {}),
          ...(page !== undefined ? { page } : {}),
          ...(section !== undefined ? { section } : {}),
          ...(charStart !== undefined ? { char_start: charStart } : {}),
          ...(charEnd !== undefined ? { char_end: charEnd } : {}),
          ...(stringValue(span.chunk_id) !== undefined
            ? { chunk_id: stringValue(span.chunk_id) }
            : {}),
          ...(spanText !== undefined ? { text: spanText.slice(0, 500) } : {}),
          ...(typeof span.score === "number" ? { score: span.score } : {}),
        };
      });
      const firstEvidence = evidence[0];
      const citationId = stringValue(document.citation_id) ?? firstEvidence?.citation_id;
      const documentId =
        stringValue(document.document_id) ??
        stringValue(documentMetadata.document_id) ??
        reference;
      const version =
        stringValue(document.version) ??
        stringValue(documentMetadata.version) ??
        firstEvidence?.version;
      explicitEntries.push({
        key: reference.trim(),
        citation: {
          title,
          url,
          snippet: snippet.slice(0, 500),
          similarity_score:
            typeof document.score === "number" ? document.score : 0,
          ...(citationId !== undefined ? { citation_id: citationId } : {}),
          document_id: documentId,
          ...(version !== undefined ? { version } : {}),
          ...(firstEvidence?.page !== undefined ? { page: firstEvidence.page } : {}),
          ...(firstEvidence?.section !== undefined ? { section: firstEvidence.section } : {}),
          ...(firstEvidence?.char_start !== undefined ? { char_start: firstEvidence.char_start } : {}),
          ...(firstEvidence?.char_end !== undefined ? { char_end: firstEvidence.char_end } : {}),
          ...(firstEvidence?.chunk_id !== undefined ? { chunk_id: firstEvidence.chunk_id } : {}),
          ...(evidence.length > 0 ? { evidence } : {}),
        },
      });
    });
  }

  const entriesByKey = new Map<string, { key: string; citation: Citation }>();
  for (const entry of [...parsedEntries, ...explicitEntries]) {
    if (!entriesByKey.has(entry.key)) entriesByKey.set(entry.key, entry);
  }
  const entries = [...entriesByKey.values()];

  // Without explicit tool identity, retain the strict payload gate that keeps
  // unrelated tools with a generic {results:[...]} shape out of the registry.
  const hasParsedDocIdentity =
    chunks.some((chunk) => (chunk.baseRef ?? "").trim() !== "") ||
    summaries.some((summary) => summary.reference.trim() !== "");
  if (explicitEntries.length === 0 && !hasParsedDocIdentity) return content;
  if (entries.length === 0) return content;

  const indices = await citations.register(entries);

  const lines = entries.map((entry, index) => {
    const citationIndex = indices[index];
    return `[${citationIndex}] ${entry.citation.title} (Ref: ${entry.key})`;
  });
  const note =
    "Zitier-Hinweis: The self-retrieved hits below are numbered as sources — " +
    "cite used hits inline in your answer with exactly the global [n] given " +
    "here. Never assign local numbers starting at [1] and never derive the " +
    "number from the order in the tool result:\n" +
    lines.join("\n");

  // MCP text-content array → APPEND the note as a trailing text part, keeping
  // the raw payload as content[0] so any downstream re-parse still sees JSON.
  if (
    Array.isArray(content) &&
    content.every(
      (part) =>
        part !== null && typeof part === "object" && "text" in (part as object),
    )
  ) {
    return [...content, { type: "text", text: note }];
  }
  if (typeof content === "string") return `${content}\n\n${note}`;
  return content;
}
