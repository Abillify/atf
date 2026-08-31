// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * A/B experiments over flow versions (`src/graph/flow-ab.ts`)
 *
 * Where the canary manager routes a fraction of traffic to a candidate *flow
 * id* and auto-rolls-back on regression, A/B experiments deliberately split
 * traffic across N **published versions of the same flow** to *measure* them —
 * no auto-rollback, just per-variant statistics (samples, error rate, mean
 * latency, mean judge score) so an operator can decide which version wins.
 *
 * Versions are immutable history entries from the {@link FlowStore}; the manager
 * resolves each variant's version definition once (cached) and exposes it under
 * a synthetic versioned flow id `flow@version`, which a version-aware registry
 * overlay can execute — so the engine, monitoring, replay and cost machinery
 * all work unchanged.
 *
 * Policy lives in a hot-reloaded `flows/experiments.json` (validated with Zod; a
 * bad file disables A/B, never crashes). Selection is deterministic per routing
 * key (so a conversation stays on one variant) and the stats are pure.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import { z } from "zod";
import type { FlowDefinition } from "../types/flow.js";
import type { Logger } from "../observability/logger.js";
import { parseFlowFile, resolveConfigFile } from "../util/parse-flow-file.js";

const EXPERIMENTS_FILE = "experiments";

// ---------------------------------------------------------------------------
// Policy schema
// ---------------------------------------------------------------------------

const VariantSchema = z.object({
  /** Stable label for the variant (used in stats + reporting). */
  label: z.string().min(1).max(64),
  /** Published version of the flow this variant runs. */
  version: z.number().int().min(1),
  /** Relative traffic weight (normalised across the experiment). Default 1. */
  weight: z.number().min(0).optional(),
});

const ExperimentSchema = z.object({
  /** The flow id clients request and that the experiment splits. */
  flow: z.string().min(1),
  /** 2+ variants to compare. */
  variants: z.array(VariantSchema).min(2).max(20),
});

const ExperimentPolicySchema = z.object({
  experiments: z.array(ExperimentSchema).max(200),
});

export type ExperimentVariant = z.infer<typeof VariantSchema>;
export type Experiment = z.infer<typeof ExperimentSchema>;
export type ExperimentPolicy = z.infer<typeof ExperimentPolicySchema>;

// ---------------------------------------------------------------------------
// Pure selection + stats
// ---------------------------------------------------------------------------

/** Deterministic fraction in [0,1) for a routing key (stable hashing). Pure. */
export function hashFraction(key: string): number {
  const hash = crypto.createHash("sha256").update(key).digest();
  // First 4 bytes → unsigned 32-bit → [0,1).
  const n =
    (((hash[0] ?? 0) << 24) >>> 0) +
    ((hash[1] ?? 0) << 16) +
    ((hash[2] ?? 0) << 8) +
    (hash[3] ?? 0);
  return (n >>> 0) / 0x1_0000_0000;
}

/**
 * Picks a variant index for a routing key by cumulative normalised weight.
 * Pure and deterministic. Returns 0 when all weights are zero (first variant).
 */
export function pickVariantIndex(
  weights: readonly number[],
  key: string,
): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return 0;
  const target = hashFraction(key) * total;
  let cumulative = 0;
  for (const [i, w] of weights.entries()) {
    cumulative += Math.max(0, w);
    if (target < cumulative) return i;
  }
  return weights.length - 1;
}

export interface VariantStats {
  label: string;
  version: number;
  samples: number;
  errors: number;
  latencySumMs: number;
  scoreSum: number;
  scoreCount: number;
}

export function emptyVariantStats(
  label: string,
  version: number,
): VariantStats {
  return {
    label,
    version,
    samples: 0,
    errors: 0,
    latencySumMs: 0,
    scoreSum: 0,
    scoreCount: 0,
  };
}

export interface VariantReport {
  label: string;
  version: number;
  samples: number;
  errorRate: number;
  meanLatencyMs?: number;
  meanScore?: number;
}

export function reportVariant(s: VariantStats): VariantReport {
  return {
    label: s.label,
    version: s.version,
    samples: s.samples,
    errorRate:
      s.samples > 0 ? Math.round((s.errors / s.samples) * 1000) / 1000 : 0,
    ...(s.samples > 0
      ? { meanLatencyMs: Math.round(s.latencySumMs / s.samples) }
      : {}),
    ...(s.scoreCount > 0
      ? { meanScore: Math.round((s.scoreSum / s.scoreCount) * 1000) / 1000 }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadExperimentPolicy(
  flowsDir: string,
  logger?: Logger,
): ExperimentPolicy {
  const filePath = resolveConfigFile(flowsDir, EXPERIMENTS_FILE);
  if (filePath === null) return { experiments: [] };
  let raw: unknown;
  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    logger?.warn("Failed to read/parse experiments config — A/B disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { experiments: [] };
  }
  const result = ExperimentPolicySchema.safeParse(raw);
  if (!result.success) {
    logger?.warn("experiments config failed schema validation — A/B disabled", {
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return { experiments: [] };
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Resolves a published version definition for a flow (from the flow store). */
export type VersionResolver = (
  flow: string,
  version: number,
) => Promise<FlowDefinition | undefined>;

export interface AbSelection {
  variant: string;
  version: number;
  /** Synthetic versioned flow id the version-aware registry executes. */
  versionedId: string;
}

export interface ExperimentReport {
  flow: string;
  variants: VariantReport[];
}

export interface AbManager {
  enabled: boolean;
  /** Selects a variant for a flow + routing key, or undefined when no experiment. */
  select(flow: string, routingKey: string): AbSelection | undefined;
  /** Records an outcome for a chosen variant. */
  record(
    flow: string,
    variant: string,
    outcome: { error: boolean; latencyMs?: number; score?: number },
  ): void;
  /** Per-experiment comparison report. */
  status(): ExperimentReport[];
  /** Resolves a synthetic `flow@version` id to its (cached) definition. */
  resolveVersioned(id: string): FlowDefinition | undefined;
  /** Reloads policy + re-resolves version definitions. */
  reload(): Promise<void>;
}

export function versionedFlowId(flow: string, version: number): string {
  return `${flow}@${version}`;
}

interface ExperimentState {
  experiment: Experiment;
  /** Per-variant accumulated stats, keyed by label. */
  stats: Map<string, VariantStats>;
}

class AbManagerImpl implements AbManager {
  private byFlow = new Map<string, ExperimentState>();
  /** Cache of resolved `flow@version` → definition (immutable history). */
  private versionCache = new Map<string, FlowDefinition>();

  constructor(
    private readonly flowsDir: string,
    private readonly resolver: VersionResolver,
    private readonly logger?: Logger,
  ) {}

  get enabled(): boolean {
    return this.byFlow.size > 0;
  }

  async reload(): Promise<void> {
    const policy = loadExperimentPolicy(this.flowsDir, this.logger);
    const next = new Map<string, ExperimentState>();
    const cache = new Map<string, FlowDefinition>();

    for (const experiment of policy.experiments) {
      const stats = new Map<string, VariantStats>();
      let resolvable = true;
      for (const v of experiment.variants) {
        const def = await this.resolver(experiment.flow, v.version);
        if (def === undefined) {
          this.logger?.warn(
            "A/B experiment references an unknown flow version — skipping experiment",
            {
              flow: experiment.flow,
              version: v.version,
            },
          );
          resolvable = false;
          break;
        }
        const vid = versionedFlowId(experiment.flow, v.version);
        // Rewrite the id so the engine keys/caches the versioned graph distinctly.
        cache.set(vid, { ...def, id: vid });
        // Preserve stats across reloads for an unchanged (flow,label,version).
        const prev = this.byFlow.get(experiment.flow)?.stats.get(v.label);
        stats.set(
          v.label,
          prev !== undefined && prev.version === v.version
            ? prev
            : emptyVariantStats(v.label, v.version),
        );
      }
      if (resolvable) next.set(experiment.flow, { experiment, stats });
    }

    this.byFlow = next;
    this.versionCache = cache;
    this.logger?.info("A/B experiments reloaded", {
      experiments: this.byFlow.size,
    });
  }

  select(flow: string, routingKey: string): AbSelection | undefined {
    const state = this.byFlow.get(flow);
    if (state === undefined) return undefined;
    const variants = state.experiment.variants;
    const weights = variants.map((v) => v.weight ?? 1);
    const idx = pickVariantIndex(weights, routingKey);
    const variant = variants[idx];
    if (variant === undefined) return undefined; // unreachable: pickVariantIndex always returns a valid index
    return {
      variant: variant.label,
      version: variant.version,
      versionedId: versionedFlowId(flow, variant.version),
    };
  }

  record(
    flow: string,
    variant: string,
    outcome: { error: boolean; latencyMs?: number; score?: number },
  ): void {
    const stats = this.byFlow.get(flow)?.stats.get(variant);
    if (stats === undefined) return;
    stats.samples += 1;
    if (outcome.error) stats.errors += 1;
    if (outcome.latencyMs !== undefined)
      stats.latencySumMs += outcome.latencyMs;
    if (outcome.score !== undefined) {
      stats.scoreSum += outcome.score;
      stats.scoreCount += 1;
    }
  }

  status(): ExperimentReport[] {
    return [...this.byFlow.values()].map((s) => ({
      flow: s.experiment.flow,
      variants: [...s.stats.values()].map(reportVariant),
    }));
  }

  resolveVersioned(id: string): FlowDefinition | undefined {
    return this.versionCache.get(id);
  }
}

/**
 * Builds an {@link AbManager}. `reload()` must be awaited once after
 * construction to populate the version cache (the caller does this during
 * startup, mirroring the DB flow source's initial refresh).
 */
export function createAbManager(
  flowsDir: string,
  resolver: VersionResolver,
  logger?: Logger,
): AbManager {
  return new AbManagerImpl(flowsDir, resolver, logger);
}
