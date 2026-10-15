// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * identifier.ts
 *
 * Search-side identifier normalization and recognition (design §6.4, task 3.4,
 * Requirements 12.1–12.3).
 *
 * ## Why Search needs its own copy
 *
 * A specification is full of *codes* a reader searches for verbatim: an article
 * number, a mask/transaction code ("Maske WE01"), a drawing number ("ZG-100"),
 * a standard ("DIN EN 1090-2"), a requirement id ("REQ-014"). German-stemming
 * FTS (`ts_de`) mangles them and a dense embedding blurs them, so the design
 * keeps a dedicated identifier index (`vs_identifiers`) that Search turns into a
 * THIRD RRF list when a query carries an identifier.
 *
 * Extract's document pass (`apps/extract/src/jobs/docpass/identifiers.ts`)
 * already *finds* identifiers and ships them on `document.end.identifiers`. This
 * module is the Search-side twin: it recognizes identifier-shaped tokens in a
 * QUERY and canonicalizes any identifier `value` (from either side) to a single
 * `value_norm`. Both the ingest side (indexing `document.end.identifiers`) and
 * the query side run every value through {@link normalizeIdentifier}, so the two
 * always agree on equality regardless of casing or separators — `WE-01/A`,
 * `we 01/a` and `WE01A` collapse to the same `value_norm`.
 *
 * `apps/search` does not depend on `apps/extract`, so the regex classes are
 * re-declared here rather than imported. They mirror Extract's
 * `DEFAULT_IDENTIFIER_CLASSES` (same kinds, same shapes, same most-specific-first
 * ordering) so both services recognise the same tokens as identifiers.
 *
 * Pure functions over strings — no I/O, deterministic.
 */

/** One named regex class: a `kind` label and the pattern that finds it. */
export interface IdentifierClass {
  kind: string;
  /** A global (`g`) regex; the first capture group (when present) is the value, else the whole match. */
  pattern: RegExp;
}

/**
 * The identifier classes Search recognises in a query. Mirrors Extract's
 * `DEFAULT_IDENTIFIER_CLASSES` so the two services agree on what an identifier
 * is. Ordered most-specific-first: a standard like `DIN EN 1090-2` is claimed
 * before a bare code, and a dashed drawing number before an un-dashed mask code.
 */
export const DEFAULT_IDENTIFIER_CLASSES: readonly IdentifierClass[] = [
  {
    kind: "standard",
    pattern:
      /\b(?:DIN(?:\s+EN)?(?:\s+ISO)?|EN(?:\s+ISO)?|ISO(?:\/IEC)?|IEC|VDI|VDE)\s+\d+(?:[-:]\d+)*\b/g,
  },
  {
    kind: "requirement",
    pattern: /\b(?:REQ|ANF|RQ)[-_ ]?\d+\b/gi,
  },
  {
    kind: "bpmn_task",
    pattern: /\b(?:Task|Activity|Gateway|Event|Flow)_[0-9a-zA-Z]+\b/g,
  },
  {
    // Composite (specification/module) codes: two-to-six uppercase letters plus
    // at least one further dashed uppercase-alphanumeric group, ending in a
    // digit group, optional "/A" style suffix ("QAP-MDE-03", "QAB-MDE-03").
    // Placed BEFORE drawing_number on purpose: without it the drawing-number
    // class claims only the tail ("MDE-03" out of "QAP-MDE-03"), so every
    // section's "…-MDE-03" collapses to the same value_norm and the prefix that
    // distinguishes them (QAP vs QAB vs QAV) is lost. Requiring ≥2 dashes
    // and a trailing digit group keeps prose ("AM-PM") and single-dash codes
    // ("ZG-100", "WE-01/A", "AB-100-2") with their existing classes.
    kind: "composite_code",
    pattern: /\b[A-Z]{2,6}(?:-[A-Z0-9]{2,})+-\d{2,}(?:\/[A-Za-z0-9]+)?\b/g,
  },
  {
    // Drawing numbers: 2–4 uppercase letters, a dash, a digit run, optional
    // further dashed groups AND an optional trailing "/A" style suffix so a
    // code like "WE-01/A" is recognised whole ("ZG-100", "AB-100-2", "WE-01/A").
    kind: "drawing_number",
    pattern: /\b[A-Z]{2,4}-\d{2,}(?:-\d+)*(?:\/[A-Za-z0-9]+)?\b/g,
  },
  {
    // Mask / transaction codes: 2–6 uppercase letters directly followed by 2+
    // digits, no dash ("WE01", "VA01"), with an optional "/A" style suffix.
    kind: "mask_code",
    pattern: /\b[A-Z]{2,6}\d{2,}(?:\/[A-Za-z0-9]+)?\b/g,
  },
  {
    kind: "article_number",
    pattern:
      /\b(?:Art(?:ikel)?\.?[-\s]?Nr\.?|Artikelnummer)\s*:?\s*(\d[\d-]*)\b/gi,
  },
];

/**
 * Canonicalize an identifier value to its `value_norm`: upper-case, with the
 * separators a writer adds or drops freely (spaces, dots, hyphens, slashes,
 * non-breaking spaces) removed. `WE-01/A`, `we 01/a` and `WE01A` all normalize
 * to `WE01A`.
 *
 * Upper-case (design intent) — Extract's `text-fidelity` uses lower-case for its
 * OWN fidelity comparison, but that value never leaves Extract; the shared
 * contract between Extract's `document.end.identifiers` and Search's
 * `vs_identifiers` is THIS function, applied on both sides, so the case choice
 * only has to be internally consistent.
 */
export function normalizeIdentifier(value: string): string {
  return value.normalize("NFC").toUpperCase().replace(/[\s.\-/\u00a0]/g, "");
}

/**
 * Build the `simple`-config FTS text for a unit's `ts_ident` vector: the
 * space-joined `value_norm` of every identifier recognized in `content`
 * (Requirement 12.1). Each code becomes ONE normalized token, so an
 * `to_tsvector('simple', …)` of this text holds `WE01A` as a lexeme and a query
 * normalized the same way matches it — the German stemmer never touches it.
 *
 * Returns an empty string when the content carries no identifier, so a prose
 * unit's `ts_ident` is an empty vector and never spuriously matches.
 */
export function buildIdentifierText(
  content: string,
  classes: readonly IdentifierClass[] = DEFAULT_IDENTIFIER_CLASSES,
): string {
  return recognizeIdentifiers(content, classes)
    .map((r) => r.valueNorm)
    .join(" ");
}

/** Upper bound on distinct identifiers a single query contributes to the identifier list. */
export const MAX_QUERY_IDENTIFIERS = 16;

/**
 * The deduplicated `value_norm`s a query contributes to the identifier RRF list
 * (Requirement 12.3): every identifier RECOGNIZED in `query` plus every
 * EXPLICIT identifier the caller named (e.g. `/v2/search` `filters.identifier`),
 * each normalized with {@link normalizeIdentifier}. An explicit value is taken
 * verbatim (it does not have to match a recognizer class — the caller asserted
 * it is an identifier), so `we-01/a` still resolves to `WE01A`.
 *
 * Capped at {@link MAX_QUERY_IDENTIFIERS} so a pathological query cannot blow
 * up the lookup; explicit identifiers are kept first.
 */
export function queryIdentifierValueNorms(
  query: string,
  explicit: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: string): void => {
    if (v === "" || seen.has(v) || out.length >= MAX_QUERY_IDENTIFIERS) return;
    seen.add(v);
    out.push(v);
  };
  for (const e of explicit) {
    if (typeof e === "string") add(normalizeIdentifier(e.trim()));
  }
  for (const r of recognizeIdentifiers(query)) add(r.valueNorm);
  return out;
}

/**
 * Build the `to_tsquery('simple', …)` text matching any of `valueNorms` against
 * a unit's `ts_ident` vector (Requirement 12.1). Each value is emitted as a
 * single-quoted tsquery operand and the operands are OR-ed (`|`).
 *
 * Quoting makes the operand safe against tsquery syntax (`:`, `&`, `!`, `(`…
 * inside a value can never become an operator) and lets PostgreSQL run the
 * operand through the SAME `simple` parser `to_tsvector('simple', …)` used at
 * ingest: a value the parser splits (e.g. `ISO9001:2015` → `iso9001`, `2015`)
 * becomes a phrase (`<->`) that matches exactly the adjacent lexemes the ingest
 * side produced. Backslashes and single quotes are escaped per the tsquery
 * quoting rules.
 *
 * Returns null when there is nothing to match, so the caller emits no lexical
 * identifier branch at all.
 */
export function buildIdentifierTsQuery(valueNorms: readonly string[]): string | null {
  const operands = valueNorms
    .filter((v) => typeof v === "string" && v.trim() !== "")
    .map((v) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`);
  if (operands.length === 0) return null;
  return operands.join(" | ");
}

/** True when `re` carries the global flag (required for `matchAll`). */
function isGlobal(re: RegExp): boolean {
  return re.flags.includes("g");
}

/** A recognized identifier in a text: the raw match, its kind and its `value_norm`. */
export interface RecognizedIdentifier {
  /** The identifier text as it appeared (the class's capture group or whole match). */
  value: string;
  kind: string;
  /** The canonical form used for exact lookup against `vs_identifiers`. */
  valueNorm: string;
}

/**
 * Recognize every identifier-shaped token in `text`, most-specific class first,
 * with each span claimed by only one class (a `DIN EN 1090-2` is never also a
 * bare code). Returns the recognized identifiers in text order, deduplicated by
 * `(kind, valueNorm)` so a query mentioning the same code twice yields one entry.
 *
 * Used at query time to decide whether the identifier RRF list participates and
 * with which `value_norm`s to look up (Requirement 12.3).
 */
export function recognizeIdentifiers(
  text: string,
  classes: readonly IdentifierClass[] = DEFAULT_IDENTIFIER_CLASSES,
): RecognizedIdentifier[] {
  if (typeof text !== "string" || text.trim() === "") return [];

  interface Hit {
    start: number;
    end: number;
    value: string;
    kind: string;
  }
  const hits: Hit[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  for (const cls of classes) {
    if (!isGlobal(cls.pattern)) {
      throw new Error(
        `identifier class "${cls.kind}" pattern must be global (g); got flags "${cls.pattern.flags}"`,
      );
    }
    const re = new RegExp(cls.pattern.source, cls.pattern.flags);
    for (const match of text.matchAll(re)) {
      const whole = match[0];
      const index = match.index ?? 0;
      if (whole === "") continue;
      if (overlaps(index, index + whole.length)) continue;
      const value = (match[1] ?? whole).trim();
      if (value === "") continue;
      claimed.push([index, index + whole.length]);
      hits.push({ start: index, end: index + whole.length, value, kind: cls.kind });
    }
  }

  hits.sort((a, b) => a.start - b.start);

  const seen = new Set<string>();
  const out: RecognizedIdentifier[] = [];
  for (const h of hits) {
    const valueNorm = normalizeIdentifier(h.value);
    if (valueNorm === "") continue;
    const key = `${h.kind}\u0000${valueNorm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: h.value, kind: h.kind, valueNorm });
  }
  return out;
}
