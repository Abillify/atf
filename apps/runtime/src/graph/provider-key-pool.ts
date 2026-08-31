// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Provider API-key pool — health-based load-balancing & rotation
 * (`src/graph/provider-key-pool.ts`)
 *
 * A single API key per provider is both a rate-limit bottleneck and a single
 * point of failure: when one key is throttled (HTTP 429) or revoked, every
 * request to that provider fails. This pool lets an operator supply MANY keys
 * per provider and:
 *
 *   - spreads load across them (round-robin among healthy keys), and
 *   - quarantines a key on failure with an exponential cooldown so a throttled
 *     or revoked key is skipped until it recovers — then automatically returns
 *     it to rotation.
 *
 * The pool is pure, in-memory and per-replica (no external state), so it adds
 * zero dependencies and is fully unit-testable with an injected clock. When no
 * keys are configured for a provider the pool returns `undefined` and the
 * caller falls back to the single key from {@link AppConfig} — so the feature
 * is strictly additive and off by default.
 *
 * No `any` at module boundaries.
 */

/** Supported providers that authenticate with a rotatable API key. */
export type KeyedProvider =
  | "openai"
  | "google"
  | "azure"
  | "bedrock"
  | "anthropic";

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

/** One key's live health state within a provider's rotation. */
interface KeyState {
  /** The credential value. */
  key: string;
  /** Consecutive failures since the last success (drives cooldown length). */
  consecutiveFailures: number;
  /** Epoch ms before which the key is quarantined (0 = healthy now). */
  cooldownUntil: number;
  /** Total successes / failures (diagnostics + metrics). */
  successes: number;
  failures: number;
}

export interface KeyHealth {
  /** Masked key (only the last 4 chars are shown). */
  keyMask: string;
  healthy: boolean;
  consecutiveFailures: number;
  cooldownUntil: number;
  successes: number;
  failures: number;
}

export interface ProviderKeyPoolOptions {
  /** Base cooldown (ms) applied on the first failure. Default 1000. */
  baseCooldownMs?: number;
  /** Maximum cooldown (ms) the exponential backoff is capped at. Default 60000. */
  maxCooldownMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  clock?: Clock;
}

/**
 * Masks a credential so it can appear in logs/metrics without leaking: keeps a
 * short provider-style prefix when present and the last 4 chars, redacting the
 * middle. Never returns the full key.
 */
export function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  const tail = key.slice(-4);
  return `****${tail}`;
}

/**
 * Manages one provider's pool of keys: round-robin selection among healthy
 * keys with exponential-backoff quarantine on failure.
 */
class SingleProviderPool {
  private readonly states: KeyState[];
  private cursor = 0;

  constructor(
    keys: readonly string[],
    private readonly baseCooldownMs: number,
    private readonly maxCooldownMs: number,
    private readonly clock: Clock,
  ) {
    // De-duplicate while preserving order — a repeated key would otherwise get
    // double weight in the rotation.
    const seen = new Set<string>();
    this.states = [];
    for (const k of keys) {
      if (k.length === 0 || seen.has(k)) continue;
      seen.add(k);
      this.states.push({
        key: k,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        successes: 0,
        failures: 0,
      });
    }
  }

  get size(): number {
    return this.states.length;
  }

  /**
   * Picks the next key to use. Prefers healthy keys in round-robin order; when
   * every key is in cooldown it falls back to the one whose cooldown expires
   * soonest (fail-open — better to try a likely-throttled key than to fail the
   * request outright). Returns undefined only when the pool is empty.
   */
  acquire(): string | undefined {
    if (this.states.length === 0) return undefined;
    const now = this.clock();
    const n = this.states.length;

    // Round-robin scan for a healthy key.
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const s = this.states[idx];
      if (s === undefined) continue; // unreachable: idx is always < n === this.states.length
      if (s.cooldownUntil <= now) {
        this.cursor = (idx + 1) % n;
        return s.key;
      }
    }

    // All quarantined — pick the soonest to recover (fail-open).
    const [firstState, ...restStates] = this.states;
    if (firstState === undefined) return undefined; // unreachable: length checked above
    let best = firstState;
    for (const s of restStates) {
      if (s.cooldownUntil < best.cooldownUntil) best = s;
    }
    return best.key;
  }

  reportSuccess(key: string): void {
    const s = this.states.find((x) => x.key === key);
    if (s === undefined) return;
    s.consecutiveFailures = 0;
    s.cooldownUntil = 0;
    s.successes++;
  }

  reportFailure(key: string): void {
    const s = this.states.find((x) => x.key === key);
    if (s === undefined) return;
    s.consecutiveFailures++;
    s.failures++;
    // Exponential backoff: base * 2^(n-1), capped. e.g. 1s, 2s, 4s, … ≤ max.
    const factor = 2 ** Math.min(s.consecutiveFailures - 1, 30);
    const cooldown = Math.min(this.baseCooldownMs * factor, this.maxCooldownMs);
    s.cooldownUntil = this.clock() + cooldown;
  }

  health(): KeyHealth[] {
    const now = this.clock();
    return this.states.map((s) => ({
      keyMask: maskKey(s.key),
      healthy: s.cooldownUntil <= now,
      consecutiveFailures: s.consecutiveFailures,
      cooldownUntil: s.cooldownUntil,
      successes: s.successes,
      failures: s.failures,
    }));
  }
}

/** Per-provider key sets supplied by configuration. */
export type ProviderKeys = Partial<Record<KeyedProvider, string[]>>;

/**
 * The public pool. Holds one {@link SingleProviderPool} per configured provider
 * and exposes acquire / report / health keyed by provider.
 */
export class ProviderKeyPool {
  private readonly pools = new Map<KeyedProvider, SingleProviderPool>();
  private readonly clock: Clock;

  constructor(keys: ProviderKeys, opts: ProviderKeyPoolOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    const base = opts.baseCooldownMs ?? 1000;
    const max = opts.maxCooldownMs ?? 60_000;
    for (const provider of Object.keys(keys) as KeyedProvider[]) {
      const list = keys[provider] ?? [];
      if (list.length === 0) continue;
      this.pools.set(
        provider,
        new SingleProviderPool(list, base, max, this.clock),
      );
    }
  }

  /** True when at least one provider has a configured key pool. */
  get active(): boolean {
    return this.pools.size > 0;
  }

  /** Number of keys configured for a provider (0 when none). */
  sizeFor(provider: KeyedProvider): number {
    return this.pools.get(provider)?.size ?? 0;
  }

  /**
   * Returns the next key to use for a provider, or undefined when the pool has
   * no keys for it (caller then uses the single AppConfig key).
   */
  acquire(provider: KeyedProvider): string | undefined {
    return this.pools.get(provider)?.acquire();
  }

  /** Marks a key healthy (resets its cooldown). No-op for unknown keys. */
  reportSuccess(provider: KeyedProvider, key: string): void {
    this.pools.get(provider)?.reportSuccess(key);
  }

  /** Quarantines a key with exponential backoff. No-op for unknown keys. */
  reportFailure(provider: KeyedProvider, key: string): void {
    this.pools.get(provider)?.reportFailure(key);
  }

  /** Per-provider key health snapshot (masked) for diagnostics / dashboard. */
  health(): Record<string, KeyHealth[]> {
    const out: Record<string, KeyHealth[]> = {};
    for (const [provider, pool] of this.pools) out[provider] = pool.health();
    return out;
  }
}
