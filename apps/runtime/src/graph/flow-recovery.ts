// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-flow crash-recovery resolution (`src/graph/flow-recovery.ts`)
 *
 * Turns the deployment-wide `JOB_RECOVERY_*` settings plus a flow's own
 * `recovery` declaration into the concrete `{ maxAttempts, leaseMs }` an async
 * job is created with — or into "no recovery for this one".
 *
 * Why this exists
 * ───────────────
 * `JOB_RECOVERY_ENABLED` is a single deployment-wide switch, and the retry it
 * enables re-runs a flow **from the beginning** (ADR-0023 — it is crash
 * resilience, not step-exact resumption). Whether that is acceptable is a
 * property of the individual flow's tools, not of the deployment:
 *
 *   - a retrieval/research flow only reads → re-running it is harmless;
 *   - a flow whose tools send an e-mail, open a ticket or post a payment can
 *     repeat that side effect on a retry.
 *
 * With only the global switch the operator had to choose between "no crash
 * recovery anywhere" and "possible duplicate side effects everywhere". Neither
 * matches the actual risk. `FlowDefinition.recovery.retry` moves the decision to
 * where the tools are known.
 *
 * Two deliberate asymmetries
 * ──────────────────────────
 * **A flow can only narrow, never widen.** `recovery.maxAttempts` is clamped to
 * the global ceiling, so a flow author cannot grant themselves more retries than
 * the operator allows. `retry: true` likewise does nothing when recovery is
 * globally off.
 *
 * **An omitted declaration fails closed.** The engine currently restarts async
 * jobs from the beginning; it does not resume at a checkpointed graph step.
 * Therefore unknown tool side effects must never be replayed automatically.
 * A flow author must explicitly declare `recovery.retry: true` after auditing
 * its tools as read-only/idempotent, or explicitly opt out with `false`.
 */

import type { FlowDefinition } from "../types/flow.js";

/** The deployment-wide recovery settings, as resolved from config. */
export interface GlobalJobRecovery {
  maxAttempts: number;
  leaseMs: number;
}

/** What an async job should be created with. `undefined` = no recovery. */
export type ResolvedJobRecovery = GlobalJobRecovery | undefined;

/**
 * Resolve the effective recovery settings for one flow.
 *
 * @param global Deployment settings, or `undefined` when `JOB_RECOVERY_ENABLED`
 *   is off. A flow cannot enable recovery that the deployment has not enabled.
 * @param flow The flow about to run. `undefined` (flow not found) is treated as
 *   unknown and therefore not automatically recoverable.
 */
export function resolveFlowRecovery(
  global: GlobalJobRecovery | undefined,
  flow: Pick<FlowDefinition, "recovery"> | undefined,
): ResolvedJobRecovery {
  // Recovery is off for the whole deployment — a flow cannot opt itself in.
  if (global === undefined) return undefined;

  const declared = flow?.recovery;

  // No explicit audit declaration means side effects are unknown. Because
  // recovery restarts from the beginning (not from a durable graph step), the
  // only safe default is no automatic retry.
  if (declared === undefined) return undefined;

  // Explicit opt-out wins over the global switch. The job is then created
  // without a resumePayload, so the sweeper fails it with a stated reason
  // rather than leaving it stuck — a clean terminal state, not a silent drop.
  if (declared.retry !== true) return undefined;

  // Opted in: honour a lower per-flow cap, ignore a higher one.
  const capped =
    declared.maxAttempts !== undefined
      ? Math.min(declared.maxAttempts, global.maxAttempts)
      : global.maxAttempts;

  return { maxAttempts: Math.max(1, capped), leaseMs: global.leaseMs };
}

/**
 * Split a set of flows by whether they have declared a recovery policy.
 *
 * Used by the production-readiness gate to report the flows that would be
 * retried purely because of the global default. Returns names sorted so the
 * output is stable across runs (a gate message that reorders itself is noise in
 * a diff).
 */
export function partitionFlowsByRecoveryDeclaration(
  flows: Iterable<Pick<FlowDefinition, "id" | "recovery">>,
): { declared: string[]; undeclared: string[] } {
  const declared: string[] = [];
  const undeclared: string[] = [];
  for (const flow of flows) {
    if (flow.recovery === undefined) undeclared.push(flow.id);
    else declared.push(flow.id);
  }
  declared.sort();
  undeclared.sort();
  return { declared, undeclared };
}
