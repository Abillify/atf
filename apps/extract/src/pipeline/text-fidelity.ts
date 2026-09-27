// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * text-fidelity.ts
 *
 * A deterministic check that the model kept the wording it was told to keep.
 *
 * ## Why this exists
 *
 * The page prompt makes the text layer authoritative for wording: spelling,
 * numbers, identifiers, units. That instruction is enforced by wording alone —
 * the model is *asked* to transcribe the raw text faithfully, but nothing
 * verifies that it did. A vision model asked to read text it could instead be
 * told verbatim will occasionally "correct" an article number or a date, and the
 * result looks plausible, which is exactly what makes it dangerous.
 *
 * This module closes that gap without trusting the model's cooperation: it
 * compares the *risky tokens* of the text layer against the model's Markdown and
 * reports, as a page warning, any that vanished. It never rewrites the output —
 * a deterministic replacement would need a reliable alignment between the
 * restructured Markdown and the linearised text layer, which does not exist, and
 * would happily destroy the legitimate omissions the prompt asks for (headers,
 * page numbers). A warning is the honest primitive: it makes the prompt's
 * instruction measurable and surfaces the one failure class that matters, while
 * leaving the human to judge.
 *
 * ## What counts as a risky token, and what does not
 *
 * Only tokens where a silent character-level change is both plausible and
 * consequential:
 *
 *  - **numbers** — `12`, `3,14`, `1.234`, `1 234,56`. Thousands separators and
 *    the decimal mark are normalised away so `1.234` and `1234` compare equal;
 *    the comparison is on the digit core, because that is what an operator cares
 *    about and what the model is most likely to mangle.
 *  - **identifiers** — an alphanumeric run containing at least one digit and at
 *    least one letter, like `BA2b`, `WU-123`, `EAN13`. Pure words are excluded:
 *    reflowing prose is legitimate and would drown the signal in false hits.
 *
 * Dates are covered by the number rule (their digit groups are numbers) without
 * a separate date grammar, which would only add locale-specific fragility.
 *
 * ## Why the false-positive guards matter
 *
 * The prompt tells the model to drop page numbers, headers and footers, so a few
 * missing tokens are expected and correct. The check therefore reports only when
 * the loss is both absolute (at least {@link MIN_MISSING} tokens) and relative
 * (at least {@link MIN_MISSING_RATIO} of the page's risky tokens) — a single
 * dropped footer number never trips it, a page that quietly lost a third of its
 * article numbers does.
 */

/** Minimum count of missing risky tokens before a page is flagged. */
export const MIN_MISSING = 3;
/** Minimum share of a page's risky tokens that must be missing before flagging. */
export const MIN_MISSING_RATIO = 0.15;
/** How many example tokens to name in the warning. */
const MAX_EXAMPLES = 8;

export interface TextFidelityResult {
  /** Risky tokens found in the raw text layer. */
  totalTokens: number;
  /** Distinct risky tokens present in the raw text but absent from the Markdown. */
  missing: string[];
  /** True when the loss crossed both the absolute and relative thresholds. */
  flagged: boolean;
}

/**
 * Normalise a numeric token to its digit core so separators do not cause a
 * spurious mismatch. `1.234,50` → `123450`, `1 234` → `1234`.
 *
 * Non-digit characters other than a sign are dropped. This deliberately makes
 * `1.234` and `1234` equal: an operator worried about a mangled article number
 * does not care whether the model kept the thousands dot, only whether the
 * digits survived.
 */
function normalizeNumber(token: string): string {
  return token.replace(/[^\d]/g, "");
}

/**
 * Normalise an identifier: lower-case, strip separators that a model may add or
 * drop freely (spaces, hyphens, dots, slashes). `WU-123` and `wu 123` compare
 * equal; the digits and letters are what must survive.
 */
function normalizeIdentifier(token: string): string {
  return token.toLowerCase().replace(/[\s.\-/]/g, "");
}

const NUMBER = /\d[\d.,\u00a0 ]*\d|\d/g;
/** An alphanumeric run with at least one letter and at least one digit. */
const IDENTIFIER = /[A-Za-z0-9][A-Za-z0-9.\-/]*/g;

interface RiskyToken {
  /** As it appeared, for the warning message. */
  raw: string;
  /** Normalised form used for the presence comparison. */
  key: string;
  kind: "number" | "identifier";
}

/** Extract the risky tokens (numbers and mixed identifiers) from a text. */
export function extractRiskyTokens(text: string): RiskyToken[] {
  const tokens: RiskyToken[] = [];

  for (const match of text.matchAll(NUMBER)) {
    const raw = match[0];
    const key = normalizeNumber(raw);
    if (key.length >= 2) tokens.push({ raw: raw.trim(), key, kind: "number" });
  }

  for (const match of text.matchAll(IDENTIFIER)) {
    const raw = match[0];
    const hasLetter = /[A-Za-z]/.test(raw);
    const hasDigit = /\d/.test(raw);
    // A pure number is already covered by the NUMBER pass; a pure word is not
    // risky. Only the mixed case (article numbers, codes) is added here.
    if (hasLetter && hasDigit) {
      const key = normalizeIdentifier(raw);
      if (key.length >= 2) tokens.push({ raw, key, kind: "identifier" });
    }
  }

  return tokens;
}

/**
 * Build the set of normalised keys present in the Markdown, for O(1) lookups.
 * Both token grammars are applied so a number in the body matches a number in
 * the raw text and likewise for identifiers.
 */
function presentKeys(markdown: string): Set<string> {
  const keys = new Set<string>();
  for (const match of markdown.matchAll(NUMBER)) {
    const key = normalizeNumber(match[0]);
    if (key.length >= 2) keys.add(key);
  }
  for (const match of markdown.matchAll(IDENTIFIER)) {
    if (/[A-Za-z]/.test(match[0]) && /\d/.test(match[0])) {
      keys.add(normalizeIdentifier(match[0]));
    }
  }
  return keys;
}

/**
 * Compare the risky tokens of the text layer against the produced Markdown.
 *
 * Returns which distinct tokens went missing and whether the loss is large
 * enough to warrant a warning. Pure structural or prose differences do not
 * register because only numbers and mixed identifiers are considered.
 */
export function checkTextFidelity(rawText: string, markdown: string): TextFidelityResult {
  const tokens = extractRiskyTokens(rawText);
  if (tokens.length === 0) {
    return { totalTokens: 0, missing: [], flagged: false };
  }

  const present = presentKeys(markdown);

  // Distinct missing tokens, keyed by normalised form, keeping the first raw
  // spelling for the message. Counting distinct rather than every occurrence
  // stops a header repeated on every line from dominating the ratio.
  const missingByKey = new Map<string, string>();
  const distinctKeys = new Set<string>();
  for (const token of tokens) {
    distinctKeys.add(token.key);
    if (!present.has(token.key) && !missingByKey.has(token.key)) {
      missingByKey.set(token.key, token.raw);
    }
  }

  const missing = [...missingByKey.values()];
  const distinctTotal = distinctKeys.size;
  const flagged =
    missing.length >= MIN_MISSING && missing.length / distinctTotal >= MIN_MISSING_RATIO;

  return { totalTokens: distinctTotal, missing, flagged };
}

/**
 * The German page warning for a flagged fidelity divergence, or `undefined` when
 * nothing crosses the threshold. Kept next to the check so the message and the
 * decision cannot drift apart.
 */
export function textFidelityWarning(result: TextFidelityResult): string | undefined {
  if (!result.flagged) return undefined;
  const examples = result.missing.slice(0, MAX_EXAMPLES).join(", ");
  const more = result.missing.length > MAX_EXAMPLES ? ` (und ${result.missing.length - MAX_EXAMPLES} weitere)` : "";
  return (
    `Abgleich mit der Textschicht: ${result.missing.length} von ${result.totalTokens} ` +
    `Zahlen/Bezeichnern der Seite fehlen im erzeugten Markdown und wurden vom Modell ` +
    `möglicherweise verändert oder ausgelassen. Betroffen u. a.: ${examples}${more}. ` +
    `Der Inhalt wurde nicht automatisch korrigiert; bitte prüfen.`
  );
}
