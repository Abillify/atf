// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Retention target adapters (`src/observability/retention-targets.ts`)
 *
 * Wraps the platform's persistence stores into the generic {@link RetentionTarget}
 * contract consumed by {@link RetentionService}. Keeping the adapters here (not
 * inside each store) means the stores stay focused on their domain and the
 * compliance layer owns the policy/identity mapping.
 *
 * No `any` at module boundaries.
 */

import {
  subjectUserIds,
  type RetentionTarget,
  type ErasureSubject,
} from "./retention.js";
import type { ReplayStore } from "../graph/replay.js";
import type { ExecutionStore } from "../monitoring/execution-store.js";
import type { MemoryStore, MemoryScope } from "../graph/memory-store.js";
import type { PiiVaultStore } from "../graph/pii-vault.js";

/** Stable target names — also used as policy keys (RETENTION_MAX_AGE_DAYS). */
export const RETENTION_TARGET = {
  replaySnapshots: "replay_snapshots",
  executionHistory: "execution_history",
  longTermMemory: "long_term_memory",
  piiVault: "pii_vault",
} as const;

/** Replay snapshots: age-purge by capture time + subject erasure (tenant/user). */
export function replayRetentionTarget(store: ReplayStore): RetentionTarget {
  return {
    name: RETENTION_TARGET.replaySnapshots,
    purgeOlderThan: (cutoffIso) => store.purgeOlderThan(cutoffIso),
    eraseSubject: (subject) => store.eraseSubject(subject),
  };
}

/** Execution history: age-purge by start time + tenant-scoped subject erasure. */
export function executionHistoryRetentionTarget(
  store: ExecutionStore,
): RetentionTarget {
  return {
    name: RETENTION_TARGET.executionHistory,
    purgeOlderThan: (cutoffIso) => store.purgeOlderThan(cutoffIso),
    eraseSubject: (subject) => store.eraseSubject(subject),
  };
}

/**
 * Long-term memory: right-to-be-forgotten only. Memories live in a vector
 * collection keyed per (tenant, user) scope, so erasure needs a user to
 * identify the scope; a tenant-only subject cannot enumerate every user's
 * collection and therefore erases nothing here (reported as 0). There is no
 * cross-scope age purge for the same reason.
 */
export function memoryRetentionTarget(store: MemoryStore): RetentionTarget {
  return {
    name: RETENTION_TARGET.longTermMemory,
    eraseSubject: async (subject: ErasureSubject): Promise<number> => {
      if (subject.userId === undefined || subject.userId.trim().length === 0)
        return 0;
      const scope: MemoryScope = {
        userId: subject.userId,
        ...(subject.tenantId !== undefined
          ? { tenantId: subject.tenantId }
          : {}),
      };
      return store.clear(scope);
    },
  };
}

/**
 * Reversible PII vault entries: age-purge (safety net for orphaned entries
 * from a crashed/abandoned run — the vault itself already releases entries
 * when a run finishes streaming) + right-to-be-forgotten.
 *
 * Vault entries are keyed by execution only, so a user-scoped subject is
 * resolved to that user's executions through `executionIdsForSubject` (the
 * execution history). Register this target BEFORE the execution-history
 * target: {@link RetentionService.forget} runs targets in order, and the
 * history erase removes the attribution this lookup relies on. Without the
 * lookup a user-scoped erase fails instead of wiping the whole tenant. Only a
 * subject without user identifiers erases every entry of its tenant.
 */
export function piiVaultRetentionTarget(
  store: PiiVaultStore,
  executionIdsForSubject?: (subject: ErasureSubject) => Promise<string[]>,
): RetentionTarget {
  // Bind now (while `purgeOlderThan` is narrowed to a function) so `this`
  // inside the store's real implementation stays bound to `store`.
  const purgeOlderThan = store.purgeOlderThan?.bind(store);
  return {
    name: RETENTION_TARGET.piiVault,
    ...(purgeOlderThan !== undefined ? { purgeOlderThan } : {}),
    eraseSubject: async (subject: ErasureSubject): Promise<number> => {
      if (subjectUserIds(subject).length > 0) {
        if (executionIdsForSubject === undefined)
          throw new Error(
            "PII vault entries cannot be attributed to a user without the execution history",
          );
        let erased = 0;
        for (const executionId of await executionIdsForSubject(subject))
          erased += await store.clear(executionId);
        return erased;
      }
      if (
        store.eraseTenant === undefined ||
        subject.tenantId === undefined ||
        subject.tenantId.trim().length === 0
      ) {
        return 0;
      }
      return store.eraseTenant(subject.tenantId);
    },
  };
}
