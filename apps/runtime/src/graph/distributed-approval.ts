// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cluster-wide human-in-the-loop approval coordination
 * (`src/graph/distributed-approval.ts`)
 *
 * The base {@link ApprovalRegistry} (see `approval-gate.ts`) is in-process: a
 * run awaiting approval is pinned to the replica that opened its stream, and a
 * reviewer must hit that same replica to resolve it. Behind a load balancer
 * with N replicas this breaks down — the dashboard may land on a replica that
 * has never heard of the pending approval, so it neither lists nor can resolve
 * it.
 *
 * This decorator closes that gap WITHOUT re-architecting the synchronous
 * interrupt/resume path. The waiting Promise still lives on the owning replica
 * (that is where the SSE run is parked), but:
 *
 *   1. Each pending approval is mirrored into Redis (`SETEX`, TTL ≈ the approval
 *      timeout) so any replica can LIST the cluster-wide pending set.
 *   2. Resolutions are broadcast over a Redis pub/sub channel. A reviewer can
 *      POST a decision to ANY replica; the decision is published, and the
 *      replica that actually owns the waiter settles its local Promise. The
 *      mirror key is then deleted everywhere.
 *
 * Failure handling is fail-soft and never blocks the request path:
 *   - A Redis error while mirroring/listing degrades to the LOCAL view (exactly
 *     the prior single-replica behaviour) — the run still pauses and the owning
 *     replica can still resolve it directly.
 *   - The mirror key carries a TTL, so a crashed owner's pending entry
 *     self-heals out of the cluster-wide list instead of lingering forever.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import { createRedisClient } from "../util/redis-client.js";
import type {
  ApprovalDecision,
  ApprovalListener,
  ApprovalRegistry,
  ApprovalRequest,
  PendingApproval,
  ResolvedApproval,
} from "./approval-gate.js";

// ---------------------------------------------------------------------------
// Redis client surface
// ---------------------------------------------------------------------------

/** Minimal command client (Bun's native RedisClient `send`). */
export interface ApprovalRedisCommand {
  send(command: string, args: string[]): Promise<unknown>;
  close?(): void;
}

/** Pub/sub pair: a publishing command client + a dedicated subscriber. */
export interface ApprovalRedis {
  command: ApprovalRedisCommand;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  close(): Promise<void>;
}

const PENDING_PREFIX = "aiperator:approval:pending";
const RESOLVED_PREFIX = "aiperator:approval:resolved";
const RESOLVE_CHANNEL = "aiperator:approval:resolve";
/** How long a resolved-decision marker is retained for UI re-rendering. */
const RESOLVED_TTL_SECONDS = 3600;

interface ResolveMessage {
  id: string;
  decision: ApprovalDecision;
}

// ---------------------------------------------------------------------------
// Distributed registry
// ---------------------------------------------------------------------------

export class DistributedApprovalRegistry implements ApprovalRegistry {
  readonly enabled: boolean;
  readonly globalPatterns: readonly string[];
  readonly timeoutMs: number;
  private subscribed = false;

  constructor(
    private readonly local: ApprovalRegistry,
    private readonly redis: ApprovalRedis,
    private readonly ttlSeconds: number,
    private readonly logger?: Logger,
  ) {
    this.enabled = local.enabled;
    this.globalPatterns = local.globalPatterns;
    this.timeoutMs = local.timeoutMs;
  }

  /** Subscribes to the resolution channel. Call once at startup. */
  async start(): Promise<void> {
    if (this.subscribed) return;
    try {
      await this.redis.subscribe(RESOLVE_CHANNEL, (message) => {
        let msg: ResolveMessage;
        try {
          msg = JSON.parse(message) as ResolveMessage;
        } catch {
          return;
        }
        // Settle the local waiter if THIS replica owns it. resolve() is
        // idempotent (false when unknown/already settled), so replicas that do
        // not own the waiter simply ignore the broadcast.
        const settled = this.local.resolve(msg.id, msg.decision);
        if (settled === true) void this.removeMirror(msg.id);
      });
      this.subscribed = true;
      this.logger?.info("Distributed approval coordination enabled via Redis");
    } catch (err) {
      this.logger?.warn(
        "Failed to subscribe to approval resolution channel — falling back to local-only approvals",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  requires(
    toolRef: string,
    nodeConfig: Record<string, unknown> | undefined,
  ): boolean {
    return this.local.requires(toolRef, nodeConfig);
  }

  request(
    req: ApprovalRequest,
    notify?: ApprovalListener,
  ): Promise<ApprovalDecision> {
    let pendingId: string | undefined;
    const promise = this.local.request(req, (pending) => {
      pendingId = pending.id;
      void this.addMirror(pending);
      if (notify !== undefined) notify(pending);
    });
    // Whether the waiter is resolved by a human, a cross-replica broadcast, or
    // the local timeout auto-deny, drop the cluster-wide mirror entry.
    void promise.finally(() => {
      if (pendingId !== undefined) void this.removeMirror(pendingId);
    });
    return promise;
  }

  async resolve(id: string, decision: ApprovalDecision): Promise<boolean> {
    // Fast path: this replica owns the waiter — settle directly.
    const settledLocally = this.local.resolve(id, decision);
    if (settledLocally === true) {
      await this.removeMirror(id);
      // Persist the decision (so any replica can re-render the final state) and
      // broadcast so any stale mirror/listeners converge (idempotent).
      const localRecord = await this.local.getResolved(id);
      await this.storeResolved(
        localRecord ?? {
          id,
          approved: decision.approved,
          ...(decision.by !== undefined ? { by: decision.by } : {}),
          decidedAt: new Date().toISOString(),
        },
      );
      await this.publishResolution(id, decision);
      return true;
    }
    // Not local: the owner is (probably) another replica. Only acknowledge the
    // resolution if the approval is actually pending cluster-wide, so an unknown
    // id still returns 404 to the reviewer.
    const mirrored = await this.readMirror(id);
    if (mirrored === undefined) return false;
    await this.storeResolved({
      id,
      approved: decision.approved,
      ...(mirrored.tool !== undefined ? { tool: mirrored.tool } : {}),
      ...(decision.by !== undefined ? { by: decision.by } : {}),
      decidedAt: new Date().toISOString(),
    });
    await this.publishResolution(id, decision);
    return true;
  }

  async listPending(): Promise<PendingApproval[]> {
    try {
      const keys = await this.scanPending();
      if (keys.length === 0) return [];
      const records: PendingApproval[] = [];
      for (const key of keys) {
        const raw = await this.redis.command.send("GET", [key]);
        if (raw === null || raw === undefined) continue;
        const str = typeof raw === "string" ? raw : String(raw);
        if (str === "") continue;
        try {
          records.push(JSON.parse(str) as PendingApproval);
        } catch {
          /* ignore malformed entry */
        }
      }
      return records.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    } catch (err) {
      this.logger?.warn(
        "Approval listPending Redis error — returning local view only",
        { error: err instanceof Error ? err.message : String(err) },
      );
      const local = this.local.listPending();
      return local instanceof Promise ? local : Promise.resolve(local);
    }
  }

  /** Closes the underlying Redis connections. */
  async close(): Promise<void> {
    await this.redis.close();
  }

  /**
   * Best-effort list of recently-resolved decisions. Returns this replica's
   * local view (decisions it owned); resolved markers mirrored by other
   * replicas live per-id in Redis and are fetched on demand via getResolved.
   * Sufficient for dashboard colouring of graph nodes by approval outcome.
   */
  async listResolved(): Promise<ResolvedApproval[]> {
    const local = this.local.listResolved();
    return local instanceof Promise ? local : Promise.resolve(local);
  }

  async getResolved(id: string): Promise<ResolvedApproval | undefined> {
    // Prefer the local record (richest, includes the tool); fall back to the
    // Redis-mirrored marker so a replica that did not own the waiter can still
    // render the final state.
    const localVal = await this.local.getResolved(id);
    if (localVal !== undefined) return localVal;
    try {
      const raw = await this.redis.command.send("GET", [this.resolvedKey(id)]);
      if (raw === null || raw === undefined) return undefined;
      const str = typeof raw === "string" ? raw : String(raw);
      if (str === "") return undefined;
      return JSON.parse(str) as ResolvedApproval;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Redis helpers (all fail-soft)
  // -------------------------------------------------------------------------

  private key(id: string): string {
    return `${PENDING_PREFIX}:${id}`;
  }

  private resolvedKey(id: string): string {
    return `${RESOLVED_PREFIX}:${id}`;
  }

  private async addMirror(pending: PendingApproval): Promise<void> {
    // A per-request timeout override (e.g. a compliance-policy.yaml
    // approvalRules[].timeoutMs, ADR-0009) can exceed the registry's global
    // timeout the mirror TTL was sized for at construction — recompute the
    // margin here so the cluster-wide mirror does not expire (and vanish from
    // `GET /monitoring/approvals` on other replicas) before the local waiter
    // actually times out.
    const ttlSeconds =
      pending.timeoutMs !== undefined
        ? Math.max(1, Math.ceil(pending.timeoutMs / 1000) + 30)
        : this.ttlSeconds;
    try {
      await this.redis.command.send("SET", [
        this.key(pending.id),
        JSON.stringify(pending),
        "EX",
        String(ttlSeconds),
      ]);
    } catch (err) {
      this.logger?.warn(
        "Approval mirror write failed (local-only for this id)",
        {
          id: pending.id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  private async removeMirror(id: string): Promise<void> {
    try {
      await this.redis.command.send("DEL", [this.key(id)]);
    } catch {
      /* TTL will reap it */
    }
  }

  private async readMirror(id: string): Promise<PendingApproval | undefined> {
    try {
      const raw = await this.redis.command.send("GET", [this.key(id)]);
      if (raw === null || raw === undefined) return undefined;
      const str = typeof raw === "string" ? raw : String(raw);
      if (str === "") return undefined;
      return JSON.parse(str) as PendingApproval;
    } catch {
      return undefined;
    }
  }

  private async storeResolved(record: ResolvedApproval): Promise<void> {
    try {
      await this.redis.command.send("SET", [
        this.resolvedKey(record.id),
        JSON.stringify(record),
        "EX",
        String(RESOLVED_TTL_SECONDS),
      ]);
    } catch {
      /* re-rendering the final state is best-effort */
    }
  }

  private async publishResolution(
    id: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    try {
      const msg: ResolveMessage = { id, decision };
      await this.redis.publish(RESOLVE_CHANNEL, JSON.stringify(msg));
    } catch (err) {
      this.logger?.warn("Approval resolution publish failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** SCANs the keyspace for pending-approval mirror keys. */
  private async scanPending(): Promise<string[]> {
    const match = `${PENDING_PREFIX}:*`;
    const keys: string[] = [];
    let cursor = "0";
    do {
      const res = (await this.redis.command.send("SCAN", [
        cursor,
        "MATCH",
        match,
        "COUNT",
        "100",
      ])) as unknown;
      // Reply shape: [nextCursor, [key, ...]]
      if (!Array.isArray(res) || res.length < 2) break;
      cursor = String(res[0]);
      const batch = res[1];
      if (Array.isArray(batch)) {
        for (const k of batch) keys.push(String(k));
      }
    } while (cursor !== "0");
    return keys;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface DistributedApprovalOptions {
  /** Mirror-key TTL in seconds. Default derived from the approval timeout. */
  ttlSeconds?: number;
}

/**
 * Builds the Redis pub/sub pair (publisher command client + dedicated
 * subscriber) using Bun's native RedisClient, or returns undefined when it is
 * unavailable so the caller keeps the local-only registry.
 */
export function createApprovalRedis(
  redisUrl: string,
  logger?: Logger,
): ApprovalRedis | undefined {
  const command = createRedisClient<
    ApprovalRedisCommand & {
      publish: (channel: string, message: string) => Promise<unknown>;
    }
  >(redisUrl, "Distributed approvals", logger);
  if (command === undefined) return undefined;
  // Pub/sub needs a dedicated subscriber connection separate from the command
  // client. If it cannot be created, release the command client and degrade.
  const sub = createRedisClient<{
    subscribe: (
      channel: string,
      cb: (message: string) => void,
    ) => Promise<void>;
    close?: () => void;
  }>(redisUrl, "Distributed approvals (subscriber)", logger);
  if (sub === undefined) {
    command.close?.();
    return undefined;
  }
  return {
    command,
    publish: (channel, message) => command.publish(channel, message),
    subscribe: (channel, handler) => sub.subscribe(channel, handler),
    async close(): Promise<void> {
      command.close?.();
      sub.close?.();
    },
  };
}

/**
 * Wraps a local {@link ApprovalRegistry} with cluster-wide coordination when a
 * Redis URL is available. Returns the original registry unchanged when Redis is
 * not configured/available, so the behaviour is strictly additive.
 *
 * The returned registry must be `start()`-ed once to subscribe to resolutions.
 */
export async function createDistributedApprovalGate(
  local: ApprovalRegistry,
  redisUrl: string,
  timeoutMs: number,
  logger?: Logger,
  opts?: DistributedApprovalOptions,
): Promise<ApprovalRegistry> {
  const redis = createApprovalRedis(redisUrl, logger);
  if (redis === undefined) return local;
  // Give the mirror entry a little slack over the auto-deny timeout so a
  // pending approval never disappears from the cluster list before it settles.
  const ttlSeconds =
    opts?.ttlSeconds ?? Math.max(1, Math.ceil(timeoutMs / 1000) + 30);
  const registry = new DistributedApprovalRegistry(
    local,
    redis,
    ttlSeconds,
    logger,
  );
  await registry.start();
  return registry;
}
