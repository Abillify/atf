// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * memory.ts
 *
 * In-memory GCRA backend with bounded growth: when the key count exceeds
 * `maxKeys`, the entries whose buckets fill up soonest (lowest TAT) are
 * evicted first, which under a many-source flood keeps the limiters that
 * actually matter warm. Single-process only — use the Redis backend when
 * several replicas share a limit.
 */

import { gcraCheck, type GcraConfig, type GcraState, type RateLimitBackend, type RateLimitResult } from "./gcra.ts";

export interface MemoryBackendOptions {
  /** Maximum tracked keys before eviction (default 50 000). */
  maxKeys?: number;
  /** Clock injection (microseconds); defaults to `performance.now()*1000`-style Date.now. */
  nowUs?: () => number;
}

export function createMemoryRateLimitBackend(options: MemoryBackendOptions = {}): RateLimitBackend & {
  /** Number of tracked keys (tests/metrics). */
  size(): number;
  /** Drop all state (tests). */
  clear(): void;
} {
  const maxKeys = options.maxKeys ?? 50_000;
  const nowUs = options.nowUs ?? ((): number => Date.now() * 1000);
  const states = new Map<string, { state: GcraState; expiresAtUs: number }>();

  const take = async (key: string, config: GcraConfig, cost = 1): Promise<RateLimitResult> => {
    const now = nowUs();
    // Opportunistic cleanup of expired entries keeps memory bounded without a timer.
    if (states.size > 1024) {
      for (const [entryKey, entry] of states) {
        if (entry.expiresAtUs <= now) states.delete(entryKey);
      }
    }
    const existing = states.get(key);
    const decision = gcraCheck(config, existing === undefined ? null : existing.state, now, cost);
    // Entry can be dropped once its bucket is full again — nobody can tell it
    // apart from a never-seen key at that point.
    states.set(key, { state: decision.state, expiresAtUs: decision.state.tatUs });
    if (states.size > maxKeys) {
      // Evict the 10 % oldest (lowest TAT = fullest/cheapest buckets).
      const sorted = [...states.entries()].sort((a, b) => a[1].state.tatUs - b[1].state.tatUs);
      const drop = Math.ceil(maxKeys * 0.1);
      for (let i = 0; i < drop && i < sorted.length; i++) {
        const entry = sorted[i];
        if (entry !== undefined) states.delete(entry[0]);
      }
    }
    return {
      allowed: decision.allowed,
      limit: config.limit,
      remaining: decision.remaining,
      retryAfterMs: decision.retryAfterMs,
      resetAfterMs: decision.resetAfterMs,
    };
  };

  return {
    take,
    size: () => states.size,
    clear: () => states.clear(),
  };
}
