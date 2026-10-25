// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * contextual-header.ts
 *
 * The contextual embedding header (task 3.3 — "Kontextueller
 * Embedding-Header", which REPLACES defect D1).
 *
 * D1 was the old behaviour of concatenating EVERY page summary into one
 * document-wide chain and prepending it to EVERY chunk's embedding input. On a
 * long document that chain grew without bound and blew the embedding model's
 * 8192-token input limit. The v2 header is the opposite: a SMALL, per-unit
 * context capped at ~15 % of the chunk token budget (Requirement 11.4), with NO
 * whole-document summary chain.
 *
 * A header carries, most-important-first:
 *   1. the document title,
 *   2. the section path (heading breadcrumb),
 *   3. the page range,
 *   4. the unit type,
 *   5. a summary of the page(s) the unit covers — the truncatable tail.
 *
 * The header is prepended to a unit's `embedInput` ONLY (the text sent to the
 * embedding model). It is deliberately NOT added to the stored `content` /
 * full-text-search text: the header is retrieval context, not document content,
 * so polluting FTS with it would make a query match a chunk on its neighbours'
 * titles/summaries rather than its own words.
 *
 * The 15 % cap is measured with the task-3.1 token counter (`countBatch`), the
 * same tokenizer the embedding model uses, and enforced by dropping the LEAST
 * important parts last: the summary is trimmed (word-wise, then dropped) before
 * any of title / section path / pages / type is touched. When even the fixed
 * head (title + section path + pages + type) exceeds the budget the header is
 * still emitted whole — a header is context, and a hard mid-word cut of the
 * title would be worse than a slightly-over-budget head; in practice the fixed
 * head is a handful of tokens and this never triggers.
 *
 * Determinism (Requirement 5.5 nuance): the header changes a chunk's
 * `embedInput` (and therefore its vector) but NEVER its `unitId` — ids are
 * content/coordinate based (batch-unit-builder.ts), so a re-embed with the same
 * header reproduces the same vector and upserts in place. The optional
 * CONTEXTUAL_CHUNK_LLM placement sentence (Requirement 11.6) is model-generated
 * and therefore NOT byte-reproducible; when that flag is on the vector is not
 * guaranteed identical across runs. That is acceptable: it is an offline
 * enrichment, and the id (hence the row identity) is unaffected.
 */

/** The default fraction of the chunk token budget a header may occupy (Req 11.4). */
export const DEFAULT_CONTEXT_HEADER_MAX_FRACTION = 0.15;

/** The token-counter surface the header needs — matches task 3.1's `countBatch`. */
export interface HeaderTokenCounter {
  countBatch(texts: string[], signal?: AbortSignal): Promise<number[]>;
}

/** The per-unit context the header is built from. */
export interface HeaderContext {
  /** Document title (from `document.begin`); omitted when unknown. */
  title?: string | undefined;
  /** Section path / heading breadcrumb for the unit; may be empty. */
  sectionPath: string[];
  /** First page the unit covers. */
  pageStart: number;
  /** Last page the unit covers. */
  pageEnd: number;
  /** Unit type ("chunk" | "table" | "figure" | …). */
  unitType: string;
  /**
   * Summary of the page(s) the unit covers — the truncatable tail of the
   * header. Comes from the page record's own `summary` at build time (see the
   * ordering note in batch-unit-builder.ts). Optional/empty when absent.
   */
  pageSummary?: string | undefined;
  /**
   * Optional CONTEXTUAL_CHUNK_LLM placement sentence (Req 11.6). When present it
   * is appended after the summary as its own labelled line. It is treated as
   * part of the truncatable tail so a long sentence cannot push the header over
   * budget.
   */
  placementSentence?: string | undefined;
}

export interface BuildHeaderOptions {
  /** Chunk token budget (Req 11.2, default 500). The cap is a fraction of this. */
  budgetTokens: number;
  /** Fraction of the budget the header may occupy. Default 0.15 (15 %). */
  maxFraction?: number;
  /** Token counter used to measure the header against the cap. */
  tokenCounter: HeaderTokenCounter;
  signal?: AbortSignal;
}

/** German field labels, matching the German-first convention across the codebase. */
const LABEL_TITLE = "Titel";
const LABEL_SECTION = "Abschnitt";
const LABEL_PAGES = "Seiten";
const LABEL_PAGE = "Seite";
const LABEL_TYPE = "Typ";
const LABEL_SUMMARY = "Zusammenfassung";
const LABEL_CONTEXT = "Kontext";

/** One "Label: value" line, or null when the value is empty. */
function line(label: string, value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  return `${label}: ${v}`;
}

/** The page component: "Seite 4" for a single page, "Seiten 4–6" for a range. */
function pagesValue(pageStart: number, pageEnd: number): string {
  return pageStart === pageEnd
    ? `${LABEL_PAGE} ${pageStart}`
    : `${LABEL_PAGES} ${pageStart}\u2013${pageEnd}`;
}

/**
 * The fixed head of the header — title, section path, pages, type. These are
 * kept whole; only the summary tail is truncated to fit the budget.
 */
function buildHead(ctx: HeaderContext): string[] {
  const lines: string[] = [];
  const title = line(LABEL_TITLE, ctx.title);
  if (title) lines.push(title);
  const section =
    ctx.sectionPath.length > 0
      ? line(LABEL_SECTION, ctx.sectionPath.join(" \u203a "))
      : null;
  if (section) lines.push(section);
  lines.push(pagesValue(ctx.pageStart, ctx.pageEnd));
  lines.push(`${LABEL_TYPE}: ${ctx.unitType}`);
  return lines;
}

/** The truncatable tail lines — the page summary and, if any, the LLM sentence. */
function buildTail(ctx: HeaderContext): string[] {
  const lines: string[] = [];
  const summary = line(LABEL_SUMMARY, ctx.pageSummary);
  if (summary) lines.push(summary);
  const placement = line(LABEL_CONTEXT, ctx.placementSentence);
  if (placement) lines.push(placement);
  return lines;
}

/**
 * Build the contextual header text for a unit, capped at `maxFraction` of the
 * chunk token budget and measured with the token counter.
 *
 * The head (title / section / pages / type) is always kept. The tail (summary,
 * then the optional LLM placement sentence) is trimmed word-by-word — the LLM
 * sentence first, then the summary — until the whole header fits. When even the
 * head alone exceeds the cap the head is returned as-is (see the module note).
 *
 * Returns the header string WITHOUT a trailing separator; use
 * {@link prependHeader} to attach it to a unit's embed input.
 */
export async function buildContextualHeader(
  ctx: HeaderContext,
  opts: BuildHeaderOptions,
): Promise<string> {
  const maxFraction = opts.maxFraction ?? DEFAULT_CONTEXT_HEADER_MAX_FRACTION;
  const capTokens = Math.max(1, Math.floor(opts.budgetTokens * maxFraction));

  const head = buildHead(ctx);
  const tail = buildTail(ctx);

  // Fast path: no tail to trim.
  if (tail.length === 0) return head.join("\n");

  const full = [...head, ...tail].join("\n");
  const [fullTokens] = await opts.tokenCounter.countBatch([full], opts.signal);
  if ((fullTokens ?? heuristic(full)) <= capTokens) return full;

  // Over budget: shrink the tail. Trim from the end (LLM sentence first, then
  // the summary), dropping whole words, re-measuring as we go.
  const headText = head.join("\n");
  let tailWords = tail.join("\n").split(/\s+/).filter((w) => w !== "");

  while (tailWords.length > 0) {
    tailWords = tailWords.slice(0, -1);
    const candidate =
      tailWords.length > 0 ? `${headText}\n${tailWords.join(" ")}` : headText;
    const [tokens] = await opts.tokenCounter.countBatch([candidate], opts.signal);
    if ((tokens ?? heuristic(candidate)) <= capTokens) return candidate;
  }

  // Even the head exceeds the cap: emit the head whole rather than cutting a
  // title mid-word. In practice the head is a few tokens and never gets here.
  return headText;
}

/**
 * Prepend a header to a unit's embed input. The header and the body are
 * separated by a blank line so the model sees them as distinct. An empty header
 * returns the body unchanged.
 */
export function prependHeader(header: string, embedInput: string): string {
  const h = header.trim();
  if (h === "") return embedInput;
  return `${h}\n\n${embedInput}`;
}

/** The minimal unit shape the header pass reads and mutates. */
export interface HeaderableUnit {
  unitType: string;
  embedInput: string;
  /** Stored/FTS text — the pass NEVER touches this (the header is not content). */
  content: string;
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
  pageSummary?: string | undefined;
  unitId?: string | undefined;
}

/** The text-LLM surface the CONTEXTUAL_CHUNK_LLM stage uses (a subset of SummaryClient). */
export interface PlacementLlm {
  placeInContext(
    excerpt: string,
    context: string,
  ): Promise<{ ok: true; result: string } | { ok: false; error: { code: string } }>;
}

export interface ApplyHeadersOptions {
  /** Document title for the header; falls back to a document reference upstream. */
  documentTitle: string;
  /** Chunk token budget (Req 11.2); the header cap is a fraction of it. */
  budgetTokens: number;
  /** Fraction of the budget the header may occupy. Default 0.15. */
  maxFraction?: number;
  /** Token counter used to measure the header against the cap. */
  tokenCounter: HeaderTokenCounter;
  /** Text-LLM for the per-chunk placement sentence (Req 11.6). Omit to disable. */
  placementLlm?: PlacementLlm | undefined;
  /** Enable the per-chunk placement sentence. No-op without `placementLlm`. Default false. */
  contextualChunkLlm?: boolean;
  /** Optional debug logger for LLM degradation. */
  onLlmDegrade?: (unitId: string | undefined, reason: string) => void;
  signal?: AbortSignal;
}

/** Unit types that receive a contextual header. Summary units ARE context already. */
const HEADER_TYPES = new Set(["chunk", "table", "figure"]);

/**
 * Prepend the contextual header to each `chunk`/`table`/`figure`
 * unit's `embedInput`, in place. `content` (the stored/FTS text) is never
 * touched. Summary/section/page/document units are skipped — they already are
 * the context, so a header on them would be circular.
 *
 * When {@link ApplyHeadersOptions.contextualChunkLlm} is on and a
 * {@link ApplyHeadersOptions.placementLlm} is present, a per-CHUNK placement
 * sentence is generated first and folded into the header. A text-LLM failure
 * (a non-ok result OR a thrown error) degrades to the header without the
 * sentence and never propagates — the batch must not fail for an optional
 * enrichment (Req 11.6).
 */
export async function applyContextualHeaders(
  units: HeaderableUnit[],
  opts: ApplyHeadersOptions,
): Promise<void> {
  for (const unit of units) {
    if (!HEADER_TYPES.has(unit.unitType)) continue;

    let placementSentence: string | undefined;
    if (
      opts.contextualChunkLlm &&
      opts.placementLlm &&
      unit.unitType === "chunk"
    ) {
      placementSentence = await placementFor(unit, opts);
    }

    const header = await buildContextualHeader(
      {
        title: opts.documentTitle,
        sectionPath: unit.sectionPath,
        pageStart: unit.pageStart,
        pageEnd: unit.pageEnd,
        unitType: unit.unitType,
        pageSummary: unit.pageSummary,
        placementSentence,
      },
      {
        budgetTokens: opts.budgetTokens,
        maxFraction: opts.maxFraction ?? DEFAULT_CONTEXT_HEADER_MAX_FRACTION,
        tokenCounter: opts.tokenCounter,
        signal: opts.signal,
      },
    );
    unit.embedInput = prependHeader(header, unit.embedInput);
  }
}

/** Ask the LLM for one placement sentence; degrade to undefined on any failure. */
async function placementFor(
  unit: HeaderableUnit,
  opts: ApplyHeadersOptions,
): Promise<string | undefined> {
  const llm = opts.placementLlm;
  if (!llm) return undefined;
  const contextParts = [
    `${LABEL_TITLE}: ${opts.documentTitle}`,
    unit.sectionPath.length > 0
      ? `${LABEL_SECTION}: ${unit.sectionPath.join(" \u203a ")}`
      : "",
    unit.pageSummary ? `${LABEL_SUMMARY}: ${unit.pageSummary}` : "",
  ].filter((p) => p !== "");
  try {
    const res = await llm.placeInContext(unit.embedInput, contextParts.join("\n"));
    if (res.ok) return res.result;
    opts.onLlmDegrade?.(unit.unitId, res.error.code);
    return undefined;
  } catch (cause) {
    opts.onLlmDegrade?.(unit.unitId, String(cause));
    return undefined;
  }
}

/** ~4 chars/token fallback, mirroring the token counter's own heuristic. */
function heuristic(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}
