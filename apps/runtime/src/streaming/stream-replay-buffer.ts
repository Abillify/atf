// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SSE Stream Replay Buffer (`src/streaming/stream-replay-buffer.ts`)
 *
 * Stores the frames emitted for each in-flight inference stream so that a
 * client that disconnects and reconnects with a `Last-Event-ID` header can
 * resume mid-stream without missing tokens.
 *
 * Design:
 *   - One entry per active `executionId`.
 *   - Each frame is stored as its raw `data: …\n\n` string together with a
 *     monotonically-incrementing sequence number used as the SSE event `id`.
 *   - Entries expire after `ttlMs` (default 5 minutes) so reconnects after
 *     the stream finished are handled too (the buffer holds the entire
 *     completed stream for the TTL window).
 *   - Compact in-memory only — there is no cross-replica resume for inference
 *     streams (they are stateful, in-process LangGraph runs). Cross-replica
 *     resume would require pinning the client to the same replica, which the
 *     reverse proxy already does for long-running SSE connections.
 *
 * Usage (in the chat route):
 *   const buf = streamReplayBuffer.open(executionId);
 *   // when writing each frame: buf.record(seqId, rawFrame);
 *   // on reconnect: buf.getFramesSince(lastSeqId) → missed frames
 *   // on completion: streamReplayBuffer.seal(executionId, ttlMs)
 *
 * No `any` at module boundaries.
 */

export interface BufferedFrame {
  /** Monotonically-increasing sequence number used as the SSE `id:` field. */
  seqId: number;
  /** Raw SSE frame string, e.g. `"data: {...}\n\n"` or `"data: [DONE]\n\n"`. */
  raw: string;
}

export interface StreamBuffer {
  /** Current sequence number (last recorded). */
  readonly currentSeq: number;
  /** Append a frame to the buffer and advance the sequence counter. */
  record(raw: string): number;
  /** Return all frames whose seqId is strictly greater than `afterSeq`. */
  getFramesSince(afterSeq: number): BufferedFrame[];
  /** Whether this stream has been sealed (finished). */
  readonly sealed: boolean;
}

class StreamBufferImpl implements StreamBuffer {
  private readonly frames: BufferedFrame[] = [];
  private seq = 0;
  private _sealed = false;

  get currentSeq(): number {
    return this.seq;
  }

  get sealed(): boolean {
    return this._sealed;
  }

  record(raw: string): number {
    this.seq += 1;
    this.frames.push({ seqId: this.seq, raw });
    return this.seq;
  }

  getFramesSince(afterSeq: number): BufferedFrame[] {
    return this.frames.filter((f) => f.seqId > afterSeq);
  }

  seal(): void {
    this._sealed = true;
  }
}

/**
 * Registry of in-flight and recently-finished stream buffers.
 *
 * @param defaultTtlMs  How long a completed stream's buffer is retained
 *                      after sealing (default 5 minutes).
 * @param maxBuffers    Maximum simultaneous in-flight buffers (default 500).
 *                      Old entries are evicted LRU-style when the cap is hit.
 */
export class StreamReplayBuffer {
  private readonly buffers = new Map<
    string,
    { buf: StreamBufferImpl; expiresAt: number }
  >();
  private readonly defaultTtlMs: number;
  private readonly maxBuffers: number;

  constructor(opts: { defaultTtlMs?: number; maxBuffers?: number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60_000;
    this.maxBuffers = opts.maxBuffers ?? 500;
  }

  /**
   * Open a new stream buffer for `executionId`. If one already exists (from a
   * previous attempt) it is replaced.
   */
  open(executionId: string): StreamBuffer {
    this.evictExpired();
    if (this.buffers.size >= this.maxBuffers) {
      // Evict the oldest entry.
      const oldest = this.buffers.keys().next().value;
      if (oldest !== undefined) this.buffers.delete(oldest);
    }
    const buf = new StreamBufferImpl();
    this.buffers.set(executionId, {
      buf,
      expiresAt: Date.now() + this.defaultTtlMs,
    });
    return buf;
  }

  /**
   * Look up an existing buffer. Returns `undefined` when the execution is
   * unknown or has expired.
   */
  get(executionId: string): StreamBuffer | undefined {
    this.evictExpired();
    const entry = this.buffers.get(executionId);
    return entry?.buf;
  }

  /**
   * Seal the buffer for `executionId` and schedule it for deletion after
   * `ttlMs` (defaults to the registry's `defaultTtlMs`).
   */
  seal(executionId: string, ttlMs?: number): void {
    const entry = this.buffers.get(executionId);
    if (entry === undefined) return;
    entry.buf.seal();
    entry.expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.buffers) {
      if (entry.expiresAt < now) this.buffers.delete(id);
    }
  }
}

/** Singleton instance used by the chat route. */
export const inferenceStreamBuffer = new StreamReplayBuffer();
