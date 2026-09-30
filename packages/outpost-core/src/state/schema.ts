// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sync_State schema (requirements 7.1, 7.6).
 *
 * `ItemState` holds everything the planner and reducer need per item:
 * the derived reference, the change marker, the content hash, the status
 * and — for interrupted resumable uploads — the pending upload session.
 * `SourceState` is the persisted document: one per source, versioned.
 * `candidateSetHash` lives on source level (outside `items`) so a pending
 * delete confirmation can be bound to exactly one candidate set (9.11).
 */

import { z } from "zod";

export const itemStateSchema = z.object({
  reference: z.string().min(1),
  marker: z.string(),
  sha256: z.string().optional(),
  size: z.number().int().nonnegative(),
  status: z.enum(["synced", "failed", "pending-job", "deleted-in-source"]),
  jobId: z.string().optional(),
  pendingUpload: z
    .object({
      uploadId: z.string().min(1),
      sha256: z.string().min(1),
    })
    .optional(),
  lastError: z
    .object({
      code: z.string(),
      message: z.string(),
      at: z.string(),
    })
    .optional(),
  syncedAt: z.string().optional(),
});

export type ItemState = z.infer<typeof itemStateSchema>;

export const sourceStateSchema = z.object({
  version: z.literal(1),
  sourceId: z.string().min(1),
  collection: z.string().min(1),
  items: z.record(z.string(), itemStateSchema),
  /** Hash of a delete-candidate set awaiting confirmation (9.11). */
  candidateSetHash: z.string().optional(),
});

export type SourceState = z.infer<typeof sourceStateSchema>;

/** One journal record: an atomic change to the source state (7.8). */
export const journalEntrySchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    quellId: z.string(),
    item: itemStateSchema,
  }),
  z.object({
    op: z.literal("delete"),
    quellId: z.string(),
  }),
  z.object({
    op: z.literal("meta"),
    collection: z.string().min(1).optional(),
    /** null removes the stored hash; undefined leaves it unchanged. */
    candidateSetHash: z.string().nullable().optional(),
  }),
]);

export type JournalEntry = z.infer<typeof journalEntrySchema>;

/** Apply one journal entry to a state (pure). */
export function applyJournalEntry(state: SourceState, entry: JournalEntry): SourceState {
  switch (entry.op) {
    case "upsert": {
      const items = { ...state.items };
      items[entry.quellId] = entry.item;
      return { ...state, items };
    }
    case "delete": {
      const items = { ...state.items };
      delete items[entry.quellId];
      return { ...state, items };
    }
    case "meta": {
      const next = { ...state };
      if (entry.collection !== undefined) next.collection = entry.collection;
      if (entry.candidateSetHash === null) delete next.candidateSetHash;
      else if (entry.candidateSetHash !== undefined) next.candidateSetHash = entry.candidateSetHash;
      return next;
    }
  }
}
