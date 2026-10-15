// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/docpass/identifiers.ts
 *
 * Identifier extraction for the streaming document pass (design §5 S7 step 4,
 * requirement 9.4).
 *
 * ## What an "identifier" is, and why it is indexed
 *
 * A specification is full of *codes* a reader searches for verbatim: an article
 * number, a mask/transaction code ("Maske WE01"), a drawing number ("ZG-100"),
 * a standard ("DIN EN 1090-2"), a requirement id ("REQ-014"), a BPMN task id, a
 * field label. These are exactly the tokens the German stemming FTS mangles and
 * a dense embedding blurs, so the design keeps a dedicated identifier index: for
 * each distinct identifier, the list of places it occurs (block, page). Search
 * later turns that into the third RRF list (task 3.4). Here, in the document
 * pass, we only *find* them and record the occurrences.
 *
 * ## Configurable regex classes
 *
 * The design calls for "konfigurierbare Regex-Klassen" — a named, overridable
 * set of pattern classes rather than one giant regex. {@link IdentifierClass}
 * is that named unit: a `kind` label and a `pattern`. {@link DEFAULT_IDENTIFIER_CLASSES}
 * ships the built-in classes; a deployment can override or extend the set (a
 * corpus with house-specific codes adds its own class) without touching this
 * module. The classes are applied in order and the FIRST class that matches a
 * given span wins, so a more specific class (a standard like `DIN EN 1090-2`)
 * is placed before a broader one (a bare code) to claim its text.
 *
 * ## Determinism
 *
 * Pure functions over strings — no model, no I/O. The same text always yields
 * the same identifiers in the same order, which is what makes the whole
 * document pass replayable byte-for-byte on a resume.
 */

/** One named, testable regex class (design §5 S7: "konfigurierbare Regex-Klassen"). */
export interface IdentifierClass {
  /** The `kind` stamped on every occurrence this class finds. */
  kind: string;
  /**
   * A global (`g`) regex whose whole-match (or first capture group, when
   * present) is the identifier value. Applied with `matchAll`; must be `g` or
   * the extractor throws, since a non-global regex would loop forever.
   */
  pattern: RegExp;
}

/** A single occurrence of an identifier: where it was found. */
export interface IdentifierOccurrence {
  page: number;
  /** The block the identifier's text sits in, when known. */
  blockId?: string;
}

/** An identifier and all the places it occurs, accumulated across the document. */
export interface IdentifierRecord {
  value: string;
  kind: string;
  occurrences: IdentifierOccurrence[];
}

/**
 * The built-in identifier classes (design §5 S7 step 4, requirement 9.4).
 *
 * Ordered most-specific first so a broader class never steals a span a specific
 * class should own. Each pattern is deliberately conservative: it matches the
 * canonical shape of the code, not "any token with a digit", so ordinary prose
 * numbers ("in 3 Schritten") are not mistaken for identifiers.
 */
export const DEFAULT_IDENTIFIER_CLASSES: readonly IdentifierClass[] = [
  {
    // Standards: DIN, ISO, EN, DIN EN, ISO/IEC, optionally with a number and a
    // part ("DIN EN 1090-2", "ISO 9001", "ISO/IEC 27001"). The prefix run is
    // captured together with the number so the whole designation is the value.
    kind: "standard",
    pattern:
      /\b(?:DIN(?:\s+EN)?(?:\s+ISO)?|EN(?:\s+ISO)?|ISO(?:\/IEC)?|IEC|VDI|VDE)\s+\d+(?:[-:]\d+)*\b/g,
  },
  {
    // Requirement ids: a REQ/ANF/RQ prefix and a number, dash or colon optional
    // ("REQ-014", "ANF 12", "RQ_3").
    kind: "requirement",
    pattern: /\b(?:REQ|ANF|RQ)[-_ ]?\d+\b/gi,
  },
  {
    // BPMN task ids: an Activity/Task/Gateway/Event id as BPMN tools emit them
    // ("Task_0x1y2z", "Activity_1abc", "Gateway_09f").
    kind: "bpmn_task",
    pattern: /\b(?:Task|Activity|Gateway|Event|Flow)_[0-9a-zA-Z]+\b/g,
  },
  {
    // Composite (specification/module) codes: a two-to-six uppercase-letter
    // prefix, at least one further dashed uppercase-alphanumeric group, and a
    // trailing digit group ("QAP-MDE-03", "QAB-MDE-03", "QAV-MDE-03").
    // Placed BEFORE drawing numbers on purpose: without it the drawing-number
    // class claims only the tail ("MDE-03" out of "QAP-MDE-03"), so every
    // section's "…-MDE-03" collapses to the same normalized value and the
    // distinguishing prefix is lost. Requiring at least two dashed groups and a
    // trailing digit group keeps prose ("AM-PM") and single-dash codes
    // ("ZG-100", "AB-100-2") with their existing classes. An optional "/A"
    // style revision suffix is part of the code, mirroring Search's class.
    kind: "composite_code",
    pattern: /\b[A-Z]{2,6}(?:-[A-Z0-9]{2,})+-\d{2,}(?:\/[A-Za-z0-9]+)?\b/g,
  },
  {
    // Drawing numbers: a two-to-four uppercase-letter prefix, a dash, then a
    // digit run, optionally with further dashed groups and an optional "/A"
    // style revision suffix ("ZG-100", "ZN-4471", "AB-100-2", "WE-01/A").
    // Placed BEFORE mask codes so a dashed designation is claimed as a drawing
    // number, not a mask code — the dash is the drawing-number signal, and
    // mask/transaction codes are written without one. The suffix is part of the
    // code so the value_norm matches the Search-side recognizer exactly.
    kind: "drawing_number",
    pattern: /\b[A-Z]{2,4}-\d{2,}(?:-\d+)*(?:\/[A-Za-z0-9]+)?\b/g,
  },
  {
    // Mask / transaction codes: two-to-six uppercase letters directly followed
    // by two or more digits, no dash ("WE01", "VA01", "MIGO2"), with an
    // optional "/A" style suffix. The un-dashed letters+digits shape is what a
    // screen/transaction code looks like; the dashed form is a drawing number
    // (claimed by the class above).
    kind: "mask_code",
    pattern: /\b[A-Z]{2,6}\d{2,}(?:\/[A-Za-z0-9]+)?\b/g,
  },
  {
    // Article numbers: "Art.-Nr. 12345", "Artikelnummer 4711", "Art. 815-2".
    // The captured group is the number so the value is the code, not the label.
    kind: "article_number",
    pattern:
      /\b(?:Art(?:ikel)?\.?[-\s]?Nr\.?|Artikelnummer)\s*:?\s*(\d[\d-]*)\b/gi,
  },
];

/** True when `re` has the global flag (a precondition of `matchAll`). */
function isGlobal(re: RegExp): boolean {
  return re.flags.includes("g");
}

/**
 * Find every identifier occurrence in `text`, tagging each with `page` and the
 * optional `blockId`. Classes are applied in order; a span already claimed by an
 * earlier (more specific) class is not re-matched by a later one, so a standard
 * like `DIN EN 1090-2` is never also reported as a bare code. Returns the
 * occurrences in document order (by match position), which keeps the whole pass
 * deterministic.
 */
export function extractIdentifiers(
  text: string,
  page: number,
  blockId: string | undefined,
  classes: readonly IdentifierClass[] = DEFAULT_IDENTIFIER_CLASSES,
): Array<{ value: string; kind: string; occurrence: IdentifierOccurrence }> {
  if (typeof text !== "string" || text.trim() === "") return [];

  interface Hit {
    start: number;
    end: number;
    value: string;
    kind: string;
  }
  const hits: Hit[] = [];
  // Track claimed [start,end) spans so a later class does not re-match text an
  // earlier, more specific class already owns.
  const claimed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  for (const cls of classes) {
    if (!isGlobal(cls.pattern)) {
      throw new Error(
        `identifier class "${cls.kind}" pattern must be global (g); got flags "${cls.pattern.flags}"`,
      );
    }
    // A fresh, lastIndex-independent regex per class avoids state bleeding
    // between calls (a shared /g regex remembers lastIndex).
    const re = new RegExp(cls.pattern.source, cls.pattern.flags);
    for (const match of text.matchAll(re)) {
      const whole = match[0];
      const index = match.index ?? 0;
      if (whole === "" ) continue;
      if (overlaps(index, index + whole.length)) continue;
      // Value is the first capture group when the class declared one (e.g. the
      // article number without its label), else the whole match.
      const value = (match[1] ?? whole).trim();
      if (value === "") continue;
      claimed.push([index, index + whole.length]);
      hits.push({ start: index, end: index + whole.length, value, kind: cls.kind });
    }
  }

  hits.sort((a, b) => a.start - b.start);
  return hits.map((h) => ({
    value: h.value,
    kind: h.kind,
    occurrence: { page, ...(blockId !== undefined ? { blockId } : {}) },
  }));
}

/**
 * A streaming accumulator for the document-wide identifier index. Fold each
 * block's text through {@link observe}; {@link snapshot} yields the serialisable
 * state to persist on `docpass_state`, and {@link entries} the finished index
 * for `document.end`.
 *
 * Occurrences of the same `(value, kind)` are merged under one record, and a
 * repeated occurrence on the same `(page, blockId)` is deduplicated so a
 * re-processed page (resume) never double-counts.
 */
export interface IdentifierIndex {
  observe(text: string, page: number, blockId?: string): void;
  /** The accumulated index in insertion order, deduplicated. */
  entries(): IdentifierRecord[];
  /** The serialisable state to persist after a page (design §9a.2). */
  snapshot(): IdentifierIndexState;
}

/** The persisted, JSON-serialisable identifier-index state. */
export interface IdentifierIndexState {
  version: 1;
  records: IdentifierRecord[];
}

/** An empty starting state. */
export function emptyIdentifierState(): IdentifierIndexState {
  return { version: 1, records: [] };
}

/** Coerce an unknown persisted value back to a valid {@link IdentifierIndexState}. */
export function parseIdentifierState(value: unknown): IdentifierIndexState {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { records?: unknown }).records)
  ) {
    const records = (value as { records: unknown[] }).records
      .filter(
        (r): r is IdentifierRecord =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as IdentifierRecord).value === "string" &&
          typeof (r as IdentifierRecord).kind === "string" &&
          Array.isArray((r as IdentifierRecord).occurrences),
      )
      .map((r) => ({
        value: r.value,
        kind: r.kind,
        occurrences: r.occurrences
          .filter((o): o is IdentifierOccurrence => typeof o === "object" && o !== null && typeof (o as IdentifierOccurrence).page === "number")
          .map((o) => ({ page: o.page, ...(typeof o.blockId === "string" ? { blockId: o.blockId } : {}) })),
      }));
    return { version: 1, records };
  }
  return emptyIdentifierState();
}

/**
 * Create an identifier index, optionally rehydrated from persisted state so a
 * resume continues the same accumulation (design §9a.2). Deterministic.
 */
export function createIdentifierIndex(
  initial: IdentifierIndexState = emptyIdentifierState(),
  classes: readonly IdentifierClass[] = DEFAULT_IDENTIFIER_CLASSES,
): IdentifierIndex {
  // Key `${kind}\u0000${value}` → record; a parallel Set of occurrence keys per
  // record dedupes repeats. Insertion order is preserved by the Map.
  const byKey = new Map<string, IdentifierRecord>();
  const occKeys = new Map<string, Set<string>>();

  function keyOf(kind: string, value: string): string {
    return `${kind}\u0000${value}`;
  }
  function occKeyOf(occ: IdentifierOccurrence): string {
    return `${occ.page}\u0000${occ.blockId ?? ""}`;
  }

  // Rehydrate.
  for (const rec of parseIdentifierState(initial).records) {
    const k = keyOf(rec.kind, rec.value);
    const copy: IdentifierRecord = { value: rec.value, kind: rec.kind, occurrences: [] };
    const seen = new Set<string>();
    for (const occ of rec.occurrences) {
      const ok = occKeyOf(occ);
      if (seen.has(ok)) continue;
      seen.add(ok);
      copy.occurrences.push(occ);
    }
    byKey.set(k, copy);
    occKeys.set(k, seen);
  }

  function observe(text: string, page: number, blockId?: string): void {
    for (const found of extractIdentifiers(text, page, blockId, classes)) {
      const k = keyOf(found.kind, found.value);
      let rec = byKey.get(k);
      let seen = occKeys.get(k);
      if (rec === undefined || seen === undefined) {
        rec = { value: found.value, kind: found.kind, occurrences: [] };
        seen = new Set<string>();
        byKey.set(k, rec);
        occKeys.set(k, seen);
      }
      const ok = occKeyOf(found.occurrence);
      if (seen.has(ok)) continue;
      seen.add(ok);
      rec.occurrences.push(found.occurrence);
    }
  }

  function entries(): IdentifierRecord[] {
    return [...byKey.values()].map((r) => ({
      value: r.value,
      kind: r.kind,
      occurrences: r.occurrences.map((o) => ({ ...o })),
    }));
  }

  function snapshot(): IdentifierIndexState {
    return { version: 1, records: entries() };
  }

  return { observe, entries, snapshot };
}
