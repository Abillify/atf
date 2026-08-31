// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Conversation checkpoint persistence (`src/graph/checkpointer.ts`)
 *
 * Enables stateful, resumable LangGraph threads. Each conversation (keyed by a
 * client-supplied `conversation_id`) becomes a LangGraph thread whose state is
 * persisted between requests — so a client can send only the new turn and the
 * server reconstructs prior context, and an interrupted run can resume.
 *
 * Design: the LangGraph `BaseCheckpointSaver` contract is implemented once in
 * {@link PersistentCheckpointSaver}, delegating all storage to a small
 * {@link CheckpointRepository}. That keeps the (subtle) saver logic — serde
 * round-tripping, tuple assembly, pending writes — fully unit-testable against
 * an in-memory repository, while the durable Postgres repository is a thin set
 * of parameterised queries.
 *
 * Stateless requests (no `conversation_id`) never touch a checkpointer, so the
 * default behaviour and the checkpoint tables stay free of ephemeral rows.
 *
 * No `any` at module boundaries.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  MemorySaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type {
  ChannelVersions,
  CheckpointListOptions,
  PendingWrite,
  CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import type { AppConfig } from "../config/index.js";

// ---------------------------------------------------------------------------
// Repository contract + records
// ---------------------------------------------------------------------------

export interface CheckpointRecord {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

export interface WriteRecord {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  idx: number;
  channel: string;
  type: string;
  value: Uint8Array;
}

/** Storage backend for {@link PersistentCheckpointSaver}. */
export interface CheckpointRepository {
  putCheckpoint(rec: CheckpointRecord): Promise<void>;
  getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | undefined>;
  getLatestCheckpoint(
    threadId: string,
    checkpointNs: string,
  ): Promise<CheckpointRecord | undefined>;
  listCheckpoints(
    threadId: string,
    checkpointNs: string,
    opts?: { limit?: number; beforeCheckpointId?: string },
  ): Promise<CheckpointRecord[]>;
  putWrite(rec: WriteRecord): Promise<void>;
  /**
   * Batched variant of {@link putWrite} for when a single LangGraph task
   * produces multiple channel writes (the common case — most nodes write
   * several state channels per step). Persisting them as one multi-row
   * statement instead of N sequential single-row INSERTs cuts the number of
   * round-trips per checkpoint step from N to 1, which matters because
   * `putWrites` is on the hot path of every graph step, not just at
   * shutdown/flush time like the node-events batching. Default
   * implementation falls back to sequential `putWrite` calls so existing
   * repository implementations (and test doubles) keep working unchanged.
   */
  putWriteBatch?(recs: WriteRecord[]): Promise<void>;
  getWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<WriteRecord[]>;
  /**
   * Deletes every checkpoint and write associated with a thread (across all
   * namespaces). Backs {@link PersistentCheckpointSaver.deleteThread} — the
   * LangGraph v1 abstract method used by the retention/RTBF sweep and any
   * caller that wants to permanently forget a conversation's graph state.
   */
  deleteThread(threadId: string): Promise<void>;
}

function asUint8(v: Uint8Array | string): Uint8Array {
  return typeof v === "string" ? new TextEncoder().encode(v) : v;
}

// ---------------------------------------------------------------------------
// In-memory repository (for tests and single-process use)
// ---------------------------------------------------------------------------

export class InMemoryCheckpointRepository implements CheckpointRepository {
  private readonly checkpoints: CheckpointRecord[] = [];
  private readonly writes: WriteRecord[] = [];

  async putCheckpoint(rec: CheckpointRecord): Promise<void> {
    const i = this.checkpoints.findIndex(
      (c) =>
        c.threadId === rec.threadId &&
        c.checkpointNs === rec.checkpointNs &&
        c.checkpointId === rec.checkpointId,
    );
    if (i >= 0) this.checkpoints[i] = rec;
    else this.checkpoints.push(rec);
  }

  async getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | undefined> {
    return this.checkpoints.find(
      (c) =>
        c.threadId === threadId &&
        c.checkpointNs === checkpointNs &&
        c.checkpointId === checkpointId,
    );
  }

  async getLatestCheckpoint(
    threadId: string,
    checkpointNs: string,
  ): Promise<CheckpointRecord | undefined> {
    const matching = this.checkpoints.filter(
      (c) => c.threadId === threadId && c.checkpointNs === checkpointNs,
    );
    return matching.length > 0 ? matching[matching.length - 1] : undefined;
  }

  async listCheckpoints(
    threadId: string,
    checkpointNs: string,
    opts?: { limit?: number; beforeCheckpointId?: string },
  ): Promise<CheckpointRecord[]> {
    let matching = this.checkpoints
      .filter((c) => c.threadId === threadId && c.checkpointNs === checkpointNs)
      .slice()
      .reverse(); // newest first
    if (opts?.beforeCheckpointId !== undefined) {
      const idx = matching.findIndex(
        (c) => c.checkpointId === opts.beforeCheckpointId,
      );
      if (idx >= 0) matching = matching.slice(idx + 1);
    }
    if (opts?.limit !== undefined) matching = matching.slice(0, opts.limit);
    return matching;
  }

  async putWrite(rec: WriteRecord): Promise<void> {
    const i = this.writes.findIndex(
      (w) =>
        w.threadId === rec.threadId &&
        w.checkpointNs === rec.checkpointNs &&
        w.checkpointId === rec.checkpointId &&
        w.taskId === rec.taskId &&
        w.idx === rec.idx,
    );
    if (i >= 0) this.writes[i] = rec;
    else this.writes.push(rec);
  }

  async putWriteBatch(recs: WriteRecord[]): Promise<void> {
    for (const rec of recs) await this.putWrite(rec);
  }

  async getWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<WriteRecord[]> {
    return this.writes.filter(
      (w) =>
        w.threadId === threadId &&
        w.checkpointNs === checkpointNs &&
        w.checkpointId === checkpointId,
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    const keptCheckpoints = this.checkpoints.filter((c) => c.threadId !== threadId);
    this.checkpoints.length = 0;
    this.checkpoints.push(...keptCheckpoints);
    const keptWrites = this.writes.filter((w) => w.threadId !== threadId);
    this.writes.length = 0;
    this.writes.push(...keptWrites);
  }
}

// ---------------------------------------------------------------------------
// Postgres repository (durable, cross-replica)
// ---------------------------------------------------------------------------

export class PostgresCheckpointRepository implements CheckpointRepository {
  constructor(private readonly db: Database) {}

  async putCheckpoint(rec: CheckpointRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
       DO UPDATE SET parent_checkpoint_id = EXCLUDED.parent_checkpoint_id,
                     type = EXCLUDED.type,
                     checkpoint = EXCLUDED.checkpoint,
                     metadata = EXCLUDED.metadata`,
      [
        rec.threadId,
        rec.checkpointNs,
        rec.checkpointId,
        rec.parentCheckpointId,
        rec.type,
        rec.checkpoint,
        rec.metadata,
      ],
    );
  }

  async getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | undefined> {
    const rows = await this.db.query<CheckpointRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
         FROM checkpoints
        WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`,
      [threadId, checkpointNs, checkpointId],
    );
    return rows[0] ? rowToCheckpoint(rows[0]) : undefined;
  }

  async getLatestCheckpoint(
    threadId: string,
    checkpointNs: string,
  ): Promise<CheckpointRecord | undefined> {
    const rows = await this.db.query<CheckpointRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
         FROM checkpoints
        WHERE thread_id = $1 AND checkpoint_ns = $2
        ORDER BY seq DESC
        LIMIT 1`,
      [threadId, checkpointNs],
    );
    return rows[0] ? rowToCheckpoint(rows[0]) : undefined;
  }

  async listCheckpoints(
    threadId: string,
    checkpointNs: string,
    opts?: { limit?: number; beforeCheckpointId?: string },
  ): Promise<CheckpointRecord[]> {
    const params: unknown[] = [threadId, checkpointNs];
    let where = "thread_id = $1 AND checkpoint_ns = $2";
    if (opts?.beforeCheckpointId !== undefined) {
      params.push(opts.beforeCheckpointId);
      // Compare on the monotonic seq of the boundary checkpoint, so pagination
      // is correct even when checkpoint IDs are not lexically ordered.
      where += ` AND seq < (SELECT seq FROM checkpoints
                              WHERE thread_id = $1 AND checkpoint_ns = $2
                                AND checkpoint_id = $${params.length})`;
    }
    let sql = `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
                 FROM checkpoints
                WHERE ${where}
                ORDER BY seq DESC`;
    if (opts?.limit !== undefined) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const rows = await this.db.query<CheckpointRow>(sql, params);
    return rows.map(rowToCheckpoint);
  }

  async putWrite(rec: WriteRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
       DO UPDATE SET channel = EXCLUDED.channel, type = EXCLUDED.type, value = EXCLUDED.value`,
      [
        rec.threadId,
        rec.checkpointNs,
        rec.checkpointId,
        rec.taskId,
        rec.idx,
        rec.channel,
        rec.type,
        rec.value,
      ],
    );
  }

  async putWriteBatch(recs: WriteRecord[]): Promise<void> {
    if (recs.length === 0) return;
    // Single multi-row INSERT with the same ON CONFLICT semantics as
    // putWrite, instead of N sequential statements — a `putWrites` call with
    // K channel writes (typically 2-6 for a real node) becomes one round-trip
    // instead of K.
    const values: string[] = [];
    const params: unknown[] = [];
    for (const rec of recs) {
      const base = params.length;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
      );
      params.push(
        rec.threadId,
        rec.checkpointNs,
        rec.checkpointId,
        rec.taskId,
        rec.idx,
        rec.channel,
        rec.type,
        rec.value,
      );
    }
    await this.db.query(
      `INSERT INTO checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES ${values.join(", ")}
       ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
       DO UPDATE SET channel = EXCLUDED.channel, type = EXCLUDED.type, value = EXCLUDED.value`,
      params,
    );
  }

  async getWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<WriteRecord[]> {
    const rows = await this.db.query<WriteRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value
         FROM checkpoint_writes
        WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3
        ORDER BY task_id ASC, idx ASC`,
      [threadId, checkpointNs, checkpointId],
    );
    return rows.map(rowToWrite);
  }

  async deleteThread(threadId: string): Promise<void> {
    // checkpoint_writes has no direct thread_id-independent FK cascade
    // assumption here — delete both tables explicitly, writes first, so a
    // concurrent read never sees writes without their owning checkpoint.
    await this.db.query(
      `DELETE FROM checkpoint_writes WHERE thread_id = $1`,
      [threadId],
    );
    await this.db.query(`DELETE FROM checkpoints WHERE thread_id = $1`, [
      threadId,
    ]);
  }
}

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array | Buffer | string;
  metadata: Uint8Array | Buffer | string;
}

interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number | string;
  channel: string;
  type: string | null;
  value: Uint8Array | Buffer | string | null;
}

function rowToCheckpoint(r: CheckpointRow): CheckpointRecord {
  return {
    threadId: r.thread_id,
    checkpointNs: r.checkpoint_ns,
    checkpointId: r.checkpoint_id,
    parentCheckpointId: r.parent_checkpoint_id,
    type: r.type ?? "json",
    checkpoint: asUint8(r.checkpoint as Uint8Array | string),
    metadata: asUint8(r.metadata as Uint8Array | string),
  };
}

function rowToWrite(r: WriteRow): WriteRecord {
  return {
    threadId: r.thread_id,
    checkpointNs: r.checkpoint_ns,
    checkpointId: r.checkpoint_id,
    taskId: r.task_id,
    idx: Number(r.idx),
    channel: r.channel,
    type: r.type ?? "json",
    value: asUint8((r.value ?? new Uint8Array()) as Uint8Array | string),
  };
}

// ---------------------------------------------------------------------------
// BaseCheckpointSaver implementation
// ---------------------------------------------------------------------------

function cfg(config: RunnableConfig): {
  threadId: string;
  checkpointNs: string;
  checkpointId?: string;
} {
  const c = (config.configurable ?? {}) as Record<string, unknown>;
  return {
    threadId: typeof c.thread_id === "string" ? c.thread_id : "",
    checkpointNs: typeof c.checkpoint_ns === "string" ? c.checkpoint_ns : "",
    checkpointId:
      typeof c.checkpoint_id === "string" ? c.checkpoint_id : undefined,
  };
}

/**
 * A {@link BaseCheckpointSaver} that delegates persistence to a
 * {@link CheckpointRepository}. Works with any repository implementation.
 */
export class PersistentCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly repo: CheckpointRepository) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, checkpointNs, checkpointId } = cfg(config);
    if (threadId === "") return undefined;

    const rec =
      checkpointId !== undefined
        ? await this.repo.getCheckpoint(threadId, checkpointNs, checkpointId)
        : await this.repo.getLatestCheckpoint(threadId, checkpointNs);
    if (rec === undefined) return undefined;

    const checkpoint = (await this.serde.loadsTyped(
      rec.type,
      rec.checkpoint,
    )) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(
      rec.type,
      rec.metadata,
    )) as CheckpointMetadata;

    const writeRecs = await this.repo.getWrites(
      threadId,
      checkpointNs,
      rec.checkpointId,
    );
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writeRecs.map(
        async (w): Promise<CheckpointPendingWrite> => [
          w.taskId,
          w.channel,
          await this.serde.loadsTyped(w.type, w.value),
        ],
      ),
    );

    return {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: rec.checkpointId,
        },
      },
      checkpoint,
      metadata,
      parentConfig:
        rec.parentCheckpointId !== null
          ? {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNs,
                checkpoint_id: rec.parentCheckpointId,
              },
            }
          : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { threadId, checkpointNs } = cfg(config);
    if (threadId === "") return;
    const before = options?.before
      ? cfg(options.before as RunnableConfig).checkpointId
      : undefined;
    const recs = await this.repo.listCheckpoints(threadId, checkpointNs, {
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(before !== undefined ? { beforeCheckpointId: before } : {}),
    });
    for (const rec of recs) {
      const checkpoint = (await this.serde.loadsTyped(
        rec.type,
        rec.checkpoint,
      )) as Checkpoint;
      const metadata = (await this.serde.loadsTyped(
        rec.type,
        rec.metadata,
      )) as CheckpointMetadata;
      yield {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: rec.checkpointId,
          },
        },
        checkpoint,
        metadata,
        parentConfig:
          rec.parentCheckpointId !== null
            ? {
                configurable: {
                  thread_id: threadId,
                  checkpoint_ns: checkpointNs,
                  checkpoint_id: rec.parentCheckpointId,
                },
              }
            : undefined,
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const { threadId, checkpointNs, checkpointId } = cfg(config);
    const [type, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
    const [, metadataBytes] = await this.serde.dumpsTyped(metadata);

    await this.repo.putCheckpoint({
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: checkpointId ?? null,
      type,
      checkpoint: checkpointBytes,
      metadata: metadataBytes,
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const { threadId, checkpointNs, checkpointId } = cfg(config);
    if (checkpointId === undefined) return;
    const recs: WriteRecord[] = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return {
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx,
          channel,
          type,
          value: bytes,
        };
      }),
    );
    if (recs.length === 0) return;
    if (this.repo.putWriteBatch !== undefined) {
      await this.repo.putWriteBatch(recs);
    } else {
      for (const rec of recs) await this.repo.putWrite(rec);
    }
  }

  /**
   * Deletes all checkpoints and pending writes for a thread. Required as of
   * LangGraph v1 (`BaseCheckpointSaver.deleteThread` is now abstract);
   * delegates to the repository so both the in-memory and Postgres backends
   * support permanently forgetting a conversation's graph state (RTBF).
   */
  async deleteThread(threadId: string): Promise<void> {
    await this.repo.deleteThread(threadId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds the checkpointer for the engine, or `undefined` when checkpointing is
 * disabled (the default — preserves fully stateless behaviour).
 *
 * - Postgres present → durable, cross-replica {@link PersistentCheckpointSaver}.
 * - No database      → in-process {@link MemorySaver} (resumable within one
 *   replica; lost on restart).
 */
export function createCheckpointer(
  config: AppConfig,
  db?: Database,
  logger?: Logger,
): BaseCheckpointSaver | undefined {
  if (config.checkpointingEnabled !== true) return undefined;
  if (db !== undefined) {
    logger?.info("Conversation checkpointing enabled (Postgres-backed)");
    return new PersistentCheckpointSaver(new PostgresCheckpointRepository(db));
  }
  logger?.warn(
    "Conversation checkpointing enabled with in-memory MemorySaver — state is lost on restart. Configure DATABASE_URL for durable threads.",
  );
  return new MemorySaver();
}
