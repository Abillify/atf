// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/version-detect.ts
 *
 * Determine a document's version when the caller did not pass one. Search
 * orders the revisions of a document by it (`compareDocumentVersions`): only a
 * newer version becomes the latest.
 *
 * Sources, strongest first:
 *
 *   1. explicit          the caller's `version`
 *   2. page_label        a version label on the first page: "Version 2.1",
 *                        "Rev. C", "Fassung 3", "v1.4.2" …
 *   3. page_date         a labelled date on the first page ("Stand: 12.03.2024",
 *                        "Revision date: March 4, 2025", "Datum 2024-03-12"),
 *                        else an unambiguous unlabelled one near the top
 *   4. llm               a text model reads the first page (optional; only when
 *                        the patterns found nothing)
 *   5. source_modified   the file's modification time passed by the caller
 *
 * A label and a date found together are kept together: "Version 2.1 vom
 * 12.03.2024" orders by the label and breaks ties by the date.
 *
 * Deliberately conservative: a validity date ("gültig ab") is not a version
 * date, a standard number ("ISO 9001:2015") is not a version, and a page with
 * several unlabelled dates far apart yields no date rather than a guess.
 */

import type { DocumentVersion } from "@atf/extract-contract";

/** Lines of the first page that are searched. Title pages put this near the top. */
const MAX_LINES = 120;

// ─── Version labels ───────────────────────────────────────────────────────

/** "Version 2.1", "Vers. 3", "Revision 4.0.1", "Rel. 2", "Fassung 2", "Ausgabe 5" … */
const NUMERIC_LABEL =
  /(?:^|[^\p{L}])(version|vers\.|ver\.|revision|rev\.?|release|rel\.|fassung|ausgabe|edition|änderungsstand|änderungsindex|revisionsstand|versionsnummer|version\s+no\.?|version\s+nr\.?)\s*(?:nr\.?|no\.?|number)?\s*[:#.]?\s*(v?\d{1,4}(?:[._-]\d{1,4}){0,3}[a-z]?)(?![\p{L}\d]|\/\d)/iu;

/** "Rev. C", "Revision B", "Index AB", "Änderungsindex c" — letter revisions (upper case). */
const LETTER_LABEL =
  /(?:^|[^\p{L}])(?:[Rr]evision|REVISION|[Rr]ev\.?|REV\.?|[Ii]ndex|INDEX|[ÄäA]nderungsindex)\s*[:#.]?\s*([A-Z]{1,2})(?![\p{L}\d])/u;

/** A bare "v2.1" / "V 3.0.1" token (a dot is required, so "v2" in prose does not count). */
const BARE_LABEL = /(?:^|[\s([])[vV]\s?(\d{1,3}\.\d{1,3}(?:\.\d{1,4})?)(?![\p{L}\d.])/u;

/** Things that look like versions but are not the document's own version. */
const NOT_A_VERSION_CONTEXT =
  /\b(?:iso|din|en|iec|vde|ieee|rfc|java|python|node|windows|android|ios|office|sap|release notes?)\s*$/i;

function findLabel(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const numeric = NUMERIC_LABEL.exec(line);
    // "Ausgabe 12.03.2024" is a date, not a version label.
    if (numeric?.[2] !== undefined && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(numeric[2])) {
      const before = line.slice(0, numeric.index);
      if (!NOT_A_VERSION_CONTEXT.test(before)) {
        return `${numeric[2]}`.replace(/^v/i, "");
      }
    }
    const letter = LETTER_LABEL.exec(line);
    if (letter?.[1] !== undefined) return `Rev. ${letter[1]}`;
    const bare = BARE_LABEL.exec(line);
    if (bare?.[1] !== undefined) {
      const before = line.slice(0, bare.index);
      if (!NOT_A_VERSION_CONTEXT.test(before)) return bare[1];
    }
  }
  return undefined;
}

// ─── Dates ────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, january: 1, jänner: 1, jaenner: 1,
  februar: 2, feb: 2, february: 2,
  märz: 3, maerz: 3, mär: 3, mrz: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, okt: 10, october: 10, oct: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12, december: 12, dec: 12,
};
const MONTH_NAMES = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

interface DatePattern {
  re: RegExp;
  toParts(m: RegExpExecArray): [number, number, number] | null;
}

function year4(y: string): number {
  const n = Number(y);
  return y.length === 2 ? (n >= 70 ? 1900 + n : 2000 + n) : n;
}

const DATE_PATTERNS: DatePattern[] = [
  // 2024-03-12
  { re: /(?<![\d.])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d])/gu, toParts: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  // 12.03.2024, 12.3.24, 12. 03. 2024
  { re: /(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?![\d])/gu, toParts: (m) => [year4(m[3] ?? ""), Number(m[2]), Number(m[1])] },
  // 12. März 2024, 4 March 2025
  {
    re: new RegExp(`(?<![\\d])(\\d{1,2})\\.?\\s+(${MONTH_NAMES})\\.?\\s+(\\d{4})(?![\\d])`, "giu"),
    toParts: (m) => {
      const month = MONTHS[(m[2] ?? "").toLowerCase()];
      return month === undefined ? null : [Number(m[3]), month, Number(m[1])];
    },
  },
  // March 4, 2025
  {
    re: new RegExp(`(?<![\\p{L}])(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\d])`, "giu"),
    toParts: (m) => {
      const month = MONTHS[(m[1] ?? "").toLowerCase()];
      return month === undefined ? null : [Number(m[3]), month, Number(m[2])];
    },
  },
  // März 2024 / March 2025 (month precision → the 1st)
  {
    re: new RegExp(`(?<![\\p{L}\\d.]\\s?)(${MONTH_NAMES})\\.?\\s+(\\d{4})(?![\\d])`, "giu"),
    toParts: (m) => {
      const month = MONTHS[(m[1] ?? "").toLowerCase()];
      return month === undefined ? null : [Number(m[2]), month, 1];
    },
  },
  // 03/2024 (month precision)
  { re: /(?<![\d/.])(\d{1,2})\/(\d{4})(?![\d/])/gu, toParts: (m) => [Number(m[2]), Number(m[1]), 1] },
];

/** Words that introduce the document's own date. */
const DATE_LABEL =
  /(stand|datum|date|dated|vom|as of|last (?:updated|revised|modified|changed)|zuletzt (?:geändert|aktualisiert|überarbeitet)|aktualisiert(?: am)?|überarbeitet(?: am)?|erstellt(?: am)?|ausgabedatum|revisionsdatum|revision date|release date|issue date|issued|veröffentlicht(?: am)?|published|freigabe(?:datum)?|freigegeben(?: am)?|versionsdatum)\s*[:.]?\s*$/i;

/** Words that introduce a date that is NOT the document's date. */
const NOT_THE_DOCUMENT_DATE =
  /(gültig (?:ab|bis|von)|valid (?:from|until|to|through)|effective(?: date| from)?|in kraft|frist|deadline|bis zum|bis|until|due|fällig|geboren|born|termin|meeting|sitzung am)\s*[:.]?\s*$/i;

interface FoundDate {
  iso: string;
  line: number;
  labelled: boolean;
  excluded: boolean;
}

function validDate(y: number, m: number, d: number, now: Date): string | null {
  if (y < 1980 || y > now.getUTCFullYear() + 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  // A version date lies in the past (a day of slack for time zones).
  if (ms > now.getTime() + 86_400_000) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function findDates(lines: readonly string[], now: Date): FoundDate[] {
  const out: FoundDate[] = [];
  lines.forEach((line, index) => {
    const taken: Array<[number, number]> = [];
    for (const pattern of DATE_PATTERNS) {
      pattern.re.lastIndex = 0;
      for (const m of line.matchAll(pattern.re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (taken.some(([s, e]) => start < e && end > s)) continue;
        const parts = pattern.toParts(m as RegExpExecArray);
        if (parts === null) continue;
        const iso = validDate(parts[0], parts[1], parts[2], now);
        if (iso === null) continue;
        taken.push([start, end]);
        // The label may sit on the same line before the date, or alone on the
        // line above ("Stand:\n12.03.2024").
        const before = line.slice(Math.max(0, start - 40), start);
        const prevLine = start === 0 || before.trim() === "" ? (lines[index - 1] ?? "") : "";
        const context = `${prevLine} ${before}`.replace(/\s+/g, " ");
        out.push({
          iso,
          line: index,
          labelled: DATE_LABEL.test(context) || /version(?:\s+\S+)?\s+(?:vom|from|of)\s*$/i.test(context),
          excluded: NOT_THE_DOCUMENT_DATE.test(context),
        });
      }
    }
  });
  return out;
}

function findDate(lines: readonly string[], now: Date): string | undefined {
  const dates = findDates(lines, now).filter((d) => !d.excluded);
  const labelled = dates.find((d) => d.labelled);
  if (labelled) return labelled.iso;
  // Unlabelled: one distinct date on the page, or the first one in the top
  // part of the page (a letterhead or title block) — never a guess among many.
  const distinct = [...new Set(dates.map((d) => d.iso))];
  if (distinct.length === 1) return distinct[0];
  const topLimit = Math.max(8, Math.ceil(lines.length * 0.4));
  const top = dates.filter((d) => d.line < topLimit);
  const topDistinct = [...new Set(top.map((d) => d.iso))];
  if (topDistinct.length === 1) return topDistinct[0];
  return undefined;
}

// ─── Public API ───────────────────────────────────────────────────────────

/** The first page's text as the lines the detectors look at. */
function firstLines(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/­/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l !== "")
    .slice(0, MAX_LINES);
}

/**
 * A version read from the first page's text, or undefined. The source is
 * `page_label` when a label was found (with its date when there is one), else
 * `page_date`.
 */
export function detectVersionInText(text: string, now: Date = new Date()): DocumentVersion | undefined {
  const lines = firstLines(text);
  if (lines.length === 0) return undefined;
  const label = findLabel(lines);
  const date = findDate(lines, now);
  if (label !== undefined) {
    return { label, ...(date !== undefined ? { date } : {}), source: "page_label" };
  }
  if (date !== undefined) return { date, source: "page_date" };
  return undefined;
}

/** A caller-supplied version string: a bare date is a date, anything else a label. */
export function explicitVersion(value: string): DocumentVersion | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(trimmed);
  if (iso?.[1] !== undefined) return { date: iso[1], source: "explicit" };
  return { label: trimmed.slice(0, 200), source: "explicit" };
}

/** The file modification time as the weakest version, or undefined when unparseable. */
export function sourceModifiedVersion(value: string | undefined): DocumentVersion | undefined {
  if (value === undefined || Number.isNaN(Date.parse(value))) return undefined;
  return { date: new Date(value).toISOString(), source: "source_modified" };
}

/**
 * Parse a text model's answer to {@link VERSION_LLM_SYSTEM_PROMPT} into a
 * version, or undefined. Tolerates prose around the JSON object and rejects a
 * date the page could not carry (future, malformed).
 */
export function parseLlmVersion(answer: string, now: Date = new Date()): DocumentVersion | undefined {
  const match = /\{[\s\S]*\}/.exec(answer);
  if (match === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const raw = parsed as { version?: unknown; date?: unknown };
  const label =
    typeof raw.version === "string" && raw.version.trim() !== "" && raw.version.trim().length <= 60
      ? raw.version.trim().replace(/^(?:version|v)\s*/i, "")
      : undefined;
  let date: string | undefined;
  if (typeof raw.date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.date.trim());
    if (m) date = validDate(Number(m[1]), Number(m[2]), Number(m[3]), now) ?? undefined;
  }
  if (label === undefined && date === undefined) return undefined;
  return { ...(label !== undefined ? { label } : {}), ...(date !== undefined ? { date } : {}), source: "llm" };
}

/** System prompt of the optional LLM fallback. */
export const VERSION_LLM_SYSTEM_PROMPT = [
  "You read the first page of a document and extract its own version metadata.",
  'Answer with a single JSON object and nothing else: {"version": string|null, "date": "YYYY-MM-DD"|null}.',
  '"version" is the document\'s version, revision or edition label exactly as printed (e.g. "2.1", "Rev. C", "3"),',
  "not a product, software or standard version (ISO 9001:2015 is not a version).",
  '"date" is the document\'s own issue, revision or "as of" date (Stand, Datum, Version vom),',
  "not a validity, deadline, meeting or referenced date.",
  "Use null for anything the page does not state.",
].join(" ");

/** The first page text, cut to what the model needs. */
export function versionLlmUserPrompt(firstPage: string): string {
  return `First page:\n\n${firstPage.slice(0, 6000)}`;
}
