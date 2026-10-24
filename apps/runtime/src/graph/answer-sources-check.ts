// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Post-answer sources check (`src/graph/answer-sources-check.ts`)
 *
 * Opt-in, deterministic completion of an LLM answer's sources section
 * (`config.sourcesCheck` on `llm` nodes, default off). Local models cite `[n]`
 * inline but regularly forget some of those numbers in the closing
 * `## Quellen` list, even when the prompt demands the self-check twice
 * (local-model traces 26ce0b42, 7172af01, 33f5e48c, 4279aef7). The check
 *
 * - appends every inline-cited `[n]` that the sources section lacks, built
 *   ONLY from the source registered under that number in this execution
 *   (never invented — an unregistered `[n]` is reported, not listed);
 * - creates the section when the answer has none (or when it is not the
 *   answer's last section, because the completion is streamed as a trailing
 *   chunk and can only ever be appended);
 * - optionally (separate switch) removes the observed pseudo marker
 *   `[Regel: …]`. Nothing else in brackets is touched: units, values or
 *   labels in square brackets are legitimate content.
 *
 * Pure and dependency-free apart from the `Citation` type, so it is
 * unit-testable without the handler.
 */

import type { Citation } from "../types/openai.js";

export interface SourcesCheckConfig {
  /** Append missing cited `[n]` entries to the sources section. */
  completeSection: boolean;
  /** Markdown heading of the sources section (matched by its text). */
  heading: string;
  /** Remove `[Regel: …]` pseudo markers from not-yet-streamed answer text. */
  stripRuleMarkers: boolean;
  /**
   * Hard-retry an answer that cites `[n]` outside the registered range
   * `1..citationCount` (local models hallucinate plausible-looking numbers,
   * e.g. `[491]` when one source is registered). Requires the execution to
   * expose `runtime.citationCount`; only applies while the answer text has not
   * been streamed yet. Default off: out-of-range markers stay a warn-only
   * node-end diagnostic.
   */
  rejectOutOfRangeMarkers: boolean;
}

export const DEFAULT_SOURCES_HEADING = "## Quellen";

/**
 * Reads `config.sourcesCheck`. Returns `undefined` unless at least one switch
 * is explicitly `true`, so an absent or malformed value keeps today's
 * behaviour.
 */
export function parseSourcesCheckConfig(
  raw: unknown,
): SourcesCheckConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const completeSection = record.completeSection === true;
  const stripRuleMarkers = record.stripRuleMarkers === true;
  const rejectOutOfRangeMarkers = record.rejectOutOfRangeMarkers === true;
  if (!completeSection && !stripRuleMarkers && !rejectOutOfRangeMarkers) {
    return undefined;
  }
  const heading =
    typeof record.heading === "string" && headingText(record.heading) !== ""
      ? record.heading.trim()
      : DEFAULT_SOURCES_HEADING;
  return { completeSection, heading, stripRuleMarkers, rejectOutOfRangeMarkers };
}

/** `[Regel: …]` with an optional single leading space/tab (no line breaks). */
const RULE_MARKER_RE = /[ \t]?\[Regel:[^\]\n]*\]/g;

/** Removes `[Regel: …]` pseudo markers; returns the removed markers. */
export function stripRuleMarkers(text: string): {
  text: string;
  removed: string[];
} {
  const removed: string[] = [];
  const stripped = text.replace(RULE_MARKER_RE, (match) => {
    removed.push(match.trim());
    return "";
  });
  return { text: stripped, removed };
}

/** `[Regel: …]` markers still present in `text` (e.g. already streamed). */
export function findRuleMarkers(text: string): string[] {
  return [...text.matchAll(RULE_MARKER_RE)].map((match) => match[0].trim());
}

const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const CITATION_RE = /\[(\d+)\]/g;
const LISTED_ENTRY_RE = /^[ \t]*(?:[-*+][ \t]+|\d+\.[ \t]+)?\*{0,2}\[(\d+)\]/;

function headingText(heading: string): string {
  const match = HEADING_RE.exec(heading.trim());
  return (match?.[1] ?? heading.replace(/^#+/, "")).trim().toLowerCase();
}

/** Blanks fenced code so `[n]` inside code is neither cited nor listed. */
function blankFencedCode(lines: string[]): string[] {
  let inFence = false;
  return lines.map((line) => {
    const fence = /^[ \t]*(```|~~~)/.test(line);
    if (fence) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

/**
 * Citation markers `[n]` in `text` outside the valid range `1..count`
 * (deduplicated, ascending). `[n]` inside fenced code is ignored, matching
 * {@link completeSourcesSection}. An empty array means every marker resolves
 * against the registered sources.
 */
export function findOutOfRangeMarkers(
  text: string,
  count: number,
): number[] {
  const found = new Set<number>();
  for (const line of blankFencedCode(text.split("\n"))) {
    for (const match of line.matchAll(CITATION_RE)) {
      const n = Number(match[1]);
      if (n < 1 || n > count) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}

function pageLabel(citation: Citation): string | undefined {
  const { page_start: start, page_end: end, page } = citation;
  if (typeof start === "number") {
    return typeof end === "number" && end !== start
      ? `S. ${start}–${end}`
      : `S. ${start}`;
  }
  if (page !== undefined && String(page).trim() !== "") return `S. ${page}`;
  return undefined;
}

/** One sources line built only from registered citation metadata. */
export function formatSourceEntry(index: number, citation: Citation): string {
  const title = (citation.displayTitle ?? citation.title).trim();
  const parts = [`[${index}] ${title.length > 0 ? title : "Quelle"}`];
  if (citation.version !== undefined && citation.version.trim() !== "") {
    parts.push(`Version ${citation.version.trim()}`);
  }
  const page = pageLabel(citation);
  if (page !== undefined) parts.push(page);
  const ref = (citation.document_id ?? citation.url).trim();
  return ref.length > 0 && ref !== title
    ? `${parts.join(", ")}; Ref: ${ref}`
    : parts.join(", ");
}

export interface SourcesCompletion {
  /** Text to append to the answer (empty when nothing is missing). */
  appendix: string;
  /** Cited numbers added to the sources section, ascending. */
  appended: number[];
  /** Cited numbers without a registered source (not listed), ascending. */
  unresolved: number[];
  /** True when the appendix opens a new sources section. */
  createdSection: boolean;
}

/**
 * Computes the trailing completion of the sources section. Cited numbers are
 * the `[n]` outside the (last) sources section; listed numbers are entries at
 * the start of a line inside it. Each missing number is appended once.
 */
export function completeSourcesSection(
  text: string,
  lookup: (index: number) => Citation | undefined,
  heading: string = DEFAULT_SOURCES_HEADING,
): SourcesCompletion {
  const none: SourcesCompletion = {
    appendix: "",
    appended: [],
    unresolved: [],
    createdSection: false,
  };
  if (text.trim().length === 0) return none;
  const wanted = headingText(heading);
  const lines = blankFencedCode(text.split("\n"));

  let sectionStart = -1;
  lines.forEach((line, i) => {
    const match = HEADING_RE.exec(line);
    if (match !== null && (match[1] ?? "").trim().toLowerCase() === wanted) {
      sectionStart = i;
    }
  });
  let sectionEnd = lines.length;
  if (sectionStart !== -1) {
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (HEADING_RE.test(lines[i] ?? "")) {
        sectionEnd = i;
        break;
      }
    }
  }

  const cited = new Set<number>();
  const listed = new Set<number>();
  lines.forEach((line, i) => {
    const inSection = sectionStart !== -1 && i > sectionStart && i < sectionEnd;
    if (inSection) {
      const entry = LISTED_ENTRY_RE.exec(line);
      if (entry !== null) listed.add(Number(entry[1]));
      return;
    }
    if (i === sectionStart) return;
    for (const match of line.matchAll(CITATION_RE)) {
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > 0) cited.add(n);
    }
  });

  const missing = [...cited].filter((n) => !listed.has(n)).sort((a, b) => a - b);
  const appended: number[] = [];
  const unresolved: number[] = [];
  const entries: string[] = [];
  for (const n of missing) {
    const citation = lookup(n);
    if (citation === undefined) {
      unresolved.push(n);
      continue;
    }
    appended.push(n);
    entries.push(formatSourceEntry(n, citation));
  }
  if (entries.length === 0) return { ...none, unresolved };

  const trailingNewlines = (/\n*$/.exec(text)?.[0] ?? "").length;
  const sectionIsLast = sectionStart !== -1 && sectionEnd === lines.length;
  if (sectionIsLast) {
    return {
      appendix:
        "\n".repeat(Math.max(0, 1 - trailingNewlines)) + entries.join("\n"),
      appended,
      unresolved,
      createdSection: false,
    };
  }
  return {
    appendix:
      "\n".repeat(Math.max(0, 2 - trailingNewlines)) +
      `${heading.trim()}\n${entries.join("\n")}`,
    appended,
    unresolved,
    createdSection: true,
  };
}
