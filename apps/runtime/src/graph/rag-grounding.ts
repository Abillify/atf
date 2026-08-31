// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * RAG grounding assembly (`src/graph/rag-grounding.ts`)
 *
 * Pure, dependency-light helpers that turn the parsed vectorsearch output of a
 * `tool` node — search-hit chunks and document summaries — into:
 *
 *   - ONE ordered, deduplicated citation list (`orderedCitations`), where
 *     position `i` is citation `[i+1]`; and
 *   - the grounding text sections (COLLECTION OVERVIEW + RELEVANT PASSAGES)
 *     that are injected into the next LLM node.
 *
 * The key property is **document-stable `[n]` numbering**: the overview and the
 * relevant passages are numbered from the SAME list keyed by the parent
 * document identity, so a document that appears both as a summary and as a
 * search passage carries the SAME `[n]` in both places — and every summarised
 * document is itself citable as `[n]`. This keeps the client's native
 * citations, the injected overview, and the answer's inline `[n]` all aligned.
 *
 * Extracted from `handlers/tool.ts` so the logic is unit-testable without
 * importing the node-handler barrel (which has an init-order cycle via
 * graph-engine). No `any` at module boundaries.
 */

import type { Citation, CitationEvidence } from "../types/openai.js";
import { docKeyOf, type RagChunk, type RagSummary } from "./reranker.js";

/**
 * Section markers for the assembled grounding text.
 *
 * These are a small protocol between this module, which writes them, and
 * `agent-harness/loop.ts`, which recognises and compacts the overview section by
 * matching on them. Exported so a reader cannot change the wording here without
 * seeing who depends on it.
 */
export const COLLECTION_OVERVIEW_MARKER = "COLLECTION OVERVIEW";
export const RELEVANT_PASSAGES_MARKER = "RELEVANT PASSAGES";
export const RELEVANT_SOURCES_MARKER = "RELEVANT SOURCES";
/** Precedes the store's true document total in the overview header. */
export const OVERVIEW_TOTAL_LABEL = "TOTAL";

/** chars per summary body kept in the overview (≈1 sentence). */
const SUMMARY_BODY_MAX = 300;
/** overview character budget (~10 k tokens at ~4 chars/token). */
const OVERVIEW_CHAR_BUDGET = 40_000;
/** max snippet length carried on a citation. */
const SNIPPET_MAX = 500;

// `docKeyOf` lives in reranker.ts (a leaf module) so RagChunk fusion and this
// grounding builder share ONE document-identity definition. Re-exported here
// for the handlers that build grounding.
export { docKeyOf } from "./reranker.js";

/**
 * Returns a source-chip title enriched with the document chapter breadcrumb
 * encoded by vectorsearch in `reference`/`baseRef`.
 *
 * The raw document title is deliberately preserved elsewhere for document
 * identity, prompt grounding, and existing citation numbers. A breadcrumb is
 * appended only when the reference contains numeric chapter segments after the
 * document title; ordinary root references therefore stay a plain filename.
 */
export function citationDisplayTitle(title: string, reference: string): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle === "" || reference.trim() === "") return title;

  const segments = reference
    .replace(/\\/g, "/")
    // Some stores serialise a document-to-chapter boundary with a dash rather
    // than a slash; normalize it before splitting the hierarchy.
    .replace(/\s+[—–]\s+/g, "/")
    .split(/[/>›]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  const titleIndex = segments.indexOf(normalizedTitle);
  const afterTitle = titleIndex >= 0 ? segments.slice(titleIndex + 1) : segments;
  // Examples: "5. Specification", "5.3.2 Requirements", or the indexed
  // form "2. 5.3.2 Requirements" emitted by a hierarchical extractor.
  const chapterSegments = afterTitle.filter((segment) =>
    /^\d+(?:\.\d+)*\.?\s+\S/.test(segment),
  );

  return chapterSegments.length > 0
    ? `${title} — ${chapterSegments.join(" › ")}`
    : title;
}

/** A citation paired with its stable document key (for cross-node dedup). */
export interface CitationEntry {
  /** Stable document identity (base_ref → url → title). */
  key: string;
  citation: Citation;
}

/**
 * Builds ordered, deduplicated citation entries from parsed search chunks and
 * document summaries. Summaries lead (coverage-map order); search hits merge
 * into their summary entry (same document → same key) or append. Each entry
 * carries its document `key` so callers can register it in a per-execution
 * citation registry and reuse the SAME `[n]` across nodes (e.g. an overview
 * document and a later self-search hit of the same file). Exported so both the
 * `tool` node and the LLM self-search annotator share one definition.
 */
export function buildCitationEntries(
  chunks: readonly RagChunk[],
  summaries: readonly RagSummary[],
): CitationEntry[] {
  const byKey = new Map<string, Citation>();
  const order: string[] = [];
  const evidenceKey = (evidence: CitationEvidence): string =>
    evidence.chunk_id ??
    [
      evidence.document_id,
      evidence.version,
      evidence.page,
      evidence.section,
      evidence.char_start,
      evidence.char_end,
      evidence.text,
    ].map((value) => String(value ?? "")).join("\u001f");
  const upsert = (key: string, cand: Citation): void => {
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...cand, ...(cand.evidence !== undefined ? { evidence: [...cand.evidence] } : {}) });
      order.push(key);
      return;
    }
    if (cand.similarity_score > existing.similarity_score) {
      existing.similarity_score = cand.similarity_score;
    }
    if (existing.snippet.trim() === "" && cand.snippet.trim() !== "") {
      existing.snippet = cand.snippet;
    }
    if (existing.url === "" && cand.url !== "") existing.url = cand.url;
    for (const field of ["citation_id", "document_id", "version", "page", "section", "char_start", "char_end", "chunk_id"] as const) {
      if (existing[field] === undefined && cand[field] !== undefined) {
        (existing as unknown as Record<string, unknown>)[field] = cand[field];
      }
    }
    if (cand.evidence !== undefined) {
      const merged = existing.evidence ?? [];
      const seen = new Set(merged.map(evidenceKey));
      for (const evidence of cand.evidence) {
        const id = evidenceKey(evidence);
        if (!seen.has(id)) {
          merged.push(evidence);
          seen.add(id);
        }
      }
      existing.evidence = merged;
    }
    if (
      (existing.displayTitle === undefined ||
        existing.displayTitle === existing.title) &&
      cand.displayTitle !== undefined &&
      cand.displayTitle !== cand.title
    ) {
      existing.displayTitle = cand.displayTitle;
    }
  };

  for (const s of summaries) {
    const key = docKeyOf({ reference: s.reference, url: s.url, title: s.title });
    upsert(key, {
      title: s.title,
      displayTitle: citationDisplayTitle(s.title, s.reference),
      url: s.url,
      snippet: s.summary.slice(0, SNIPPET_MAX),
      similarity_score: 0,
    });
  }
  for (const c of chunks) {
    const key = docKeyOf({ reference: c.baseRef, url: c.url, title: c.title });
    const score = Math.max(0, Math.min(1, c.retrievalScore));
    const evidence: CitationEvidence = {
      ...(c.citationId !== undefined ? { citation_id: c.citationId } : {}),
      ...(c.documentId !== undefined ? { document_id: c.documentId } : {}),
      ...(c.version !== undefined ? { version: c.version } : {}),
      ...(c.page !== undefined ? { page: c.page } : {}),
      ...(c.section !== undefined ? { section: c.section } : {}),
      ...(c.charStart !== undefined ? { char_start: c.charStart } : {}),
      ...(c.charEnd !== undefined ? { char_end: c.charEnd } : {}),
      ...(c.chunkId !== undefined ? { chunk_id: c.chunkId } : {}),
      text: c.content.slice(0, SNIPPET_MAX),
      score,
    };
    upsert(key, {
      title: c.title,
      displayTitle: citationDisplayTitle(c.title, c.baseRef ?? ""),
      url: c.url,
      snippet: c.content.slice(0, SNIPPET_MAX),
      similarity_score: score,
      ...(c.citationId !== undefined ? { citation_id: c.citationId } : {}),
      ...(c.documentId !== undefined ? { document_id: c.documentId } : {}),
      ...(c.version !== undefined ? { version: c.version } : {}),
      ...(c.page !== undefined ? { page: c.page } : {}),
      ...(c.section !== undefined ? { section: c.section } : {}),
      ...(c.charStart !== undefined ? { char_start: c.charStart } : {}),
      ...(c.charEnd !== undefined ? { char_end: c.charEnd } : {}),
      ...(c.chunkId !== undefined ? { chunk_id: c.chunkId } : {}),
      evidence: [evidence],
    });
  }

  return order.flatMap((key) => {
    const citation = byKey.get(key);
    // unreachable: every key in `order` was set in `byKey` by upsert() above
    return citation === undefined ? [] : [{ key, citation }];
  });
}

export interface GroundingResult {
  /** Ordered, deduplicated citations — position `i` is citation `[i+1]`. */
  orderedCitations: Citation[];
  /**
   * The document keys aligned 1:1 with {@link orderedCitations} (same order),
   * so a caller can register each citation under its stable key in a
   * per-execution registry and keep `[n]` consistent across nodes.
   */
  orderedKeys: string[];
  /** Grounding text sections to inject (overview and/or passages). */
  sections: string[];
}

/**
 * Builds the ordered citation list and the grounding sections from a tool
 * node's parsed search chunks + document summaries.
 *
 * @param chunks       parsed `search` hits (may be empty)
 * @param summaries    parsed `get_summaries` documents (may be empty)
 * @param summaryTotal the store's reported total document count (for the
 *                     pagination-capped header); 0 when unknown
 * @param opts.overviewCharBudget  hard char cap for the packed overview. When
 *                     omitted, defaults to {@link OVERVIEW_CHAR_BUDGET}. A
 *                     deep-research dossier can raise this (via the tool node's
 *                     `config.overviewCharBudget`) so ALL document titles fit
 *                     the coverage map instead of being capped to the leading
 *                     subset — the completeness lever for large aktes.
 */
export function buildGroundingSections(
  chunks: readonly RagChunk[],
  summaries: readonly RagSummary[],
  summaryTotal: number,
  opts?: { overviewCharBudget?: number },
): GroundingResult {
  // Effective overview budget: node-configurable, defaulting to the module
  // constant so all existing (non-dossier) tool nodes keep their bounded prompt.
  const overviewCharBudget =
    typeof opts?.overviewCharBudget === "number" &&
    Number.isFinite(opts.overviewCharBudget) &&
    opts.overviewCharBudget > 0
      ? opts.overviewCharBudget
      : OVERVIEW_CHAR_BUDGET;
  // One ordered, deduplicated citation list (summaries lead; search hits merge
  // into their summary entry or append). Shared with the LLM self-search
  // annotator via buildCitationEntries.
  const entries = buildCitationEntries(chunks, summaries);

  // Ordering of the emitted [n] list: when summaries are present their path
  // order leads (sequential overview); otherwise (generic search-only tool
  // node) fall back to score-descending so the most relevant source is [1] —
  // preserving the previous behaviour for non-dossier tool nodes.
  const orderedEntries =
    summaries.length > 0
      ? entries
      : [...entries].sort(
          (a, b) => b.citation.similarity_score - a.citation.similarity_score,
        );
  const orderedKeys = orderedEntries.map((e) => e.key);
  const orderedCitations: Citation[] = orderedEntries.map((e) => e.citation);
  const indexByKey = new Map<string, number>();
  orderedKeys.forEach((k, i) => {
    indexByKey.set(k, i + 1);
  });
  // Per-document citation lookup for the passages section (title/score).
  const byKey = new Map<string, Citation>(
    orderedEntries.map((e) => [e.key, e.citation]),
  );

  // Group the retrieved chunk TEXT by the SAME document key used for [n], so a
  // passage block is labelled with its document's citation number.
  const contentByDocKey = new Map<string, string[]>();
  for (const c of chunks) {
    if (c.content.trim() === "") continue;
    const key = docKeyOf({ reference: c.baseRef, url: c.url, title: c.title });
    const list = contentByDocKey.get(key);
    if (list) list.push(c.content);
    else contentByDocKey.set(key, [c.content]);
  }

  const sections: string[] = [];

  if (summaries.length > 0) {
    const shown = summaries.length;
    const total = summaryTotal > shown ? summaryTotal : shown;

    // Build overview lines. Each line leads with the document's stable citation
    // number `[n]` (so the model can cite the overview directly) and carries the
    // reference AFTER "Ref:" — deliberately NOT in square brackets, so `[n]`
    // unambiguously means the citation number while the reference stays
    // available as the get_document/get_summary argument.
    const overviewLine = (s: RagSummary, withBody: boolean): string => {
      const key = docKeyOf({
        reference: s.reference,
        url: s.url,
        title: s.title,
      });
      const n = indexByKey.get(key);
      const head = `[${n}] ${s.title} (Ref: ${s.reference})`;
      if (!withBody) return head;
      const rawBody = s.summary.trim();
      const body =
        rawBody !== ""
          ? rawBody.length > SUMMARY_BODY_MAX
            ? `${rawBody.slice(0, SUMMARY_BODY_MAX)}…`
            : rawBody
          : "(keine Zusammenfassung gespeichert)";
      return `${head}: ${body}`;
    };

    // Greedily pack overview lines under a hard character budget so the
    // injected prompt stays bounded no matter how many summaries were fetched.
    // Previously the titles-only fallback listed ALL documents unbounded, so a
    // large collection (e.g. 329 documents with long paths) overflowed the
    // model context and the LLM returned an empty response. Now we keep as many
    // LEADING documents as fit and tell the model to paginate for the rest.
    // Always includes at least one line so the overview is never empty.
    const packUnderBudget = (
      withBody: boolean,
    ): { text: string; count: number } => {
      let acc = 0;
      const out: string[] = [];
      for (const s of summaries) {
        const line = overviewLine(s, withBody);
        const add = (out.length > 0 ? 1 : 0) + line.length; // +1 for "\n"
        if (out.length > 0 && acc + add > overviewCharBudget) break;
        out.push(line);
        acc += add;
      }
      return { text: out.join("\n"), count: out.length };
    };

    // Prefer summaries WITH their bodies; if not all fetched docs fit that way,
    // fall back to a titles-only list (also budget-packed).
    const full = packUnderBudget(true);
    let overview: string;
    let listedCount: number;
    let withBody: boolean;
    if (full.count >= shown) {
      overview = full.text;
      listedCount = full.count;
      withBody = true;
    } else {
      const titlesOnly = packUnderBudget(false);
      overview = titlesOnly.text;
      listedCount = titlesOnly.count;
      withBody = false;
    }

    // The inline overview covers documents 0..listedCount-1 of the store.
    // Anything beyond that — not fetched at all (pagination) or dropped to keep
    // the prompt under budget — is reachable via the same offset instruction.
    const remaining = Math.max(0, total - listedCount);
    const numberingHint =
      `Every line starts with its citation number [n]; cite a document listed ` +
      `here inline as [n]. The value after "Ref:" is the argument for ` +
      `get_document/get_summary, NOT the citation number.`;
    let header: string;
    if (remaining > 0) {
      const kind = withBody
        ? `short summaries of the first ${listedCount}`
        : `document list (titles only) of the first ${listedCount}`;
      header =
        `${COLLECTION_OVERVIEW_MARKER} — ${kind} of ${OVERVIEW_TOTAL_LABEL} ` +
        `${total} documents in the collection (TRUNCATED — NOT complete; ` +
        `${remaining} more are NOT listed here). Do NOT treat this list as ` +
        `complete: for an EXACT document or file count use collection_stats; ` +
        `page through the remaining ${remaining} documents with get_summaries ` +
        `or list_documents using offset=${listedCount} (and onwards in steps). ` +
        `Use the list to decide which documents you need to read in full ` +
        `(get_document) or search specifically. ${numberingHint}`;
    } else {
      header =
        `${COLLECTION_OVERVIEW_MARKER} — short summaries of ALL ${listedCount} ` +
        `recorded documents in the collection. This is the complete document ` +
        `list. Use it to decide which documents you need to read in full ` +
        `(get_document) or search specifically. ${numberingHint}`;
    }

    sections.push(`${header}\n\n${overview}`);
  }

  if (contentByDocKey.size > 0) {
    // Relevant passages, displayed most-relevant-first but numbered with the
    // document's stable [n] (which may come from the overview above). This
    // keeps a passage and its overview entry on the SAME citation number.
    const passageKeys = [...contentByDocKey.keys()].sort(
      (a, b) =>
        (byKey.get(b)?.similarity_score ?? 0) -
        (byKey.get(a)?.similarity_score ?? 0),
    );
    const sourceBlocks = passageKeys.map((key) => {
      const n = indexByKey.get(key);
      const title = byKey.get(key)?.title ?? key;
      const body = (contentByDocKey.get(key) ?? []).join("\n\n").trim();
      return body !== "" ? `[${n}] ${title}\n${body}` : `[${n}] ${title}`;
    });
    sections.push(
      `${RELEVANT_PASSAGES_MARKER} (ordered by relevance to the question). ` +
        `Cite used sources inline as [n] (each used source separately, for ` +
        `example [1][3]); the [n] are the same as in the ` +
        `${COLLECTION_OVERVIEW_MARKER}. Do not invent citations.` +
        `\n\n${sourceBlocks.join("\n\n")}`,
    );
  } else if (orderedCitations.length > 0 && summaries.length === 0) {
    // Citations without any chunk text or overview (a non-vectorsearch tool
    // that still produced sources) — titles-only numbered list.
    sections.push(
      `${RELEVANT_SOURCES_MARKER} (numbered). Cite used sources inline as [n]; ` +
        `do not invent citations.\n\n` +
        orderedCitations.map((c, i) => `[${i + 1}] ${c.title}`).join("\n"),
    );
  }

  return { orderedCitations, orderedKeys, sections };
}
