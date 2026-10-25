// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Persistent Sync_State per source (requirements 3.8, 7.1, 7.7, 7.8).
 *
 * Layout: snapshot `state/<sourceId>.json` plus append-only journal
 * `state/<sourceId>.journal` (JSON Lines). Every change is one journal
 * record — 8 hex chars payload length, the JSON payload, 8 hex chars
 * CRC32, newline — written with `fsync`, so an interrupted run loses at
 * most the record that was in flight (7.8). Loading reads the snapshot and
 * replays the journal up to the FIRST invalid record; a truncated or
 * corrupt tail is ignored, never an error (7.7). After every run — or once
 * the journal reaches `compactAfterEntries` (default 10 000) — the snapshot
 * is rewritten via tmp → fsync → rename and the journal truncated. An
 * unreadable snapshot is quarantined to `*.corrupt-<ts>` and rebuilt empty;
 * Mirror_Delete stays suspended for that run because the empty state has no
 * candidates (7.7).
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  applyJournalEntry,
  journalEntrySchema,
  sourceStateSchema,
  type ItemState,
  type JournalEntry,
  type SourceState,
} from "./schema.js";

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE) over the bytes. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    const idx = (c ^ b) & 0xff;
    const t = CRC_TABLE[idx];
    if (t === undefined) throw new Error("crc table invariant");
    c = t ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode one journal record: len(8 hex) + payload + crc(8 hex) + "\n". */
export function encodeJournalRecord(payload: Uint8Array): Uint8Array {
  const len = payload.byteLength.toString(16).padStart(8, "0");
  const crc = crc32(payload).toString(16).padStart(8, "0");
  const record = Buffer.allocUnsafe(8 + payload.byteLength + 8 + 1);
  record.write(len, 0, "ascii");
  payload.forEach((b, i) => {
    record[8 + i] = b;
  });
  record.write(crc, 8 + payload.byteLength, "ascii");
  record[8 + payload.byteLength + 8] = 0x0a;
  return record;
}

type DecodedRecord =
  | { ok: true; payload: string; next: number }
  | { ok: false };

/** Decode one record at `offset`; `ok:false` on any malformed/truncated data. */
export function decodeJournalRecord(buf: Buffer, offset: number): DecodedRecord {
  if (offset + 8 > buf.length) return { ok: false };
  const lenHex = buf.toString("ascii", offset, offset + 8);
  if (!/^[0-9a-f]{8}$/.test(lenHex)) return { ok: false };
  const len = Number.parseInt(lenHex, 16);
  const payloadStart = offset + 8;
  const crcStart = payloadStart + len;
  const end = crcStart + 9; // crc(8) + newline(1)
  if (end > buf.length) return { ok: false };
  if (buf[end - 1] !== 0x0a) return { ok: false };
  const crcHex = buf.toString("ascii", crcStart, crcStart + 8);
  if (!/^[0-9a-f]{8}$/.test(crcHex)) return { ok: false };
  const payload = buf.subarray(payloadStart, crcStart);
  if (crc32(payload) !== Number.parseInt(crcHex, 16)) return { ok: false };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return { ok: false };
  }
  return { ok: true, payload: text, next: end };
}

export interface SyncStateStoreOptions {
  /** The `state/` directory (Docker: mounted volume; desktop: app data). */
  dir: string;
  sourceId: string;
  /** Initial collection for a fresh state (1.8). */
  collection: string;
  /** Compact once the journal reaches this many entries (default 10 000). */
  compactAfterEntries?: number;
  /** Injectable clock for quarantine file names. */
  now?: () => Date;
}

const emptyState = (sourceId: string, collection: string): SourceState => ({
  version: 1,
  sourceId,
  collection,
  items: {},
});

export class SyncStateStore {
  readonly #dir: string;
  readonly #sourceId: string;
  readonly #snapshotPath: string;
  readonly #journalPath: string;
  readonly #compactAfter: number;
  readonly #now: () => Date;
  #state: SourceState;
  #appended = 0;
  #appendHandle: Awaited<ReturnType<typeof open>> | undefined;

  private constructor(options: SyncStateStoreOptions) {
    this.#dir = options.dir;
    this.#sourceId = options.sourceId;
    this.#snapshotPath = path.join(options.dir, `${options.sourceId}.json`);
    this.#journalPath = path.join(options.dir, `${options.sourceId}.journal`);
    this.#compactAfter = options.compactAfterEntries ?? 10_000;
    this.#now = options.now ?? (() => new Date());
    this.#state = emptyState(options.sourceId, options.collection);
  }

  /** Load snapshot + journal; never throws on corrupt data (7.7). */
  static async open(options: SyncStateStoreOptions): Promise<SyncStateStore> {
    const store = new SyncStateStore(options);
    await store.#load();
    return store;
  }

  /** The current state (snapshot + replayed journal). */
  get state(): SourceState {
    return this.#state;
  }

  async #load(): Promise<void> {
    let base = emptyState(this.#sourceId, this.#state.collection);
    let snapshotText: string | undefined;
    try {
      snapshotText = await readFile(this.#snapshotPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Unreadable (permissions, I/O): treat like corrupt (7.7).
        snapshotText = undefined;
        await this.#quarantineSnapshot(true);
        base = emptyState(this.#sourceId, this.#state.collection);
      }
    }
    if (snapshotText !== undefined) {
      const parsed = safeJson(snapshotText);
      const validated = parsed !== undefined ? sourceStateSchema.safeParse(parsed) : undefined;
      if (validated?.success && validated.data.sourceId === this.#sourceId) {
        base = validated.data;
      } else {
        await this.#quarantineSnapshot(true);
        base = emptyState(this.#sourceId, this.#state.collection);
      }
    }
    let journal: Buffer;
    try {
      journal = await readFile(this.#journalPath);
    } catch {
      this.#state = base;
      return;
    }
    let offset = 0;
    for (;;) {
      const record = decodeJournalRecord(journal, offset);
      if (!record.ok) break; // truncated/corrupt tail → stop (7.8)
      const parsed = safeJson(record.payload);
      if (parsed === undefined) break;
      const entry = journalEntrySchema.safeParse(parsed);
      if (!entry.success) break;
      base = applyJournalEntry(base, entry.data);
      offset = record.next;
    }
    this.#state = base;
  }

  async #quarantineSnapshot(exists: boolean): Promise<void> {
    if (!exists) return;
    const ts = this.#now().getTime();
    try {
      await rename(this.#snapshotPath, `${this.#snapshotPath}.corrupt-${ts}`);
    } catch {
      // Best effort: even if the rename fails, the state is rebuilt empty.
    }
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }

  async #appendHandleOpen(): Promise<Awaited<ReturnType<typeof open>>> {
    if (this.#appendHandle === undefined) {
      await this.#ensureDir();
      this.#appendHandle = await open(this.#journalPath, "a");
    }
    return this.#appendHandle;
  }

  async #append(entry: JournalEntry): Promise<void> {
    const payload = Buffer.from(JSON.stringify(entry), "utf8");
    const record = encodeJournalRecord(payload);
    const handle = await this.#appendHandleOpen();
    await handle.write(record);
    await handle.sync(); // 7.8: every change is fsync-protected
    this.#appended += 1;
    this.#state = applyJournalEntry(this.#state, entry);
    if (this.#appended >= this.#compactAfter) await this.flush();
  }

  /** Record an upsert of one item (atomic per item, 7.8). */
  async upsert(quellId: string, item: ItemState): Promise<void> {
    await this.#append({ op: "upsert", quellId, item });
  }

  /** Record the removal of one item entry. */
  async deleteItem(quellId: string): Promise<void> {
    await this.#append({ op: "delete", quellId });
  }

  /** Record source-level metadata changes (collection, candidateSetHash, deltaLink). */
  async setMeta(meta: {
    collection?: string;
    candidateSetHash?: string | null;
    deltaLink?: string | null;
  }): Promise<void> {
    await this.#append({ op: "meta", ...meta });
  }

  /**
   * Rewrite the snapshot (tmp → fsync → rename) and truncate the journal.
   * Called after every run and by logout; crash-safe because replaying
   * journal entries already contained in the snapshot is idempotent.
   */
  async flush(): Promise<void> {
    await this.#ensureDir();
    const tmpPath = `${this.#snapshotPath}.tmp`;
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(JSON.stringify(this.#state), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, this.#snapshotPath);
    if (this.#appendHandle !== undefined) {
      await this.#appendHandle.close();
      this.#appendHandle = undefined;
    }
    const truncate = await open(this.#journalPath, "w");
    try {
      await truncate.sync();
    } finally {
      await truncate.close();
    }
    this.#appended = 0;
  }

  /** Release the journal handle without writing a snapshot. */
  async close(): Promise<void> {
    if (this.#appendHandle !== undefined) {
      await this.#appendHandle.close();
      this.#appendHandle = undefined;
    }
  }
}

function safeJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
