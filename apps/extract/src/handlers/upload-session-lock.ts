// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * upload-session-lock.ts
 *
 * Serialisation of chunk appends to one resumable upload session
 *
 * Two PATCH requests for the same session must never both write at the
 * confirmed offset. Two layers make that hold:
 *
 *   1. {@link KeyedMutex} — a process-local try-lock per upload id. A second
 *      PATCH for a session that already has a chunk in flight on this replica
 *      is refused immediately (409) instead of racing the first one.
 *   2. {@link UploadOffsetCommitter} — the database-side guard across replicas.
 *      The default Postgres implementation delegates to
 *      `ExtractStore.advanceUploadOffset`, which locks the session row
 *      (`SELECT … FOR UPDATE`), re-checks `received_offset = $expected`,
 *      appends the already checksum-verified chunk to the session file while
 *      holding the lock, and advances the offset with an optimistic
 *      `UPDATE … WHERE received_offset = $expected` in the same transaction.
 *      The SQL lives in `persistence/` (extract-queries.ts).
 */

import type { ExtractStore } from "../persistence/index.js";
import type { UploadAppend, UploadAppendResult } from "../persistence/types.js";

/** A process-local, non-blocking lock keyed by an arbitrary string. */
export class KeyedMutex {
  private readonly held = new Set<string>();

  /**
   * Take the lock for `key`. Returns a release function, or `null` when the
   * key is already held. The release function is idempotent.
   */
  tryAcquire(key: string): (() => void) | null {
    if (this.held.has(key)) return null;
    this.held.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(key);
    };
  }

  /** Whether `key` is currently held (for tests and diagnostics). */
  isHeld(key: string): boolean {
    return this.held.has(key);
  }
}

/** One chunk append; see {@link UploadAppend} (defined by the persistence layer). */
export type UploadChunkCommit = UploadAppend;

/** The outcome of a chunk append; see {@link UploadAppendResult}. */
export type UploadCommitResult = UploadAppendResult;

/** Commits a chunk append and its offset advance atomically per session. */
export interface UploadOffsetCommitter {
  commitChunk(commit: UploadChunkCommit): Promise<UploadCommitResult>;
}

/**
 * Postgres-backed committer: row lock + conditional offset update in one
 * transaction, so concurrent PATCHes on different replicas are serialised and
 * a stale expected offset can never advance the session.
 */
export function createPgUploadOffsetCommitter(
  store: Pick<ExtractStore, "advanceUploadOffset">,
): UploadOffsetCommitter {
  return {
    commitChunk: (commit) => store.advanceUploadOffset(commit),
  };
}
