// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Model-pool selection (`src/graph/model-pool.ts`)
 *
 * Turns a node's {@link LlmConfig} — optionally carrying a `pool` attached by
 * the flow parser when the node references a POOL shortcut in
 * `flows/model-shortcuts.yaml` — into the ORDERED candidate chain a handler
 * should attempt, from first choice to last failover.
 *
 * Strategies (see `LlmPoolStrategy`):
 *   - `"fallback"`     — the configured order IS the priority order: candidate
 *                        0 is the primary, each later one a failover.
 *   - `"round-robin"`  — calls rotate evenly across the members. A shared
 *                        cursor (keyed by pool identity) advances once per
 *                        call; the member it lands on becomes the primary and
 *                        the remaining members (configured order, wrapped)
 *                        follow as failovers, so a pool still degrades
 *                        gracefully when the rotated-to member is down.
 *   - weighted-round-robin / random / weighted-random / least-used — see the
 *                        helpers below.
 *
 * Nested pools: a candidate may itself carry a `pool` (a pool shortcut that
 * references another pool shortcut). Such a candidate is resolved recursively
 * BY ITS OWN STRATEGY and its leaves are spliced into the parent's order at the
 * candidate's position. So an outer `"fallback"` pool `[ rr(a, b), c ]` yields
 * the rr primary, then the rr other, then `c` — the inner round-robin rotates
 * between a and b, and c is only reached once both a and b are exhausted or
 * unavailable. Each sub-pool uses an independent cursor key.
 *
 * Stickiness (`pool.sticky`, see `LlmPoolStickiness`): small local servers
 * often keep only one slot and cache the prompt prefix, so rotating away on
 * every call defeats that cache. With `sticky: "execution"` or
 * `"conversation"` the leaf selected on the pool's FIRST call for a given
 * context (an execution, or a conversation keyed by `conversationId`/
 * `sessionId`) is remembered and moved to the front on later calls; the rest
 * of the order is untouched, so failover still works. Sticky entries live in
 * a bounded LRU map with a TTL — process-local like the cursors, and losing
 * them is harmless.
 *
 * Load (`options.isBusy`, see `endpoint-load.ts`): a leaf whose endpoint is at
 * its `maxConcurrent` capacity moves behind the free leaves, and a sticky pin
 * on a busy leaf moves to the free primary. Single-slot servers therefore only
 * receive a call while they are idle; the busy leaf remains a failover.
 *
 * A config with no `pool` yields a single-element chain `[config]`, so callers
 * get uniform handling whether or not a pool is in play. The returned chain is
 * always a FLAT list of concrete leaf configs.
 *
 * The round-robin cursor is process-local in-memory state. It is deliberately
 * NOT persisted: rotation is a load-spreading heuristic, not a correctness
 * guarantee, and a fresh cursor after a restart is harmless. The cursor is
 * keyed by a caller-supplied identity string (typically flow + node + the pool
 * signature) so two distinct pools never share a counter, and it advances
 * monotonically (a plain counter, not a stored index) so concurrent calls
 * interleave rather than collide on the same slot.
 *
 * Pure apart from that cursor map — no I/O — so the selection is unit-testable.
 *
 * No `any` at module boundaries.
 */

import type { LlmConfig, LlmPoolStrategy } from "../types/flow.js";

/**
 * Monotonic round-robin cursors keyed by pool identity. Values grow without
 * bound; modulo against the member count is applied at read time.
 */
const roundRobinCursors = new Map<string, number>();
const usageCounters = new Map<string, number[]>();

/** Max sticky entries kept in memory; oldest are evicted beyond this. */
export const STICKY_MAX_ENTRIES = 10_000;
/** A sticky entry is forgotten after this many milliseconds without a hit. */
export const STICKY_TTL_MS = 60 * 60 * 1000;

/**
 * Sticky pool selections keyed by `<poolKey>|<stickyKey>`: the leaf the pool
 * picked on the first call for a context, plus the last time it was used.
 * `Map` insertion order doubles as the LRU order (entries are re-inserted on
 * every hit). Process-local like the cursors — a restart simply un-pins.
 */
const stickySelections = new Map<string, { leafKey: string; touchedAt: number }>();

/** `provider/model` identity of a leaf config. */
function leafKeyOf(config: LlmConfig): string {
  return `${config.provider}/${config.model}`;
}

/**
 * Drops expired entries and, if still over {@link STICKY_MAX_ENTRIES}, the
 * least-recently-touched ones (`Map` iteration order = insertion order, and
 * hits re-insert, so the oldest insertion is the LRU victim).
 */
function pruneStickyEntries(now: number): void {
  if (stickySelections.size <= STICKY_MAX_ENTRIES) return;
  for (const [key, entry] of stickySelections) {
    if (now - entry.touchedAt > STICKY_TTL_MS) {
      stickySelections.delete(key);
    }
  }
  while (stickySelections.size > STICKY_MAX_ENTRIES) {
    const oldest = stickySelections.keys().next();
    if (oldest.done === true) break;
    stickySelections.delete(oldest.value);
  }
}

/**
 * Applies stickiness to an ordered leaf chain for one pool + context.
 *
 * When a fresh sticky entry exists whose leaf is still in `ordered`, that leaf
 * is moved to position 1 and the rest of the order is kept unchanged (so the
 * failover chain survives). Otherwise the current head becomes the sticky
 * leaf. The entry is refreshed (re-inserted) on every access.
 *
 * @param ordered - The ordered leaf chain produced by the pool strategy.
 * @param poolKey - Identity of the pool (its cursor key).
 * @param stickyKey - Identity of the stickiness context (execution or
 *   conversation id).
 * @returns The (possibly reordered) chain, first = primary.
 */
export function applyStickiness(
  ordered: LlmConfig[],
  poolKey: string,
  stickyKey: string,
  isBusy?: (candidate: LlmConfig) => boolean,
): LlmConfig[] {
  if (ordered.length === 0) return ordered;
  const now = Date.now();
  pruneStickyEntries(now);
  const key = `${poolKey}|${stickyKey}`;
  const entry = stickySelections.get(key);
  let stickyIndex =
    entry === undefined || now - entry.touchedAt > STICKY_TTL_MS
      ? -1
      : ordered.findIndex((leaf) => leafKeyOf(leaf) === entry.leafKey);
  // A pinned leaf that is busy while the head is free gives way: the call goes
  // to the free head and the pin moves there (its prefix cache now lives on
  // the new leaf). When the head is busy too, every leaf is, and the pin wins.
  if (
    stickyIndex > 0 &&
    isBusy !== undefined &&
    isBusy(ordered[stickyIndex]) &&
    !isBusy(ordered[0])
  ) {
    stickyIndex = -1;
  }
  if (stickyIndex <= 0) {
    // No usable sticky leaf (none yet, expired, or the pinned leaf dropped
    // out of the chain): the head becomes the new sticky leaf.
    stickySelections.delete(key);
    stickySelections.set(key, { leafKey: leafKeyOf(ordered[0]), touchedAt: now });
    return ordered;
  }
  stickySelections.delete(key);
  stickySelections.set(key, {
    leafKey: leafKeyOf(ordered[stickyIndex]),
    touchedAt: now,
  });
  return [
    ordered[stickyIndex],
    ...ordered.slice(0, stickyIndex),
    ...ordered.slice(stickyIndex + 1),
  ];
}

export interface PoolSelectionOptions {
  /** Candidates returning false are skipped before selection and failover. */
  isAvailable?: (candidate: LlmConfig) => boolean;
  /** Injectable randomness for deterministic tests. Returns [0, 1). */
  random?: () => number;
  /**
   * Identity of the stickiness context (execution or conversation id). When
   * set and the pool is `sticky: "execution" | "conversation"`, the selected
   * leaf is remembered for this context and kept at the front of later
   * chains. Omit to disable stickiness for this call.
   */
  stickyKey?: string;
  /**
   * Load check (see `endpoint-load.ts`). A busy leaf moves behind the free
   * leaves of the final chain — keeping the relative order within both groups,
   * so it stays a failover — and a sticky pin on a busy leaf moves to the free
   * primary. When every leaf is busy the order is unchanged.
   */
  isBusy?: (candidate: LlmConfig) => boolean;
}

/**
 * Moves busy leaves behind the free ones, stable within both groups. Returns
 * the input unchanged when no leaf or every leaf is busy.
 */
export function demoteBusyLeaves(
  leaves: LlmConfig[],
  isBusy: (candidate: LlmConfig) => boolean,
): LlmConfig[] {
  if (leaves.length <= 1) return leaves;
  const free: LlmConfig[] = [];
  const busy: LlmConfig[] = [];
  for (const leaf of leaves) {
    (isBusy(leaf) ? busy : free).push(leaf);
  }
  if (free.length === 0 || busy.length === 0) return leaves;
  return [...free, ...busy];
}

/**
 * A stable signature for a pool's candidate set, used as part of the cursor
 * key so a pool that changes membership (hot-reloaded shortcuts) starts a fresh
 * rotation rather than inheriting a stale offset. Order-sensitive.
 */
export function poolSignature(candidates: readonly LlmConfig[]): string {
  return candidates
    .map((c) => `${c.provider}/${c.model}`)
    .join(",");
}

/**
 * All concrete LEAF configs reachable from a config, walking nested sub-pools.
 * Excludes the host config itself — it returns the pool members (and, for a
 * nested sub-pool, that sub-pool's leaves). A config without a `pool` yields
 * `[]`. Used by consumers that must account for every model a node could call
 * (compliance data-flow map, capability collection, token-limit accounting),
 * so a rotated-to, failed-over, or nested member is never invisible.
 */
export function poolLeafConfigs(config: LlmConfig): LlmConfig[] {
  const leaves: LlmConfig[] = [];
  const walk = (candidates: readonly LlmConfig[] | undefined): void => {
    for (const candidate of candidates ?? []) {
      if (
        candidate.pool !== undefined &&
        Array.isArray(candidate.pool.candidates)
      ) {
        walk(candidate.pool.candidates);
      } else {
        leaves.push(candidate);
      }
    }
  };
  walk(config.pool?.candidates);
  return leaves;
}

/**
 * Orders `candidates` for a round-robin call: advances the shared cursor for
 * `key`, makes the landed-on member the primary, and lists the rest in
 * configured order (wrapped) as failovers.
 */
function rotateForRoundRobin(
  candidates: readonly LlmConfig[],
  key: string,
): LlmConfig[] {
  const n = candidates.length;
  if (n <= 1) return [...candidates];
  const next = (roundRobinCursors.get(key) ?? -1) + 1;
  // Keep the stored value bounded to avoid unbounded growth over a long-lived
  // process; the rotation phase is preserved by taking the same modulus.
  roundRobinCursors.set(key, next % n);
  const start = next % n;
  const ordered: LlmConfig[] = [];
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const candidate = candidates[idx];
    if (candidate !== undefined) ordered.push(candidate);
  }
  return ordered;
}

function weightOf(candidate: LlmConfig): number {
  return typeof candidate.weight === "number" && candidate.weight > 0
    ? candidate.weight
    : 1;
}

function weightedOrder(
  candidates: readonly LlmConfig[],
  key: string,
  strategy: "weighted-round-robin" | "weighted-random",
  random: () => number,
): LlmConfig[] {
  if (candidates.length <= 1) return [...candidates];
  const weights = candidates.map(weightOf);
  if (strategy === "weighted-round-robin") {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const cursor = (roundRobinCursors.get(key) ?? -1) + 1;
    roundRobinCursors.set(key, cursor % total);
    let offset = cursor % total;
    let start = 0;
    for (let index = 0; index < weights.length; index += 1) {
      if (offset < weights[index]) {
        start = index;
        break;
      }
      offset -= weights[index];
    }
    return [...candidates.slice(start), ...candidates.slice(0, start)];
  }
  const remaining = [...candidates];
  const ordered: LlmConfig[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((sum, candidate) => sum + weightOf(candidate), 0);
    let pick = Math.min(Math.max(random(), 0), 0.999999999) * total;
    let selected = remaining.length - 1;
    for (let index = 0; index < remaining.length; index += 1) {
      pick -= weightOf(remaining[index]);
      if (pick < 0) {
        selected = index;
        break;
      }
    }
    ordered.push(remaining[selected]);
    remaining.splice(selected, 1);
  }
  return ordered;
}

function leastUsedOrder(candidates: readonly LlmConfig[], key: string): LlmConfig[] {
  const counts = usageCounters.get(key) ?? candidates.map(() => 0);
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index, count: counts[index] ?? 0 }))
    .sort((left, right) => left.count - right.count || left.index - right.index);
  const selected = ordered[0];
  if (selected !== undefined) counts[selected.index] = selected.count + 1;
  usageCounters.set(key, counts);
  return ordered.map((entry) => entry.candidate);
}

/**
 * Whether a candidate has at least one usable leaf. A concrete candidate is
 * usable when `isAvailable` accepts its provider; a nested sub-pool is usable
 * when ANY of its (recursively resolved) leaves is usable.
 */
function candidateHasUsableLeaf(
  candidate: LlmConfig,
  isAvailable: (candidate: LlmConfig) => boolean,
): boolean {
  if (candidate.pool !== undefined && Array.isArray(candidate.pool.candidates)) {
    return candidate.pool.candidates.some((child) =>
      candidateHasUsableLeaf(child, isAvailable),
    );
  }
  return isAvailable(candidate);
}

/**
 * Orders ONE pool level's candidates by `strategy`. Candidates may be concrete
 * configs or nested sub-pools; ordering treats them opaquely (a sub-pool keeps
 * its position and weight). The caller expands the ordered candidates into
 * leaves afterwards.
 */
function orderLevel(
  candidates: readonly LlmConfig[],
  strategy: LlmPoolStrategy,
  cursorKey: string,
  random: () => number,
): LlmConfig[] {
  if (strategy === "round-robin") return rotateForRoundRobin(candidates, cursorKey);
  if (strategy === "weighted-round-robin" || strategy === "weighted-random") {
    return weightedOrder(candidates, cursorKey, strategy, random);
  }
  if (strategy === "random") {
    return weightedOrder(
      candidates.map((candidate) => ({ ...candidate, weight: 1 })),
      cursorKey,
      "weighted-random",
      random,
    );
  }
  if (strategy === "least-used") return leastUsedOrder(candidates, cursorKey);
  return [...candidates];
}

/**
 * Builds the ordered, FLAT list of concrete leaf configs a handler should
 * attempt for `config`, resolving nested sub-pools recursively.
 *
 * - No `pool` → `[config]` (unchanged single-model behaviour).
 * - A pool is ordered by its own `strategy` (`fallback` = configured order,
 *   `round-robin`/weighted/random/least-used as documented). Each ordered
 *   candidate that is itself a sub-pool is expanded recursively BY ITS OWN
 *   STRATEGY before moving to the parent's next candidate. So an outer
 *   `fallback` pool `[ rr(llm1, llm2), qwen ]` yields `[<rr primary>, <rr
 *   other>, qwen]` — the sub-pool rotates internally and `qwen` is only reached
 *   once both sub-pool members are exhausted/unavailable.
 *
 * Availability: an unavailable leaf (its provider's circuit is open) is dropped;
 * a sub-pool is dropped only when ALL its leaves are unavailable. A healthy pool
 * with no usable leaf returns `[]` so the caller can fall back to the
 * deployment-level chain; an explicitly empty/malformed pool returns `[config]`.
 *
 * Each sub-pool gets a distinct cursor key (`<parentKey>>><index>`) so its
 * rotation is independent of the parent and of sibling sub-pools.
 *
 * @param config  - The node's resolved LLM config (may carry a nested `pool`).
 * @param cursorKey - Identity for the rotation cursors (flow + node + pool
 *   signature recommended).
 * @returns The ordered leaf candidates, first = primary.
 */
export function buildPoolCandidateChain(
  config: LlmConfig,
  cursorKey: string,
  options: PoolSelectionOptions = {},
): LlmConfig[] {
  // Load is applied once, to the final chain of the outermost pool, so nested
  // sub-pools are expanded without it.
  const { isBusy, ...expandOptions } = options;
  const expanded = expandPoolCandidateChain(config, cursorKey, expandOptions);
  const leaves =
    isBusy !== undefined ? demoteBusyLeaves(expanded, isBusy) : expanded;
  // Stickiness is applied once, to the final FLAT chain of the outermost pool,
  // so a pinned leaf stays first regardless of nested sub-pool expansion.
  const sticky = config.pool?.sticky;
  if (
    options.stickyKey !== undefined &&
    (sticky === "execution" || sticky === "conversation") &&
    leaves.length > 0
  ) {
    return applyStickiness(leaves, cursorKey, options.stickyKey, isBusy);
  }
  return leaves;
}

function expandPoolCandidateChain(
  config: LlmConfig,
  cursorKey: string,
  options: PoolSelectionOptions,
): LlmConfig[] {
  const pool = config.pool;
  if (pool === undefined || !Array.isArray(pool.candidates)) {
    return [config];
  }
  const isAvailable = options.isAvailable ?? (() => true);
  const random = options.random ?? Math.random;

  const usable = pool.candidates.filter((candidate) =>
    candidateHasUsableLeaf(candidate, isAvailable),
  );
  // An explicitly empty/malformed pool keeps legacy single-model behaviour;
  // a healthy pool whose members are all unavailable returns no candidates so
  // the caller can continue with deployment-level fallbacks instead of retrying
  // the known-dead primary.
  if (usable.length === 0) {
    return pool.candidates.length === 0 ? [config] : [];
  }

  const strategy: LlmPoolStrategy = pool.strategy ?? "fallback";
  const ordered = orderLevel(usable, strategy, cursorKey, random);

  const leaves: LlmConfig[] = [];
  for (const candidate of ordered) {
    if (
      candidate.pool !== undefined &&
      Array.isArray(candidate.pool.candidates)
    ) {
      // Nested sub-pool: resolve by ITS OWN strategy, with an independent
      // cursor keyed off this candidate's position and signature.
      const childKey = `${cursorKey}>>${poolSignature(candidate.pool.candidates)}`;
      leaves.push(...buildPoolCandidateChain(candidate, childKey, options));
    } else {
      leaves.push(candidate);
    }
  }
  return leaves;
}

/**
 * Resets the round-robin cursor for `key`, or all cursors when omitted. Also
 * clears the matching sticky selections. Exposed for tests and for operators
 * who want to re-phase a pool after a backend change; not called on the hot
 * path.
 */
export function resetPoolCursors(key?: string): void {
  if (key === undefined) {
    roundRobinCursors.clear();
    usageCounters.clear();
    stickySelections.clear();
    return;
  }
  roundRobinCursors.delete(key);
  usageCounters.delete(key);
  const prefix = `${key}|`;
  for (const stickyKey of stickySelections.keys()) {
    if (stickyKey.startsWith(prefix)) {
      stickySelections.delete(stickyKey);
    }
  }
}
