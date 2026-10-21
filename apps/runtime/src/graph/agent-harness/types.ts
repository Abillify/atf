// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — Core Types, Constants, and Pure Helpers
 *
 * This module defines the data model, configuration parsing, and pure helper
 * functions for the `agent-harness` node type. These are consumed by the loop
 * handler, the delegation/planning tools, and the property tests.
 *
 * @module agent-harness/types
 */

import type { FlowNode, LlmConfig } from "../../types/flow.js";
import {
  type CoverageAssignmentMode,
  type CoverageLedger,
  type CoverageQueueConfig,
  type CoverageSummaryTriageConfig,
  DEFAULT_SUMMARY_TRIAGE_ACCEPT_TOP_K,
  DEFAULT_SUMMARY_TRIAGE_EXCLUDE_BELOW_RANK,
  DEFAULT_SUMMARY_TRIAGE_EXCLUDE_MAX_SCORE,
  DEFAULT_SUMMARY_TRIAGE_QUERIES,
  MAX_SUMMARY_TRIAGE_QUERIES,
} from "./coverage.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Status of an individual task in the harness task list. */
export type TaskStatus = "pending" | "in-progress" | "completed" | "failed";

/** A single unit of work planned by the harness. */
export interface Task {
  /** Stable technical identifier assigned by the harness (e.g. "t1", "t2"). */
  id: string;
  /**
   * User-facing ordinal within the current research sequence. Unlike {@link id},
   * this stays continuous when a re-plan replaces pending technical task ids.
   */
  displayStep?: number;
  /** Whether this task was created by a re-plan rather than the initial plan. */
  replanned?: boolean;
  /** Human-readable description of the unit of work. */
  description: string;
  /** Selected Delegation_Target — always a member of the validated allowlist. */
  target: string;
  /** Current execution status. */
  status: TaskStatus;
  /** Outcome captured when the task completes or fails (Req 4.3, 8.2). */
  result?: string;
  /** Concise, evidence-bound research and decision status. */
  researchStatus?: string;
  /** Error text when status is "failed" (Req 4.6, 11.4, 12.2). */
  error?: string;
  /**
   * Whether this task may run CONCURRENTLY with the adjacent tasks that also
   * carry the flag. Set by the planner.
   *
   * A deliberately coarse model rather than a `dependsOn` dependency graph: a
   * small local planner reliably answers "does this step need the previous one's
   * result?" but routinely produces malformed id references. An absent/false
   * flag makes the task a BARRIER (runs alone, after everything before it), so
   * a planner that never sets it yields exactly the previous fully sequential
   * behaviour.
   */
  parallelizable?: boolean;
  /**
   * How many times this task has been retried after a failure. Absent means
   * never retried.
   */
  attempts?: number;
  /** Deterministic coverage assignment carried privately to a plannerless worker. */
  coverageAssignmentId?: string;
  coverageAssignmentMode?: CoverageAssignmentMode;
  coverageRefs?: string[];
}

/**
 * The reason why the harness execution loop stopped.
 * Each variant maps to a specific requirement clause.
 */
export type StopReason =
  | "completed" // Req 4.5
  | "no-tasks" // Req 3.3
  | "iteration-limit" // Req 5.2
  /** Plannerless worker produced no new finding for the configured number of passes. */
  | "stagnation-limit"
  /** A shared execution budget was exhausted; retrying cannot make progress. */
  | "budget-limit"
  | "cost-limit" // Req 6.2
  | "time-limit" // Req 7.2
  | "planning-failure" // Req 12.1
  /** Coverage queue could not prove that its get_summaries seed was complete. */
  | "coverage-seed-failure"
  /** Coverage search succeeded, but its server response could not prove provenance. */
  | "coverage-provenance-failure"
  | "exhausted" // Req 12.3 (all remaining targets failed)
  /**
   * All work settled, but the configured verifier never confirmed the result
   * within its attempt budget. Distinct from "completed" so a caller can tell an
   * unverified answer from a verified one, and distinct from "exhausted" because
   * the tasks themselves DID succeed.
   */
  | "verification-failed"
  /**
   * This harness was entered deeper than `maxDelegationDepth` allows. Reported
   * instead of silently running, so an over-deep hierarchy is visible in the
   * trace rather than showing up only as latency and spend.
   */
  | "depth-limit";

/** The full progress record persisted to AgentState.harness. */
export interface HarnessProgress {
  /** The ordered task list (plan + updates). */
  tasks: Task[];
  /** Number of loop iterations completed so far. */
  iterations: number;
  /** Accumulated cost in USD for this harness run. */
  cost: number;
  /** Set only once the run terminates. */
  stopReason?: StopReason;
  /** True when the run stopped before fully achieving the goal (Req 8.3). */
  partial?: boolean;
  /** Human-readable final status message (Req 8.3, 9.4). */
  statusMessage?: string;
  /** IDs of allowlist entries dropped as invalid (Req 2.3). */
  droppedTargets?: string[];
  /**
   * Allowlist entries refused because delegating to them would re-enter a
   * harness already on the stack (self-reference or a cycle). Reported
   * separately from {@link droppedTargets} because the cause is different: the
   * target EXISTS, it just may not be entered from here.
   */
  cyclicTargets?: string[];
  /** Nesting depth this harness ran at; 0 is the outermost. */
  depth?: number;
  /** Deterministic document coverage snapshot, present only when configured. */
  coverage?: CoverageLedger;
  /** Verification rounds run (absent when no gate is configured). */
  verificationRounds?: number;
  /**
   * Whether the verifier confirmed the result. `false` alongside
   * `stopReason: "verification-failed"` means the work ran but was rejected.
   */
  verified?: boolean;
}

/** Verification gate applied before a harness run may report "completed". */
export interface VerificationConfig {
  /**
   * Node id of the reviewer. Resolved from the node map SEPARATELY from the
   * allowlist: the planner must not be able to schedule the verifier as ordinary
   * work, or it could "verify" mid-run and consume the attempt budget.
   */
  target: string;
  /**
   * Exact trimmed verdict the reviewer emits to signal a pass
   * (case-insensitive). Any surrounding text is a rejection.
   *
   * A sentinel rather than a structured verdict for the same reason
   * `stopSignal` is one: a small local model reliably reproduces a fixed
   * marker, while a boolean field in JSON is one more thing for it to get
   * wrong — and a mis-parsed verdict would silently default to a failure and
   * burn the whole attempt budget.
   */
  passSignal: string;
  /**
   * How many verification rounds may run. Each failed round costs one verifier
   * delegation plus one re-plan, so this is a real budget. Default
   * {@link DEFAULT_VERIFICATION_ATTEMPTS}.
   */
  maxAttempts?: number;
  /**
   * When true, a missing or technically unavailable verifier rejects completion
   * instead of silently accepting an unverified result. Defaults to false for
   * backward compatibility; completeness-critical flows should enable it.
   */
  failClosed?: boolean;
}

export interface ProgressNarratorConfig {
  /** Explicit switch; defaults to true when the object is present. */
  enabled?: boolean;
  /** Small/fast model used only to phrase one bounded status line. */
  llm: LlmConfig;
  /** Per-call deadline. Narration failure never fails the harness. */
  timeoutMs?: number;
  /** Hard character ceiling applied after generation. */
  maxOutputChars?: number;
  /** Which explicitly labelled hypotheses may enter the sanitized DTO. */
  includeHypotheses?: {
    active?: boolean;
    confirmed?: boolean;
    rejected?: boolean;
  };
}

/** Validated configuration for an agent-harness node. */
export interface HarnessConfig {
  /** Delegation_Target IDs the harness may select (Req 2). Min length 1. */
  allowlist: string[];
  /** Hard cap on Execution_Loop iterations (Req 5). Default applied when absent. */
  maxIterations?: number;
  /** Optional accumulated-cost ceiling in USD (Req 6). */
  maxCost?: number;
  /** Optional wall-clock ceiling in milliseconds (Req 7). */
  maxTimeMs?: number;
  /** Target IDs that require approval before delegation (Req 11). */
  consequentialTargets?: string[];
  /**
   * Maximum harness NESTING depth below this one. 0 forbids delegating to
   * another harness entirely; the default
   * ({@link DEFAULT_MAX_DELEGATION_DEPTH}) admits a
   * coordinator → specialist → worker hierarchy.
   *
   * Required because `delegate()` resolves handlers by node type, so a harness
   * can target another harness — including itself. Without a bound, a
   * self-referential or cyclic allowlist recurses until the stack overflows.
   */
  maxDelegationDepth?: number;
  /**
   * Maximum tasks executed concurrently when the planner marks them
   * `parallelizable`. Defaults to {@link DEFAULT_MAX_CONCURRENT_TASKS}.
   *
   * A cap rather than unbounded fan-out because every concurrent task is a live
   * model call plus its tool traffic: an unbounded batch would multiply peak
   * memory, hit provider rate limits, and — on a single local inference server —
   * queue behind itself and end up SLOWER than running sequentially.
   */
  maxConcurrentTasks?: number;
  /**
   * How many times a failed task is retried before being recorded as failed.
   * 0 disables retries (the previous behaviour); default
   * {@link DEFAULT_MAX_TASK_ATTEMPTS}.
   *
   * Retrying matters because delegated workers fail for transient reasons —
   * a provider hiccup, a momentarily unavailable tool, an empty completion from
   * a local model — much more often than for reasons a re-plan can fix. Without
   * a retry, recovery depended on the planner deciding to try again, which costs
   * a planner call and often produced a reworded task that hit the same wall.
   */
  maxTaskAttempts?: number;
  /**
   * Optional verification gate applied before the run may report "completed".
   *
   * Without it the harness reports success as soon as every task settled — which
   * says the STEPS ran, not that the GOAL was met. A planner that decomposed the
   * request incorrectly, or workers that each answered something adjacent, both
   * produce a confidently wrong "completed". The gate delegates to a reviewer
   * node that sees the accumulated findings and must emit
   * {@link VerificationConfig.passSignal} for the run to count as complete;
   * otherwise its feedback is fed back into a re-plan.
   *
   * Mirrors Hermes's verification-stop / verify-hooks idea.
   */
  verification?: VerificationConfig;
  /** Optional planner LLM override; falls back to node.llm then appConfig.defaultLlm. */
  plannerLlm?: LlmConfig;
  /**
   * Optional evidence-based progress narration. The narrator sees only a
   * bounded DTO derived from completed findings and explicitly labelled
   * hypotheses, never raw model reasoning, messages, or tool payloads.
   */
  progressNarrator?: ProgressNarratorConfig;
  /**
   * How much of a completed delegation's output is carried into the context
   * that subsequent delegations and re-plans see:
   * - `"full"` (default): append the worker's ENTIRE message output (answer +
   *   any injected RAG/context and tool traffic). Legacy behaviour — simple
   *   but the shared context grows unbounded across iterations.
   * - `"condensed"`: carry forward ONLY a single condensed finding per task
   *   (the worker's final answer text), never its raw output. The context per
   *   iteration then grows by one bounded finding instead of the whole worker
   *   transcript — required for long research loops over large corpora.
   */
  carryForward?: "full" | "condensed";
  /**
   * How completed delegation results are returned by the harness:
   * - `"delegated"` (default): preserve the delegated assistant messages. Use
   *   this when the harness itself is the user-facing end node.
   * - `"context"`: return one aggregated, task-marker-free assistant message
   *   for a downstream synthesizer. Worker findings remain internal context and
   *   cannot surface as several competing final answers.
   */
  resultMode?: "delegated" | "context";
  /**
   * Whether visible token and reasoning events from delegated workers are sent
   * to the client. Defaults to `true` for backward compatibility. Set to
   * `false` for orchestrator/researcher flows where only a later synthesizer
   * should produce user-visible output; worker findings still remain available
   * in the harness state for downstream nodes.
   */
  streamDelegates?: boolean;
  /**
   * Optional deterministic stop signal. When a completed delegation's finding
   * text contains this substring (case-insensitive), the loop stops
   * immediately with reason "completed" — WITHOUT spending another planner
   * re-plan call to discover there is nothing left to do. Lets a self-directed
   * worker end the run by emitting a sentinel (e.g. "RECHERCHE VOLLSTAENDIG").
   * Absent → prior behaviour (the planner decides on every re-plan).
   */
  stopSignal?: string;
  /** Required line-prefix markers for a worker result to count as a finding. */
  requiredFindingMarkers?: string[];
  /**
   * Plannerless loop mode. When `true`, the harness SKIPS all LLM planner
   * calls (initial plan + every re-plan) and delegates repeatedly without a
   * planner. Generic plannerless loops use the first allowlist target. Coverage
   * queues may override that target per assignment mode via
   * `coverageQueue.targets`; every configured target must also be allowlisted.
   * Missing mode overrides fall back to the first allowlist target.
   */
  plannerless?: boolean;
  /**
   * Consecutive plannerless passes allowed without a unique condensed finding.
   * When reached, the harness stops with `stagnation-limit` and preserves all
   * findings collected so far for downstream synthesis. Absent disables this
   * progress guard for backward compatibility.
   */
  maxStagnantIterations?: number;
  /** Deterministic plannerless document coverage queue. */
  coverageQueue?: CoverageQueueConfig;
  /**
   * Maximum characters from stable user/system context and verifier feedback
   * passed to a coverage worker. The private assignment is added separately.
   * Prior worker findings and the global RAG overview are intentionally absent:
   * the deterministic assignment is the worker's complete authority.
   */
  coverageWorkerContextMaxChars?: number;
  /**
   * Hard character ceiling for the complete verifier state (request context,
   * compacted findings and the mandatory sanitized ledger manifest).
   */
  verificationContextMaxChars?: number;
  /** Per-finding carry-forward cap; defaults to 6000 characters. */
  condensedFindingMaxChars?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default maximum iterations applied when no `maxIterations` is specified in
 * the node config (Req 5.3).
 */
export const DEFAULT_MAX_ITERATIONS = 12;

/**
 * Default concurrency for `parallelizable` tasks. Matches Hermes's
 * `delegation.max_concurrent_children`. Three is a deliberate compromise: enough
 * to overlap the latency of independent research steps, low enough that a single
 * local inference server is not thrashed by requests that then queue behind each
 * other.
 */
export const DEFAULT_MAX_CONCURRENT_TASKS = 3;

/** Hard ceiling on concurrency regardless of configuration. */
export const MAX_ALLOWED_CONCURRENT_TASKS = 8;

// ---------------------------------------------------------------------------
// Batch scheduling
// ---------------------------------------------------------------------------

/**
 * Selects the next batch of tasks to execute.
 *
 * Rules, in order:
 *  1. Only `pending` tasks are eligible, scanned in list order (the planner's
 *     order is the intended execution order).
 *  2. The FIRST eligible task is always taken — the loop must always make
 *     progress, even when nothing is parallelizable.
 *  3. Further tasks join the batch only while BOTH the first task and the
 *     candidate are `parallelizable`, they are CONTIGUOUS in the pending
 *     sequence, and the batch is below `maxConcurrent`.
 *  4. A task requiring approval is never batched with others — it is returned
 *     alone. Approval is an interactive pause, and interleaving several prompts
 *     from one batch would present the user with concurrent, unordered requests.
 *  5. A candidate whose `target` is ALREADY in the batch is a barrier, unless
 *     `options.allowSameTarget`: each delegation then runs as its own instance
 *     (see graph-engine/node-instance.ts), so the per-node execution state is
 *     no longer shared. Without that option, two concurrent delegations to the
 *     same node are not parallelism — the node is a single resource, and the
 *     engine's per-node execution state (streaming guardrail buffer, chunk ids,
 *     start time, model, token counts, prompt and response capture) is keyed by
 *     node id alone. Running one node twice at once therefore interleaves two
 *     token streams through one guardrail buffer (producing corrupted text),
 *     overwrites the timing/model bookkeeping, and fires the node's completion
 *     event twice. The tasks still both run — just in consecutive batches
 *     instead of simultaneously.
 *
 * Contiguity matters: a non-parallelizable task acts as a barrier, so tasks
 * after it must not be pulled forward past work they may depend on.
 *
 * Returns an empty array when no task is pending.
 */
export function selectTaskBatch(
  tasks: Task[],
  maxConcurrent: number,
  requiresApproval: (task: Task) => boolean = () => false,
  options?: { allowSameTarget?: boolean },
): Task[] {
  const cap = Math.max(1, Math.floor(maxConcurrent));
  const pending = tasks.filter((t) => t.status === "pending");
  const first = pending[0];
  if (first === undefined) return [];

  // Approval-gated work runs alone (rule 4).
  if (requiresApproval(first)) return [first];
  // A non-parallelizable head is a barrier (rule 3).
  if (first.parallelizable !== true) return [first];

  const batch: Task[] = [first];
  const targetsInBatch = new Set<string>([first.target]);
  for (const candidate of pending.slice(1)) {
    if (batch.length >= cap) break;
    if (candidate.parallelizable !== true) break; // barrier
    if (requiresApproval(candidate)) break; // must run alone
    // Rule 5: the same node must not run twice concurrently, unless
    // options.allowSameTarget: each delegation then runs as its own instance
    // (see graph-engine/node-instance.ts).
    if (
      options?.allowSameTarget !== true &&
      targetsInBatch.has(candidate.target)
    ) {
      break;
    }
    batch.push(candidate);
    targetsInBatch.add(candidate.target);
  }
  return batch;
}

/** Clamps a configured concurrency into `[1, MAX_ALLOWED_CONCURRENT_TASKS]`. */
export function resolveMaxConcurrentTasks(
  configured: number | undefined,
): number {
  if (
    configured === undefined ||
    !Number.isFinite(configured) ||
    configured < 1
  ) {
    return DEFAULT_MAX_CONCURRENT_TASKS;
  }
  return Math.min(Math.floor(configured), MAX_ALLOWED_CONCURRENT_TASKS);
}

/**
 * Default retry count for a failed task: OFF.
 *
 * Deliberately opt-in rather than on-by-default. Requirement 4.6 specifies that a
 * failed delegation fails the task and the loop continues, and the property suite
 * asserts exactly that — silently retrying would contradict an agreed contract
 * and double the worst-case cost for a target that is genuinely broken rather than
 * flaky. Flows that want the robustness set `config.maxTaskAttempts` explicitly
 * (a local-model agent branch typically does).
 */
export const DEFAULT_MAX_TASK_ATTEMPTS = 0;

/** Hard ceiling on retries per task. */
export const MAX_ALLOWED_TASK_ATTEMPTS = 3;

/**
 * Clamps a configured retry count into `[0, MAX_ALLOWED_TASK_ATTEMPTS]`.
 * 0 is meaningful (retries disabled) and must not be treated as absent.
 */
/**
 * Default verification rounds. One round means: verify, and if it fails, re-plan
 * once and verify again. More rounds rarely help — a reviewer that rejected twice
 * is usually pointing at a goal the available targets cannot satisfy.
 */
export const DEFAULT_VERIFICATION_ATTEMPTS = 1;

/** Hard ceiling on verification rounds. */
export const MAX_ALLOWED_VERIFICATION_ATTEMPTS = 3;

/** Clamps configured verification rounds into `[1, MAX_ALLOWED_…]`. */
export function resolveVerificationAttempts(
  configured: number | undefined,
): number {
  if (
    configured === undefined ||
    !Number.isFinite(configured) ||
    configured < 1
  ) {
    return DEFAULT_VERIFICATION_ATTEMPTS;
  }
  return Math.min(Math.floor(configured), MAX_ALLOWED_VERIFICATION_ATTEMPTS);
}

/**
 * Reads a raw `config.verification` record into a {@link VerificationConfig}, or
 * `undefined` when it is absent or unusable.
 *
 * Both `target` and `passSignal` are mandatory: a gate without a pass signal
 * could never pass, which would turn every run into `verification-failed` — worse
 * than having no gate at all. An incomplete config is therefore treated as
 * "no gate" rather than as an empty gate.
 */
export function parseVerificationConfig(
  raw: unknown,
): VerificationConfig | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const target = record.target;
  const passSignal = record.passSignal;
  if (typeof target !== "string" || target.trim() === "") return undefined;
  if (typeof passSignal !== "string" || passSignal.trim() === "") {
    return undefined;
  }
  const result: VerificationConfig = {
    target: target.trim(),
    passSignal: passSignal.trim(),
  };
  if (
    typeof record.maxAttempts === "number" &&
    Number.isFinite(record.maxAttempts) &&
    record.maxAttempts >= 1
  ) {
    result.maxAttempts = Math.floor(record.maxAttempts);
  }
  if (record.failClosed === true) result.failClosed = true;
  return result;
}

export function resolveMaxTaskAttempts(configured: number | undefined): number {
  if (
    configured === undefined ||
    !Number.isFinite(configured) ||
    configured < 0
  ) {
    return DEFAULT_MAX_TASK_ATTEMPTS;
  }
  return Math.min(Math.floor(configured), MAX_ALLOWED_TASK_ATTEMPTS);
}

// ---------------------------------------------------------------------------
// State reducer — mergeHarnessProgress
// ---------------------------------------------------------------------------

/**
 * LangGraph Annotation reducer for the `harness` state field.
 *
 * Merges two {@link HarnessProgress} snapshots:
 * - Tasks are merged by `id`: a right-side task replaces a left-side task with
 *   the same id; new ids from the right are appended preserving order.
 * - Scalar progress fields (`iterations`, `cost`, `stopReason`, `partial`,
 *   `statusMessage`, `droppedTargets`) take the right (newer) value when
 *   defined.
 * - `right === undefined` is treated as identity (returns `left` unchanged).
 *
 * The reducer is idempotent for repeated identical updates.
 *
 * @param left  - The current accumulated progress (may be `undefined` at start).
 * @param right - The incoming progress snapshot from the latest handler update.
 * @returns The merged progress, or `undefined` if both inputs are `undefined`.
 *
 * _Validates: Requirements 10.1, 10.2_
 */
export function mergeHarnessProgress(
  left: HarnessProgress | undefined,
  right: HarnessProgress | undefined,
): HarnessProgress | undefined {
  if (right === undefined) return left;
  if (left === undefined) return right;

  // Merge tasks by id: right-side task replaces the left-side task with the
  // same id; new ids are appended preserving order.
  const byId = new Map(left.tasks.map((t) => [t.id, t]));
  for (const t of right.tasks) byId.set(t.id, t);

  return {
    tasks: [...byId.values()],
    iterations: right.iterations,
    cost: right.cost,
    ...(right.stopReason !== undefined ? { stopReason: right.stopReason } : {}),
    ...(right.partial !== undefined ? { partial: right.partial } : {}),
    ...(right.statusMessage !== undefined
      ? { statusMessage: right.statusMessage }
      : {}),
    ...(right.droppedTargets !== undefined
      ? { droppedTargets: right.droppedTargets }
      : {}),
    ...(right.cyclicTargets !== undefined
      ? { cyclicTargets: right.cyclicTargets }
      : {}),
    ...(right.depth !== undefined ? { depth: right.depth } : {}),
    ...(right.coverage !== undefined ? { coverage: right.coverage } : {}),
    ...(right.verificationRounds !== undefined
      ? { verificationRounds: right.verificationRounds }
      : {}),
    ...(right.verified !== undefined ? { verified: right.verified } : {}),
  };
}

// ---------------------------------------------------------------------------
// Allowlist resolution
// ---------------------------------------------------------------------------

/**
 * Intersects the configured allowlist with the keys of the compiled node map.
 *
 * Entries present in `nodeMap` become the selectable target set (`valid`);
 * absent entries are collected into `dropped` for error reporting.
 * Both arrays preserve the original declaration order from the allowlist.
 *
 * @param allowlist - Target IDs declared in `HarnessConfig.allowlist`.
 * @param nodeMap   - The compiled flow's `Map<string, FlowNode>`.
 * @returns `{ valid, dropped }` — the partitioned allowlist.
 *
 * _Validates: Requirements 2.3, 2.4_
 */
export function resolveAllowlist(
  allowlist: string[],
  nodeMap: Map<string, FlowNode>,
): { valid: string[]; dropped: string[] } {
  const valid: string[] = [];
  const dropped: string[] = [];

  for (const entry of allowlist) {
    if (nodeMap.has(entry)) {
      valid.push(entry);
    } else {
      dropped.push(entry);
    }
  }

  return { valid, dropped };
}

// ---------------------------------------------------------------------------
// Plan normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes raw Planner output into a validated Task list.
 *
 * Each `{description, target}` item is mapped to a full {@link Task} with a
 * stable sequential id (`t1`, `t2`, ...) and status `"pending"`. Items whose
 * `target` is not present in `validTargets` are silently dropped — this is the
 * defense-in-depth check ensuring only allowlisted nodes can be delegated to,
 * even if the Planner hallucinates an invalid target (Req 2.4).
 *
 * IDs are assigned only to retained tasks, so dropped entries do not consume
 * sequence numbers.
 *
 * @param planResponse  - Raw Planner output: an array of `{description, target}`.
 * @param validTargets  - The validated allowlist subset (output of `resolveAllowlist`).
 * @returns An ordered array of {@link Task} objects ready for the Execution_Loop.
 *
 * _Validates: Requirements 3.1, 3.2, 2.4_
 */
export function normalize(
  planResponse: Array<{
    description: string;
    target: string;
    parallelizable?: unknown;
  }>,
  validTargets: string[],
  /**
   * Sequence offset for generated ids. Re-plans pass the number of ids already
   * issued so a new pending task cannot collide with a settled one — task ids
   * are the merge key in {@link mergeHarnessProgress}, and a collision would
   * silently overwrite the historical record of a completed task.
   */
  idOffset = 0,
): Task[] {
  const validSet = new Set(validTargets);
  const tasks: Task[] = [];
  let seq = Math.max(0, Math.floor(idOffset)) + 1;

  for (const item of planResponse) {
    if (!validSet.has(item.target)) continue;
    tasks.push({
      id: `t${seq}`,
      displayStep: tasks.length + 1,
      description: item.description,
      target: item.target,
      status: "pending",
      // Only a literal `true` enables concurrency. A planner emitting the string
      // "true", 1, or nothing at all yields the safe sequential default.
      ...(item.parallelizable === true ? { parallelizable: true } : {}),
    });
    seq++;
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Re-plan merge
// ---------------------------------------------------------------------------

/**
 * Merges re-plan output into the current task list.
 *
 * Settled tasks (`completed` or `failed`) are preserved unchanged and in their
 * original relative order. All unsettled tasks (`pending` or `in-progress`) are
 * discarded and replaced by `replanTasks`, which become the new pending region
 * appended after the settled prefix.
 *
 * This ensures the Planner can reorganize, add, or remove pending work without
 * affecting the historical record of what has already been executed.
 *
 * @param currentTasks - The current task list (may contain any mix of statuses).
 * @param replanTasks  - The new pending tasks produced by re-plan normalization.
 * @returns A new task array: settled tasks in original order + replanTasks appended.
 *
 * _Validates: Requirements 4.4_
 */
export function mergeReplan(currentTasks: Task[], replanTasks: Task[]): Task[] {
  const settled = currentTasks.filter(
    (t) => t.status === "completed" || t.status === "failed",
  );
  return [
    ...settled,
    ...replanTasks.map((task, index) => ({
      ...task,
      // The id remains unique for state merges, while the visible step follows
      // the settled history so a replacement for pending t2 is shown as step 2.
      displayStep: settled.length + index + 1,
      replanned: true,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Limit-check scheduler
// ---------------------------------------------------------------------------

/**
 * Checks whether any configured limit has been reached BEFORE starting the
 * next task iteration. Returns the triggering {@link StopReason} if a limit is
 * hit, or `undefined` if execution may continue.
 *
 * Checks are evaluated in priority order:
 * 1. **Iteration limit** — `progress.iterations >= (cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS)`
 * 2. **Cost limit** — `cfg.maxCost` defined and `progress.cost >= cfg.maxCost`
 * 3. **Time limit** — `cfg.maxTimeMs` defined and elapsed time >= threshold
 *
 * The function is pure (no side effects beyond optionally invoking the clock)
 * and accepts an injectable `now` parameter for deterministic testing.
 *
 * @param progress  - Current harness progress (iterations and cost so far).
 * @param cfg       - The harness configuration (limits).
 * @param startTime - The timestamp (ms) when the harness loop started.
 * @param now       - Clock function returning current time in ms. Defaults to `Date.now`.
 * @returns The triggering `StopReason` or `undefined` if no limit is reached.
 *
 * _Validates: Requirements 5.1, 5.2, 5.3, 6.1, 6.2, 7.1, 7.2, 12.3_
 */
export function checkLimits(
  progress: HarnessProgress,
  cfg: HarnessConfig,
  startTime: number,
  now: () => number = Date.now,
): StopReason | undefined {
  // 1. Iteration limit (default applied when maxIterations absent)
  const maxIterations = cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (progress.iterations >= maxIterations) {
    return "iteration-limit";
  }

  // 2. Cost limit (only checked when configured)
  if (cfg.maxCost !== undefined && progress.cost >= cfg.maxCost) {
    return "cost-limit";
  }

  // 3. Time limit (only checked when configured; uses injectable clock)
  if (cfg.maxTimeMs !== undefined && now() - startTime >= cfg.maxTimeMs) {
    return "time-limit";
  }

  // No limit reached — execution may continue
  return undefined;
}

// ---------------------------------------------------------------------------
// Task-list rendering (Component 9 — streaming visibility)
// ---------------------------------------------------------------------------

/**
 * Status indicator characters for task list rendering.
 */
const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "○",
  "in-progress": "◉",
  completed: "✓",
  failed: "✗",
};

/**
 * Renders the task list as a human-readable markdown-style checklist with
 * status indicators for streaming to the client via `onReasoning`.
 *
 * Each task is rendered as a single line with a status icon, technical id,
 * visible step number, description, and target. This gives the end-user a
 * clear picture of progress without exposing re-plan ID gaps as step gaps.
 *
 * @param tasks - The current task list to render.
 * @returns A multi-line string suitable for emission via `runtime.onReasoning`.
 *
 * _Validates: Requirements 9.1_
 */
export function formatTaskReference(task: Task): string {
  const fallbackStep = Number.parseInt(task.id.slice(1), 10);
  const displayStep =
    task.displayStep ?? (Number.isFinite(fallbackStep) ? fallbackStep : 1);
  return `${task.id} · step ${displayStep}${task.replanned ? " (replanned)" : ""}`;
}

export function renderTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return "(no tasks)";
  return tasks
    .map(
      (t) =>
        `${STATUS_ICON[t.status]} ${formatTaskReference(t)}: ${t.description} → ${t.target}` +
        (t.researchStatus === undefined ? "" : `\n  Status: ${t.researchStatus}`),
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Parses `coverageQueue.summaryTriage`. Defense in depth next to the zod
 * schema: any invalid mode or threshold degrades to `mode: "llm"` with default
 * thresholds — never to a deterministic exclusion.
 */
export function parseSummaryTriageConfig(
  raw: Record<string, unknown>,
): CoverageSummaryTriageConfig {
  const share = (value: unknown, fallback: number): number | undefined =>
    value === undefined
      ? fallback
      : typeof value === "number" &&
          Number.isFinite(value) &&
          value > 0 &&
          value < 1
        ? value
        : undefined;
  const queries = Array.isArray(raw.queries)
    ? raw.queries
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim() !== "",
        )
        .slice(0, MAX_SUMMARY_TRIAGE_QUERIES)
    : [];
  const rerankOrder = raw.rerankOrder !== false;
  const acceptTopK = share(raw.acceptTopK, DEFAULT_SUMMARY_TRIAGE_ACCEPT_TOP_K);
  const excludeBelowRank = share(
    raw.excludeBelowRank,
    DEFAULT_SUMMARY_TRIAGE_EXCLUDE_BELOW_RANK,
  );
  const excludeMaxScore =
    raw.excludeMaxScore === undefined
      ? DEFAULT_SUMMARY_TRIAGE_EXCLUDE_MAX_SCORE
      : typeof raw.excludeMaxScore === "number" &&
          Number.isFinite(raw.excludeMaxScore) &&
          raw.excludeMaxScore >= 0 &&
          raw.excludeMaxScore <= 1
        ? raw.excludeMaxScore
        : undefined;
  const mode =
    raw.mode === undefined
      ? "llm"
      : raw.mode === "llm" || raw.mode === "hybrid" || raw.mode === "rerank"
        ? raw.mode
        : undefined;
  const effectiveQueries =
    queries.length > 0 ? queries : [...DEFAULT_SUMMARY_TRIAGE_QUERIES];
  const problems: string[] = [];
  if (mode === undefined) problems.push(`invalid mode '${String(raw.mode)}'`);
  if (acceptTopK === undefined) {
    problems.push(`invalid acceptTopK '${String(raw.acceptTopK)}'`);
  }
  if (excludeBelowRank === undefined) {
    problems.push(`invalid excludeBelowRank '${String(raw.excludeBelowRank)}'`);
  }
  if (excludeMaxScore === undefined) {
    problems.push(`invalid excludeMaxScore '${String(raw.excludeMaxScore)}'`);
  }
  if (
    acceptTopK !== undefined &&
    excludeBelowRank !== undefined &&
    acceptTopK >= excludeBelowRank
  ) {
    problems.push("acceptTopK >= excludeBelowRank");
  }
  if (
    mode === undefined ||
    acceptTopK === undefined ||
    excludeBelowRank === undefined ||
    excludeMaxScore === undefined ||
    problems.length > 0
  ) {
    return {
      mode: "llm",
      rerankOrder,
      acceptTopK: DEFAULT_SUMMARY_TRIAGE_ACCEPT_TOP_K,
      excludeBelowRank: DEFAULT_SUMMARY_TRIAGE_EXCLUDE_BELOW_RANK,
      excludeMaxScore: DEFAULT_SUMMARY_TRIAGE_EXCLUDE_MAX_SCORE,
      queries: effectiveQueries,
      configError: problems.join("; "),
    };
  }
  return {
    mode,
    rerankOrder,
    acceptTopK,
    excludeBelowRank,
    excludeMaxScore,
    queries: effectiveQueries,
  };
}

/**
 * Reads a validated `node.config` record into a typed {@link HarnessConfig}.
 *
 * This function assumes the record has already passed the Zod
 * `HarnessConfigSchema` validation at flow-parse time (Req 1.2). It performs a
 * typed read of the known fields with sensible defensive defaults so the
 * handler logic never touches raw `unknown` values.
 *
 * @param config - The `node.config` record from a `FlowNode` with
 *   `type === "agent-harness"`. May be `undefined` if somehow missing.
 * @returns A fully typed `HarnessConfig`. Fields absent from the record are
 *   omitted from the result (the handler applies defaults like
 *   `DEFAULT_MAX_ITERATIONS` at runtime).
 */
export function parseHarnessConfig(
  config: Record<string, unknown> | undefined,
): HarnessConfig {
  if (!config) {
    return { allowlist: [] };
  }

  const allowlist = Array.isArray(config.allowlist)
    ? (config.allowlist as string[]).filter(
        (entry) => typeof entry === "string" && entry.length > 0,
      )
    : [];

  const result: HarnessConfig = { allowlist };

  if (
    typeof config.maxIterations === "number" &&
    Number.isFinite(config.maxIterations) &&
    config.maxIterations > 0
  ) {
    result.maxIterations = config.maxIterations;
  }

  if (
    typeof config.maxCost === "number" &&
    Number.isFinite(config.maxCost) &&
    config.maxCost > 0
  ) {
    result.maxCost = config.maxCost;
  }

  if (
    typeof config.maxTimeMs === "number" &&
    Number.isFinite(config.maxTimeMs) &&
    config.maxTimeMs > 0
  ) {
    result.maxTimeMs = config.maxTimeMs;
  }

  if (Array.isArray(config.consequentialTargets)) {
    const targets = (config.consequentialTargets as string[]).filter(
      (entry) => typeof entry === "string" && entry.length > 0,
    );
    if (targets.length > 0) {
      result.consequentialTargets = targets;
    }
  }

  if (config.plannerLlm && typeof config.plannerLlm === "object") {
    const llm = config.plannerLlm as Record<string, unknown>;
    if (typeof llm.provider === "string" && typeof llm.model === "string") {
      result.plannerLlm = config.plannerLlm as LlmConfig;
    }
  }

  if (config.progressNarrator && typeof config.progressNarrator === "object") {
    const raw = config.progressNarrator as Record<string, unknown>;
    const llm = raw.llm;
    if (llm && typeof llm === "object") {
      const llmRecord = llm as Record<string, unknown>;
      if (
        typeof llmRecord.provider === "string" &&
        typeof llmRecord.model === "string"
      ) {
        const narrator: ProgressNarratorConfig = {
          llm: llm as LlmConfig,
          ...(raw.enabled === false ? { enabled: false } : {}),
        };
        if (
          typeof raw.timeoutMs === "number" &&
          Number.isInteger(raw.timeoutMs) &&
          raw.timeoutMs >= 1000 &&
          raw.timeoutMs <= 120000
        ) {
          narrator.timeoutMs = raw.timeoutMs;
        }
        if (
          typeof raw.maxOutputChars === "number" &&
          Number.isInteger(raw.maxOutputChars) &&
          raw.maxOutputChars >= 80 &&
          raw.maxOutputChars <= 500
        ) {
          narrator.maxOutputChars = raw.maxOutputChars;
        }
        if (
          raw.includeHypotheses &&
          typeof raw.includeHypotheses === "object"
        ) {
          const hypotheses = raw.includeHypotheses as Record<string, unknown>;
          narrator.includeHypotheses = {
            ...(typeof hypotheses.active === "boolean"
              ? { active: hypotheses.active }
              : {}),
            ...(typeof hypotheses.confirmed === "boolean"
              ? { confirmed: hypotheses.confirmed }
              : {}),
            ...(typeof hypotheses.rejected === "boolean"
              ? { rejected: hypotheses.rejected }
              : {}),
          };
        }
        result.progressNarrator = narrator;
      }
    }
  }

  if (config.carryForward === "condensed" || config.carryForward === "full") {
    result.carryForward = config.carryForward;
  }

  if (config.resultMode === "delegated" || config.resultMode === "context") {
    result.resultMode = config.resultMode;
  }

  // `true` is the legacy default and therefore need not be materialized. Only
  // retain the explicit opt-out, keeping omitted or malformed values safe.
  if (config.streamDelegates === false) {
    result.streamDelegates = false;
  }

  if (
    typeof config.stopSignal === "string" &&
    config.stopSignal.trim().length > 0
  ) {
    result.stopSignal = config.stopSignal.trim();
  }

  if (Array.isArray(config.requiredFindingMarkers)) {
    const markers = config.requiredFindingMarkers
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
      .map((entry) => entry.trim());
    if (markers.length > 0) result.requiredFindingMarkers = markers;
  }

  if (config.plannerless === true) {
    result.plannerless = true;
  }

  if (
    typeof config.maxStagnantIterations === "number" &&
    Number.isInteger(config.maxStagnantIterations) &&
    config.maxStagnantIterations >= 1 &&
    config.maxStagnantIterations <= 20
  ) {
    result.maxStagnantIterations = config.maxStagnantIterations;
  }

  if (
    typeof config.condensedFindingMaxChars === "number" &&
    Number.isInteger(config.condensedFindingMaxChars) &&
    config.condensedFindingMaxChars >= 6000 &&
    config.condensedFindingMaxChars <= 30000
  ) {
    result.condensedFindingMaxChars = config.condensedFindingMaxChars;
  }

  if (
    typeof config.coverageWorkerContextMaxChars === "number" &&
    Number.isInteger(config.coverageWorkerContextMaxChars) &&
    config.coverageWorkerContextMaxChars >= 16000 &&
    config.coverageWorkerContextMaxChars <= 300000
  ) {
    result.coverageWorkerContextMaxChars =
      config.coverageWorkerContextMaxChars;
  }

  if (
    typeof config.verificationContextMaxChars === "number" &&
    Number.isInteger(config.verificationContextMaxChars) &&
    config.verificationContextMaxChars >= 32000 &&
    config.verificationContextMaxChars <= 500000
  ) {
    result.verificationContextMaxChars = config.verificationContextMaxChars;
  }

  if (config.coverageQueue && typeof config.coverageQueue === "object") {
    const raw = config.coverageQueue as Record<string, unknown>;
    const markers =
      raw.markers && typeof raw.markers === "object"
        ? (raw.markers as Record<string, unknown>)
        : undefined;
    const start =
      typeof markers?.start === "string" && markers.start.trim() !== ""
        ? markers.start
        : "<COVERAGE_REPORT>";
    const end =
      typeof markers?.end === "string" && markers.end.trim() !== ""
        ? markers.end
        : "</COVERAGE_REPORT>";
    if (
      raw.enabled === true &&
      typeof raw.sourceTool === "string" &&
      raw.sourceTool.trim() !== "" &&
      start !== end
    ) {
      const boundedInt = (
        value: unknown,
        min: number,
        max: number,
        fallback: number,
      ): number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= min &&
        value <= max
          ? value
          : fallback;
      const hybridSearch =
        raw.hybridSearch && typeof raw.hybridSearch === "object"
          ? (raw.hybridSearch as Record<string, unknown>)
          : undefined;
      const searchDiscovery =
        raw.searchDiscovery && typeof raw.searchDiscovery === "object"
          ? (raw.searchDiscovery as Record<string, unknown>)
          : undefined;
      const rawTargets =
        raw.targets && typeof raw.targets === "object"
          ? (raw.targets as Record<string, unknown>)
          : undefined;
      const targets =
        rawTargets === undefined
          ? undefined
          : Object.fromEntries(
              (["summary", "discovery", "original"] as const).flatMap(
                (mode) => {
                  const target = rawTargets[mode];
                  return typeof target === "string" && target.trim() !== ""
                    ? [[mode, target.trim()] as const]
                    : [];
                },
              ),
            );
      result.coverageQueue = {
        enabled: true,
        ...(raw.mode === "staged" || raw.mode === "legacy"
          ? { mode: raw.mode }
          : {}),
        ...(targets !== undefined && Object.keys(targets).length > 0
          ? { targets }
          : {}),
        sourceTool: raw.sourceTool.trim(),
        batchSize: boundedInt(raw.batchSize, 1, 100, 20),
        lanes: boundedInt(raw.lanes, 1, 8, 1),
        maxOriginalsPerBatch: boundedInt(raw.maxOriginalsPerBatch, 1, 10, 3),
        assignmentCharBudget: boundedInt(
          raw.assignmentCharBudget,
          1000,
          100000,
          20000,
        ),
        documentWindowChars: boundedInt(
          raw.documentWindowChars,
          1000,
          100000,
          20000,
        ),
        ...(hybridSearch !== undefined
          ? {
              hybridSearch: {
                minDistinctQueries: boundedInt(
                  hybridSearch.minDistinctQueries,
                  2,
                  10,
                  2,
                ),
                requireHydeVariants:
                  hybridSearch.requireHydeVariants === true,
                requireGroupedResults:
                  hybridSearch.requireGroupedResults === true,
                requireReranking: hybridSearch.requireReranking === true,
                requireEffectiveHyde:
                  hybridSearch.requireEffectiveHyde === true,
              },
            }
          : {}),
        ...(searchDiscovery !== undefined
          ? {
              searchDiscovery: {
                rounds: boundedInt(searchDiscovery.rounds, 1, 10, 1),
                maxAttemptsPerRound: boundedInt(
                  searchDiscovery.maxAttemptsPerRound,
                  1,
                  10,
                  3,
                ),
                maxHitsPerPass: boundedInt(
                  searchDiscovery.maxHitsPerPass,
                  1,
                  100,
                  10,
                ),
                ...(typeof searchDiscovery.rerankScoreThreshold === "number" &&
                Number.isFinite(searchDiscovery.rerankScoreThreshold) &&
                searchDiscovery.rerankScoreThreshold >= 0 &&
                searchDiscovery.rerankScoreThreshold <= 1
                  ? {
                      rerankScoreThreshold:
                        searchDiscovery.rerankScoreThreshold,
                    }
                  : {}),
                maxExpansionRounds: boundedInt(
                  searchDiscovery.maxExpansionRounds,
                  0,
                  2,
                  0,
                ),
                ...(typeof searchDiscovery.maxExpansionSeeds === "number" &&
                Number.isInteger(searchDiscovery.maxExpansionSeeds) &&
                searchDiscovery.maxExpansionSeeds >= 1 &&
                searchDiscovery.maxExpansionSeeds <= 100
                  ? { maxExpansionSeeds: searchDiscovery.maxExpansionSeeds }
                  : {}),
                ...(typeof searchDiscovery.maxQueriesPerExpansionRound === "number" &&
                Number.isInteger(searchDiscovery.maxQueriesPerExpansionRound) &&
                searchDiscovery.maxQueriesPerExpansionRound >= 1 &&
                searchDiscovery.maxQueriesPerExpansionRound <= 20
                  ? {
                      maxQueriesPerExpansionRound:
                        searchDiscovery.maxQueriesPerExpansionRound,
                    }
                  : {}),
                ...(typeof searchDiscovery.maxCandidates === "number" &&
                Number.isInteger(searchDiscovery.maxCandidates) &&
                searchDiscovery.maxCandidates >= 1 &&
                searchDiscovery.maxCandidates <= 10000
                  ? { maxCandidates: searchDiscovery.maxCandidates }
                  : {}),
              },
            }
          : {}),
        markers: { start, end },
        ...(raw.structuredReport === true ? { structuredReport: true } : {}),
        ...(raw.summaryTriage !== null && typeof raw.summaryTriage === "object"
          ? {
              summaryTriage: parseSummaryTriageConfig(
                raw.summaryTriage as Record<string, unknown>,
              ),
            }
          : {}),
      };
    }
  }

  // 0 is meaningful here (forbid nesting entirely), so the guard checks for a
  // non-negative integer rather than truthiness.
  if (
    typeof config.maxDelegationDepth === "number" &&
    Number.isFinite(config.maxDelegationDepth) &&
    config.maxDelegationDepth >= 0
  ) {
    result.maxDelegationDepth = Math.floor(config.maxDelegationDepth);
  }

  if (
    typeof config.maxConcurrentTasks === "number" &&
    Number.isFinite(config.maxConcurrentTasks) &&
    config.maxConcurrentTasks >= 1
  ) {
    result.maxConcurrentTasks = Math.floor(config.maxConcurrentTasks);
  }

  // 0 is meaningful (retries disabled), so this checks for non-negative.
  if (
    typeof config.maxTaskAttempts === "number" &&
    Number.isFinite(config.maxTaskAttempts) &&
    config.maxTaskAttempts >= 0
  ) {
    result.maxTaskAttempts = Math.floor(config.maxTaskAttempts);
  }

  const verification = parseVerificationConfig(config.verification);
  if (verification !== undefined) {
    result.verification = verification;
  }

  return result;
}
