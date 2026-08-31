// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regex PII detector (`src/graph/pii-detector-regex.ts`)
 *
 * Wraps the existing deterministic regex + check-digit detection logic from
 * {@link "./output-guardrails.js"} into the {@link PiiDetector} interface.
 * This detector is always available, has no external dependencies, and serves
 * as the fast, auditable baseline for structured PII (emails, IBANs, cards,
 * tax IDs, secrets, etc.).
 *
 * Priority: 10 (highest trust — deterministic, check-digit validated).
 *
 * No `any` at module boundaries.
 */

import type { PiiDetector } from "./pii-detector.js";
import { findPiiMatches, type PiiMatch, type PiiType } from "./output-guardrails.js";

/**
 * Deterministic regex-based PII detector. Delegates entirely to the existing
 * {@link findPiiMatches} implementation (priority-ordered regex patterns with
 * optional check-digit validators like Luhn, MOD 11,10, date plausibility).
 *
 * This detector is synchronous internally but fulfills the async interface
 * contract. It never throws — regex execution on reasonable-length text cannot
 * fail in a way that matters.
 */
export class RegexPiiDetector implements PiiDetector {
  readonly name = "regex";
  readonly priority = 10;

  async detect(text: string, types?: readonly PiiType[]): Promise<PiiMatch[]> {
    return findPiiMatches(text, types);
  }
}
