// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SQL retention targets (`src/observability/retention-db-targets.ts`)
 *
 * Retention and right-to-be-forgotten for the Postgres tables that have no
 * store object of their own on the compliance path: the assistant tables,
 * conversation checkpoints, the cost ledger, analysis artifacts, Rocket.Chat
 * connect requests and the autopilot run history.
 *
 * Subject semantics match {@link ErasureSubject}: user identifiers erase only
 * that user's rows (inside `tenantId` when given); a subject without user
 * identifiers erases the whole tenant. Everything runs on the operator
 * connection because an operator-plane erase spans tenants under RLS.
 *
 * {@link uncoveredRetentionTarget} is the honest answer for a store that holds
 * personal data but cannot be erased automatically: it fails the erasure, so a
 * DSAR reports `partial` instead of a `complete` that is not true.
 *
 * No `any` at module boundaries.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "../db/database.js";
import {
  normalizeTenantId,
  sanitizeIdentitySegment,
} from "../assistants/types.js";
import {
  subjectUserIds,
  type ErasureSubject,
  type RetentionTarget,
} from "./retention.js";

/** Stable target names — also the keys of RETENTION_MAX_AGE_DAYS. */
export const DB_RETENTION_TARGET = {
  assistantData: "assistant_data",
  assistantWorkspaces: "assistant_workspaces",
  conversationCheckpoints: "conversation_checkpoints",
  costLedger: "cost_ledger",
  analysisArtifacts: "analysis_artifacts",
  rocketchatConnectRequests: "rocketchat_connect_requests",
  autopilotRuns: "autopilot_runs",
} as const;

/**
 * The identifier list as one JSON text parameter. Bun's SQL client sends a JS
 * array as a comma-joined string, and a bare `$n::jsonb` arrives as a JSON
 * string scalar, so callers expand it with `jsonb_array_elements_text($n::text::jsonb)`.
 */
const idList = (ids: readonly string[]): string => JSON.stringify(ids);

/** Runs a `DELETE … RETURNING 1` and returns how many rows it removed. */
async function deleteCount(
  db: Database,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const rows = await db.query<{ n: number | string }>(
    `WITH d AS (${sql} RETURNING 1) SELECT count(*) AS n FROM d`,
    [...params],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The WHERE clause selecting a subject's rows in a table with one tenant and
 * one user column. Parameters: `$1` user-id list (JSON text), `$2` tenant.
 */
function subjectClause(
  subject: ErasureSubject,
  tenantColumn: string,
  userColumns: readonly string[],
  /** The table stores tenants normalised (`normalizeTenantId`: trimmed, lower-case). */
  normalizedTenant = false,
): { where: string; params: unknown[] } | undefined {
  const userIds = subjectUserIds(subject);
  const tenantId =
    subject.tenantId !== undefined && normalizedTenant
      ? normalizeTenantId(subject.tenantId)
      : subject.tenantId;
  if (userIds.length === 0) {
    if (tenantId === undefined) return undefined;
    return { where: `${tenantColumn} = $1`, params: [tenantId] };
  }
  const user = userColumns
    .map((c) => `${c} IN (SELECT jsonb_array_elements_text($1::text::jsonb))`)
    .join(" OR ");
  return tenantId === undefined
    ? { where: `(${user})`, params: [idList(userIds)] }
    : {
        where: `(${user}) AND ${tenantColumn} = $2`,
        params: [idList(userIds), tenantId],
      };
}

/**
 * Every durable assistant table (sessions, transcripts, tool journal, runs,
 * schedules, skills and proposals, soul, credentials, messages and grants,
 * Rocket.Chat bindings and outboxes, the assistants themselves). Ordered so
 * NO ACTION foreign keys are satisfied: outboxes before runs and bindings,
 * messages before grants. Proposal events, rollbacks and skill canaries
 * cascade from their parents.
 */
const ASSISTANT_TABLES: ReadonlyArray<{
  table: string;
  tenantColumn: string;
  userColumn: string;
  /** Second (tenant, user) pair of a two-party row (messages, grants). */
  peer?: { tenantColumn: string; userColumn: string };
}> = [
  { table: "assistant_rocketchat_outbox", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_mirror_outbox", tenantColumn: "tenant_id", userColumn: "user_id" },
  {
    table: "assistant_messages",
    tenantColumn: "from_tenant_id",
    userColumn: "from_user_id",
    peer: { tenantColumn: "to_tenant_id", userColumn: "to_user_id" },
  },
  {
    table: "assistant_grants",
    tenantColumn: "from_tenant_id",
    userColumn: "from_user_id",
    peer: { tenantColumn: "to_tenant_id", userColumn: "to_user_id" },
  },
  { table: "assistant_tool_journal", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_session_events", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_session_snapshots", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_sessions", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_turns", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_runs", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_schedules", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_skill_canaries", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_skill_proposals", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_skills", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_soul_revisions", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_souls", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_credentials", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistant_rocketchat_bindings", tenantColumn: "tenant_id", userColumn: "user_id" },
  { table: "assistants", tenantColumn: "tenant_id", userColumn: "user_id" },
];

/**
 * Assistant data: right-to-be-forgotten only. The rows are the user's own
 * assistant state, retained for as long as the assistant exists, so there is
 * no age purge.
 */
export function assistantDataRetentionTarget(db: Database): RetentionTarget {
  return {
    name: DB_RETENTION_TARGET.assistantData,
    eraseSubject: (subject) =>
      db.withOperator(async (op) => {
        let erased = 0;
        for (const t of ASSISTANT_TABLES) {
          const own = subjectClause(subject, t.tenantColumn, [t.userColumn], true);
          if (own === undefined) return 0;
          let where = own.where;
          if (t.peer !== undefined) {
            const peer = subjectClause(
              subject,
              t.peer.tenantColumn,
              [t.peer.userColumn],
              true,
            );
            if (peer !== undefined) where = `(${own.where}) OR (${peer.where})`;
          }
          erased += await deleteCount(
            op,
            `DELETE FROM ${t.table} WHERE ${where}`,
            own.params,
          );
        }
        return erased;
      }),
  };
}

/**
 * Assistant workspace files under `ASSISTANT_WORKSPACE_ROOT`, laid out as
 * `<tenant>/<user>/<assistant>` with the same segment mapping as
 * `AssistantWorkspaceResolver.workspaceDir`. A user-scoped subject removes the
 * user's directory (in every tenant when no tenant is given); a tenant-only
 * subject removes the tenant's directory. Returns the directories removed.
 */
export function assistantWorkspaceRetentionTarget(root: string): RetentionTarget {
  const tenantSegment = (tenantId: string): string =>
    sanitizeIdentitySegment(normalizeTenantId(tenantId)) ?? "_";
  const removeDir = async (dir: string): Promise<number> => {
    try {
      await fs.promises.access(dir);
    } catch {
      return 0;
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    return 1;
  };
  return {
    name: DB_RETENTION_TARGET.assistantWorkspaces,
    eraseSubject: async (subject) => {
      const base = path.resolve(root);
      const userSegments = [
        ...new Set(
          subjectUserIds(subject)
            .map((id) => sanitizeIdentitySegment(id))
            .filter((seg): seg is string => seg !== undefined),
        ),
      ];
      if (subjectUserIds(subject).length === 0) {
        return subject.tenantId === undefined
          ? 0
          : removeDir(path.join(base, tenantSegment(subject.tenantId)));
      }
      let tenants: string[];
      if (subject.tenantId !== undefined) {
        tenants = [tenantSegment(subject.tenantId)];
      } else {
        try {
          tenants = (await fs.promises.readdir(base, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          return 0; // no workspace root yet — nothing was ever written
        }
      }
      let removed = 0;
      for (const tenant of tenants)
        for (const user of userSegments)
          removed += await removeDir(path.join(base, tenant, user));
      return removed;
    },
  };
}

/**
 * Conversation checkpoints (`checkpoints` + `checkpoint_writes`): the full
 * graph state of threaded conversations, including every message.
 *
 * Age purge removes checkpoints older than the cutoff and the writes no
 * checkpoint owns any more. Subject erasure deletes the threads the subject's
 * executions ran on — `threadsForSubject` resolves them from the execution
 * history, so register this target BEFORE the execution-history target.
 * Threads whose executions were already age-purged are only reached by this
 * target's own age purge.
 */
export function conversationCheckpointRetentionTarget(
  db: Database,
  threadsForSubject: (subject: ErasureSubject) => Promise<string[]>,
): RetentionTarget {
  return {
    name: DB_RETENTION_TARGET.conversationCheckpoints,
    purgeOlderThan: (cutoffIso) =>
      db.withOperator(async (op) => {
        const purged = await deleteCount(
          op,
          `DELETE FROM checkpoints WHERE created_at < $1`,
          [cutoffIso],
        );
        await op.query(
          `DELETE FROM checkpoint_writes w
            WHERE NOT EXISTS (
              SELECT 1 FROM checkpoints c
               WHERE c.thread_id = w.thread_id
                 AND c.checkpoint_ns = w.checkpoint_ns
                 AND c.checkpoint_id = w.checkpoint_id)`,
        );
        return purged;
      }),
    eraseSubject: async (subject) => {
      const threads = await threadsForSubject(subject);
      if (threads.length === 0) return 0;
      return db.withOperator(async (op) => {
        const params = [idList(threads)];
        const inThreads = `thread_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))`;
        await op.query(`DELETE FROM checkpoint_writes WHERE ${inThreads}`, params);
        return deleteCount(op, `DELETE FROM checkpoints WHERE ${inThreads}`, params);
      });
    },
  };
}

/** Cost ledger: per-call cost rows carrying the user id and display label. */
export function costLedgerRetentionTarget(db: Database): RetentionTarget {
  return {
    name: DB_RETENTION_TARGET.costLedger,
    purgeOlderThan: (cutoffIso) =>
      db.withOperator((op) =>
        deleteCount(op, `DELETE FROM cost_ledger WHERE created_at < $1`, [
          cutoffIso,
        ]),
      ),
    eraseSubject: async (subject) => {
      const clause = subjectClause(subject, "tenant_id", ["user_id", "user_label"]);
      if (clause === undefined) return 0;
      return db.withOperator((op) =>
        deleteCount(op, `DELETE FROM cost_ledger WHERE ${clause.where}`, clause.params),
      );
    },
  };
}

/** Analysis artifacts: model-produced analyses stored per (tenant, user). */
export function analysisArtifactRetentionTarget(db: Database): RetentionTarget {
  return {
    name: DB_RETENTION_TARGET.analysisArtifacts,
    eraseSubject: async (subject) => {
      const clause = subjectClause(subject, "tenant_id", ["user_id"]);
      if (clause === undefined) return 0;
      // One statement: a derived artifact referencing a parent of the same
      // subject satisfies its NO ACTION foreign key at statement end.
      return db.withOperator((op) =>
        deleteCount(
          op,
          `DELETE FROM analysis_artifacts WHERE ${clause.where}`,
          clause.params,
        ),
      );
    },
  };
}

/** Rocket.Chat connect requests: the verified email and OIDC subject of a user. */
export function rocketchatConnectRetentionTarget(db: Database): RetentionTarget {
  return {
    name: DB_RETENTION_TARGET.rocketchatConnectRequests,
    eraseSubject: async (subject) => {
      const clause = subjectClause(subject, "tenant_id", [
        "oidc_subject",
        "verified_email",
      ]);
      if (clause === undefined) return 0;
      return db.withOperator((op) =>
        deleteCount(
          op,
          `DELETE FROM rocketchat_connect_requests WHERE ${clause.where}`,
          clause.params,
        ),
      );
    },
  };
}

/** Autopilot run history: operational flow metrics, no personal data — age purge only. */
export function autopilotRunRetentionTarget(db: Database): RetentionTarget {
  return {
    name: DB_RETENTION_TARGET.autopilotRuns,
    purgeOlderThan: (cutoffIso) =>
      db.withOperator((op) =>
        deleteCount(op, `DELETE FROM autopilot_runs WHERE started_at < $1`, [
          cutoffIso,
        ]),
      ),
  };
}

/**
 * A store known to hold personal data that no target can erase. Its erasure
 * always fails with `reason`, so the DSAR reports `partial` and names the gap
 * instead of claiming a complete erasure.
 */
export function uncoveredRetentionTarget(
  name: string,
  reason: string,
): RetentionTarget {
  return {
    name,
    erasureGap: reason,
    eraseSubject: async () => {
      throw new Error(`Not erased automatically: ${reason}`);
    },
  };
}
