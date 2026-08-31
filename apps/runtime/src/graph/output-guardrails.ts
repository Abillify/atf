// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Output guardrails (`src/graph/output-guardrails.ts`)
 *
 * A pipeline stage that scrubs model output before it reaches the client.
 * Two concerns:
 *   1. PII redaction — emails, phone numbers, credit-card numbers (Luhn-checked
 *      to avoid false positives), IBANs, US SSNs, IPv4 addresses and common
 *      secret/token shapes (OpenAI keys, AWS access keys, GitHub tokens, JWTs).
 *   2. Content blocklist — operator-supplied regex patterns whose matches are
 *      redacted (mode "redact") or replaced with a single notice (mode "block").
 *
 * Streaming-safe: tokens arrive as a delta stream, and a sensitive value can
 * straddle two deltas ("4111 1111" + " 1111 1111"). {@link GuardrailStream}
 * buffers a trailing window and only emits text it is safe to release (cut at a
 * whitespace boundary, never within the window), so a value split across deltas
 * is still caught. {@link GuardrailStream.flush} drains the remainder at end.
 *
 * Pure detection logic ({@link redactText}) is exported and unit-testable.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// PII detectors
// ---------------------------------------------------------------------------

export type PiiType =
  | "email"
  | "phone"
  | "creditCard"
  | "iban"
  | "ssn"
  | "ipv4"
  | "secret"
  | "deTaxId"
  | "deSocialId"
  | "euVatId"
  | "person"
  | "location"
  | "organization";

/** All detector names, used when no explicit subset is configured. */
export const ALL_PII_TYPES: readonly PiiType[] = [
  "secret",
  "email",
  "iban",
  "euVatId",
  "deTaxId",
  "deSocialId",
  "creditCard",
  "ssn",
  "ipv4",
  "phone",
  "person",
  "location",
  "organization",
];

/**
 * PII types that have NO deterministic regex detector — they are only produced
 * by the NER / remote detector pipeline (ADR-0015). Requesting one of these on
 * a regex-only path (the output/egress guardrail, or the vault without a
 * detector registry) silently redacts nothing, so callers warn on it rather
 * than give false assurance.
 */
export const NER_ONLY_PII_TYPES: readonly PiiType[] = [
  "person",
  "location",
  "organization",
];

/** Returns the subset of `types` that no regex detector can match. */
export function nerOnlyTypes(types: readonly string[]): PiiType[] {
  return (NER_ONLY_PII_TYPES as readonly string[]).filter((t) =>
    types.includes(t),
  ) as PiiType[];
}

/** Luhn checksum — used to confirm a digit run is a plausible card number. */
export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Validates a German tax identification number (steuerliche
 * Identifikationsnummer / IdNr) — 11 digits with an ISO 7064 MOD 11,10 check
 * digit. The check digit rejects ~90% of random 11-digit runs, keeping the
 * detector precise enough to run on free model output.
 */
export function validateDeTaxId(candidate: string): boolean {
  const d = candidate.replace(/\D/g, "");
  if (d.length !== 11) return false;
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (Number(d[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = (11 - product) % 10;
  return check === Number(d[10]);
}

/**
 * Validates a German social-insurance number (Versicherungsnummer / SVNR):
 * 2-digit area + 6-digit birth date (DDMMYY) + 1 letter (initial) + 3 digits
 * (serial + check). Validates the embedded date for plausibility, which makes
 * the 12-char shape specific enough to avoid false positives.
 */
export function validateDeSocialId(candidate: string): boolean {
  const c = candidate.replace(/\s/g, "");
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})[A-Za-z](\d{3})$/.exec(c);
  if (m === null) return false;
  const dd = Number(m[2]);
  const mm = Number(m[3]);
  if (dd < 1 || dd > 31) return false;
  if (mm < 1 || mm > 12) return false;
  return true;
}

interface Detector {
  type: PiiType;
  regex: RegExp;
  /** Optional extra validation on a candidate match (e.g. Luhn for cards). */
  validate?: (match: string) => boolean;
}

/** Detectors are applied in this order; earlier redactions remove ambiguity. */
function buildDetectors(): Detector[] {
  return [
    {
      type: "secret",
      // OpenAI keys, GitHub tokens, AWS access keys, Slack tokens, JWTs.
      regex:
        /\b(?:(?:sk|pk|rk)-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    },
    {
      type: "email",
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    },
    {
      type: "iban",
      regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    },
    {
      // EU VAT identification numbers (USt-IdNr.) for the most common member
      // states. Country prefix + the state-specific body. Runs before the
      // generic phone detector so the digit body is not mistaken for a number.
      type: "euVatId",
      regex:
        /\b(?:DE\d{9}|ATU\d{8}|BE0\d{9}|FR[A-Z0-9]{2}\d{9}|IT\d{11}|NL\d{9}B\d{2}|PL\d{10}|ES[A-Z0-9]\d{7}[A-Z0-9])\b/g,
    },
    {
      // German social-insurance number (SVNR): 2 + 6 (DDMMYY) + letter + 3.
      // Validated (date plausibility) before the tax-id/phone detectors so its
      // letter-bearing shape is matched first.
      type: "deSocialId",
      regex: /\b\d{2} ?\d{6} ?[A-Za-z] ?\d{3}\b/g,
      validate: (m) => validateDeSocialId(m),
    },
    {
      // German tax id (steuerliche IdNr): 11 digits with a MOD 11,10 check
      // digit. Runs before the phone detector (which would otherwise eat the
      // 11-digit run) and is check-digit gated to stay precise.
      type: "deTaxId",
      regex: /\b\d{2} ?\d{3} ?\d{3} ?\d{3}\b/g,
      validate: (m) => validateDeTaxId(m),
    },
    {
      type: "creditCard",
      // Candidate runs of 13–19 digits with optional spaces/hyphens; Luhn-gated.
      regex: /\b(?:\d[ -]?){13,19}\b/g,
      validate: (m) => luhnValid(m),
    },
    {
      type: "ssn",
      regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    },
    {
      type: "ipv4",
      regex:
        /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    },
    {
      type: "phone",
      // International/local phone numbers with common separators; ≥7 digits.
      // Negative-lookahead excludes date patterns (DD.MM.YYYY / DD-MM-YYYY /
      // YYYY-MM-DD) that would otherwise be mis-matched as phone numbers —
      // e.g. filenames like "Anrufprotokoll_22.02.2024_gesichtet.pdf".
      regex:
        /(?<!\d{4}[-.])\+?\d[\d\s().-]{6,}\d(?![-_.]\d{4}\b)(?!\d{4}[-.])/g,
      validate: (m) => {
        // Reject pure date-shaped strings: DD.MM.YYYY or YYYY-MM-DD or YYYYMMDD
        const digits = m.replace(/\D/g, "");
        if (/^\d{8}$/.test(digits)) {
          // Could be YYYYMMDD or DDMMYYYY — reject
          return false;
        }
        if (/^\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}$/.test(m.trim())) {
          return false;
        }
        return digits.length >= 7;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Span-based detection (pure) — used by the reversible PII vault
// ---------------------------------------------------------------------------

export interface PiiMatch {
  type: PiiType;
  value: string;
  /** Start offset (inclusive) in the original text. */
  start: number;
  /** End offset (exclusive) in the original text. */
  end: number;
}

/**
 * Returns every validated PII match in `text` with its position, using the
 * same detectors and priority order as {@link redactText} — but reporting
 * spans instead of replacing them in place. Consumed by the reversible PII
 * tokenization vault ({@link "./pii-vault.js"}), which substitutes a stable
 * placeholder for each span rather than a one-way `[REDACTED_*]` marker.
 *
 * Detectors run in {@link buildDetectors}'s priority order (secrets first,
 * then email, IBAN, …, phone last) and a later detector's match is discarded
 * when it overlaps a span already accepted from an earlier, higher-priority
 * detector — the same precedence `redactText`'s sequential `.replace()` calls
 * produce, just made explicit for span output. Pure — no I/O.
 */
export function findPiiMatches(
  text: string,
  types?: readonly PiiType[],
): PiiMatch[] {
  const active = types !== undefined && types.length > 0 ? types : ALL_PII_TYPES;
  const enabled = new Set<PiiType>(active);
  const accepted: PiiMatch[] = [];
  const occupied: Array<[number, number]> = [];
  const overlaps = (start: number, end: number): boolean =>
    occupied.some(([os, oe]) => start < oe && end > os);

  for (const det of buildDetectors()) {
    if (!enabled.has(det.type)) continue;
    const flags = det.regex.flags.includes("g")
      ? det.regex.flags
      : `${det.regex.flags}g`;
    const g = new RegExp(det.regex.source, flags);
    for (const m of text.matchAll(g)) {
      const value = m[0];
      const start = m.index ?? 0;
      const end = start + value.length;
      if (overlaps(start, end)) continue;
      if (det.validate && !det.validate(value)) continue;
      accepted.push({ type: det.type, value, start, end });
      occupied.push([start, end]);
    }
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

// ---------------------------------------------------------------------------
// Redaction (pure)
// ---------------------------------------------------------------------------

export interface RedactionResult {
  text: string;
  /** Count of redactions per finding type (e.g. { email: 2, phone: 1 }). */
  findings: Record<string, number>;
}

export interface GuardrailOptions {
  redactPii: boolean;
  /** When non-empty, only these PII detectors run. */
  piiTypes: PiiType[];
  /** Compiled blocklist patterns (case-insensitive, global). */
  blockedPatterns: RegExp[];
  mode: "redact" | "block";
}

function placeholder(label: string, mode: "redact" | "block"): string {
  return mode === "block" ? "[BLOCKED]" : `[REDACTED_${label.toUpperCase()}]`;
}

/**
 * Applies PII detectors and the blocklist to a complete text, returning the
 * scrubbed text and per-type finding counts. Pure — no I/O, no state.
 */
export function redactText(
  text: string,
  opts: GuardrailOptions,
): RedactionResult {
  const findings: Record<string, number> = {};
  let out = text;

  const bump = (type: string, n: number): void => {
    if (n > 0) findings[type] = (findings[type] ?? 0) + n;
  };

  // 1. Blocklist patterns first (operator intent wins).
  for (const re of opts.blockedPatterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const g = new RegExp(re.source, flags);
    let count = 0;
    out = out.replace(g, () => {
      count++;
      return placeholder("blocked", opts.mode);
    });
    bump("blocked", count);
  }

  // 2. PII detectors.
  if (opts.redactPii) {
    const active =
      opts.piiTypes.length > 0 ? opts.piiTypes : [...ALL_PII_TYPES];
    const enabled = new Set<PiiType>(active);
    for (const det of buildDetectors()) {
      if (!enabled.has(det.type)) continue;
      let count = 0;
      out = out.replace(det.regex, (m: string) => {
        if (det.validate && !det.validate(m)) return m;
        count++;
        return placeholder(det.type, opts.mode);
      });
      bump(det.type, count);
    }
  }

  return { text: out, findings };
}

// ---------------------------------------------------------------------------
// Streaming guardrail
// ---------------------------------------------------------------------------

/** Trailing window (chars) held back so a value split across deltas is caught. */
const STREAM_WINDOW = 256;
/**
 * Hard upper bound on the buffer before we force a cut even without a "clean"
 * (non-numeric-group) boundary — protects against an all-numeric stream that
 * would otherwise never present a clean boundary and buffer without limit.
 */
const HARD_BUFFER_MAX = 4096;
/**
 * Max chars to nudge a forced cut left to escape a spaced numeric group. Larger
 * than any detector's maximum value length (IBAN ≤ 34), so a forced cut never
 * lands inside a *detectable* number; a run longer than this matches no detector.
 */
const NUMERIC_GROUP_ESCAPE = 64;

/**
 * Buffers a delta stream and emits only text safe to release. A value cannot be
 * split undetected because we never cut within {@link STREAM_WINDOW} chars of
 * the buffer end and always cut at a whitespace boundary.
 */
export class GuardrailStream {
  private buffer = "";
  private readonly findings: Record<string, number> = {};

  constructor(private readonly opts: GuardrailOptions) {}

  /** Feeds a delta; returns the scrubbed text that is safe to emit now (may be ""). */
  push(delta: string): string {
    this.buffer += delta;
    if (this.buffer.length <= STREAM_WINDOW) return "";

    // Find a whitespace cut point that leaves at least STREAM_WINDOW chars buffered.
    // Several PII detectors match values that CONTAIN internal whitespace — a
    // credit card `4111 1111 1111 1111`, a phone number, the German tax/social
    // id — so cutting at just any whitespace can split such a value across two
    // flushes, and each fragment then fails its Luhn/length/check-digit test and
    // is emitted unredacted. We therefore only accept a whitespace boundary that
    // is NOT inside a spaced numeric group: a boundary is "clean" unless it has a
    // digit on both sides (ignoring the separator run), which is exactly the
    // shape of a spaced number straddling the cut.
    const limit = this.buffer.length - STREAM_WINDOW;
    let cut = -1;
    for (let i = limit; i > 0; i--) {
      const ch = this.buffer[i] ?? "";
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
        if (this.isInsideNumericGroup(i)) continue; // don't split a spaced number
        cut = i;
        break;
      }
    }

    if (cut <= 0) {
      // No clean boundary yet. Keep buffering until we grow past the hard cap;
      // then force a cut so memory is truly bounded even when the stream has NO
      // whitespace at all (a continuous run). To avoid splitting a spaced PII
      // value across the forced cut, nudge left off any digit/separator run —
      // bounded by NUMERIC_GROUP_ESCAPE, which comfortably exceeds every
      // detector's max value length (IBAN ≤ 34, card ≤ 19, etc.), so the cut
      // never lands inside a *detectable* number. A run longer than that is not
      // a PII value any detector matches, so cutting it is safe.
      if (this.buffer.length <= HARD_BUFFER_MAX) return "";
      cut = this.buffer.length - STREAM_WINDOW;
      let escaped = 0;
      while (cut > 0 && escaped < NUMERIC_GROUP_ESCAPE && this.isInsideNumericGroup(cut)) {
        cut--;
        escaped++;
      }
      if (cut <= 0) cut = this.buffer.length - STREAM_WINDOW; // give up nudging; still bound memory
    }

    const head = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return this.scrub(head);
  }

  /**
   * True when the whitespace at `idx` sits between two digits (ignoring a short
   * run of number separators — spaces, hyphens, dots, parens), i.e. it is an
   * internal separator of a spaced numeric value rather than a real word break.
   */
  private isInsideNumericGroup(idx: number): boolean {
    const isSep = (c: string): boolean =>
      c === " " || c === "-" || c === "." || c === "(" || c === ")" || c === "\t";
    const isDigit = (c: string): boolean => c >= "0" && c <= "9";
    let l = idx - 1;
    while (l >= 0 && isSep(this.buffer[l] ?? "")) l--;
    let r = idx + 1;
    while (r < this.buffer.length && isSep(this.buffer[r] ?? "")) r++;
    const left = l >= 0 ? (this.buffer[l] ?? "") : "";
    const right = r < this.buffer.length ? (this.buffer[r] ?? "") : "";
    return isDigit(left) && isDigit(right);
  }

  /** Drains and scrubs any remaining buffered text. Call once at stream end. */
  flush(): string {
    if (this.buffer.length === 0) return "";
    const remaining = this.buffer;
    this.buffer = "";
    return this.scrub(remaining);
  }

  /** Aggregated redaction counts seen so far. */
  getFindings(): Record<string, number> {
    return { ...this.findings };
  }

  private scrub(text: string): string {
    const result = redactText(text, this.opts);
    for (const [type, n] of Object.entries(result.findings)) {
      this.findings[type] = (this.findings[type] ?? 0) + n;
    }
    return result.text;
  }
}

// ---------------------------------------------------------------------------
// Egress DLP — outbound tool-call arguments
// ---------------------------------------------------------------------------

export interface ToolArgScrubResult {
  /** The arguments with string values scrubbed (deep copy; input untouched). */
  args: Record<string, unknown>;
  /** Per-type finding counts across all scrubbed string values. */
  findings: Record<string, number>;
}

/**
 * Recursively scrubs the string values of a tool-call argument object so PII /
 * secrets the model may have lifted from the conversation are not exfiltrated
 * to an external MCP tool. Non-string values (numbers, booleans) pass through;
 * nested objects and arrays are walked. Pure — returns a new object and never
 * mutates the input. Keys are NOT redacted (a key like "email" is structure,
 * not data).
 *
 * Note: the MCP wrapper injects protected parameters (`user_token`,
 * `user_email`, `client_id`) from the request context *after* this runs, so
 * legitimate credentials are unaffected — this only scrubs model-supplied args.
 */
export function scrubToolArgs(
  args: Record<string, unknown>,
  opts: GuardrailOptions,
): ToolArgScrubResult {
  const findings: Record<string, number> = {};
  const bump = (f: Record<string, number>): void => {
    for (const [k, n] of Object.entries(f))
      findings[k] = (findings[k] ?? 0) + n;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const r = redactText(value, opts);
      bump(r.findings);
      return r.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };
  return { args: walk(args) as Record<string, unknown>, findings };
}

/** True when a findings map has at least one redaction. */
export function hasFindings(findings: Record<string, number>): boolean {
  for (const n of Object.values(findings)) if (n > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// OutputGuardrail facade + factory
// ---------------------------------------------------------------------------

export interface OutputGuardrail {
  enabled: boolean;
  /** Scrubs a complete text (non-streaming path). */
  redact(text: string): RedactionResult;
  /** Creates a per-stream incremental scrubber. */
  createStream(): GuardrailStream;
}

class OutputGuardrailImpl implements OutputGuardrail {
  readonly enabled = true;
  constructor(private readonly opts: GuardrailOptions) {}

  redact(text: string): RedactionResult {
    return redactText(text, this.opts);
  }

  createStream(): GuardrailStream {
    return new GuardrailStream(this.opts);
  }
}

export interface OutputGuardrailConfig {
  enabled?: boolean;
  redactPii?: boolean;
  piiTypes?: string[];
  blockedPatterns?: string[];
  mode?: "redact" | "block";
}

/**
 * Builds an {@link OutputGuardrail}, or undefined when disabled. Invalid
 * blocklist regexes are skipped with a warning rather than aborting startup.
 */
export function createOutputGuardrail(
  config: OutputGuardrailConfig,
  logger?: Logger,
): OutputGuardrail | undefined {
  if (config.enabled !== true) return undefined;

  const blockedPatterns: RegExp[] = [];
  for (const src of config.blockedPatterns ?? []) {
    try {
      blockedPatterns.push(new RegExp(src, "gi"));
    } catch (err) {
      logger?.warn("Skipping invalid guardrail blocked pattern", {
        pattern: src,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const piiTypes = (config.piiTypes ?? []).filter((t): t is PiiType =>
    (ALL_PII_TYPES as readonly string[]).includes(t),
  );

  const nerOnly = nerOnlyTypes(piiTypes);
  if (nerOnly.length > 0) {
    logger?.warn(
      "Output guardrail configured with NER-only PII types that have no regex detector — " +
        "these redact NOTHING on the streaming output path (which is regex-only for latency). " +
        "They are only tokenized at vault ingress when the NER/remote detector pipeline is enabled (PII_DETECTORS).",
      { nerOnlyTypes: nerOnly },
    );
  }

  const opts: GuardrailOptions = {
    redactPii: config.redactPii ?? true,
    piiTypes,
    blockedPatterns,
    mode: config.mode ?? "redact",
  };

  logger?.info("Output guardrails enabled", {
    redactPii: opts.redactPii,
    piiTypes: opts.piiTypes.length > 0 ? opts.piiTypes : "all",
    blockedPatterns: blockedPatterns.length,
    mode: opts.mode,
  });

  return new OutputGuardrailImpl(opts);
}

// ---------------------------------------------------------------------------
// Tool egress guardrail facade + factory
// ---------------------------------------------------------------------------

export interface ToolEgressGuardrail {
  enabled: boolean;
  /** "redact" scrubs string args; "block" denies a tool call carrying PII. */
  mode: "redact" | "block";
  /** Scrubs outbound tool-call arguments. */
  scrub(args: Record<string, unknown>): ToolArgScrubResult;
}

class ToolEgressGuardrailImpl implements ToolEgressGuardrail {
  readonly enabled = true;
  constructor(private readonly opts: GuardrailOptions) {}
  get mode(): "redact" | "block" {
    return this.opts.mode;
  }
  scrub(args: Record<string, unknown>): ToolArgScrubResult {
    return scrubToolArgs(args, this.opts);
  }
}

/**
 * Builds a {@link ToolEgressGuardrail}, or undefined when disabled. Reuses the
 * same PII detectors and blocklist as the output guardrail but is toggled
 * independently — egress DLP (what leaves to external tools) and output DLP
 * (what reaches the client) are distinct controls.
 */
export function createToolEgressGuardrail(
  config: OutputGuardrailConfig,
  logger?: Logger,
): ToolEgressGuardrail | undefined {
  if (config.enabled !== true) return undefined;

  const blockedPatterns: RegExp[] = [];
  for (const src of config.blockedPatterns ?? []) {
    try {
      blockedPatterns.push(new RegExp(src, "gi"));
    } catch (err) {
      logger?.warn("Skipping invalid egress guardrail blocked pattern", {
        pattern: src,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const piiTypes = (config.piiTypes ?? []).filter((t): t is PiiType =>
    (ALL_PII_TYPES as readonly string[]).includes(t),
  );

  const nerOnly = nerOnlyTypes(piiTypes);
  if (nerOnly.length > 0) {
    logger?.warn(
      "Tool egress guardrail configured with NER-only PII types that have no regex detector — " +
        "these scrub NOTHING (the egress path is regex-only).",
      { nerOnlyTypes: nerOnly },
    );
  }

  const opts: GuardrailOptions = {
    redactPii: config.redactPii ?? true,
    piiTypes,
    blockedPatterns,
    mode: config.mode ?? "redact",
  };

  logger?.info("Tool egress guardrail enabled", {
    redactPii: opts.redactPii,
    mode: opts.mode,
    blockedPatterns: blockedPatterns.length,
  });

  return new ToolEgressGuardrailImpl(opts);
}
