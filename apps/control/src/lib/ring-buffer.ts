// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Fixed-capacity ring buffer (Requirement 9.1).
 *
 * Once the buffer is full, the oldest element is overwritten — memory usage
 * stays bounded no matter how many events a long-lived dashboard stream
 * delivers. `toArray()` always returns the retained elements in insertion
 * order (oldest first), so consumers see the same sequence they pushed.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  /** Index of the oldest retained element. */
  private start = 0;
  private count = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `RingBuffer capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.slots = new Array<T | undefined>(capacity);
  }

  /** Number of elements currently retained. */
  get size(): number {
    return this.count;
  }

  /** Append an element, dropping the oldest one when at capacity. */
  push(item: T): void {
    const writeIndex = (this.start + this.count) % this.capacity;
    if (this.count === this.capacity) {
      // Buffer full: the write slot is the oldest element — overwrite it and
      // advance the start pointer so insertion order is preserved.
      this.slots[writeIndex] = item;
      this.start = (this.start + 1) % this.capacity;
      return;
    }
    this.slots[writeIndex] = item;
    this.count += 1;
  }

  /** Append every element of `items`, in order. */
  pushMany(items: readonly T[]): void {
    for (const item of items) this.push(item);
  }

  /** Retained elements in insertion order (oldest first). */
  toArray(): T[] {
    const out: T[] = new Array<T>(this.count);
    for (let i = 0; i < this.count; i += 1) {
      out[i] = this.slots[(this.start + i) % this.capacity] as T;
    }
    return out;
  }

  /** Drop all retained elements. */
  clear(): void {
    this.slots.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}
