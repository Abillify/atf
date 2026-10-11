// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/docpass/refs.ts
 *
 * Cross-reference and caption resolution for the streaming document pass
 * (design §5 S7 step 3, requirement 9.3).
 *
 * ## What a "ref" is
 *
 * Prose points at other things: "siehe Kapitel 4.2", "Abbildung 12", "Tabelle
 * 3", "Maske WE01". Each of those is a {@link Ref} — a typed pointer stored on
 * the block that made the reference. When the pass can resolve the pointer to a
 * concrete target (a figure id, a section id, a table id), it fills `target`;
 * an unresolved reference is kept as a dangling ref (text only) so a later pass
 * or a human can still see it. This is the "lightweight document graph in
 * PostgreSQL" of the design — links, no graph database.
 *
 * ## The patterns
 *
 * German reference phrasings, each mapped to a {@link Ref} kind:
 *  - "Abbildung 12", "Abb. 12", "Bild 12"  → figure
 *  - "Tabelle 3", "Tab. 3"                  → table
 *  - "Kapitel 4.2", "Abschnitt 4.2", "Kap. 4.2", "siehe 4.2" → section
 *  - "Maske WE01" (and other identifier-like codes) → identifier
 *  - "Seite 37"                             → page
 *
 * A phrase becomes a ref regardless of whether it resolves; resolution is a
 * separate, best-effort lookup against the running document state (the figure
 * captions seen so far, the open section numbering, the tables). The reference
 * *number* (e.g. "12" in "Abbildung 12") is a document-local ordinal the author
 * uses, not our block id, so resolution maps the ordinal to the id we minted.
 *
 * ## Determinism
 *
 * Pure functions over strings plus a small resolution registry the pass feeds
 * as it streams. No model, no I/O.
 */

import type { Ref } from "@atf/extract-contract/v2";

/** A caption→figure link the pass accumulates so a later "Abbildung n" resolves. */
export interface FigureCaptionEntry {
  /** The author's figure ordinal, e.g. 12 from "Abbildung 12: …". */
  ordinal: number;
  /** The figure block/asset id we minted. */
  figureId: string;
  page: number;
}

/** A table ordinal→id link, for "Tabelle n". */
export interface TableRefEntry {
  ordinal: number;
  tableId: string;
  page: number;
}

/** A section numbering→id link, for "Kapitel x.y". */
export interface SectionRefEntry {
  numbering: string;
  sectionId: string;
}

/** The registry the pass feeds to resolve reference ordinals to ids. */
export interface RefRegistry {
  figures: FigureCaptionEntry[];
  tables: TableRefEntry[];
  sections: SectionRefEntry[];
}

/** An empty registry. */
export function emptyRefRegistry(): RefRegistry {
  return { figures: [], tables: [], sections: [] };
}

/**
 * A caption ordinal parsed from a figure caption like "Abbildung 12: Maske
 * WE01". Returns the ordinal, or `null` when the caption carries no leading
 * "Abbildung/Abb./Bild n". Exported so the pass can register figure captions.
 */
export function captionOrdinal(caption: string | undefined): number | null {
  if (caption === undefined) return null;
  const m = /^(?:Abbildung|Abb\.?|Bild)\s+(\d+)/i.exec(caption.trim());
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** One reference pattern: how to find it and which kind it produces. */
interface RefPattern {
  kind: Ref["kind"];
  /** Global regex; capture group 1 is the reference key (number or numbering/code). */
  pattern: RegExp;
}

/**
 * The reference phrasings (design §5 S7 step 3, requirement 9.3). Ordered so a
 * specific phrasing ("Kapitel 4.2") is tried before a bare "siehe 4.2".
 */
const REF_PATTERNS: readonly RefPattern[] = [
  { kind: "figure", pattern: /\b(?:Abbildung|Abb\.?|Bild)\s+(\d+)/gi },
  { kind: "table", pattern: /\b(?:Tabelle|Tab\.?)\s+(\d+)/gi },
  {
    kind: "section",
    pattern: /\b(?:Kapitel|Abschnitt|Kap\.?|siehe)\s+(\d+(?:\.\d+)*)\b/gi,
  },
  { kind: "page", pattern: /\bSeite\s+(\d+)\b/gi },
  { kind: "identifier", pattern: /\bMaske\s+([A-Z]{2,6}-?\d{2,})\b/g },
];

/**
 * Find every cross-reference in `text` and resolve what can be resolved against
 * `registry`. Returns the {@link Ref}s in document order (by match position).
 * The same text yields the same refs — deterministic.
 */
export function extractRefs(text: string, registry: RefRegistry): Ref[] {
  if (typeof text !== "string" || text.trim() === "") return [];

  interface Hit {
    start: number;
    kind: Ref["kind"];
    text: string;
    key: string;
  }
  const hits: Hit[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  for (const { kind, pattern } of REF_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(re)) {
      const whole = match[0];
      const key = match[1];
      const index = match.index ?? 0;
      if (whole === "" || key === undefined) continue;
      if (overlaps(index, index + whole.length)) continue;
      claimed.push([index, index + whole.length]);
      hits.push({ start: index, kind, text: whole.replace(/\s+/g, " ").trim(), key });
    }
  }

  hits.sort((a, b) => a.start - b.start);
  return hits.map((h) => {
    const target = resolve(h.kind, h.key, registry);
    return {
      kind: h.kind,
      text: h.text,
      ...(target !== undefined ? { target } : {}),
    };
  });
}

/** Resolve a reference key to a concrete target id against the registry. */
function resolve(kind: Ref["kind"], key: string, registry: RefRegistry): string | undefined {
  switch (kind) {
    case "figure": {
      const ordinal = Number(key);
      // The last-registered figure with this ordinal wins (a document rarely
      // reuses an ordinal, but if it does the nearest-preceding is the sane pick
      // and the pass registers in document order).
      const found = [...registry.figures].reverse().find((f) => f.ordinal === ordinal);
      return found?.figureId;
    }
    case "table": {
      const ordinal = Number(key);
      const found = [...registry.tables].reverse().find((t) => t.ordinal === ordinal);
      return found?.tableId;
    }
    case "section": {
      const numbering = key.replace(/\.$/, "");
      const found = registry.sections.find((s) => s.numbering === numbering);
      return found?.sectionId;
    }
    case "identifier":
      // A mask code resolves to itself as the identifier value; the identifier
      // index (identifiers.ts) is the authority on occurrences.
      return key;
    case "page":
      // A page reference targets the page itself; the page number is the target.
      return `page:${key}`;
    default:
      return undefined;
  }
}
