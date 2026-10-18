// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * expected-reference.ts
 *
 * Document-reference comparison for the fail-closed expected fields of the
 * asset tools (`get_asset`, `get_document_asset` — task 15.4).
 *
 * The v2 batch pipeline stores unit references as
 * `${documentReference}#unit:${unitId}` (batch-worker.ts), and search hits
 * expose that suffixed form. A model that faithfully copies a hit's reference
 * into `expected_document_reference` would otherwise trip the metadata
 * mismatch against the asset's bare `document_reference` — a false negative
 * that denies access to an asset the caller is authorized for.
 *
 * The comparison therefore matches on the document-reference BASE: the part
 * before the first `#` fragment separator. A suffix (`#unit:<sha>` or any
 * other fragment) is tolerated on either side; a genuinely different document
 * reference still fails closed, so the binding between evidence and asset is
 * preserved.
 */

/** Strip a `#…` fragment from a document reference. */
export function referenceBase(reference: string): string {
  const hash = reference.indexOf("#");
  return hash === -1 ? reference : reference.slice(0, hash);
}

/**
 * True when `expected` names the same document as `actual`, tolerating a
 * `#`-fragment suffix (e.g. `#unit:<sha>` copied from a search hit) on
 * either side. Different document references never match.
 */
export function expectedReferenceMatches(actual: string, expected: string): boolean {
  return actual === expected || referenceBase(actual) === referenceBase(expected);
}
