// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/docpass/text-continuation.ts
 *
 * Paragraphs and lists that run over a page break (contract 2.3). Search
 * chunks per page, so a requirement whose sentence ends on the next page was
 * cut into two units, neither holding the whole sentence. The document pass
 * sees page N+1's base record (already staged) while folding page N, decides
 * deterministically whether the last text block of N continues on N+1, and
 * marks both sides with the table vocabulary:
 *
 *   page N    last block  `continues: true`, `continuationText` = the leading
 *                         fragment of its continuation up to the first
 *                         sentence end (bounded);
 *   page N+1  first block `continuationOf` = the id of that block.
 *
 * The decision uses the base record of N+1, which stays untouched until N+1
 * commits, so a resume decides the same way.
 */

import type { Block, PageRecord } from "@atf/extract-contract/v2";

type TextLike = Extract<Block, { type: "paragraph" | "footnote" | "code" | "list" }>;

/** The persisted part: the block on the previous page that continues. */
export interface TextContinuationState {
	/** Id of the last text block of the previous page when it continues, else null. */
	openBlockId: string | null;
}

export function emptyTextContinuationState(): TextContinuationState {
	return { openBlockId: null };
}

export function parseTextContinuationState(value: unknown): TextContinuationState {
	if (typeof value !== "object" || value === null) return emptyTextContinuationState();
	const id = (value as { openBlockId?: unknown }).openBlockId;
	return { openBlockId: typeof id === "string" && id !== "" ? id : null };
}

/** Cap on the carried fragment. */
const MAX_CONTINUATION_CHARS = 400;

const PAGE_LABEL = /^(?:seite|page|s\.)\s*\d+(?:\s*(?:von|of|\/)\s*\d+)?$/i;

/**
 * The page's content blocks in reading order, without running headers,
 * footers and page labels that a transcription may have kept as paragraphs
 * (`furniture` is the detected furniture of the page being folded; a
 * document's running header repeats on the next page).
 */
function contentBlocks(record: PageRecord, furniture: PageRecord["furniture"]): Block[] {
	const noise = new Set(
		[furniture?.header, furniture?.footer, furniture?.pageLabel]
			.filter((t): t is string => typeof t === "string" && t.trim() !== "")
			.map((t) => t.replace(/\s+/g, " ").trim()),
	);
	return record.blocks.filter((b) => {
		if (b.type !== "paragraph") return true;
		const text = b.text.replace(/\s+/g, " ").trim();
		return !(noise.has(text) || PAGE_LABEL.test(text));
	});
}

function isParagraphLike(block: Block | undefined): block is TextLike {
	return block !== undefined && (block.type === "paragraph" || block.type === "list");
}

function textOf(block: TextLike): string {
	return block.type === "list" ? block.items.join("\n") : block.text;
}

/** A line that ends a sentence (or a list item that clearly closes). */
const TERMINAL = /[.!?…:;]["'»«“”’)\]]*\s*$/;

/**
 * Does `last` (the final block of page N) continue into `first` (the first
 * block of page N+1)?
 *  - both are paragraphs, or both are lists;
 *  - a paragraph ends without sentence punctuation, and either it ends in a
 *    hyphen / comma or the next page starts in lower case (German nouns are
 *    upper case, so a hyphen or comma is the stronger signal);
 *  - a list continues when the next page resumes the list.
 */
export function continuesAcrossPage(last: Block | undefined, first: Block | undefined): boolean {
	if (!isParagraphLike(last) || !isParagraphLike(first)) return false;
	if (last.type !== first.type) return false;
	if (last.type === "list") return true;
	const tail = last.text.trimEnd();
	const head = textOf(first).trimStart();
	if (tail === "" || head === "") return false;
	if (TERMINAL.test(tail)) return false;
	if (/[-‐,]$/.test(tail)) return true;
	return /^[a-zäöüß0-9(]/.test(head);
}

/** The leading fragment of `block` up to its first sentence end, bounded. */
export function leadingFragment(block: Block): string {
	const text = isParagraphLike(block) ? textOf(block).trim() : "";
	if (text === "") return "";
	const end = /[.!?…](?=\s|$)/.exec(text);
	if (end !== null && end.index < MAX_CONTINUATION_CHARS) return text.slice(0, end.index + 1);
	if (text.length <= MAX_CONTINUATION_CHARS) return text;
	const cut = text.lastIndexOf(" ", MAX_CONTINUATION_CHARS);
	return text.slice(0, cut > 0 ? cut : MAX_CONTINUATION_CHARS);
}

/**
 * Mark the continuation on `record` (page N, in place): its first block
 * continues the previous page's open block (from `state`), and its last block
 * continues into `next` (page N+1's base record). Returns the state for the
 * next page.
 */
export function applyTextContinuation(
	record: PageRecord,
	next: PageRecord | null | undefined,
	state: TextContinuationState,
): TextContinuationState {
	const blocks = contentBlocks(record, record.furniture);
	const first = blocks[0];
	if (state.openBlockId !== null && isParagraphLike(first)) first.continuationOf = state.openBlockId;
	const last = blocks[blocks.length - 1];
	const nextFirst =
		next != null && next.page === record.page + 1 ? contentBlocks(next, record.furniture)[0] : undefined;
	if (isParagraphLike(last) && nextFirst !== undefined && continuesAcrossPage(last, nextFirst)) {
		const fragment = leadingFragment(nextFirst);
		last.continues = true;
		if (fragment !== "") last.continuationText = fragment;
		return { openBlockId: last.id };
	}
	if (isParagraphLike(last)) {
		delete last.continues;
		delete last.continuationText;
	}
	return emptyTextContinuationState();
}
