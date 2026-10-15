// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Trust labels for retrieved content.
 *
 * Everything the search service returns comes from documents someone ingested,
 * so it is untrusted data for the model that reads it: it may carry text that
 * tries to steer that model (indirect prompt injection). Every result is
 * therefore labelled `content_trust: "untrusted"`, and a cheap, deterministic
 * check adds an `injection_risk` hint per hit so a consumer can quarantine or
 * flag suspicious passages before they reach a prompt.
 *
 * The check is a heuristic over a short list of well-known override phrases in
 * English and German. It runs on the returned text at query time (no re-ingest
 * needed, no model call, no new dependency). It is a hint, not a guarantee: a
 * `none` never means "safe". The runtime keeps its own scan and spotlighting.
 */

export const CONTENT_TRUST = "untrusted" as const;

export type InjectionRisk = "none" | "suspected";

/** Longest text prefix that is scanned (bounds the cost per hit). */
const MAX_SCAN_CHARS = 20_000;

const SIGNALS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  {
    id: "override_instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|guidelines)\b/i,
  },
  {
    id: "override_instructions_de",
    pattern:
      /\b(?:ignoriere|ignorieren|vergiss|missachte)\b[^.\n]{0,40}\b(?:vorherigen|bisherigen|obigen|früheren|alle|sämtliche)\b[^.\n]{0,30}\b(?:anweisungen|instruktionen|regeln|vorgaben)\b/i,
  },
  {
    id: "new_instructions",
    pattern: /\b(?:new|updated|real)\s+instructions?\s*:|\bneue\s+anweisungen?\s*:/i,
  },
  {
    id: "role_reassignment",
    pattern: /\byou\s+are\s+now\b|\bdu\s+bist\s+(?:jetzt|nun)\b/i,
  },
  {
    id: "system_prompt_exfiltration",
    pattern:
      /\b(?:reveal|show|print|repeat|output|leak|verrate|zeige|gib)\b[^.\n]{0,40}\b(?:system[\s-]?prompt|hidden\s+instructions?|verborgenen?\s+anweisungen)\b/i,
  },
  {
    id: "chat_template_tokens",
    pattern: /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<\/?system>/i,
  },
  {
    id: "concealment",
    pattern:
      /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+user\b|\bsag(?:e)?\s+(?:es\s+)?dem\s+(?:nutzer|benutzer)\s+nicht\b/i,
  },
  {
    id: "exfiltration_url",
    pattern:
      /\b(?:send|post|forward|upload|exfiltrate|sende|schicke)\b[^.\n]{0,60}\b(?:to|an)\s+https?:\/\//i,
  },
];

export interface InjectionAssessment {
  risk: InjectionRisk;
  /** Ids of the matched signals (empty when `risk` is `none`). */
  signals: string[];
}

export function assessInjectionRisk(text: string | null | undefined): InjectionAssessment {
  if (typeof text !== "string" || text.length === 0) {
    return { risk: "none", signals: [] };
  }
  const scanned = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const signals = SIGNALS.filter((s) => s.pattern.test(scanned)).map((s) => s.id);
  return { risk: signals.length > 0 ? "suspected" : "none", signals };
}

/** Per-hit labels, spread into a result object. */
export function trustLabels(text: string | null | undefined): {
  content_trust: typeof CONTENT_TRUST;
  injection_risk: InjectionRisk;
} {
  return {
    content_trust: CONTENT_TRUST,
    injection_risk: assessInjectionRisk(text).risk,
  };
}

/** Response-level labels from per-hit risks: the worst hit decides. */
export function aggregateTrustLabels(
  risks: ReadonlyArray<InjectionRisk>,
): {
  contentTrust: typeof CONTENT_TRUST;
  content_trust: typeof CONTENT_TRUST;
  injection_risk: InjectionRisk;
} {
  return {
    contentTrust: CONTENT_TRUST,
    content_trust: CONTENT_TRUST,
    injection_risk: risks.includes("suspected") ? "suspected" : "none",
  };
}

/** Response-level labels computed straight from the returned texts. */
export function responseTrustLabels(
  texts: ReadonlyArray<string | null | undefined>,
): ReturnType<typeof aggregateTrustLabels> {
  return aggregateTrustLabels(texts.map((t) => assessInjectionRisk(t).risk));
}
