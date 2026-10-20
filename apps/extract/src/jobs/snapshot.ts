// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/snapshot.ts
 *
 * The configuration snapshot and the `resume_policy` comparison (design §9b.2,
 * requirement 4.12).
 *
 * When a job is created we freeze two things onto the row: a snapshot of the
 * config that governs its extraction, and the pipeline and prompt hashes that
 * identify the exact code/prompt versions that config implies. If a deployment
 * later changes the pipeline or a prompt while a job is mid-flight, a resuming
 * worker must not silently mix outputs from two different pipeline versions
 * into one document. The `resume_policy` decides what happens instead:
 *
 *   pin (default)   — continue only if the hashes still match; otherwise pause
 *                     the job and wait for an operator decision.
 *   continue        — run the remaining pages with the new version, recording
 *                     the used stand per page so the mix is auditable.
 *   restart-stage=X — recompute from stage X for all pages under the new
 *                     version. The bare `restart-stage` policy in the contract
 *                     enum means "from the first stage".
 *
 * The hashing is deliberately content-addressed and stable: the same config and
 * prompt set always hash to the same value, so an unchanged redeploy is a
 * no-op and only a genuine change trips the policy.
 */

import { createHash } from "node:crypto";
import { canonicalJsonConcat } from "@atf/canonical-json";
import type { ResumePolicy } from "@atf/extract-contract/v2";

/** The pipeline/prompt fingerprint frozen onto a job at creation. */
export interface PipelineSnapshot {
  /** Identifies the pipeline code version (renderer, extractor, model, DPI…). */
  pipelineHash: string;
  /** Identifies the prompt set version. */
  promptHash: string;
}

/**
 * The inputs that define a pipeline version. Anything that changes the bytes a
 * stage would produce belongs here so a change to it trips the resume policy.
 */
export interface PipelineDescriptor {
  extractor: string;
  renderer: string;
  visionModel: string;
  renderDpi: number;
  figureDpi: number;
  /** Free-form extra knobs that affect output (page label, concurrency-independent). */
  extra?: Record<string, unknown>;
}

/**
 * Stable JSON: object keys sorted recursively so key order never perturbs a
 * hash. `@atf/canonical-json`'s concat mode (code-unit order, `undefined`
 * dropped) — byte-identical to the former local helper (proven by
 * `packages/canonical-json/test/differential.test.ts`). These bytes feed the
 * persisted `pipelineHash` / `promptHash` resume keys, so the concat family's
 * purely lexicographic key order (integer-like keys sort `"01" < "10" < "9"`)
 * is frozen: snapshots already in flight must keep matching their hash.
 */
const stableStringify = canonicalJsonConcat;

/** sha256 of the stable serialisation of `value`. */
export function hashObject(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Compute the pipeline hash from a descriptor. */
export function pipelineHash(descriptor: PipelineDescriptor): string {
  return hashObject(descriptor);
}

/**
 * Compute the prompt hash from the prompt set. Each entry is `name → template`;
 * changing any template changes the hash.
 */
export function promptHash(prompts: Record<string, string>): string {
  return hashObject(prompts);
}

/** Freeze the snapshot at job creation. */
export function buildSnapshot(
  descriptor: PipelineDescriptor,
  prompts: Record<string, string>,
): PipelineSnapshot {
  return { pipelineHash: pipelineHash(descriptor), promptHash: promptHash(prompts) };
}

/** The decision a resume makes after comparing the current stand to the snapshot. */
export type ResumeDecision =
  /** Hashes match (or there was no snapshot) — carry on unchanged. */
  | { action: "continue-pinned"; changed: false }
  /** `pin` policy and the stand changed — pause and wait for an operator. */
  | { action: "pause"; changed: true; reason: "dependency" }
  /** `continue` policy — run the rest under the new stand; record it per page. */
  | { action: "continue-new"; changed: true }
  /** `restart-stage` policy — recompute from `fromStage` for all pages. */
  | { action: "restart-stage"; changed: true; fromStage: string };

/**
 * A short, stable key of a stand, folded into every stage `input_hash`
 * (design §9b.2: the input hash covers source, page, relevant configuration AND
 * the prompt hash). A changed pipeline or prompt stand therefore changes every
 * hash, which is what lets `resume_policy` decide per stage what is reused.
 */
export function standKey(stand: PipelineSnapshot): string {
  return hashObject({ p: stand.pipelineHash, q: stand.promptHash }).slice(0, 32);
}

/**
 * The per-page stage order `restart-stage=<stage>` refers to (design §9b.2):
 * render/vision1 → crops → figure2 → tiled → emitted → docpass. S2 (`analyzed`)
 * and S4 (`refined`) are folded into `vision1`, `vision2` is the figure pass
 * (`figure2`), and the summary stages belong to the document pass.
 */
export const RESTARTABLE_STAGES = ["vision1", "crops", "figure2", "tiled", "emitted", "docpass"] as const;

/** The position of a stage in {@link RESTARTABLE_STAGES}, or -1 if unknown. */
export function stageOrderIndex(stage: string): number {
  switch (stage) {
    case "analyzed":
    case "render":
    case "refined":
    case "vision1":
      return 0;
    case "crops":
      return 1;
    case "vision2":
    case "figure2":
      return 2;
    case "tiled":
      return 3;
    case "emitted":
      return 4;
    case "docpass":
      return 5;
    default:
      return stage.startsWith("summary:") ? 5 : -1;
  }
}

/**
 * How a run treats existing checkpoints, derived from the resume decision.
 *
 *   - `continue-pinned`: reuse only on an identical input hash (the default).
 *   - `continue-new`: every finished checkpoint is reused regardless of its
 *     hash; only open units run, under the new stand (recorded per page).
 *   - `restart-stage`: checkpoints BEFORE the restart stage are reused
 *     regardless of hash, the restart stage and everything after it recompute
 *     (their hashes no longer match the new stand); `restartFrom` is the index
 *     the runner invalidates the deterministic downstream stages from.
 */
export interface ReusePolicy {
  reuseDoneRegardlessOfHash(stage: string): boolean;
  /** The index into {@link RESTARTABLE_STAGES} to recompute from, or null. */
  restartFrom: number | null;
}

/** Build the {@link ReusePolicy} for a resume decision. */
export function reusePolicyFor(decision: ResumeDecision): ReusePolicy {
  switch (decision.action) {
    case "continue-new":
      return { reuseDoneRegardlessOfHash: () => true, restartFrom: null };
    case "restart-stage": {
      const from = Math.max(0, stageOrderIndex(decision.fromStage));
      return {
        reuseDoneRegardlessOfHash: (stage) => {
          const idx = stageOrderIndex(stage);
          return idx >= 0 && idx < from;
        },
        restartFrom: from,
      };
    }
    default:
      return { reuseDoneRegardlessOfHash: () => false, restartFrom: null };
  }
}

/**
 * Decide how to resume given the snapshot, the current stand, and the policy.
 *
 * `restartStage` is the stage `restart-stage=<stage>` targets; when the policy
 * is `restart-stage` and no stage was configured it defaults to the first
 * pipeline stage (`analyzed`).
 */
export function decideResume(args: {
  snapshot: PipelineSnapshot;
  current: PipelineSnapshot;
  policy: ResumePolicy;
  restartStage?: string;
}): ResumeDecision {
  const { snapshot, current, policy } = args;
  const changed =
    snapshot.pipelineHash !== current.pipelineHash ||
    snapshot.promptHash !== current.promptHash;

  if (!changed) return { action: "continue-pinned", changed: false };

  switch (policy) {
    case "pin":
      // The default: refuse to mix versions. Hold for an operator, who can flip
      // the policy to continue/restart-stage and resume.
      return { action: "pause", changed: true, reason: "dependency" };
    case "continue":
      return { action: "continue-new", changed: true };
    case "restart-stage":
      return {
        action: "restart-stage",
        changed: true,
        fromStage: args.restartStage ?? "analyzed",
      };
  }
}
