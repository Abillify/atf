// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Runtime canary rollout with auto-rollback (`src/graph/canary.ts`)
 *
 * Promotes the eval harness from a CI gate to a *continuous* quality guard. A
 * deployment routes a configurable fraction of live traffic for a flow to a
 * candidate version (a different flow id — e.g. a new prompt/model). Each run's
 * outcome (error / latency / optional LLM-judge score) is recorded per variant.
 * When the candidate has gathered enough samples and its quality regresses
 * versus the stable variant (higher error rate or lower mean score), the
 * manager automatically rolls back: all subsequent traffic returns to stable.
 *
 * Design:
 *   - Policy is a declarative `flows/canary.json`, hot-reloaded like
 *     `dispatch.json` (validated with Zod; a bad file disables canary, never
 *     crashes).
 *   - Variant selection is deterministic per routing key (hash → bucket) so a
 *     given conversation stays on one variant, and is pure/seedable for tests.
 *   - The statistics + rollback decision ({@link CanaryStats},
 *     {@link evaluateRollback}) are pure and unit-tested without any timers.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import { z } from "zod";
import type { Logger } from "../observability/logger.js";
import { parseFlowFile, resolveConfigFile } from "../util/parse-flow-file.js";

const CANARY_FILE = "canary";

// ---------------------------------------------------------------------------
// Policy schema
// ---------------------------------------------------------------------------

const CanaryDeploymentSchema = z.object({
  /** The flow id clients request and that stable traffic resolves to. */
  flow: z.string().min(1),
  /** The candidate flow id that canary traffic is routed to. */
  candidate: z.string().min(1),
  /** Percentage of traffic (0–100) sent to the candidate. */
  trafficPercent: z.number().min(0).max(100),
  /** Minimum candidate samples before a rollback can trigger. Default 20. */
  minSamples: z.number().int().min(1).max(100000).optional(),
  /** Roll back when candidate error rate exceeds stable's by this much. Default 0.05. */
  maxErrorRateDelta: z.number().min(0).max(1).optional(),
  /** Roll back when candidate mean score is below stable's by this much. Default 0.05. */
  minScoreDelta: z.number().min(0).max(1).optional(),
  /** When false, regressions are only logged, not auto-rolled-back. Default true. */
  autoRollback: z.boolean().optional(),
});

const CanaryPolicySchema = z.object({
  deployments: z.array(CanaryDeploymentSchema).max(200),
});

export type CanaryDeployment = z.infer<typeof CanaryDeploymentSchema>;
export type CanaryPolicy = z.infer<typeof CanaryPolicySchema>;

export type Variant = "stable" | "canary";

// ---------------------------------------------------------------------------
// Per-variant statistics (pure)
// ---------------------------------------------------------------------------

export interface CanaryStats {
  samples: number;
  errors: number;
  scoreSum: number;
  scoreCount: number;
}

export function emptyStats(): CanaryStats {
  return { samples: 0, errors: 0, scoreSum: 0, scoreCount: 0 };
}

export function errorRate(s: CanaryStats): number {
  return s.samples > 0 ? s.errors / s.samples : 0;
}

export function meanScore(s: CanaryStats): number | undefined {
  return s.scoreCount > 0 ? s.scoreSum / s.scoreCount : undefined;
}

export interface RollbackOptions {
  minSamples: number;
  maxErrorRateDelta: number;
  minScoreDelta: number;
}

export interface RollbackVerdict {
  rollback: boolean;
  reason?: string;
}

/**
 * Decides whether the candidate should be rolled back, comparing it to stable.
 * Pure — no I/O, no time. Requires at least `minSamples` candidate samples.
 */
export function evaluateRollback(
  stable: CanaryStats,
  canary: CanaryStats,
  opts: RollbackOptions,
): RollbackVerdict {
  if (canary.samples < opts.minSamples) return { rollback: false };

  const candidateErr = errorRate(canary);
  const stableErr = errorRate(stable);
  if (candidateErr - stableErr > opts.maxErrorRateDelta) {
    return {
      rollback: true,
      reason: `candidate error rate ${(candidateErr * 100).toFixed(1)}% exceeds stable ${(stableErr * 100).toFixed(1)}% by more than ${(opts.maxErrorRateDelta * 100).toFixed(1)}%`,
    };
  }

  const candidateScore = meanScore(canary);
  const stableScore = meanScore(stable);
  if (
    candidateScore !== undefined &&
    stableScore !== undefined &&
    stableScore - candidateScore > opts.minScoreDelta
  ) {
    return {
      rollback: true,
      reason: `candidate mean score ${candidateScore.toFixed(3)} is below stable ${stableScore.toFixed(3)} by more than ${opts.minScoreDelta.toFixed(3)}`,
    };
  }

  return { rollback: false };
}

/** Deterministic 0–99 bucket for a routing key (stable hashing). */
export function bucketOf(key: string): number {
  const hash = crypto.createHash("sha256").update(key).digest();
  // First two bytes → 0–65535 → 0–99.
  const n = ((hash[0] ?? 0) << 8) | (hash[1] ?? 0);
  return n % 100;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadCanaryPolicy(
  flowsDir: string,
  logger?: Logger,
): CanaryPolicy {
  const filePath = resolveConfigFile(flowsDir, CANARY_FILE);
  if (filePath === null) return { deployments: [] };
  let raw: unknown;
  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    logger?.warn("Failed to read/parse canary config — canary disabled", {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { deployments: [] };
  }
  const result = CanaryPolicySchema.safeParse(raw);
  if (!result.success) {
    logger?.warn("canary config failed schema validation — canary disabled", {
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return { deployments: [] };
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface CanarySelection {
  /** The flow id to actually execute. */
  flowId: string;
  /** Which variant was chosen. */
  variant: Variant;
  /** True when this flow has an active (non-rolled-back) canary deployment. */
  active: boolean;
}

export interface CanaryStatusEntry {
  flow: string;
  candidate: string;
  trafficPercent: number;
  rolledBack: boolean;
  stable: CanaryStats;
  canary: CanaryStats;
}

export interface CanaryManager {
  /** Whether any deployment is configured. */
  enabled: boolean;
  /**
   * Resolves the flow id to run. `routingKey` (e.g. conversation id or request
   * id) makes the choice deterministic per caller. Returns the requested flow
   * unchanged when no deployment covers it or it has been rolled back.
   */
  select(requestedFlow: string, routingKey: string): CanarySelection;
  /** Records an execution outcome for the chosen variant and re-evaluates rollback. */
  record(
    flow: string,
    variant: Variant,
    outcome: { error: boolean; score?: number },
  ): void;
  /** Current rollout status for the dashboard. */
  status(): CanaryStatusEntry[];
  /** Reload the policy from disk (hot-reload hook). */
  reload(): void;
}

interface DeploymentState {
  deployment: Required<CanaryDeployment>;
  rolledBack: boolean;
  stable: CanaryStats;
  canary: CanaryStats;
}

function withDefaults(d: CanaryDeployment): Required<CanaryDeployment> {
  return {
    flow: d.flow,
    candidate: d.candidate,
    trafficPercent: d.trafficPercent,
    minSamples: d.minSamples ?? 20,
    maxErrorRateDelta: d.maxErrorRateDelta ?? 0.05,
    minScoreDelta: d.minScoreDelta ?? 0.05,
    autoRollback: d.autoRollback ?? true,
  };
}

class CanaryManagerImpl implements CanaryManager {
  private byFlow = new Map<string, DeploymentState>();

  constructor(
    private readonly flowsDir: string,
    private readonly logger?: Logger,
  ) {
    this.load();
  }

  get enabled(): boolean {
    return this.byFlow.size > 0;
  }

  private load(): void {
    const policy = loadCanaryPolicy(this.flowsDir, this.logger);
    const next = new Map<string, DeploymentState>();
    for (const raw of policy.deployments) {
      const deployment = withDefaults(raw);
      // Preserve accumulated stats + rollback state across reloads for an
      // unchanged deployment so a hot-edit doesn't reset the safety window.
      const prev = this.byFlow.get(deployment.flow);
      const unchanged =
        prev !== undefined &&
        prev.deployment.candidate === deployment.candidate;
      next.set(deployment.flow, {
        deployment,
        rolledBack: unchanged && prev !== undefined ? prev.rolledBack : false,
        stable: unchanged && prev !== undefined ? prev.stable : emptyStats(),
        canary: unchanged && prev !== undefined ? prev.canary : emptyStats(),
      });
    }
    this.byFlow = next;
  }

  select(requestedFlow: string, routingKey: string): CanarySelection {
    const state = this.byFlow.get(requestedFlow);
    if (state === undefined) {
      return { flowId: requestedFlow, variant: "stable", active: false };
    }
    if (state.rolledBack || state.deployment.trafficPercent <= 0) {
      return { flowId: requestedFlow, variant: "stable", active: true };
    }
    const inCanary = bucketOf(routingKey) < state.deployment.trafficPercent;
    return inCanary
      ? { flowId: state.deployment.candidate, variant: "canary", active: true }
      : { flowId: requestedFlow, variant: "stable", active: true };
  }

  record(
    flow: string,
    variant: Variant,
    outcome: { error: boolean; score?: number },
  ): void {
    const state = this.byFlow.get(flow);
    if (state === undefined) return;
    const stats = variant === "canary" ? state.canary : state.stable;
    stats.samples += 1;
    if (outcome.error) stats.errors += 1;
    if (outcome.score !== undefined) {
      stats.scoreSum += outcome.score;
      stats.scoreCount += 1;
    }

    if (state.rolledBack || !state.deployment.autoRollback) return;

    const verdict = evaluateRollback(state.stable, state.canary, {
      minSamples: state.deployment.minSamples,
      maxErrorRateDelta: state.deployment.maxErrorRateDelta,
      minScoreDelta: state.deployment.minScoreDelta,
    });
    if (verdict.rollback) {
      state.rolledBack = true;
      this.logger?.warn("Canary auto-rolled-back", {
        flow,
        candidate: state.deployment.candidate,
        reason: verdict.reason,
      });
    }
  }

  status(): CanaryStatusEntry[] {
    return [...this.byFlow.values()].map((s) => ({
      flow: s.deployment.flow,
      candidate: s.deployment.candidate,
      trafficPercent: s.deployment.trafficPercent,
      rolledBack: s.rolledBack,
      stable: { ...s.stable },
      canary: { ...s.canary },
    }));
  }

  reload(): void {
    this.load();
    this.logger?.info("Canary policy reloaded", {
      deployments: this.byFlow.size,
    });
  }
}

/**
 * Builds a {@link CanaryManager}. Always returns a manager (cheap when no
 * policy file exists — `enabled` is then false and `select` is a pass-through),
 * so the hot-reload wiring can be set up unconditionally like the dispatcher.
 */
export function createCanaryManager(
  flowsDir: string,
  logger?: Logger,
): CanaryManager {
  return new CanaryManagerImpl(flowsDir, logger);
}
