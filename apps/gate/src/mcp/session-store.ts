// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Bounded, idle-expiring registry for live MCP sessions.
 *
 * Why this exists
 * ───────────────
 * A session is created by `initialize` (Streamable HTTP) or by opening the SSE
 * stream, and it owns a `Server` instance plus the captured `AuthContext` of the
 * caller. Previously sessions lived in a plain `Map` that was only ever pruned
 * when the client sent an explicit `DELETE` or the transport emitted `close`.
 * Neither is guaranteed: a client that simply walks away — or a caller looping
 * `initialize` — leaves entries resident for the lifetime of the process. That
 * is unbounded growth driven by request volume, i.e. a memory-exhaustion path.
 *
 * Two independent bounds close it:
 *
 *   • **Idle timeout.** Every request on a session refreshes its `lastSeen`. A
 *     periodic sweep evicts sessions idle beyond `idleTimeoutMs`. This is what
 *     actually reclaims abandoned sessions.
 *   • **Hard cap.** `tryReserve()` refuses a *new* session once `max` are held.
 *     Deliberately a refusal (503) rather than evicting the oldest: silently
 *     killing a stranger's working session to admit a new one turns one client's
 *     misbehaviour into everyone's outage, and hides the capacity problem.
 *
 * Scope boundary
 * ──────────────
 * This store is per-process by design. An MCP session is bound to the `Server`
 * object and transport living in the process that served `initialize`, so it
 * cannot be shared across replicas by moving metadata into Redis — the
 * connection state itself is not serialisable. Horizontal scaling therefore
 * requires sticky routing on `Mcp-Session-Id`. Documented rather than faked.
 */

import { logger } from "../logger.ts";

/** Bounds for a session store. Mirrors `server.sessions` in the config. */
export interface SessionLimits {
  /** Evict after this long with no request. 0 disables the idle sweep. */
  idleTimeoutMs: number;
  /** Max concurrent sessions. 0 disables the cap. */
  max: number;
  /** Sweep interval. */
  sweepIntervalMs: number;
}

interface Entry<T> {
  value: T;
  createdAt: number;
  lastSeen: number;
}

/** Result of asking for permission to create a session. */
export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: string; held: number; max: number };

export class SessionStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param limits  Bounds to enforce.
   * @param onEvict Called for each session dropped by the idle sweep, so the
   *                caller can close the transport and emit a monitor event.
   * @param now     Injectable clock (tests).
   */
  constructor(
    private readonly limits: SessionLimits,
    private readonly onEvict: (id: string, value: T, idleMs: number) => void,
    private readonly now: () => number = Date.now,
  ) {
    if (limits.idleTimeoutMs > 0) {
      this.timer = setInterval(() => this.sweep(), limits.sweepIntervalMs);
      // Never hold the event loop open just for the sweep.
      this.timer.unref?.();
    }
  }

  /** Number of sessions currently held. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Ask whether a new session may be created. Call this BEFORE doing the
   * expensive setup (transport + Server + connect), so a refused request costs
   * nothing.
   */
  tryReserve(): ReserveResult {
    const max = this.limits.max;
    if (max > 0 && this.entries.size >= max) {
      // A cap hit is often just a leak that the sweep has not caught yet, so
      // give it a chance before refusing.
      this.sweep();
      if (this.entries.size >= max) {
        return {
          ok: false,
          reason: `Session limit reached (${this.entries.size}/${max})`,
          held: this.entries.size,
          max,
        };
      }
    }
    return { ok: true };
  }

  /** Register a session. Overwrites any existing entry with the same id. */
  set(id: string, value: T): void {
    const t = this.now();
    this.entries.set(id, { value, createdAt: t, lastSeen: t });
  }

  /**
   * Look up a session and refresh its idle timer.
   *
   * Touching on read is the point: it means "idle" tracks actual client
   * activity rather than session age, so a long-running, actively used session
   * is never evicted.
   */
  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.lastSeen = this.now();
    return entry.value;
  }

  /** Look up without refreshing the idle timer. */
  peek(id: string): T | undefined {
    return this.entries.get(id)?.value;
  }

  /** Remove a session. Returns true when it was present. */
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Evict everything idle beyond the timeout. Returns the number evicted. */
  sweep(): number {
    const timeout = this.limits.idleTimeoutMs;
    if (timeout <= 0) return 0;
    const cutoff = this.now() - timeout;
    let evicted = 0;
    for (const [id, entry] of this.entries) {
      if (entry.lastSeen <= cutoff) {
        this.entries.delete(id);
        evicted++;
        const idleMs = this.now() - entry.lastSeen;
        try {
          this.onEvict(id, entry.value, idleMs);
        } catch (err) {
          logger.warn("session evict handler failed", {
            session: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (evicted > 0) {
      logger.info("swept idle MCP sessions", {
        evicted,
        remaining: this.entries.size,
        idleTimeoutMs: timeout,
      });
    }
    return evicted;
  }

  /** Stop the sweep timer (graceful shutdown / tests). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
