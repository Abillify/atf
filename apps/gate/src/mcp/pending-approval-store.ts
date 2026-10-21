// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { randomUUID } from "node:crypto";
import { logger } from "../logger.ts";
import { approvalArgsFingerprint } from "./governance.ts";
import { TaskCapacityError } from "./tasks.ts";

/**
 * A pending tool-call approval of the stateless 2026 endpoint. The entry
 * survives resolution until `expiresAt` so the requester can poll the outcome
 * (and pick up the one-shot approval token) via `approvals/get`.
 */
export interface PendingApproval {
  requestState: string;
  owner: string;
  tenantId: string;
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
  evidenceContractHash?: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  /** Minted one-shot token, kept for the requester until `expiresAt`. */
  token?: string;
}

/** Cursor for `approvals/list`: base64url of `createdAt|requestState`. */
export const encodeApprovalCursor = (entry: { createdAt: number; requestState: string }): string =>
  Buffer.from(`${entry.createdAt}|${entry.requestState}`, "utf8").toString("base64url");

export const decodeApprovalCursor = (cursor: string): { createdAt: number; requestState: string } | undefined => {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = text.indexOf("|");
  if (sep <= 0) return undefined;
  const createdAt = Number(text.slice(0, sep));
  if (!Number.isFinite(createdAt)) return undefined;
  return { createdAt, requestState: text.slice(sep + 1) };
};

export const APPROVAL_PAGE_SIZE = 50;

/**
 * Storage for the pending approvals of the 2026 endpoint. The interface is
 * async so the same call sites work against the per-process memory store and
 * the shared Redis store. Redis failures reject with
 * `Error("approval store unavailable")` — fail-closed, the router answers
 * with JSON-RPC `-32603`.
 */
export interface PendingApprovalStoreLike {
  readonly backing: "memory" | "redis";
  create(
    owner: string,
    tenantId: string,
    tool: string,
    args: Record<string, unknown>,
    evidenceContractHash?: string,
  ): Promise<PendingApproval>;
  /**
   * Consume a pending request for resolution by its owner: the entry survives
   * (status and minted token) until `expiresAt` so the requester can poll it
   * via `approvals/get`, but a second resolution attempt no longer succeeds.
   */
  take(requestState: string, owner: string): Promise<PendingApproval | undefined>;
  /** Look at a pending request without consuming it (separation-of-duties checks). */
  peek(requestState: string): Promise<PendingApproval | undefined>;
  /**
   * Look at an entry without sweeping, so `approvals/get` can report `expired`.
   * The Redis key carries the remaining lifetime as its TTL, so there an entry
   * that expired is already gone and reads as not found instead.
   */
  lookup(requestState: string): Promise<PendingApproval | undefined>;
  /** Consume a pending request on behalf of a resolver other than its owner. */
  takeForeign(requestState: string): Promise<PendingApproval | undefined>;
  /** Record the outcome of a resolution; the entry is kept until `expiresAt`. */
  markResolved(requestState: string, status: "approved" | "denied", token?: string): Promise<void>;
  /**
   * Open (still pending) approvals of one tenant, oldest first, max `limit`
   * per page. `filter` decides which of the caller's tenant entries are
   * visible to them.
   */
  list(
    tenantId: string,
    filter: (entry: PendingApproval) => boolean,
    cursor?: string,
    limit?: number,
  ): Promise<{ approvals: PendingApproval[]; nextCursor?: string }>;
  /** Test-only reset; the Redis store does not implement it. */
  clear?(): void;
  close?(): Promise<void>;
}

/**
 * Single-process fallback (the store as it lived inside `stateless-2026.ts`).
 * Safe only with one replica; the production-readiness gate warns when more
 * replicas run without a shared Redis store.
 */
export class MemoryPendingApprovalStore implements PendingApprovalStoreLike {
  readonly backing = "memory" as const;
  private readonly entries = new Map<string, PendingApproval>();
  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}
  private sweep(now = Date.now()) {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
  async create(
    owner: string,
    tenantId: string,
    tool: string,
    args: Record<string, unknown>,
    evidenceContractHash?: string,
  ): Promise<PendingApproval> {
    this.sweep();
    if (this.entries.size >= this.maxEntries) throw new TaskCapacityError();
    const now = Date.now();
    const entry = {
      requestState: randomUUID(), owner, tenantId, tool,
      args: structuredClone(args),
      fingerprint: approvalArgsFingerprint(args),
      ...(evidenceContractHash !== undefined ? { evidenceContractHash } : {}),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: "pending" as const,
    };
    this.entries.set(entry.requestState, entry);
    return entry;
  }
  async take(requestState: string, owner: string): Promise<PendingApproval | undefined> {
    this.sweep();
    const entry = this.entries.get(requestState);
    if (!entry || entry.owner !== owner || entry.status !== "pending") return undefined;
    return entry;
  }
  async peek(requestState: string): Promise<PendingApproval | undefined> {
    this.sweep();
    return this.entries.get(requestState);
  }
  async lookup(requestState: string): Promise<PendingApproval | undefined> {
    return this.entries.get(requestState);
  }
  async takeForeign(requestState: string): Promise<PendingApproval | undefined> {
    this.sweep();
    const entry = this.entries.get(requestState);
    if (entry?.status !== "pending") return undefined;
    return entry;
  }
  async markResolved(requestState: string, status: "approved" | "denied", token?: string): Promise<void> {
    const entry = this.entries.get(requestState);
    if (!entry) return;
    entry.status = status;
    if (token !== undefined) entry.token = token;
  }
  async list(
    tenantId: string,
    filter: (entry: PendingApproval) => boolean,
    cursor?: string,
    limit = APPROVAL_PAGE_SIZE,
  ): Promise<{ approvals: PendingApproval[]; nextCursor?: string }> {
    this.sweep();
    let open = [...this.entries.values()]
      .filter((entry) => entry.tenantId === tenantId && entry.status === "pending" && filter(entry))
      .sort((a, b) => (a.createdAt === b.createdAt ? a.requestState.localeCompare(b.requestState) : a.createdAt - b.createdAt));
    if (cursor !== undefined && cursor !== "") {
      const after = decodeApprovalCursor(cursor);
      if (!after) return { approvals: [] };
      open = open.filter((entry) => entry.createdAt > after.createdAt
        || (entry.createdAt === after.createdAt && entry.requestState > after.requestState));
    }
    const page = open.slice(0, limit);
    const last = page[page.length - 1];
    return {
      approvals: page,
      ...(open.length > limit && last ? { nextCursor: encodeApprovalCursor(last) } : {}),
    };
  }
  clear() { this.entries.clear(); }
}

/** Minimal shape of the parts of the redis client we use (mirrors identity-rate-limit.ts). */
interface RedisLike {
  connect(): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
  on?(event: string, listener: (err: Error) => void): void;
  quit?(): Promise<unknown>;
}

const PENDING_KEY_PREFIX = "mcpgate:approval:pending:";
const TENANT_INDEX_PREFIX = "mcpgate:approval:tenant:";

/**
 * Shared cross-replica implementation: the entry lives as JSON under
 * `mcpgate:approval:pending:<requestState>` with `PX` set to its remaining
 * lifetime (Redis expires it), indexed per tenant in the ZSET
 * `mcpgate:approval:tenant:<tenantId>` scored by `createdAt`. A resolution
 * rewrites the entry with `XX KEEPTTL` so the requester can still poll it.
 */
export class RedisPendingApprovalStore implements PendingApprovalStoreLike {
  readonly backing = "redis" as const;
  constructor(private readonly client: RedisLike, private readonly ttlMs: number) {}

  private key(requestState: string): string {
    return `${PENDING_KEY_PREFIX}${requestState}`;
  }
  private indexKey(tenantId: string): string {
    return `${TENANT_INDEX_PREFIX}${tenantId}`;
  }
  /** Fail-closed: the underlying error is logged, the caller sees one stable message. */
  private fail(operation: string, err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`pending approval redis ${operation} failed: ${message}`);
    throw new Error("approval store unavailable");
  }
  private async read(requestState: string): Promise<PendingApproval | undefined> {
    const raw = await this.client.sendCommand(["GET", this.key(requestState)]);
    if (typeof raw !== "string") return undefined;
    return JSON.parse(raw) as PendingApproval;
  }

  async create(
    owner: string,
    tenantId: string,
    tool: string,
    args: Record<string, unknown>,
    evidenceContractHash?: string,
  ): Promise<PendingApproval> {
    const now = Date.now();
    const entry = {
      requestState: randomUUID(), owner, tenantId, tool,
      args: structuredClone(args),
      fingerprint: approvalArgsFingerprint(args),
      ...(evidenceContractHash !== undefined ? { evidenceContractHash } : {}),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: "pending" as const,
    };
    try {
      const written = await this.client.sendCommand([
        "SET", this.key(entry.requestState), JSON.stringify(entry),
        "PX", String(entry.expiresAt - now), "NX",
      ]);
      if (written !== "OK") throw new Error(`request state ${entry.requestState} already exists`);
      await this.client.sendCommand(["ZADD", this.indexKey(tenantId), String(entry.createdAt), entry.requestState]);
      return entry;
    } catch (err) {
      return this.fail("create", err);
    }
  }
  async take(requestState: string, owner: string): Promise<PendingApproval | undefined> {
    try {
      const entry = await this.read(requestState);
      if (!entry || entry.owner !== owner || entry.status !== "pending") return undefined;
      return entry;
    } catch (err) {
      return this.fail("take", err);
    }
  }
  async peek(requestState: string): Promise<PendingApproval | undefined> {
    try {
      return await this.read(requestState);
    } catch (err) {
      return this.fail("peek", err);
    }
  }
  async lookup(requestState: string): Promise<PendingApproval | undefined> {
    try {
      return await this.read(requestState);
    } catch (err) {
      return this.fail("lookup", err);
    }
  }
  async takeForeign(requestState: string): Promise<PendingApproval | undefined> {
    try {
      const entry = await this.read(requestState);
      if (entry?.status !== "pending") return undefined;
      return entry;
    } catch (err) {
      return this.fail("takeForeign", err);
    }
  }
  async markResolved(requestState: string, status: "approved" | "denied", token?: string): Promise<void> {
    try {
      const existing = await this.read(requestState);
      if (!existing) return;
      const updated: PendingApproval = {
        ...existing,
        status,
        ...(token !== undefined ? { token } : {}),
      };
      await this.client.sendCommand(["SET", this.key(requestState), JSON.stringify(updated), "XX", "KEEPTTL"]);
    } catch (err) {
      return this.fail("markResolved", err);
    }
  }
  async list(
    tenantId: string,
    filter: (entry: PendingApproval) => boolean,
    cursor?: string,
    limit = APPROVAL_PAGE_SIZE,
  ): Promise<{ approvals: PendingApproval[]; nextCursor?: string }> {
    try {
      const index = this.indexKey(tenantId);
      const members = await this.client.sendCommand(["ZRANGEBYSCORE", index, "-inf", "+inf"]);
      const states = Array.isArray(members) ? members.filter((m): m is string => typeof m === "string") : [];
      const values = states.length === 0
        ? []
        : await this.client.sendCommand(["MGET", ...states.map((state) => this.key(state))]);
      const rows = Array.isArray(values) ? values : [];
      const now = Date.now();
      const live: PendingApproval[] = [];
      const stale: string[] = [];
      for (let i = 0; i < states.length; i += 1) {
        const state = states[i];
        if (state === undefined) continue;
        const raw = rows[i];
        if (typeof raw !== "string") {
          stale.push(state);
          continue;
        }
        const entry = JSON.parse(raw) as PendingApproval;
        if (entry.expiresAt <= now) stale.push(entry.requestState);
        else live.push(entry);
      }
      if (stale.length > 0) await this.client.sendCommand(["ZREM", index, ...stale]);
      let open = live
        .filter((entry) => entry.tenantId === tenantId && entry.status === "pending" && filter(entry))
        .sort((a, b) => (a.createdAt === b.createdAt ? a.requestState.localeCompare(b.requestState) : a.createdAt - b.createdAt));
      if (cursor !== undefined && cursor !== "") {
        const after = decodeApprovalCursor(cursor);
        if (!after) return { approvals: [] };
        open = open.filter((entry) => entry.createdAt > after.createdAt
          || (entry.createdAt === after.createdAt && entry.requestState > after.requestState));
      }
      const page = open.slice(0, limit);
      const last = page[page.length - 1];
      return {
        approvals: page,
        ...(open.length > limit && last ? { nextCursor: encodeApprovalCursor(last) } : {}),
      };
    } catch (err) {
      return this.fail("list", err);
    }
  }
  async close(): Promise<void> {
    await this.client.quit?.();
  }
}

/**
 * Redis-backed when a URL is available (so `approvals/resolve` may hit a
 * different replica than the one that created the request); otherwise the
 * single-process memory store. Like the approval-consumption store this does
 * NOT throw without Redis: a single-replica deployment is safe with memory,
 * and the production-readiness gate warns about multi-replica setups that
 * leave the store unshared.
 */
export async function createPendingApprovalStore(
  redisUrl: string | undefined,
  ttlMs: number,
  maxPending: number,
): Promise<PendingApprovalStoreLike> {
  if (!redisUrl) return new MemoryPendingApprovalStore(ttlMs, maxPending);
  let redisMod: { createClient: (opts: { url: string }) => RedisLike };
  try {
    const redisName = "redis";
    redisMod = (await import(redisName)) as typeof redisMod;
  } catch {
    throw new Error(
      "pending approval store requires redis but the optional 'redis' package is " +
        "missing. Install it with: bun add redis",
    );
  }
  const client = redisMod.createClient({ url: redisUrl });
  client.on?.("error", (err: Error) => logger.error(`pending approval redis error: ${err.message}`));
  await client.connect();
  return new RedisPendingApprovalStore(client, ttlMs);
}
