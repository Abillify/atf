// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import { nextCronOccurrence, parseCronExpression } from "./cron-schedule.js";
import type { AssistantScope } from "./types.js";

export type AssistantRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AssistantRunOrigin = "internal" | "rocket-chat" | "schedule";

export class AssistantParentRunNotFoundError extends Error {
  constructor() {
    super("Parent assistant run was not found in the caller scope.");
    this.name = "AssistantParentRunNotFoundError";
  }
}

export interface AssistantRun {
  id: string;
  scope: AssistantScope;
  parentRunId?: string;
  origin: AssistantRunOrigin;
  status: AssistantRunStatus;
  attempt: number;
  maxAttempts: number;
  leaseExpiresAt?: string;
  leaseOwner?: string;
  resumePayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface AssistantSchedule {
  id: string;
  dueAt: string;
  slot: string;
  enabled: boolean;
  cronExpression?: string;
  timezone: "UTC";
  resumePayload: Record<string, unknown>;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  due_at: string | Date;
  slot: string;
  enabled: boolean;
  cron_expression: string | null;
  timezone: string;
  resume_payload: Record<string, unknown> | string;
}

function decodePayload(value: unknown): Record<string, unknown> {
  const decoded = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Assistant run resume_payload must be a JSON object.");
  }
  return decoded as Record<string, unknown>;
}

/** Authoritative durable queue for assistant work. Every scoped mutation includes its caller scope. */
export class PostgresAssistantRunStore {
  constructor(private readonly db: Database) {}

  private inTenant<T>(scope: AssistantScope, fn: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(scope.tenantId, fn) : fn(this.db);
  }

  private iso(value: string | Date): string {
    return new Date(value).toISOString();
  }

  private run(row: Record<string, unknown>): AssistantRun {
    return {
      id: String(row.id),
      scope: { tenantId: String(row.tenant_id), userId: String(row.user_id), assistantId: String(row.assistant_id) },
      ...(row.parent_run_id !== null && row.parent_run_id !== undefined ? { parentRunId: String(row.parent_run_id) } : {}),
      origin: (row.origin ?? "internal") as AssistantRunOrigin,
      status: row.status as AssistantRunStatus,
      attempt: Number(row.attempt),
      maxAttempts: Number(row.max_attempts),
      ...(row.lease_expires_at !== null && row.lease_expires_at !== undefined ? { leaseExpiresAt: this.iso(row.lease_expires_at as string) } : {}),
      ...(row.lease_owner !== null && row.lease_owner !== undefined ? { leaseOwner: String(row.lease_owner) } : {}),
      resumePayload: decodePayload(row.resume_payload),
      createdAt: this.iso(row.created_at as string),
      updatedAt: this.iso(row.updated_at as string),
      ...(row.error !== null && row.error !== undefined ? { error: String(row.error) } : {}),
    };
  }

  private schedule(row: Record<string, unknown>): AssistantSchedule {
    return {
      id: String(row.id),
      dueAt: this.iso(row.due_at as string),
      slot: String(row.slot),
      enabled: Boolean(row.enabled),
      ...(row.cron_expression !== null && row.cron_expression !== undefined ? { cronExpression: String(row.cron_expression) } : {}),
      timezone: "UTC",
      resumePayload: decodePayload(row.resume_payload),
      ...(row.lease_expires_at !== null && row.lease_expires_at !== undefined ? { leaseExpiresAt: this.iso(row.lease_expires_at as string) } : {}),
      createdAt: this.iso(row.created_at as string),
      updatedAt: this.iso(row.updated_at as string),
    };
  }

  async start(scope: AssistantScope, input: { idempotencyKey: string; parentRunId?: string; resumePayload: Record<string, unknown>; maxAttempts?: number; origin?: AssistantRunOrigin }): Promise<AssistantRun> {
    const rows = await this.inTenant(scope, (db) => db.query<Record<string, unknown>>(
      `INSERT INTO assistant_runs
         (id, tenant_id, user_id, assistant_id, parent_run_id, idempotency_key, resume_payload, max_attempts, attempt, origin)
       SELECT $1::uuid, $2, $3, $4, $5::uuid, $6, $7::text::jsonb, $8, 0, $9
        WHERE $5::uuid IS NULL OR EXISTS (
          SELECT 1 FROM assistant_runs p
           WHERE p.id=$5::uuid AND p.tenant_id=$2 AND p.user_id=$3 AND p.assistant_id=$4
        )
       ON CONFLICT (tenant_id, user_id, assistant_id, idempotency_key)
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [crypto.randomUUID(), scope.tenantId, scope.userId, scope.assistantId, input.parentRunId ?? null,
        input.idempotencyKey, JSON.stringify(input.resumePayload), Math.max(1, input.maxAttempts ?? 1),
        input.origin ?? "internal"],
    ));
    const row = rows[0];
    if (row === undefined) throw new AssistantParentRunNotFoundError();
    return this.run(row);
  }

  /** Creates an inline child already owned by its executor, never exposing it to the global queue. */
  async startClaimed(scope: AssistantScope, input: {
    idempotencyKey: string;
    parentRunId?: string;
    resumePayload: Record<string, unknown>;
    workerId: string;
    leaseMs?: number;
  }): Promise<AssistantRun> {
    const leaseMs = Math.min(900_000, Math.max(1_000, input.leaseMs ?? 60_000));
    const rows = await this.inTenant(scope, (db) => db.query<Record<string, unknown>>(
      `INSERT INTO assistant_runs
         (id,tenant_id,user_id,assistant_id,parent_run_id,idempotency_key,status,attempt,max_attempts,
          lease_owner,lease_expires_at,resume_payload)
       SELECT $1::uuid,$2,$3,$4,$5::uuid,$6,'running',1,1,$7,
              now()+($8::bigint*interval '1 millisecond'),$9::text::jsonb
        WHERE $5::uuid IS NULL OR EXISTS (
          SELECT 1 FROM assistant_runs p
           WHERE p.id=$5::uuid AND p.tenant_id=$2 AND p.user_id=$3 AND p.assistant_id=$4
        )
       ON CONFLICT (tenant_id,user_id,assistant_id,idempotency_key)
       DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key,
                     lease_expires_at=EXCLUDED.lease_expires_at,
                     updated_at=now()
         WHERE assistant_runs.status='running'
           AND assistant_runs.lease_owner=EXCLUDED.lease_owner
       RETURNING *`,
      [crypto.randomUUID(), scope.tenantId, scope.userId, scope.assistantId, input.parentRunId ?? null,
        input.idempotencyKey, input.workerId, leaseMs, JSON.stringify(input.resumePayload)],
    ));
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Durable child run could not be created or reclaimed by this execution.");
    }
    const run = this.run(row);
    if (run.status !== "running" || run.leaseOwner !== input.workerId) {
      throw new Error("Durable child run already exists and is not owned by this execution.");
    }
    return run;
  }

  async list(scope: AssistantScope, limit = 50): Promise<AssistantRun[]> {
    const rows = await this.inTenant(scope, (db) => db.query<Record<string, unknown>>(
      `SELECT * FROM assistant_runs WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3 ORDER BY created_at DESC LIMIT $4`,
      [scope.tenantId, scope.userId, scope.assistantId, Math.min(200, Math.max(1, limit))],
    ));
    return rows.map((row) => this.run(row));
  }

  async get(scope: AssistantScope, id: string): Promise<AssistantRun | undefined> {
    const rows = await this.inTenant(scope, (db) => db.query<Record<string, unknown>>(
      `SELECT * FROM assistant_runs WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3 AND id=$4::uuid`,
      [scope.tenantId, scope.userId, scope.assistantId, id],
    ));
    return rows[0] === undefined ? undefined : this.run(rows[0]);
  }

  async claim(scope: AssistantScope, id: string, workerId: string, leaseMs = 60_000): Promise<boolean> {
    const rows = await this.inTenant(scope, (db) => db.query(
      `UPDATE assistant_runs SET status='running', attempt=attempt+1, lease_owner=$5,
          lease_expires_at=now()+($6::bigint*interval '1 millisecond'), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3 AND id=$4::uuid
          AND status='queued' AND attempt<max_attempts RETURNING id`,
      [scope.tenantId, scope.userId, scope.assistantId, id, workerId, Math.min(900_000, Math.max(1_000, leaseMs))],
    ));
    return rows.length === 1;
  }

  /** Atomically claim queued work across tenants. The returned runs are already running. */
  async claimQueued(limit = 50, leaseMs = 60_000): Promise<AssistantRun[]> {
    const rows = await this.db.withOperator((db) => db.query<Record<string, unknown>>(
      `WITH candidates AS (
         SELECT id FROM assistant_runs WHERE status='queued' AND attempt<max_attempts
           AND COALESCE(resume_payload->>'kind','') <> 'harness-delegation'
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE assistant_runs r SET status='running', attempt=r.attempt+1, lease_owner=$2,
         lease_expires_at=now()+($3::bigint*interval '1 millisecond'), updated_at=now()
       FROM candidates WHERE r.id=candidates.id RETURNING r.*`,
      [Math.min(200, Math.max(1, limit)), crypto.randomUUID(), Math.min(900_000, Math.max(1_000, leaseMs))],
    ));
    return rows.map((row) => this.run(row));
  }

  async recoverExpired(): Promise<void> {
    await this.db.withOperator((db) => db.query(
      `UPDATE assistant_runs
          SET status=CASE WHEN attempt<max_attempts THEN 'queued' ELSE 'failed' END,
              error=CASE WHEN attempt<max_attempts THEN error ELSE COALESCE(error,'Assistant run lease expired after maximum attempts.') END,
              lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE status='running' AND lease_expires_at<=now()`,
    ));
  }

  async heartbeat(scope: AssistantScope, id: string, workerId: string, leaseMs = 60_000): Promise<boolean> {
    const rows = await this.inTenant(scope, (db) => db.query(
      `UPDATE assistant_runs SET lease_expires_at=now()+($6::bigint*interval '1 millisecond'), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3 AND id=$4::uuid
          AND status='running' AND lease_owner=$5 RETURNING id`,
      [scope.tenantId, scope.userId, scope.assistantId, id, workerId,
        Math.min(900_000, Math.max(1_000, leaseMs))],
    ));
    return rows.length === 1;
  }

  async settle(scope: AssistantScope, id: string, succeeded: boolean, error?: string, workerId?: string): Promise<void> {
    await this.inTenant(scope, (db) => db.query(
      `UPDATE assistant_runs
          SET status=CASE WHEN $5::boolean THEN 'completed'
                          WHEN attempt<max_attempts THEN 'queued' ELSE 'failed' END,
              error=$6, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3 AND id=$4::uuid AND status='running'
          AND ($7::text IS NULL OR lease_owner=$7)`,
      [scope.tenantId, scope.userId, scope.assistantId, id, succeeded, error ?? null, workerId ?? null],
    ));
  }

  async createSchedule(scope: AssistantScope, input: {
    dueAt?: string;
    slot?: string;
    cronExpression?: string;
    timezone?: "UTC";
    resumePayload: Record<string, unknown>;
  }): Promise<AssistantSchedule> {
    if (input.cronExpression === undefined && input.dueAt === undefined) {
      throw new Error("A schedule requires dueAt or cronExpression.");
    }
    if (input.cronExpression !== undefined) parseCronExpression(input.cronExpression);
    const dueAt = input.dueAt ?? nextCronOccurrence(input.cronExpression as string, new Date()).toISOString();
    if (input.cronExpression !== undefined) {
      // Validate that the schedule can advance after its first slot before it is persisted.
      nextCronOccurrence(input.cronExpression, new Date(dueAt));
    }
    const slot = input.slot ?? new Date(dueAt).toISOString();
    const rows = await this.inTenant(scope, (db) => db.query<Record<string, unknown>>(
      `INSERT INTO assistant_schedules
         (id, tenant_id, user_id, assistant_id, due_at, slot, cron_expression, timezone, resume_payload)
       VALUES ($1::uuid,$2,$3,$4,$5::timestamptz,$6,$7,'UTC',$8::text::jsonb) RETURNING *`,
      [crypto.randomUUID(), scope.tenantId, scope.userId, scope.assistantId, dueAt, slot,
        input.cronExpression ?? null, JSON.stringify(input.resumePayload)],
    ));
    const row = rows[0];
    if (row === undefined) throw new Error("Could not create schedule.");
    return this.schedule(row);
  }

  async listSchedules(scope: AssistantScope): Promise<AssistantSchedule[]> {
    const rows = await this.inTenant(scope, (db) => db.query<Record<string, unknown>>(
      `SELECT * FROM assistant_schedules WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3 ORDER BY due_at ASC`,
      [scope.tenantId, scope.userId, scope.assistantId],
    ));
    return rows.map((row) => this.schedule(row));
  }

  async deleteSchedule(scope: AssistantScope, id: string): Promise<boolean> {
    const rows = await this.inTenant(scope, (db) => db.query(
      `DELETE FROM assistant_schedules WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3 AND id=$4::uuid RETURNING id`,
      [scope.tenantId, scope.userId, scope.assistantId, id],
    ));
    return rows.length === 1;
  }

  /** Materializes each due slot and advances recurring schedules in the same transaction. */
  async claimDue(limit = 50): Promise<AssistantRun[]> {
    return this.db.withOperator(async (operatorDb) => {
      const execute = async (db: Database): Promise<AssistantRun[]> => {
        await db.query("BEGIN");
        try {
          const due = await db.query<ScheduleRow>(
            `SELECT * FROM assistant_schedules
              WHERE enabled AND due_at<=now()
              ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
            [Math.min(200, Math.max(1, limit))],
          );
          const runs: AssistantRun[] = [];
          for (const schedule of due) {
            const dueAt = new Date(schedule.due_at);
            const slot = schedule.cron_expression === null ? schedule.slot : dueAt.toISOString();
            const rows = await db.query<Record<string, unknown>>(
              `INSERT INTO assistant_runs
                 (id,tenant_id,user_id,assistant_id,idempotency_key,resume_payload,max_attempts,attempt,origin)
               VALUES (gen_random_uuid(),$1,$2,$3,$4,$5::text::jsonb,1,0,'schedule')
               ON CONFLICT (tenant_id,user_id,assistant_id,idempotency_key) DO NOTHING RETURNING *`,
              [schedule.tenant_id, schedule.user_id, schedule.assistant_id,
                `schedule:${schedule.id}:${slot}`, JSON.stringify(schedule.resume_payload)],
            );
            if (rows[0] !== undefined) runs.push(this.run(rows[0]));
            if (schedule.cron_expression === null) {
              await db.query(
                `UPDATE assistant_schedules SET enabled=false, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
                  WHERE id=$1::uuid`,
                [schedule.id],
              );
            } else {
              try {
                const nextDue = nextCronOccurrence(schedule.cron_expression, dueAt).toISOString();
                await db.query(
                  `UPDATE assistant_schedules SET due_at=$2::timestamptz, slot=$2, lease_owner=NULL,
                      lease_expires_at=NULL, last_error=NULL, updated_at=now() WHERE id=$1::uuid`,
                  [schedule.id, nextDue],
                );
              } catch (error) {
                await db.query(
                  `UPDATE assistant_schedules SET enabled=false, lease_owner=NULL, lease_expires_at=NULL,
                      last_error=$2, updated_at=now() WHERE id=$1::uuid`,
                  [schedule.id, error instanceof Error ? error.message : String(error)],
                );
              }
            }
          }
          await db.query("COMMIT");
          return runs;
        } catch (error) {
          await db.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      };
      return operatorDb.withConnection !== undefined
        ? operatorDb.withConnection(execute)
        : execute(operatorDb);
    });
  }
}

/** Periodic queue drain and lease recovery. Dispatch is only called after an atomic claim. */
export class AssistantRunRecoverySweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly store: PostgresAssistantRunStore,
    private readonly dispatch: (run: AssistantRun) => Promise<void>,
    private readonly logger?: Logger,
  ) {}

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.store.recoverExpired();
      await this.store.claimDue();
      for (const run of await this.store.claimQueued()) {
        const workerId = run.leaseOwner;
        const heartbeat = workerId === undefined
          ? undefined
          : setInterval(
              () => void this.store.heartbeat(run.scope, run.id, workerId).catch(() => undefined),
              20_000,
            );
        heartbeat?.unref?.();
        try {
          await this.dispatch(run);
          await this.store.settle(run.scope, run.id, true, undefined, workerId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.store.settle(
            run.scope,
            run.id,
            false,
            message,
            workerId,
          );
          const fields = {
            runId: run.id,
            tenantId: run.scope.tenantId,
            assistantId: run.scope.assistantId,
            attempt: run.attempt,
            maxAttempts: run.maxAttempts,
            error: message,
          };
          if (run.attempt < run.maxAttempts) {
            this.logger?.warn("Assistant run dispatch failed; queued for retry", fields);
          } else {
            this.logger?.error("Assistant run dispatch failed permanently", fields);
          }
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private runTick(): void {
    void this.tick().catch((error: unknown) => {
      this.logger?.error("Assistant durable run sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  start(intervalMs = 10_000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.runTick(), Math.max(1_000, intervalMs));
    this.timer.unref?.();
    this.runTick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
