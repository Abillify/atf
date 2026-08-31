// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Async job store (`src/graph/job-store.ts`)
 *
 * A long agent run (deep multi-step tool loops, big RAG context, slow models)
 * can outlast a client's HTTP timeout or a mobile connection. The async/batch
 * mode lets a client submit a chat request, get a job id back immediately
 * (HTTP 202), and poll for the result later — instead of holding a streaming
 * connection open for minutes.
 *
 * This store tracks job lifecycle and the eventual result. Two implementations
 * back the same interface:
 *   - {@link InMemoryJobStore} — per-replica, bounded (LRU by creation), TTL'd.
 *     A submitted job must be polled from the replica that ran it (use sticky
 *     sessions). The default when no Redis is configured.
 *   - {@link RedisJobStore} — cluster-wide and durable across restarts. A job
 *     submitted on replica A is visible/pollable from replica B…N, and survives
 *     a replica crash (Redis holds the record with a TTL). This removes the
 *     sticky-session requirement and the "lost on restart" caveat for the
 *     async/batch path.
 *
 * The interface methods are async-tolerant (`X | Promise<X>`): the in-memory
 * store returns synchronously, the Redis store returns a Promise. Callers
 * `await` the result either way (a no-op for the synchronous case), exactly as
 * the idempotency store does.
 *
 * ## Durable Agent Runtime — lease, heartbeat, bounded retry
 *
 * Before this, a job that crashed mid-execution (the process died while
 * `status: "running"`) was invisible: no signal it had failed, and no path
 * back to `queued`. It just sat there until its TTL expired, and the client
 * polling `GET /v1/jobs/:id` saw "running" forever.
 *
 * `markRunning`/`heartbeat` now stamp a `leaseExpiresAt` — the deadline by
 * which the executing replica must either finish the job or renew the lease.
 * `listOrphaned` finds `running` jobs whose lease has passed (the executing
 * replica died without completing or renewing it) so a separate sweeper
 * (`job-recovery-sweeper.ts`) can act on them: retry, up to `maxAttempts`, via
 * `requeueForRetry`, or `fail` once attempts are exhausted.
 *
 * This is crash-RESILIENCE, not exact-step resumption: a retried attempt
 * re-runs the whole flow from the top using the `resumePayload` snapshot
 * taken at submission time, not a resume from wherever the crashed attempt
 * had gotten to. Exact mid-flow resumption would require every async job to
 * establish a LangGraph checkpoint thread (`checkpointer.ts`), which async
 * jobs do not do today; that is a materially larger change tracked
 * separately (see the ADR). The guarantee here is narrower but concrete: the
 * client eventually gets a result (or a clean, bounded failure) instead of a
 * job stuck in `running` with no recourse.
 *
 * `resumePayload` deliberately does NOT include the original `ssoToken` —
 * only `create`'s ephemeral in-memory execution ever saw the caller's bearer
 * token, and persisting it into this store (Redis, on a durable deployment)
 * would introduce a new secret-at-rest that never existed before. A retried
 * attempt therefore runs with whatever authority the flow can establish
 * without it (e.g. an assistant's own delegated credential, when the flow
 * targets one) — the same "no interactive token" situation a scheduled
 * trigger run is already in.
 *
 * No `any` at module boundaries.
 */

import type { ChatCompletionResponse } from "../types/openai.js";
import type { ChatMessage } from "../types/openai.js";
import type { VerifiedExecutionContextEnvelope } from "./verified-execution-context.js";
import type { Logger } from "../observability/logger.js";
import {
  createRedisClient,
  type RedisClientLike,
} from "../util/redis-client.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

/**
 * Minimal, SECRET-FREE snapshot of a submission, retained so a retry can
 * re-run the flow from scratch. It excludes the bearer token while preserving
 * the already-verified, non-secret authorization claims needed to re-run the
 * same admission decision after a crash.
 */
export interface JobResumePayload {
  flowId: string;
  messages: ChatMessage[];
  /** HMAC-attested authorization identity; never accepts a legacy unsigned context. */
  verifiedContext?: VerifiedExecutionContextEnvelope;
  /** Non-authoritative request attributes needed for deterministic routing. */
  routingContext?: {
    userName?: string;
    chatId?: string;
    sessionId?: string;
    messageId?: string;
    language?: string;
    plan?: string;
    requestParams?: Record<string, unknown>;
  };
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  /** Flow id the job runs. */
  model: string;
  /** Owning tenant/identity, for access scoping on read. */
  owner?: string;
  createdAt: string;
  updatedAt: string;
  /** Present once status is "completed". */
  result?: ChatCompletionResponse;
  /** Present once status is "failed". */
  error?: string;
  /**
   * Which attempt this is (1 = the original submission, 2+ = a recovery
   * retry). Surfaced on `GET /v1/jobs/:id` so a client can tell a delayed-but-
   * healthy job apart from one that already survived a crash.
   */
  attempt: number;
  /** Attempts allowed before the sweeper gives up and calls `fail`. Default 1 (no retry). */
  maxAttempts: number;
  /**
   * ISO-8601 deadline by which the executing replica must finish or renew
   * (`heartbeat`) while `status: "running"`. Undefined while `queued` or
   * terminal. A `running` job whose lease has passed is orphaned.
   */
  leaseExpiresAt?: string;
  /** Present when the job was submitted with retry enabled (`maxAttempts > 1`). */
  resumePayload?: JobResumePayload;
}

export interface JobStore {
  /** Creates a queued job and returns its record. */
  create(input: {
    id: string;
    model: string;
    owner?: string;
    /** Attempts allowed before giving up. Default 1 (no automatic retry). */
    maxAttempts?: number;
    /** Required when `maxAttempts > 1` — the retry has nothing to re-run without it. */
    resumePayload?: JobResumePayload;
  }): JobRecord | Promise<JobRecord>;
  /**
   * Marks a job running and starts its lease. `leaseMs` bounds how long the
   * executing replica has before it must either finish or call
   * {@link heartbeat} to renew — omit to leave the job leaseless (opts out of
   * orphan detection for that job, e.g. a deployment with no sweeper running).
   */
  markRunning(id: string, leaseMs?: number): void | Promise<void>;
  /**
   * Renews a `running` job's lease. Returns `false` (and does nothing) when
   * the job is unknown, expired, or no longer `running` — mirroring the
   * distributed semaphore's heartbeat semantics: a lease already reaped by
   * the sweeper must not be silently resurrected by a late heartbeat from a
   * replica that (from its own, possibly stalled, point of view) still holds
   * it.
   */
  heartbeat(id: string, leaseMs: number): boolean | Promise<boolean>;
  /**
   * Lists `running` jobs whose lease has passed as of `nowMs` — the
   * sweeper's candidate set. Bounded/best-effort; not intended as a general
   * job-listing API.
   */
  listOrphaned(nowMs: number): JobRecord[] | Promise<JobRecord[]>;
  /**
   * Requeues an orphaned job for another attempt: increments `attempt`,
   * flips status back to `queued`, and clears the lease. Returns `undefined`
   * (and does nothing) when the job is unknown, has no `resumePayload`, or
   * has already reached `maxAttempts` — the sweeper's signal to call
   * {@link fail} instead.
   */
  requeueForRetry(id: string): JobRecord | undefined | Promise<JobRecord | undefined>;
  /** Stores a successful result and marks the job completed. */
  complete(id: string, result: ChatCompletionResponse): void | Promise<void>;
  /** Marks a job failed with an error message. */
  fail(id: string, error: string): void | Promise<void>;
  /** Returns a job by id, or undefined if unknown/expired. */
  get(id: string): JobRecord | undefined | Promise<JobRecord | undefined>;
}

export type Clock = () => number;

export interface InMemoryJobStoreOptions {
  /** Entry TTL in seconds. Default 3600 (1h). */
  ttlSeconds?: number;
  /** Max entries before LRU eviction by creation order. Default 1000. */
  maxEntries?: number;
  clock?: Clock;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;

  constructor(options: InMemoryJobStoreOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlSeconds ?? 3600) * 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.clock = options.clock ?? Date.now;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private prune(): void {
    const now = this.clock();
    for (const [id, j] of this.jobs) {
      if (now - new Date(j.createdAt).getTime() > this.ttlMs) {
        this.jobs.delete(id);
      }
    }
    // LRU by insertion order (Map preserves it).
    while (this.jobs.size > this.maxEntries) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
  }

  create(input: {
    id: string;
    model: string;
    owner?: string;
    maxAttempts?: number;
    resumePayload?: JobResumePayload;
  }): JobRecord {
    const ts = this.nowIso();
    const rec: JobRecord = {
      id: input.id,
      status: "queued",
      model: input.model,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      createdAt: ts,
      updatedAt: ts,
      attempt: 1,
      maxAttempts: Math.max(1, input.maxAttempts ?? 1),
      ...(input.resumePayload !== undefined
        ? { resumePayload: input.resumePayload }
        : {}),
    };
    this.jobs.set(input.id, rec);
    this.prune();
    return rec;
  }

  markRunning(id: string, leaseMs?: number): void {
    const j = this.jobs.get(id);
    if (j === undefined) return;
    j.status = "running";
    j.updatedAt = this.nowIso();
    if (leaseMs !== undefined) {
      j.leaseExpiresAt = new Date(this.clock() + leaseMs).toISOString();
    } else {
      delete j.leaseExpiresAt;
    }
  }

  heartbeat(id: string, leaseMs: number): boolean {
    const j = this.jobs.get(id);
    if (j === undefined || j.status !== "running") return false;
    j.leaseExpiresAt = new Date(this.clock() + leaseMs).toISOString();
    j.updatedAt = this.nowIso();
    return true;
  }

  listOrphaned(nowMs: number): JobRecord[] {
    return [...this.jobs.values()].filter(
      (j) =>
        j.status === "running" &&
        j.leaseExpiresAt !== undefined &&
        new Date(j.leaseExpiresAt).getTime() <= nowMs,
    );
  }

  requeueForRetry(id: string): JobRecord | undefined {
    const j = this.jobs.get(id);
    if (j === undefined) return undefined;
    // Must still be "running" — a job that settled (completed/failed) or was
    // already requeued between listOrphaned() and this call must never be
    // pulled back to "queued", which would silently undo its real outcome.
    if (j.status !== "running") return undefined;
    if (j.resumePayload === undefined) return undefined;
    if (j.attempt >= j.maxAttempts) return undefined;
    j.attempt += 1;
    j.status = "queued";
    delete j.leaseExpiresAt;
    j.updatedAt = this.nowIso();
    return j;
  }

  complete(id: string, result: ChatCompletionResponse): void {
    const j = this.jobs.get(id);
    if (j === undefined) return;
    j.status = "completed";
    j.result = result;
    j.updatedAt = this.nowIso();
    delete j.leaseExpiresAt;
  }

  fail(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (j === undefined) return;
    j.status = "failed";
    j.error = error;
    j.updatedAt = this.nowIso();
    delete j.leaseExpiresAt;
  }

  get(id: string): JobRecord | undefined {
    const j = this.jobs.get(id);
    if (j === undefined) return undefined;
    if (this.clock() - new Date(j.createdAt).getTime() > this.ttlMs) {
      this.jobs.delete(id);
      return undefined;
    }
    return j;
  }
}

// ---------------------------------------------------------------------------
// Redis-backed store (cluster-wide + durable across restarts)
// ---------------------------------------------------------------------------

/** Minimal shape of the Bun-native RedisClient surface we use. */
export type JobRedisClient = RedisClientLike;

const JOB_KEY_PREFIX = "aiperator:job";

export interface RedisJobStoreOptions {
  /** Entry TTL in seconds. Default 3600 (1h). */
  ttlSeconds?: number;
}

/**
 * Cluster-wide, restart-durable job store backed by Bun's native RedisClient.
 *
 * Each job is a single JSON value at `aiperator:job:<id>` with a TTL. Lifecycle
 * updates (`markRunning`/`complete`/`fail`) read-modify-write the record while
 * preserving the original expiry (`SET … KEEPTTL`); an update to an
 * unknown/expired job is a no-op, matching the in-memory store. Because the
 * record lives in Redis, any replica can serve `GET /v1/jobs/:id`, so the
 * async/batch path no longer needs sticky sessions and a result is not lost
 * when the replica that produced it restarts.
 *
 * Reads/writes never throw into the caller: a Redis error is logged and the
 * call degrades (a failed write means the client keeps polling and may see a
 * stale status until TTL; a failed read returns undefined → HTTP 404). The
 * detached job runner is unaffected.
 */
export class RedisJobStore implements JobStore {
  private readonly ttlSeconds: number;

  constructor(
    private readonly client: JobRedisClient,
    private readonly logger?: Logger,
    opts: RedisJobStoreOptions = {},
  ) {
    this.ttlSeconds = Math.max(1, opts.ttlSeconds ?? 3600);
  }

  private key(id: string): string {
    return `${JOB_KEY_PREFIX}:${id}`;
  }

  async create(input: {
    id: string;
    model: string;
    owner?: string;
    maxAttempts?: number;
    resumePayload?: JobResumePayload;
  }): Promise<JobRecord> {
    const ts = new Date().toISOString();
    const rec: JobRecord = {
      id: input.id,
      status: "queued",
      model: input.model,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      createdAt: ts,
      updatedAt: ts,
      attempt: 1,
      maxAttempts: Math.max(1, input.maxAttempts ?? 1),
      ...(input.resumePayload !== undefined
        ? { resumePayload: input.resumePayload }
        : {}),
    };
    try {
      await this.client.send("SET", [
        this.key(input.id),
        JSON.stringify(rec),
        "EX",
        String(this.ttlSeconds),
      ]);
    } catch (err) {
      this.logger?.warn("Job create Redis error", {
        id: input.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return rec;
  }

  /** Read-modify-write a job, preserving its TTL. No-op on unknown/expired id. */
  private async mutate(
    id: string,
    fn: (rec: JobRecord) => void,
  ): Promise<void> {
    try {
      const rec = await this.get(id);
      if (rec === undefined) return;
      fn(rec);
      rec.updatedAt = new Date().toISOString();
      await this.client.send("SET", [
        this.key(id),
        JSON.stringify(rec),
        "KEEPTTL",
      ]);
    } catch (err) {
      this.logger?.warn("Job update Redis error", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Sorted-set index of currently-running jobs, scored by their
   * `leaseExpiresAt` (ms epoch) — mirrors the pattern
   * `distributed-semaphore.ts` already uses for its lease tracking. A single
   * key rather than an `SCAN aiperator:job:*` over the whole keyspace: Redis
   * `SCAN` is a non-blocking cursor iteration, but running it periodically
   * over every job key (most of which are terminal, not running) to find the
   * handful of orphans would be needless load on a large deployment. The
   * index is removed from on `complete`/`fail`/`requeueForRetry`, so it only
   * ever holds ids that are ACTUALLY `running`.
   */
  private static readonly RUNNING_INDEX_KEY = "aiperator:jobs:running";

  async markRunning(id: string, leaseMs?: number): Promise<void> {
    await this.mutate(id, (r) => {
      r.status = "running";
      if (leaseMs !== undefined) {
        r.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      } else {
        delete r.leaseExpiresAt;
      }
    });
    if (leaseMs !== undefined) {
      try {
        await this.client.send("ZADD", [
          RedisJobStore.RUNNING_INDEX_KEY,
          String(Date.now() + leaseMs),
          id,
        ]);
      } catch (err) {
        this.logger?.warn("Job running-index ZADD error", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async heartbeat(id: string, leaseMs: number): Promise<boolean> {
    const rec = await this.get(id);
    if (rec === undefined || rec.status !== "running") return false;
    const newExpiry = Date.now() + leaseMs;
    await this.mutate(id, (r) => {
      r.leaseExpiresAt = new Date(newExpiry).toISOString();
    });
    try {
      await this.client.send("ZADD", [
        RedisJobStore.RUNNING_INDEX_KEY,
        String(newExpiry),
        id,
      ]);
    } catch (err) {
      this.logger?.warn("Job heartbeat ZADD error", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  async listOrphaned(nowMs: number): Promise<JobRecord[]> {
    let ids: string[];
    try {
      // ZRANGEBYSCORE key -inf now — every running job whose lease already passed.
      const res = await this.client.send("ZRANGEBYSCORE", [
        RedisJobStore.RUNNING_INDEX_KEY,
        "-inf",
        String(nowMs),
      ]);
      ids = Array.isArray(res) ? res.map((v) => String(v)) : [];
    } catch (err) {
      this.logger?.warn("Job listOrphaned ZRANGEBYSCORE error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const recs: JobRecord[] = [];
    for (const id of ids) {
      const rec = await this.get(id);
      // The index and the record can disagree briefly (e.g. the record was
      // completed but the index entry not yet removed) — only trust records
      // that are still actually `running`.
      if (rec !== undefined && rec.status === "running") recs.push(rec);
    }
    return recs;
  }

  async requeueForRetry(id: string): Promise<JobRecord | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;
    // See InMemoryJobStore.requeueForRetry for why this check exists.
    if (existing.status !== "running") return undefined;
    if (existing.resumePayload === undefined) return undefined;
    if (existing.attempt >= existing.maxAttempts) return undefined;
    let next: JobRecord | undefined;
    await this.mutate(id, (r) => {
      r.attempt += 1;
      r.status = "queued";
      delete r.leaseExpiresAt;
      next = r;
    });
    await this.removeFromRunningIndex(id);
    return next;
  }

  private async removeFromRunningIndex(id: string): Promise<void> {
    try {
      await this.client.send("ZREM", [RedisJobStore.RUNNING_INDEX_KEY, id]);
    } catch (err) {
      this.logger?.warn("Job running-index ZREM error", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async complete(id: string, result: ChatCompletionResponse): Promise<void> {
    await this.mutate(id, (r) => {
      r.status = "completed";
      r.result = result;
      delete r.leaseExpiresAt;
    });
    await this.removeFromRunningIndex(id);
  }

  async fail(id: string, error: string): Promise<void> {
    await this.mutate(id, (r) => {
      r.status = "failed";
      r.error = error;
      delete r.leaseExpiresAt;
    });
    await this.removeFromRunningIndex(id);
  }

  async get(id: string): Promise<JobRecord | undefined> {
    try {
      const res = await this.client.send("GET", [this.key(id)]);
      if (res === null || res === undefined) return undefined;
      const str = typeof res === "string" ? res : String(res);
      if (str === "") return undefined;
      return JSON.parse(str) as JobRecord;
    } catch (err) {
      this.logger?.warn("Job get Redis error", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}

/**
 * Creates a cluster-wide Redis job store using Bun's native RedisClient, or
 * returns undefined when Redis is unavailable so the caller falls back to the
 * per-replica in-memory store.
 */
export function createRedisJobStore(
  redisUrl: string,
  logger?: Logger,
  opts?: RedisJobStoreOptions,
): JobStore | undefined {
  const client = createRedisClient<JobRedisClient>(
    redisUrl,
    "Distributed job store",
    logger,
  );
  return client ? new RedisJobStore(client, logger, opts) : undefined;
}
