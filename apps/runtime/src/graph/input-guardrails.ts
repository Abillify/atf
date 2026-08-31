// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Input guardrails — prompt-injection & jailbreak detection
 * (`src/graph/input-guardrails.ts`)
 *
 * The output guardrails scrub what the model *says*; this stage inspects what
 * the user (or an upstream tool result fed back as text) *asks*, before it
 * reaches the model. It scores inbound text against a curated set of
 * prompt-injection and jailbreak signatures — instruction-override attempts,
 * system-prompt exfiltration, role/DAN jailbreaks, and tool/credential probing.
 *
 * The detector is heuristic and dependency-free (weighted regex signals), so it
 * adds negligible latency and needs no extra model call. It is intentionally a
 * *layer*: "flag" mode annotates the request with a risk score for routing /
 * observability, while "block" mode rejects high-risk requests outright. A real
 * deployment can raise the threshold or combine this with a model-based
 * classifier — the scoring is exposed so both modes share one signal.
 *
 * The signatures are **multilingual**: every signal matches its English *and*
 * German phrasings, because a regex tuned only for English ("ignore previous
 * instructions") is trivially evaded by a German deployment ("ignoriere alle
 * vorherigen Anweisungen"). For attacks in other languages, or paraphrase /
 * encoding evasion, layer the model-based classifier on top via
 * {@link InputGuardrail.scanWithModel} (see `input-guardrail-model.ts`).
 *
 * No `any` at module boundaries.
 */

/** A single named detection signal with a weight (0–1) and matcher. */
interface Signal {
  id: string;
  weight: number;
  pattern: RegExp;
}

// ---------------------------------------------------------------------------
// Normalisation: closes two concrete, verified evasions of the regex signals
// below — WITHOUT changing the signals themselves.
// ---------------------------------------------------------------------------

/**
 * Invisible/zero-width and other formatting-only code points that carry no
 * visible meaning but break a `\b…\b` regex boundary if left in place: a
 * zero-width space inserted between "ignore" and "all" turns one word into
 * two the pattern's `\s`/word-boundary assumptions do not expect, without
 * changing what a human reading the text sees. Stripped entirely rather than
 * mapped to a visible character, since they have no visible representation to
 * map to.
 *
 * Covers: zero-width space/non-joiner/joiner (U+200B–200D), the byte-order-mark
 * used as a zero-width no-break space (U+FEFF), left/right-to-left marks and
 * embedding/override/isolate controls (U+200E–200F, U+202A–202E, U+2066–2069),
 * and the Unicode "word joiner" (U+2060).
 */
const ZERO_WIDTH_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Confusable-character (homoglyph) mapping for the Latin letters the regex
 * signals below are written in. Maps visually-identical or near-identical
 * Cyrillic and Greek code points onto their Latin look-alikes so a string
 * like "Ignоre" (Cyrillic "о", U+043E, in place of Latin "o") still matches
 * the `ignore` signal instead of scoring 0.
 *
 * This is intentionally a SMALL, curated table — not a full implementation of
 * Unicode Technical Standard #39 (confusables.txt has thousands of entries
 * across many scripts). It covers the mixed-script single-character
 * substitution pattern that is by far the most common real-world evasion
 * (replacing one or two Latin letters with a visually-identical Cyrillic or
 * Greek letter so the surrounding text still reads as English/German), which
 * is exactly the gap the review identified. A deployment facing more exotic
 * confusable attacks should layer the model-based classifier
 * ({@link InputGuardrail.scanWithModel}) on top, as recommended above.
 */
const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Cyrillic → Latin (lowercase)
    а: "a",
    е: "e",
    о: "o",
    р: "p",
    с: "c",
    х: "x",
    у: "y",
    і: "i",
    ѕ: "s",
    ј: "j",
    ԃ: "d",
    // Cyrillic → Latin (uppercase)
    А: "A",
    В: "B",
    Е: "E",
    К: "K",
    М: "M",
    Н: "H",
    О: "O",
    Р: "P",
    С: "C",
    Т: "T",
    Х: "X",
    // Greek → Latin
    α: "a",
    ο: "o",
    ρ: "p",
    ν: "v",
    Α: "A",
    Β: "B",
    Ε: "E",
    Ζ: "Z",
    Η: "H",
    Ι: "I",
    Κ: "K",
    Μ: "M",
    Ν: "N",
    Ο: "O",
    Ρ: "P",
    Τ: "T",
    Υ: "Y",
    Χ: "X",
  }),
);

const CONFUSABLES_RE = new RegExp(
  `[${[...CONFUSABLES.keys()].join("")}]`,
  "g",
);

/**
 * Normalises text before it is scored: Unicode NFKC normalisation (folds
 * full-width/compatibility forms — e.g. fullwidth "ｉｇｎｏｒｅ" — onto their
 * standard forms), zero-width/control character stripping, and Cyrillic/Greek
 * confusable-to-Latin mapping. Pure; safe to apply to any text, including text
 * with no injection attempt (a benign string is unaffected in any way a human
 * reader would notice).
 */
export function normalizeForScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONFUSABLES_RE, (ch) => CONFUSABLES.get(ch) ?? ch);
}

/**
 * Curated signatures. Weights are tuned so that one strong signal (e.g. an
 * explicit "ignore previous instructions") lands near the default block
 * threshold, while weaker probes accumulate. Patterns are case-insensitive and
 * match both English and German phrasings of each attack class (a German-only
 * deployment would otherwise be wide open to German-language injections).
 */
const SIGNALS: readonly Signal[] = [
  // Instruction-override / context reset.
  {
    id: "ignore_instructions",
    weight: 0.8,
    pattern:
      /\b(ignore|disregard|forget|override|ignorier(e|st|en)?|missachte|vergiss|überschreib(e|en)?|verwirf)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|vorherige\w*|vorige\w*|obige\w*|bisherige\w*|frühere\w*|alle|sämtliche\w*)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|context|messages?|anweisung\w*|befehle?|regeln?|vorgaben?|kontext|nachrichten?)\b/i,
  },
  {
    id: "ignore_system",
    weight: 0.85,
    pattern:
      /\b(ignore|bypass|disable|turn off|umgeh(e|en|st)?|deaktivier(e|en|st)?|schalte|abschalten|ausschalten)\b[^.\n]{0,30}\b(system|safety|guard ?rails?|filters?|policies|restrictions?|sicherheit\w*|schutz\w*|guardrails?|filter\w*|richtlinien?|einschränkung\w*|beschränkung\w*|sicherheitsvorkehrung\w*)\b/i,
  },
  // System-prompt exfiltration.
  {
    id: "reveal_system_prompt",
    weight: 0.8,
    pattern:
      /\b(reveal|show|print|repeat|output|tell me|what (is|are)|zeig(e|st)?|nenne|verrate|verrät|sag(e)? mir|wie lautet|was (ist|sind)|drucke|wiederhole|gib mir)\b[^.\n]{0,40}\b(system prompt|initial instructions?|your (instructions?|prompt|rules?)|the prompt above|system-?prompt|systemanweisung\w*|ursprünglich\w* anweisung\w*|deine\w* (anweisung\w*|prompt|regeln)|deinen prompt|obige\w* prompt)\b/i,
  },
  {
    id: "verbatim_prompt",
    weight: 0.6,
    pattern:
      /\b(repeat|print|wiederhole|drucke|gib)\b[^.\n]{0,20}\b(verbatim|word for word|exactly|wortwörtlich|wort für wort|exakt|1:1)\b/i,
  },
  // Role-play / persona jailbreaks.
  {
    id: "dan_jailbreak",
    weight: 0.85,
    pattern:
      /\b(DAN|do anything now|developer mode|jailbreak|unfiltered|no restrictions?|entwicklermodus|entwickler-modus|ungefiltert|uneingeschränkt|ohne (regeln|einschränkung\w*|beschränkung\w*|filter|grenzen)|keine (regeln|einschränkung\w*|beschränkung\w*|grenzen))\b/i,
  },
  {
    id: "pretend_role",
    weight: 0.55,
    pattern:
      /\b(pretend|act as if|you are now|from now on you are|roleplay as|tu so als|gib vor|du bist (jetzt|nun)|ab (jetzt|sofort) bist du|spiele die rolle|verhalte dich wie)\b[^.\n]{0,40}\b(no (rules?|limits?|restrictions?|filters?)|evil|unrestricted|uncensored|keine (regeln|grenzen|einschränkung\w*|filter)|böse|unzensiert|uneingeschränkt)\b/i,
  },
  {
    id: "hypothetical_bypass",
    weight: 0.45,
    pattern:
      /\b(hypothetically|in a fictional|for educational purposes only|as a thought experiment|hypothetisch|rein fiktiv|nur zu (bildungs|lern)zwecken|als gedankenexperiment)\b[^.\n]{0,40}\b(how (to|do)|steps to|instructions? (for|to)|wie (man|kann|ich)|schritte (um|zum)|anleitung (für|zum|zur))\b/i,
  },
  // Credential / tool probing.
  {
    id: "exfil_credentials",
    weight: 0.7,
    pattern:
      /\b(print|show|reveal|leak|dump|give me|zeig(e)?|gib mir|verrate|leake|nenne|dumpe)\b[^.\n]{0,30}\b(api[_ -]?keys?|secrets?|passwords?|tokens?|credentials?|env(ironment)? variables?|api[_ -]?schlüssel|schlüssel|geheimnisse?|passw(ort|örter)|zugangsdaten|anmeldedaten|umgebungsvariablen?)\b/i,
  },
  {
    id: "tool_injection",
    weight: 0.6,
    pattern:
      /\b(call|invoke|execute|run|rufe?|führe?|starte|nutze)\b[^.\n]{0,30}\b(tool|function|command|werkzeug|funktion|befehl)\b[^.\n]{0,40}\b(with|using|mit|über)\b[^.\n]{0,40}\b(user_token|client_id|admin|root)\b/i,
  },
  // Encoding tricks frequently used to smuggle payloads.
  {
    id: "encoding_evasion",
    weight: 0.4,
    pattern:
      /\b(base64|rot13|decode the following|in reverse|ascii codes?|dekodiere|entschlüssele|in umgekehrter reihenfolge|rückwärts)\b[^.\n]{0,30}\b(then (execute|run|follow|do)|and (execute|run|follow)|dann (ausführ\w*|folge|mach\w*|führe)|und (ausführ\w*|folge|führe))\b/i,
  },
  // Delimiter / fake-system injection (language-independent).
  {
    id: "fake_system_turn",
    weight: 0.65,
    pattern: /(^|\n)\s*[[<#]{0,3}\s*(system|assistant)\s*[\]>]?\s*:\s/i,
  },
];

export type InputGuardrailMode = "flag" | "block";

export interface InputScanResult {
  /** Overall risk score in [0,1]. */
  score: number;
  /** True when score >= the configured block threshold. */
  flagged: boolean;
  /** IDs of the signals that matched (for logging / observability). */
  matched: string[];
}

export interface InputGuardrailOptions {
  /** Score (0–1) at/above which {@link InputScanResult.flagged} is true. Default 0.8. */
  threshold?: number;
}

/**
 * Scores a single piece of text. The score combines matched signal weights with
 * a probabilistic-OR so multiple weak signals raise risk without ever exceeding
 * 1.0, and one strong signal dominates. Pure.
 */
export function scoreText(text: string, threshold = 0.8): InputScanResult {
  // Normalise BEFORE matching, not the pattern set — this closes the
  // zero-width-insertion and homoglyph-substitution evasions without having
  // to duplicate every signal's regex for every possible obfuscation.
  const normalized = normalizeForScan(text);
  const matched: string[] = [];
  // Probabilistic OR: risk = 1 - Π(1 - weight) over matched signals.
  let survive = 1;
  for (const sig of SIGNALS) {
    if (sig.pattern.test(normalized)) {
      matched.push(sig.id);
      survive *= 1 - sig.weight;
    }
  }
  const score = Math.round((1 - survive) * 1000) / 1000;
  return { score, flagged: score >= threshold, matched };
}

/** Extracts the inspectable text from a message content (string or blocks). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

export interface ScannableMessage {
  role: string;
  content: unknown;
}

/**
 * The input guardrail. Scans the user-authored messages of a request (system /
 * assistant turns are trusted and skipped) and returns the highest single-message
 * risk plus the union of matched signals.
 */
export class InputGuardrail {
  private _threshold: number;

  constructor(opts: InputGuardrailOptions = {}) {
    this._threshold = opts.threshold ?? 0.8;
  }

  /** Score (0–1) at/above which a request is flagged. Exposed so callers that
   *  combine this with another signal can compare against the same threshold. */
  get threshold(): number {
    return this._threshold;
  }

  /**
   * Live-updates the block threshold — used by the red-team engine's auto-tune
   * (ADR-0010): when the measured bypass rate exceeds the ceiling the engine
   * tightens the threshold, and this feeds that decision back into the *live*
   * guardrail so subsequent real traffic (and later red-team runs) actually use
   * the tightened value. Clamped to [0,1].
   */
  setThreshold(value: number): void {
    if (!Number.isFinite(value)) return;
    this._threshold = Math.min(1, Math.max(0, value));
  }

  /** Scans an array of chat messages, inspecting only `user` turns. */
  scan(messages: readonly ScannableMessage[]): InputScanResult {
    let maxScore = 0;
    const matched = new Set<string>();
    for (const m of messages) {
      if (m.role !== "user") continue;
      const r = scoreText(messageText(m.content), this.threshold);
      if (r.score > maxScore) maxScore = r.score;
      for (const id of r.matched) matched.add(id);
    }
    return {
      score: maxScore,
      flagged: maxScore >= this.threshold,
      matched: [...matched],
    };
  }

  /**
   * Two-layer scan: the fast heuristic first, then — only when the heuristic
   * already saw *some* risk (>= `grayZoneFloor`) — an optional model-based
   * classifier for a calibrated second opinion. The layers are combined by
   * `max`, so a strong signal from either trips the gate; benign traffic never
   * pays for a model round-trip. The classifier is expected to fail open
   * (score 0) on error/timeout — see `createModelInputClassifier`.
   *
   * `matched` carries the heuristic signal ids plus the synthetic
   * `model_classifier` marker when the model raised the score.
   */
  async scanWithModel(
    messages: readonly ScannableMessage[],
    classify: (text: string) => Promise<{ score: number }>,
    grayZoneFloor = 0.2,
  ): Promise<InputScanResult> {
    const heuristic = this.scan(messages);
    // Below the gray-zone floor the text is clearly benign — skip the model.
    if (heuristic.score < grayZoneFloor) return heuristic;

    // Classify the highest-risk user turn (the one that drove the heuristic).
    let worst = "";
    let worstScore = -1;
    for (const m of messages) {
      if (m.role !== "user") continue;
      const text = messageText(m.content);
      const s = scoreText(text, this.threshold).score;
      if (s > worstScore) {
        worstScore = s;
        worst = text;
      }
    }

    const model = await classify(worst);
    const modelScore =
      typeof model.score === "number" && Number.isFinite(model.score)
        ? Math.min(1, Math.max(0, model.score))
        : 0;
    const combined = Math.max(heuristic.score, modelScore);
    const matched =
      modelScore > heuristic.score
        ? [...heuristic.matched, "model_classifier"]
        : heuristic.matched;
    return {
      score: Math.round(combined * 1000) / 1000,
      flagged: combined >= this.threshold,
      matched,
    };
  }
}
