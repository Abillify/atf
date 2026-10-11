// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * reembed-decision.ts
 *
 * The selective re-embedding decision (task 5.4, design §5 S7 point 2,
 * requirement 9.6: "…only re-embed units whose heading path has
 * changed").
 *
 * ## Why this exists
 *
 * Embedding is the expensive step of ingest: one model round-trip per unit. The
 * Extract finalize pass (outline.ts) corrects a document's outline metadata at
 * document end — a purely metadata change that leaves most units' text and
 * section path untouched. Re-embedding the WHOLE document for such a fix would
 * be gratuitous. Requirement 9.6 exists precisely to avoid it: re-embed ONLY the
 * units whose section path (which rides in the contextual embedding header, see
 * contextual-header.ts) actually changed, and reuse the already-stored vector
 * for every unit whose path AND content are unchanged.
 *
 * ## The key it decides on
 *
 * A unit is identified by its `unit_id`. The contextual header the vector is
 * built from folds in the unit's `section_path`; a header (hence a vector) is
 * therefore stale exactly when the section path changes OR the content text
 * changes. So the decision, per unit:
 *
 *   - stored row exists AND its section_path == incoming AND its content ==
 *     incoming  →  REUSE the stored vector, SKIP the embed call.
 *   - no stored row, OR section_path differs, OR content differs  →  EMBED.
 *
 * Everything else about a row (the non-embedding metadata columns) is updated in
 * place on upsert regardless; this decision only governs whether the costly
 * embed call runs.
 *
 * ## Determinism and purity
 *
 * This module is a pure function of the incoming unit's `(sectionPath, content)`
 * and the stored row's `(sectionPath, content)` — no I/O, no clock. The batch
 * worker (batch-worker.ts) does the batched DB lookup and feeds the pairs in;
 * the decision itself is unit-testable in isolation.
 */

/** The stored-row facts the decision compares against. */
export interface StoredUnitFacts {
  /** The section path currently persisted for this unit (empty when none). */
  sectionPath: string[];
  /** The content text currently persisted for this unit. */
  content: string;
}

/** The incoming-unit facts the decision compares. */
export interface IncomingUnitFacts {
  /** The section path the freshly-built unit carries (empty when none). */
  sectionPath: string[];
  /** The content text the freshly-built unit carries. */
  content: string;
}

/**
 * Decide whether an incoming unit must be re-embedded, given the stored row's
 * facts (or `null` when no row exists yet).
 *
 * Returns `true` (embed) when there is no stored row, when the section path
 * changed, or when the content changed. Returns `false` (reuse the stored
 * vector, skip the embed call) only when a stored row exists AND both its
 * section path and content are identical to the incoming unit's.
 */
export function shouldReembed(
  incoming: IncomingUnitFacts,
  stored: StoredUnitFacts | null,
): boolean {
  if (stored === null) return true; // new unit — must embed.
  if (stored.content !== incoming.content) return true; // content changed.
  if (!sectionPathsEqual(stored.sectionPath, incoming.sectionPath)) return true; // path changed.
  return false; // unchanged path + unchanged content → reuse the stored vector.
}

/** Structural equality of two section paths (order-sensitive). */
export function sectionPathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Parse a pgvector text rendering (`[1,2,3]`) back to a number array, so a
 * reused stored vector can be re-inserted through the same `::vector` /
 * `::halfvec` cast the upsert uses. Returns `null` when the text is empty or
 * malformed, in which case the caller falls back to embedding the unit.
 */
export function parseStoredVector(text: string | null | undefined): number[] | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "[]") return null;
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (inner.trim() === "") return null;
  const parts = inner.split(",");
  const out: number[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}
