// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2/document-identity.ts
 *
 * Two rules that Extract (producer) and Search (consumer) must apply
 * identically, so they live in the contract:
 *
 *   - {@link documentKeyOf}: the identity of a document regardless of the file
 *     format it arrived in. `handbuch.pdf` and `handbuch.docx` are the same
 *     document, so versions and duplicates are matched on `handbuch`.
 *   - {@link compareDocumentVersions}: the order of two document versions, which
 *     decides which revision of a document is the latest one.
 */

import type { DocumentVersion, VersionSource } from "./records.js";

/**
 * File extensions stripped from a reference to form its document key. Only
 * known document formats are stripped: a reference like `Vertrag v1.2` must keep
 * its `.2`, which a generic "last dot" rule would cut off.
 */
const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc", "docx", "docm", "dot", "dotx", "odt", "rtf", "txt", "md",
  "xls", "xlsx", "xlsm", "ods", "csv",
  "ppt", "pptx", "pptm", "odp",
  "vsd", "vsdx",
  "bpmn", "xml",
  "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "bmp",
  "eml", "msg",
  "htm", "html",
]);

/**
 * The format-independent key of a document reference: the reference in NFC with
 * one trailing known file extension removed (case-insensitive).
 *
 *   `docs/Handbuch.PDF`   → `docs/Handbuch`
 *   `docs/Handbuch.docx`  → `docs/Handbuch`
 *   `Vertrag v1.2`        → `Vertrag v1.2`
 */
export function documentKeyOf(reference: string): string {
  const nfc = reference.normalize("NFC").trim();
  const match = /^(.*[^/\\])\.([A-Za-z0-9]{1,5})$/.exec(nfc);
  if (match === null) return nfc;
  const [, stem, ext] = match;
  if (stem === undefined || ext === undefined) return nfc;
  return DOCUMENT_EXTENSIONS.has(ext.toLowerCase()) ? stem : nfc;
}

/** Words that introduce a version label and carry no ordering information. */
const LABEL_PREFIX =
  /^(?:version|vers|ver|v|revision|rev|release|rel|fassung|ausgabe|index|edition|ed|stand)\b\.?\s*/i;

type LabelToken = number | string;

/**
 * Split a version label into comparable tokens: digit runs as numbers, letter
 * runs lower-cased. Separators are dropped and trailing zero components are
 * trimmed so `2`, `2.0` and `v2.0.0` compare equal.
 */
export function versionLabelTokens(label: string): LabelToken[] {
  let rest = label.normalize("NFKC").trim();
  // A bare leading "v" directly before a digit ("v2.1") is a prefix too.
  rest = rest.replace(/^v(?=\d)/i, "");
  for (let i = 0; i < 3; i++) {
    const next = rest.replace(LABEL_PREFIX, "");
    if (next === rest) break;
    rest = next.replace(/^v(?=\d)/i, "");
  }
  const tokens: LabelToken[] = [];
  for (const match of rest.matchAll(/(\d+)|([A-Za-zÀ-ÿ]+)/g)) {
    if (match[1] !== undefined) tokens.push(Number.parseInt(match[1], 10));
    else if (match[2] !== undefined) tokens.push(match[2].toLowerCase());
  }
  while (tokens.length > 1 && tokens[tokens.length - 1] === 0) tokens.pop();
  return tokens;
}

function compareTokens(a: LabelToken[], b: LabelToken[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // 2.1 < 2.1a, 2.1 < 2.1.1
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
    } else if (typeof x === "string" && typeof y === "string") {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      // A number sorts before a letter at the same position (2.1 < 2.a).
      return typeof x === "number" ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Parse a version date (`YYYY-MM-DD` or RFC 3339) to epoch milliseconds, or null.
 * A bare date is taken as UTC midnight so the same calendar day compares equal
 * whatever time zone produced it.
 */
export function versionDateMs(date: string | undefined): number | null {
  if (date === undefined) return null;
  const trimmed = date.trim();
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (bare !== null) {
    const ms = Date.UTC(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/** The calendar day of a version date, so a timestamp and a bare date compare by day. */
function versionDay(date: string | undefined): number | null {
  const ms = versionDateMs(date);
  if (ms === null) return null;
  return Math.floor(ms / 86_400_000);
}

/** Version fields as they are compared; a {@link DocumentVersion} fits. */
export interface ComparableVersion {
  label?: string | undefined;
  date?: string | undefined;
  source?: VersionSource | undefined;
}

/**
 * Order two document versions. Returns a negative number when `a` is older, a
 * positive one when it is newer, 0 when they are the same version, and null
 * when the two cannot be ordered (no comparable label and not both dated).
 *
 * Labels win over dates: `2.1` vs `2.0` is decided by the label even when the
 * dates say otherwise. Labels are comparable when both start with the same kind
 * of token (both numeric like `2.1`, or both letters like `Rev. C`). Equal
 * labels fall through to the dates, compared by calendar day.
 */
export function compareDocumentVersions(
  a: ComparableVersion | null | undefined,
  b: ComparableVersion | null | undefined,
): number | null {
  if (a == null || b == null) return null;
  if (a.label !== undefined && b.label !== undefined) {
    const ta = versionLabelTokens(a.label);
    const tb = versionLabelTokens(b.label);
    if (ta.length > 0 && tb.length > 0 && typeof ta[0] === typeof tb[0]) {
      const byLabel = compareTokens(ta, tb);
      if (byLabel !== 0) return byLabel;
      const da = versionDay(a.date);
      const db = versionDay(b.date);
      if (da !== null && db !== null && da !== db) return da < db ? -1 : 1;
      return 0;
    }
  }
  const da = versionDay(a.date);
  const db = versionDay(b.date);
  if (da === null || db === null) return null;
  return da === db ? 0 : da < db ? -1 : 1;
}

/** True when a version came from content or the caller, not from a file timestamp. */
export function isStrongVersionSource(source: VersionSource | undefined): boolean {
  return source !== undefined && source !== "source_modified";
}

export type { DocumentVersion };
