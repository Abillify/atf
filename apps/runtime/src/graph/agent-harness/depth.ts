// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — delegation depth tracking (`agent-harness/depth.ts`)
 *
 * Bounds how deeply harnesses may nest.
 *
 * ## Why this is a prerequisite, not a nicety
 *
 * `delegate()` resolves a target's handler from the node-handler registry BY NODE
 * TYPE. `agent-harness` is itself a registered type, so a harness can delegate to
 * another harness — which is what makes hierarchical agents (a coordinator over
 * specialist sub-agents) possible at all. But nothing stopped the recursion:
 *
 *   - a harness whose `allowlist` contains its OWN id re-enters itself, and
 *   - a cycle across two harnesses (A → B → A) does the same indirectly.
 *
 * Neither is caught by `HarnessConfigSchema` (which only checks that the
 * allowlist is a non-empty string array) nor by `resolveAllowlist` (which only
 * checks that targets exist). The result is unbounded recursion until the stack
 * overflows, taking the request — and, with a synchronous stack overflow, more
 * than the request — with it.
 *
 * So enabling powerful nested agents REQUIRES a depth bound first. This mirrors
 * Hermes's `delegation.max_spawn_depth` (default 2).
 *
 * ## Why the depth lives on the runnable config, not on AgentState
 *
 * `AgentState` is checkpointed. A depth counter persisted into a thread would be
 * restored on the next turn and describe a delegation chain that is no longer
 * running — so a resumed conversation could refuse to delegate, or (worse) start
 * from a stale non-zero depth. Delegation depth is a property of the CURRENT call
 * stack, so it belongs to the per-invocation config that is already threaded to
 * child handlers.
 *
 * No `any` at module boundaries.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";

/**
 * Default maximum nesting depth. Depth 0 is the outermost harness, so the
 * default admits a coordinator (0) delegating to sub-harnesses (1) which may
 * delegate to leaf workers (2) — deep enough for a coordinator/specialist/worker
 * hierarchy, shallow enough that a planning mistake cannot fan out
 * exponentially. Matches Hermes's `max_spawn_depth` default.
 */
export const DEFAULT_MAX_DELEGATION_DEPTH = 2;

/**
 * Hard ceiling on the configurable depth. Even an explicit config cannot exceed
 * it: each level multiplies worst-case model calls by the branching factor, so a
 * deep tree is a cost incident, not a capability.
 */
export const MAX_ALLOWED_DELEGATION_DEPTH = 5;

/** Key used inside `config.configurable` to carry the current depth. */
const DEPTH_KEY = "harnessDelegationDepth";

/** Key used inside `config.configurable` to carry the ancestor harness chain. */
const CHAIN_KEY = "harnessAncestorIds";

interface DepthConfigurable {
  [DEPTH_KEY]?: unknown;
  [CHAIN_KEY]?: unknown;
}

/**
 * Reads the current delegation depth. Absent/invalid values read as 0 (the
 * outermost harness), which is the safe default: a missing counter must not be
 * interpreted as "already deep" and block a legitimate first delegation.
 */
export function readDelegationDepth(
  config: LangGraphRunnableConfig | undefined,
): number {
  const configurable = config?.configurable as DepthConfigurable | undefined;
  const raw = configurable?.[DEPTH_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

/**
 * Reads the chain of harness node ids currently on the stack, outermost first.
 *
 * Used for cycle DETECTION and, more importantly, for a diagnostic that names the
 * actual cycle. The depth bound alone already prevents runaway recursion, but it
 * reports "too deep" for what is really a flow-configuration error — and a
 * two-harness cycle would otherwise silently burn the whole depth budget on
 * every request.
 */
export function readAncestorChain(
  config: LangGraphRunnableConfig | undefined,
): string[] {
  const configurable = config?.configurable as DepthConfigurable | undefined;
  const raw = configurable?.[CHAIN_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Returns a config for a CHILD delegation: depth incremented and `harnessId`
 * appended to the ancestor chain.
 *
 * Copies `configurable` rather than mutating it — the parent's config object is
 * reused for its remaining tasks, and mutating it would leak the child's depth
 * into the parent's subsequent (sibling) delegations, making the effective limit
 * depend on how many tasks ran before.
 */
export function withChildDelegationDepth(
  config: LangGraphRunnableConfig,
  harnessId: string,
): LangGraphRunnableConfig {
  const depth = readDelegationDepth(config);
  const chain = readAncestorChain(config);
  return {
    ...config,
    configurable: {
      ...config.configurable,
      [DEPTH_KEY]: depth + 1,
      [CHAIN_KEY]: [...chain, harnessId],
    },
  };
}

/** Clamps a configured max depth into `[0, MAX_ALLOWED_DELEGATION_DEPTH]`. */
export function resolveMaxDelegationDepth(
  configured: number | undefined,
): number {
  if (
    configured === undefined ||
    !Number.isFinite(configured) ||
    configured < 0
  ) {
    return DEFAULT_MAX_DELEGATION_DEPTH;
  }
  return Math.min(Math.floor(configured), MAX_ALLOWED_DELEGATION_DEPTH);
}

/**
 * Partitions an allowlist into targets that may be delegated to and targets that
 * must be refused because delegating to them would re-enter a harness already on
 * the stack.
 *
 * Two cases are refused:
 *   - SELF: the harness's own id. Self-delegation is never meaningful — the
 *     re-entered harness would receive the same goal and plan the same tasks.
 *   - ANCESTOR: any harness already on the current stack, i.e. a cycle.
 *
 * Refusing only the offending TARGETS (rather than failing the whole node) keeps
 * a flow with one bad allowlist entry working with its remaining targets, which
 * matches how `resolveAllowlist` already treats unknown ids.
 */
export function partitionCyclicTargets(
  allowlist: string[],
  selfId: string,
  ancestorChain: string[],
): { allowed: string[]; cyclic: string[] } {
  const forbidden = new Set<string>([selfId, ...ancestorChain]);
  const allowed: string[] = [];
  const cyclic: string[] = [];
  for (const entry of allowlist) {
    if (forbidden.has(entry)) cyclic.push(entry);
    else allowed.push(entry);
  }
  return { allowed, cyclic };
}
