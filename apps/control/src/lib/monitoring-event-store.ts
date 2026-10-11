// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { RingBuffer } from "./ring-buffer";

/** Default upper bound on how often React is handed a new snapshot. */
export const DEFAULT_FLUSH_INTERVAL_MS = 200;

/**
 * External store feeding `useSyncExternalStore` (Requirement 9.1).
 *
 * Incoming SSE/WebSocket events are written into a {@link RingBuffer} and only
 * handed to React at most once per `flushIntervalMs` (default 200 ms): the
 * first event of a burst starts the flush timer, later events in the same
 * window ride along in the pending batch. Between flushes the snapshot
 * reference is byte-for-byte stable, so React re-renders at most five times
 * per second regardless of how many events the stream delivers.
 *
 * Invariant (Property 16): after every flush the snapshot equals the last
 * `capacity` events in input order.
 */
export class MonitoringEventStore<T> {
  private readonly buffer: RingBuffer<T>;
  private readonly flushIntervalMs: number;
  /** Events received since the last flush, not yet visible to React. */
  private pending: T[] = [];
  /** Cached snapshot — only ever replaced inside {@link flush}. */
  private snapshot: T[] = [];
  private readonly listeners = new Set<() => void>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(capacity: number, flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS) {
    this.capacity = capacity;
    this.buffer = new RingBuffer<T>(capacity);
    this.flushIntervalMs = flushIntervalMs;
  }

  /** Upper bound on the number of events retained (the ring capacity). */
  readonly capacity: number;

  /** `useSyncExternalStore` subscription entry point. */
  subscribe = (onStoreChange: () => void): (() => void) => {
    this.listeners.add(onStoreChange);
    return () => {
      this.listeners.delete(onStoreChange);
    };
  };

  /**
   * Current snapshot. The returned reference only changes on a flush that
   * actually delivered events, which is what `useSyncExternalStore` relies on
   * to avoid render loops.
   */
  getSnapshot = (): T[] => this.snapshot;

  /** Record an event; schedules a flush unless one is already pending. */
  push(item: T): void {
    this.pending.push(item);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(this.flush, this.flushIntervalMs);
    }
  }

  /**
   * Hand all pending events to React immediately (also used by the tests and
   * by {@link clear}). A no-op — and no notification — when nothing is
   * pending, keeping the snapshot reference stable.
   */
  flush = (): void => {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    this.buffer.pushMany(this.pending);
    this.pending = [];
    this.snapshot = this.buffer.toArray();
    this.emit();
  };

  /** Drop every event (buffer, pending batch, snapshot) and notify. */
  clear = (): void => {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending = [];
    if (this.buffer.size === 0 && this.snapshot.length === 0) return;
    this.buffer.clear();
    this.snapshot = [];
    this.emit();
  };

  /** Cancel any pending flush and detach all subscribers (on unmount). */
  destroy(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.listeners.clear();
  }

  private emit(): void {
    // Iterate over a copy — a listener may unsubscribe during notification.
    for (const listener of [...this.listeners]) listener();
  }
}
