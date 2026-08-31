// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Skill index rendering (`src/assistants/skill-index.ts`)
 *
 * Progressive disclosure for learned procedures. Two stages:
 *
 *   Stage 1 — the INDEX. One line per skill: its name and a single sentence
 *             stating when it applies. Injected into every turn. Bounded.
 *   Stage 2 — the BODY. Read on demand through the `skill_read` tool, served
 *             whole.
 *
 * ## Why the index is not relevance-ranked
 *
 * The obvious design ranks skills by similarity to the user's query and injects
 * the top few. It is wrong here, and the reason is prompt caching: the index sits
 * in the cacheable prefix, so a per-query ordering rewrites that prefix on every
 * turn and the KV cache never warms. The measured cost of that (see
 * `UsageAccumulator.cachedPromptTokens`) is larger than the cost of carrying a
 * few extra index lines.
 *
 * So the index is **turn-invariant**: the same assistant renders the same index
 * bytes for every turn until its skill set actually changes. Ordering is
 * lexicographic by `sortKey`. When the set exceeds the budget, the entries that
 * survive are chosen by a *stable* signal (`useCount`, then `sortKey`) — never by
 * the current query.
 *
 * Query-time relevance is not lost, it moves: `skill_search` lets the model rank
 * against its own question when the index is not enough. That trades one extra
 * round trip in the rare case for a warm cache in the common one.
 *
 * ## Why bodies are served whole
 *
 * `skill_read` has no offset/limit parameter, deliberately. Given a window, a
 * model treats the first window as the whole document and acts on a truncated
 * procedure. A skill body that does not fit is a skill that must be split — the
 * write path bounds it (`SKILL_BODY_MAX_CHARS`) so the read path never has to.
 *
 * No `any` at module boundaries.
 */

import {
  SKILL_INDEX_MAX_CHARS,
  SKILL_INDEX_MAX_ENTRIES,
  SKILL_TRIGGER_MAX_CHARS,
  type SkillRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Sort key
// ---------------------------------------------------------------------------

/**
 * Derives the stable prompt-ordering key for a skill.
 *
 * Lowercased so ordering does not depend on how the author capitalised the name,
 * and every Unicode control character (`\p{Cc}` — NUL, tab, newline, the C1 block)
 * is stripped so the key stays safe as a Postgres `text` value and cannot smuggle
 * a line break into the rendered index (the same constraint that shaped the
 * memory-collection key).
 */
export function skillSortKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\p{Cc}/gu, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Index entry
// ---------------------------------------------------------------------------

/** The minimal projection the index needs — cheap to select and to sort. */
export interface SkillIndexEntry {
  id: string;
  name: string;
  triggerLine: string;
  sortKey: string;
  /**
   * Stable popularity signal used for budget-driven selection. Turn-invariant
   * within a turn (it is read once at context build), so including it in the
   * selection does not destabilise the prompt within a conversation.
   */
  useCount: number;
  /** True while the skill is being validated by a canary. */
  canary?: boolean;
}

/** Projects a full record onto the index entry shape. */
export function toIndexEntry(skill: SkillRecord): SkillIndexEntry {
  return {
    id: skill.id,
    name: skill.name,
    triggerLine: skill.triggerLine,
    sortKey: skill.sortKey,
    useCount: skill.useCount,
    ...(skill.status === "canary" ? { canary: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Chooses which skills appear in the index when the set exceeds the budget.
 *
 * Selection signals, in order: `useCount` descending (a procedure that has
 * proven useful stays visible), then `sortKey` ascending as the tie-break so the
 * result is a total order and therefore reproducible. Neither depends on the
 * current query, which is the property that keeps the rendered index stable.
 *
 * Returns the selection already in RENDER order (by `sortKey`), not in selection
 * order, so the caller cannot accidentally render by popularity and reorder the
 * prefix whenever a counter increments.
 */
export function selectIndexEntries(
  entries: readonly SkillIndexEntry[],
  options: { maxEntries?: number } = {},
): { selected: SkillIndexEntry[]; omitted: number } {
  const maxEntries =
    options.maxEntries !== undefined &&
    Number.isFinite(options.maxEntries) &&
    options.maxEntries > 0
      ? Math.floor(options.maxEntries)
      : SKILL_INDEX_MAX_ENTRIES;

  if (entries.length <= maxEntries) {
    return { selected: sortForRender(entries), omitted: 0 };
  }
  const ranked = [...entries].sort((a, b) => {
    if (b.useCount !== a.useCount) return b.useCount - a.useCount;
    return a.sortKey.localeCompare(b.sortKey);
  });
  const kept = ranked.slice(0, maxEntries);
  return {
    selected: sortForRender(kept),
    omitted: entries.length - kept.length,
  };
}

/** Total, locale-independent render order. */
function sortForRender(entries: readonly SkillIndexEntry[]): SkillIndexEntry[] {
  return [...entries].sort((a, b) => {
    const bySortKey = a.sortKey.localeCompare(b.sortKey);
    // `sortKey` is derived from a name that is unique per assistant, so a tie is
    // only possible for two names differing solely in case. Falling through to
    // the id keeps the order total regardless.
    return bySortKey !== 0 ? bySortKey : a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Trigger line normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a trigger line for storage.
 *
 * Single-line and hard-bounded: this string is injected once per skill on every
 * turn, so it is the tightest budget in the system. A trailing period is removed
 * for visual consistency across entries, which also removes one source of
 * pointless prefix churn when two authors disagree about punctuation.
 */
export function normalizeTriggerLine(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return collapsed.length > SKILL_TRIGGER_MAX_CHARS
    ? `${collapsed.slice(0, SKILL_TRIGGER_MAX_CHARS - 1)}…`
    : collapsed;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface SkillIndexRenderResult {
  /** Prompt text. Empty when the assistant has no skills. */
  text: string;
  chars: number;
  /** Skills listed in {@link text}. */
  renderedCount: number;
  /** Skills that exist but did not fit. */
  omittedCount: number;
  /** True when anything was omitted for any reason. */
  truncated: boolean;
  /**
   * Ids rendered under canary treatment. Recorded on the turn so an outcome can
   * later be attributed to the right canary arm — a fact captured where it
   * happens rather than reconstructed from the transcript afterwards.
   */
  canaryIds: string[];
}

/** Heading of the injected index block. */
const INDEX_HEADING = "## Your learned procedures";

/**
 * Renders the stage-1 index.
 *
 * The instruction line is part of the block on purpose: an index without an
 * explanation of how to reach the bodies is a list the model reads and ignores.
 * Naming the tool here is safe because `skill_read` is registered exactly when
 * this block is rendered — a description that names a tool which gating removed
 * would be hallucination bait.
 */
export function renderSkillIndex(
  entries: readonly SkillIndexEntry[],
  options: { maxEntries?: number; maxChars?: number } = {},
): SkillIndexRenderResult {
  const maxChars =
    options.maxChars !== undefined && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : SKILL_INDEX_MAX_CHARS;

  if (entries.length === 0) {
    return {
      text: "",
      chars: 0,
      renderedCount: 0,
      omittedCount: 0,
      truncated: false,
      canaryIds: [],
    };
  }

  // The selection's own omitted count is not tracked separately: the footer
  // count is derived from how many entries actually survived rendering, which
  // subsumes both the entry-count cap and the character cap.
  const { selected } = selectIndexEntries(entries, options);
  const header = [
    INDEX_HEADING,
    "Procedures you learned earlier. The line after each name says when it applies.",
    "Call `skill_read` with the name to get the full procedure before following it.",
    "",
  ];

  // Kept alongside their entries so trimming below can recompute the canary ids
  // from what actually survived. Deriving them during the first pass and then
  // dropping lines would report a canary treatment the model never saw, which
  // would attribute a turn's outcome to the wrong arm.
  const rendered: { entry: SkillIndexEntry; line: string }[] = [];
  let bodyChars = 0;
  const headerChars = header.join("\n").length;

  for (const entry of selected) {
    const line = `- **${entry.name}** — ${entry.triggerLine}`;
    // +1 for the newline joining this line to the previous block.
    if (headerChars + bodyChars + line.length + 1 > maxChars) {
      // Stop at the first line that does not fit rather than skipping it and
      // trying a shorter one later: skipping would make the rendered set depend
      // on individual line lengths, and the entries are already in a deliberate
      // order.
      break;
    }
    rendered.push({ entry, line });
    bodyChars += line.length + 1;
  }

  // The footer counts against the budget like everything else. It is appended
  // after the fact, so trim lines until the COMPLETE block fits — an earlier
  // version reserved nothing for it and overshot `maxChars` by the footer's
  // length, which defeats the purpose of having a hard cap.
  let text = composeIndex(header, rendered, entries.length);
  while (text.length > maxChars && rendered.length > 0) {
    rendered.pop();
    text = composeIndex(header, rendered, entries.length);
  }

  if (rendered.length === 0) {
    // The budget cannot hold even one entry with its footer. Emitting the header
    // alone would be a heading with no content: tokens spent to say nothing.
    return {
      text: "",
      chars: 0,
      renderedCount: 0,
      omittedCount: entries.length,
      truncated: true,
      canaryIds: [],
    };
  }

  const totalOmitted = entries.length - rendered.length;
  return {
    text,
    chars: text.length,
    renderedCount: rendered.length,
    omittedCount: totalOmitted,
    truncated: totalOmitted > 0,
    canaryIds: rendered.filter(({ entry }) => entry.canary === true).map(({ entry }) => entry.id),
  };
}

/**
 * Assembles the final block. Separate from the budget loop so the loop can
 * measure the exact bytes that will be emitted, footer included.
 */
function composeIndex(
  header: readonly string[],
  rendered: readonly { line: string }[],
  totalEntries: number,
): string {
  if (rendered.length === 0) return "";
  const omitted = totalEntries - rendered.length;
  const footer =
    omitted > 0
      ? [
          "",
          `(${omitted} further ${omitted === 1 ? "procedure" : "procedures"} exist but are not listed here. ` +
            "Use `skill_search` to find one by description when the list above does not cover your task.)",
        ]
      : [];
  return [...header, ...rendered.map((r) => r.line), ...footer].join("\n");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** One search hit with the score that produced it. */
export interface SkillSearchHit {
  entry: SkillIndexEntry;
  score: number;
}

/**
 * Ranks skills against a free-text query.
 *
 * A deliberately simple lexical scorer rather than an embedding lookup: this
 * backs the `skill_search` tool, which the model calls only when the stable index
 * did not already answer its need. Adding an embedding round trip there would
 * spend a model-visible round trip AND a network round trip to rank at most a few
 * dozen short strings. If a deployment later wants semantic ranking, the
 * platform's existing `ToolIndex` is the right seam — this function is not.
 *
 * Scoring: a name match outweighs a trigger match (the name is what the author
 * chose as the handle), token coverage outweighs a single long match, and the
 * `sortKey` breaks ties so results are reproducible.
 */
export function searchSkills(
  entries: readonly SkillIndexEntry[],
  query: string,
  limit = 5,
): SkillSearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const hits: SkillSearchHit[] = [];
  for (const entry of entries) {
    const nameTokens = new Set(tokenize(entry.name));
    const triggerTokens = new Set(tokenize(entry.triggerLine));
    let score = 0;
    for (const token of tokens) {
      if (nameTokens.has(token)) score += 3;
      else if (triggerTokens.has(token)) score += 1;
      // Prefix match catches inflections ("reporting" vs "report") without a
      // stemmer, which would need per-language data this scorer does not have.
      else if ([...nameTokens].some((n) => n.startsWith(token))) score += 2;
      else if ([...triggerTokens].some((t) => t.startsWith(token))) score += 0.5;
    }
    if (score > 0) hits.push({ entry, score });
  }
  return hits
    .sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.entry.sortKey.localeCompare(b.entry.sortKey),
    )
    .slice(0, Math.max(1, Math.floor(limit)));
}

/** Lowercased word tokens, 2+ characters. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}
