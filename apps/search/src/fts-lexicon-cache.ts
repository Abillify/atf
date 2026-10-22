// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * fts-lexicon-cache.ts
 *
 * In-process cache of the per-collection word lexicon used by query-side
 * compound splitting (FTS_COMPOUND_SPLIT, see compound-split.ts). The lexicon
 * is the collection's own vocabulary: `ts_stat` over the collection's
 * `ts_search` column, keeping lexemes that appear in at least two chunks
 * (ndoc >= 2) so typos and one-off tokens never become split anchors.
 *
 * The lexicon is built ASYNCHRONOUSLY on first need: a cache miss starts the
 * build and returns `undefined`, so the triggering query runs WITHOUT
 * splitting. Entries expire after LEXICON_TTL_MS. A failing build logs a
 * warning, leaves the lexicon unset, and disables the feature for that table
 * for LEXICON_FAILURE_COOLDOWN_MS before it is retried.
 */

import type pino from "pino";
import type { Pool } from "pg";

/** How long a built lexicon stays valid. */
export const LEXICON_TTL_MS = 3_600_000;

/** How long a table stays disabled after a failed lexicon build. */
export const LEXICON_FAILURE_COOLDOWN_MS = 600_000;

/** Minimum number of chunks a lexeme must appear in to enter the lexicon. */
export const LEXICON_MIN_NDOC = 2;

/** Upper bound on lexicon size (most frequent lexemes win). */
export const LEXICON_MAX_WORDS = 200_000;

export interface FtsLexiconCache {
  /**
   * The lexicon for `table` when it is currently cached, otherwise
   * `undefined`. A miss (outside a failure cooldown) starts the build in the
   * background — the caller proceeds without splitting.
   */
  get(table: string): Set<string> | undefined;
}

interface LexiconEntry {
  words: Set<string>;
  expiresAt: number;
}

interface FailureEntry {
  disabledUntil: number;
}

/**
 * Build the lexicon for one collection table. `table` is the internal
 * `vc_*` table name produced by `collectionTableName()` (validated against
 * the collection-name pattern), never raw user input.
 */
export async function loadLexicon(
  pool: Pool,
  table: string,
): Promise<Set<string>> {
  const res = await pool.query(
    `SELECT word FROM ts_stat('SELECT ts_search FROM "${table}"')
       WHERE ndoc >= ${LEXICON_MIN_NDOC}
       ORDER BY ndoc DESC
       LIMIT ${LEXICON_MAX_WORDS}`,
  );
  const words = new Set<string>();
  for (const row of res.rows as Array<{ word: string }>) {
    words.add(row.word);
  }
  return words;
}

/** Create the per-client lexicon cache (see FtsLexiconCache). */
export function createFtsLexiconCache(
  pool: Pool,
  logger: pino.Logger,
): FtsLexiconCache {
  const entries = new Map<string, LexiconEntry>();
  const failures = new Map<string, FailureEntry>();
  const inFlight = new Map<string, Promise<void>>();

  return {
    get(table: string): Set<string> | undefined {
      const now = Date.now();
      const entry = entries.get(table);
      if (entry && entry.expiresAt > now) return entry.words;
      const failure = failures.get(table);
      if (failure && failure.disabledUntil > now) return undefined;
      if (!inFlight.has(table)) {
        const build = loadLexicon(pool, table)
          .then((words) => {
            entries.set(table, { words, expiresAt: Date.now() + LEXICON_TTL_MS });
          })
          .catch((err: unknown) => {
            failures.set(table, {
              disabledUntil: Date.now() + LEXICON_FAILURE_COOLDOWN_MS,
            });
            logger.warn(
              { err, table },
              "compound-split lexicon build failed; splitting disabled",
            );
          })
          .finally(() => {
            inFlight.delete(table);
          });
        inFlight.set(table, build);
      }
      return undefined;
    },
  };
}
