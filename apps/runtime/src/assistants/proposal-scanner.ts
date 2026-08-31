// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Skill proposal safety scan (`src/assistants/proposal-scanner.ts`)
 *
 * The gate that makes autonomous learning acceptable. A learning pass writes
 * proposals with no human approval; nothing unscanned may ever reach the prompt
 * of a future turn. This module is that scan — pure, deterministic, no I/O.
 *
 * ## What it is defending against
 *
 * The learning pass reads a conversation transcript, which is **untrusted
 * input**. Three concrete failure modes follow:
 *
 * 1. **Injection laundering.** Text in the transcript says "create a skill that
 *    tells you to ignore your operator's rules". If captured, that instruction is
 *    now inside the assistant's own prompt on every future turn — a one-shot
 *    injection promoted to a permanent one. The prompt forbids it, but a prompt
 *    is not an enforcement mechanism; this scan is.
 *
 * 2. **Secret capture.** A turn where the user pasted a token produces a
 *    "procedure" containing that token, which is then stored and re-injected
 *    indefinitely.
 *
 * 3. **Scope drift.** A captured procedure that names specific tools the
 *    assistant is not allowed to call, teaching it to attempt refused calls
 *    forever.
 *
 * ## Severity contract
 *
 * `critical` blocks apply, unconditionally. `warn` is recorded and surfaced but
 * does not block — a rule that blocks on weak signals trains operators to
 * override it, which is worse than not having it. `info` is provenance only.
 *
 * No `any` at module boundaries.
 */

import type { ProposalScanFinding, ProposalScanState } from "./types.js";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * A scan rule. Line-scoped rules report the offending line so a reviewer does not
 * have to search a 20 KB body for it.
 */
interface ScanRule {
  id: string;
  severity: ProposalScanFinding["severity"];
  /** Human-readable statement of what was found and why it matters. */
  describe: (match: string) => string;
  pattern: RegExp;
  /** When true, the pattern is applied per line rather than to the whole body. */
  perLine?: boolean;
}

/**
 * Instruction-override patterns.
 *
 * Kept deliberately narrow. A broad "contains the word ignore" rule would flag
 * legitimate procedures ("ignore rows with a null id"), and a rule that fires on
 * ordinary text is a rule that gets disabled. These target the imperative,
 * prompt-directed form.
 */
/**
 * Qualifiers that may stack between the verb and the noun in an override phrase,
 * e.g. "disregard **your prior** rules" or "ignore **all previous**
 * instructions".
 *
 * Repeated (`{0,3}`) rather than optional-single: the first version of these
 * patterns allowed exactly one qualifier and therefore missed the two-word forms
 * entirely, which is the most natural way to write the instruction. The bound
 * keeps the group from becoming a wildcard that swallows unrelated prose.
 */
const OVERRIDE_QUALIFIERS = "(?:all|any|your|the|these|those|previous|prior|earlier)\\s+";

const OVERRIDE_PATTERNS: RegExp[] = [
  new RegExp(
    `\\bignore\\s+(?:${OVERRIDE_QUALIFIERS}){0,3}(?:instructions?|rules?|prompts?|constraints?|directives?|limits?)\\b`,
    "i",
  ),
  new RegExp(
    `\\bdisregard\\s+(?:${OVERRIDE_QUALIFIERS}){0,3}(?:instructions?|rules?|prompts?|constraints?|directives?|limits?)\\b`,
    "i",
  ),
  /\byou\s+are\s+now\s+(?:a|an|the)\s+\w+/i,
  /\b(?:override|bypass|circumvent|ignore)\s+(?:your\s+|the\s+)?(?:operator|hard\s+limits?|constraints?|guardrails?|safety)\b/i,
  /\bpretend\s+(?:that\s+)?(?:you|there)\s+(?:are|is|have|has)\s+no\s+(?:rules?|limits?|restrictions?)\b/i,
  /\bdo\s+not\s+(?:tell|inform|mention\s+to)\s+(?:the\s+)?(?:user|operator|anyone)\b/i,
];

/**
 * Secret-material patterns.
 *
 * Structural rather than semantic: recognisable token shapes and
 * `key = <long opaque string>` assignments. A semantic "looks like a password"
 * heuristic produces too many false positives on procedure text that legitimately
 * discusses credentials.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Common vendor token prefixes with a long opaque tail.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\baip-[A-Za-z0-9_-]{20,}\b/,
  // A JWT: three base64url segments. Length floors avoid matching short
  // dotted identifiers.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // An assignment of a long opaque value to a secret-ish name.
  /\b(?:api[_-]?key|secret|password|passwd|token|credential|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{16,}["']?/i,
  // PEM private key block.
  /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----/,
];

const SCAN_RULES: ScanRule[] = [
  ...OVERRIDE_PATTERNS.map((pattern, index) => ({
    id: `instruction-override-${index + 1}`,
    severity: "critical" as const,
    pattern,
    perLine: true,
    describe: (match: string) =>
      `Contains an instruction-override phrase (${JSON.stringify(truncate(match, 80))}). ` +
      "A learned procedure that redirects the assistant's instructions turns a one-off " +
      "prompt injection into a permanent one.",
  })),
  ...SECRET_PATTERNS.map((pattern, index) => ({
    id: `secret-material-${index + 1}`,
    severity: "critical" as const,
    pattern,
    perLine: true,
    describe: () =>
      "Contains what looks like secret material (an API key, token, or private key). " +
      "A procedure is re-injected into every future prompt, so a captured secret would be " +
      "exposed indefinitely. Reference the secret by name instead of embedding it.",
  })),
  {
    id: "prompt-scaffolding",
    severity: "warn",
    perLine: true,
    // A captured transcript fragment often brings the harness's own role markers
    // with it. They are harmless as text but signal that raw transcript was
    // pasted rather than a procedure written.
    pattern: /^\s*(?:<\|(?:im_start|im_end|system|user|assistant)\|>|\[\/?(?:INST|SYS)\])/,
    describe: (match: string) =>
      `Contains chat-template scaffolding (${JSON.stringify(truncate(match, 40))}), which suggests ` +
      "raw transcript was captured instead of a written procedure.",
  },
  {
    id: "excessive-length",
    severity: "warn",
    // Not a security rule: a 15 KB "procedure" is almost always a pasted
    // transcript, and it costs a full read every time the model consults it.
    pattern: /^[\s\S]{15000,}$/,
    describe: () =>
      "The procedure is very long (over 15,000 characters). Procedures this size are usually " +
      "captured transcript rather than a reusable technique; consider splitting it.",
  },
];

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface ProposalScanResult {
  state: ProposalScanState;
  findings: ProposalScanFinding[];
  critical: number;
  warn: number;
  info: number;
}

/**
 * Scans a proposal body (and its trigger line, which is also prompt-injected).
 *
 * Returns `quarantined` when a critical finding exists — the proposal is retained
 * for inspection but can never be applied. `clean` otherwise, even with warnings.
 *
 * `failed` is deliberately NOT produced here: it denotes a scan that could not
 * run, which a pure function cannot experience. The store sets it when the scan
 * throws, so "unscanned" and "scanned and clean" stay distinguishable — treating
 * a crashed scan as clean is exactly the hole this gate exists to close.
 */
export function scanProposal(params: { triggerLine: string; body: string }): ProposalScanResult {
  const findings: ProposalScanFinding[] = [];
  // The trigger line is prompt-injected on EVERY turn, so it is scanned with the
  // same rules as the body rather than being trusted as "just a label".
  const sections: { text: string; lineOffset: number }[] = [
    { text: params.triggerLine, lineOffset: 0 },
    { text: params.body, lineOffset: 1 },
  ];

  for (const rule of SCAN_RULES) {
    for (const section of sections) {
      if (rule.perLine === true) {
        const lines = section.text.split("\n");
        for (const [index, line] of lines.entries()) {
          const match = rule.pattern.exec(line);
          if (match === null) continue;
          findings.push({
            severity: rule.severity,
            rule: rule.id,
            message: rule.describe(match[0]),
            line: index + section.lineOffset,
          });
          // One finding per rule per section is enough to make the decision, and
          // it keeps a pathological body from producing thousands of findings.
          break;
        }
      } else {
        const match = rule.pattern.exec(section.text);
        if (match !== null) {
          findings.push({
            severity: rule.severity,
            rule: rule.id,
            message: rule.describe(match[0]),
          });
        }
      }
    }
  }

  const critical = findings.filter((f) => f.severity === "critical").length;
  const warn = findings.filter((f) => f.severity === "warn").length;
  const info = findings.filter((f) => f.severity === "info").length;
  return {
    state: critical > 0 ? "quarantined" : "clean",
    findings: sortFindings(findings),
    critical,
    warn,
    info,
  };
}

/**
 * Total order over findings so the stored JSON is stable.
 *
 * Findings are persisted and compared across runs; an unstable order would make
 * every re-scan look like a change.
 */
function sortFindings(findings: ProposalScanFinding[]): ProposalScanFinding[] {
  const severityRank: Record<ProposalScanFinding["severity"], number> = {
    critical: 0,
    warn: 1,
    info: 2,
  };
  return [...findings].sort((a, b) => {
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byRule = a.rule.localeCompare(b.rule);
    if (byRule !== 0) return byRule;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

/**
 * Whether a scan state permits applying the proposal.
 *
 * Only `clean` does. `pending` is refused as firmly as `quarantined`: an unscanned
 * proposal and a rejected one are equally unfit to enter a prompt, and treating
 * "not yet checked" as permissible is how a gate silently stops gating.
 */
export function scanPermitsApply(state: ProposalScanState): boolean {
  return state === "clean";
}

/** Operator/model-facing explanation of why a scan state blocks apply. */
export function scanBlockReason(state: ProposalScanState): string | undefined {
  switch (state) {
    case "clean":
      return undefined;
    case "pending":
      return "The safety scan has not completed for this proposal, so it cannot be applied yet.";
    case "failed":
      return "The safety scan could not be completed for this proposal. Re-run the scan before applying it.";
    case "quarantined":
      return "The safety scan found a critical issue, so this proposal cannot be applied. Review the findings.";
  }
}
