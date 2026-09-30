// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory {@link SourceAdapter} for executor/run tests: items carry their
 * content directly; `open` yields the bytes as a stream. Optional hooks
 * simulate a crash (`abortAfterOpens`) and record `open` calls so tests can
 * assert "exactly one download" and abort points.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { SourceAdapter, SourceItem } from "../../src/sources/types.js";

export interface HarnessItem {
  quellId: string;
  content: Uint8Array;
  modified?: Date;
  /** Override the derived marker (e.g. to simulate a stale state entry). */
  marker?: string;
}

/** Deterministic marker for content: `<size>:<sha8>`. */
export function contentMarker(content: Uint8Array): string {
  const sha = createHash("sha256").update(content).digest("hex").slice(0, 8);
  return `${content.byteLength}:${sha}`;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export interface FakeAdapterOptions {
  /** Called after each open with the quellId (tests abort the run from here). */
  onOpen?: (quellId: string) => void;
  /** Make the listing throw after yielding this many items (incomplete). */
  failListingAfter?: number;
  /** These quellIds fail on `open` (vanished files → read-error, 8.10). */
  unreadable?: ReadonlySet<string>;
}

export interface FakeAdapter extends SourceAdapter {
  readonly openCalls: string[];
  readonly listCalls: number;
}

export function fakeAdapter(
  items: readonly HarnessItem[],
  options: FakeAdapterOptions = {},
): FakeAdapter {
  const openCalls: string[] = [];
  let listCalls = 0;
  const adapter: FakeAdapter = {
    openCalls,
    get listCalls(): number {
      return listCalls;
    },
    async *list(signal: AbortSignal): AsyncIterable<SourceItem> {
      listCalls += 1;
      let yielded = 0;
      for (const item of items) {
        if (Boolean(signal.aborted)) throw new Error("listing aborted");
        if (
          options.failListingAfter !== undefined &&
          yielded >= options.failListingAfter
        ) {
          throw new Error("listing failed midway");
        }
        yielded += 1;
        const sourceItem: SourceItem = {
          quellId: item.quellId,
          name: item.quellId.split("/").pop() ?? item.quellId,
          size: item.content.byteLength,
          modified: item.modified ?? new Date("2026-01-01T00:00:00Z"),
          marker: item.marker ?? contentMarker(item.content),
        };
        yield sourceItem;
      }
    },
    async open(item: SourceItem, signal: AbortSignal): Promise<Readable> {
      if (Boolean(signal.aborted)) throw new Error("open aborted");
      if (options.unreadable?.has(item.quellId)) {
        throw new Error(`ENOENT: no such file ${item.quellId}`);
      }
      const source = items.find((i) => i.quellId === item.quellId);
      if (source === undefined) throw new Error(`unknown item ${item.quellId}`);
      openCalls.push(item.quellId);
      options.onOpen?.(item.quellId);
      return Readable.from(Buffer.from(source.content));
    },
  };
  return adapter;
}
