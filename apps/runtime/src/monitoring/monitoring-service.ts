// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Monitoring Service (`src/monitoring/monitoring-service.ts`)
 *
 * Distributes node execution events to all connected dashboard clients over
 * SSE or WebSocket (configurable via `AppConfig.monitoringTransport`).
 *
 * Horizontal scaling: when a Redis URL is configured, events are published to
 * a Redis channel and every backend replica re-broadcasts them to its locally
 * connected clients. Without Redis, a single in-memory fan-out is used.
 *
 * Security: when `monitoringAuthRequired` is set, the /monitoring/events route
 * requires a valid JWT-format token (header or ?token= query param).
 *
 * Requirements: 9.1, 9.2
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { upgradeWebSocket } from "hono/bun";
import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import type { NodeExecutionEvent } from "../types/monitoring.js";
import type { AppConfig } from "../config/index.js";
import { isValidJwtFormat, extractBearerToken } from "../middleware/auth.js";
import { createOperatorAuthorizer } from "../middleware/operator-rbac.js";
import { roleHasPermission } from "../middleware/operator-rbac.js";
import {
  signMonitoringTicket,
  verifyMonitoringTicket,
} from "./monitoring-ticket.js";
import type { Logger } from "../observability/logger.js";
import {
  createRedisClient,
  type RedisClientLike,
} from "../util/redis-client.js";
import { normalizeExecutionId } from "../util/execution-id.js";
import {
  InMemoryExecutionStore,
  type ExecutionStore,
  type ExecutionEventMeta,
  type ExecutionSummary,
  type UsageLogEntry,
  type HistoryQuery,
  type HistoryPage,
  type HistoryFacets,
  type FlowStats,
  parseHistorySortColumn,
} from "./execution-store.js";

// ---------------------------------------------------------------------------
// MonitoringClient
// ---------------------------------------------------------------------------

export interface MonitoringClient {
  /**
   * Delivers an event to the client. `id` is the monotonic sequence number used
   * for SSE `Last-Event-ID` resume — shared across replicas when Redis is wired,
   * otherwise per-replica. Transports that cannot resume (WebSocket) may ignore it.
   */
  send(event: NodeExecutionEvent, id?: string): void;
  close?(): void;
}

// ---------------------------------------------------------------------------
// Redis publisher/subscriber abstraction (optional)
// ---------------------------------------------------------------------------

/**
 * Minimal pub/sub interface so the service is decoupled from any specific
 * Redis client. Implemented with Bun's native RedisClient when REDIS_URL is set.
 *
 * `id` is the shared sequence number assigned at the origin, and `origin` is the
 * emitting replica's id — carried so a replica can skip re-broadcasting its OWN
 * events (which it already delivered locally), avoiding double-delivery.
 */
export interface MonitoringPubSub {
  publish(event: NodeExecutionEvent, id: string, origin: string): Promise<void>;
  subscribe(
    handler: (event: NodeExecutionEvent, id: string, origin: string) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

const REDIS_CHANNEL = "aiperator:monitoring";

/** Wire envelope for a fanned-out monitoring event (adds id + origin). */
interface MonitoringEnvelope {
  id: string;
  origin: string;
  event: NodeExecutionEvent;
}

/**
 * Creates a Bun-native Redis pub/sub adapter.
 * Returns undefined if Redis is unavailable or the URL is not set.
 */
export async function createRedisPubSub(
  redisUrl: string,
  logger?: Logger,
): Promise<MonitoringPubSub | undefined> {
  try {
    // Bun provides a native RedisClient global in Bun >= 1.2
    const RedisCtor = (
      globalThis as { RedisClient?: new (url: string) => unknown }
    ).RedisClient;
    if (typeof RedisCtor !== "function") {
      logger?.warn(
        "Redis requested but Bun RedisClient is unavailable; using in-memory monitoring",
      );
      return undefined;
    }

    // Separate connections for publish and subscribe (Redis requirement)
    const pubClient = new RedisCtor(redisUrl) as {
      publish: (channel: string, message: string) => Promise<number>;
      close?: () => void;
    };
    const subClient = new RedisCtor(redisUrl) as {
      subscribe: (
        channel: string,
        cb: (message: string) => void,
      ) => Promise<void>;
      close?: () => void;
    };

    return {
      async publish(
        event: NodeExecutionEvent,
        id: string,
        origin: string,
      ): Promise<void> {
        const envelope: MonitoringEnvelope = { id, origin, event };
        await pubClient.publish(REDIS_CHANNEL, JSON.stringify(envelope));
      },
      async subscribe(
        handler: (
          event: NodeExecutionEvent,
          id: string,
          origin: string,
        ) => void,
      ): Promise<void> {
        await subClient.subscribe(REDIS_CHANNEL, (message: string) => {
          try {
            const parsed = JSON.parse(message) as Partial<MonitoringEnvelope>;
            // Tolerate legacy bare-event messages (no envelope) during rollout.
            if (
              parsed &&
              typeof parsed === "object" &&
              "event" in parsed &&
              parsed.event
            ) {
              handler(
                parsed.event,
                typeof parsed.id === "string" ? parsed.id : "",
                typeof parsed.origin === "string" ? parsed.origin : "",
              );
            } else {
              handler(JSON.parse(message) as NodeExecutionEvent, "", "");
            }
          } catch {
            /* ignore malformed */
          }
        });
      },
      async close(): Promise<void> {
        pubClient.close?.();
        subClient.close?.();
      },
    };
  } catch (err) {
    logger?.warn("Failed to initialise Redis monitoring; using in-memory", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared event buffer (cross-replica Last-Event-ID resume)
// ---------------------------------------------------------------------------

/**
 * A bounded, ordered buffer of recent events that assigns each event a
 * monotonic id and can return everything after a given id — the backing store
 * for SSE `Last-Event-ID` resume. The Redis implementation makes both the
 * sequence AND the buffer CLUSTER-WIDE, so a dashboard that reconnects to a
 * different replica resumes correctly.
 */
export interface MonitoringEventBuffer {
  /** Assigns the next (shared) id, stores the event, and returns the id. */
  append(event: NodeExecutionEvent): Promise<string>;
  /** Events with id strictly greater than `lastId`, in ascending id order. */
  since(
    lastId: string,
  ): Promise<Array<{ id: string; event: NodeExecutionEvent }>>;
}

/**
 * Redis-backed shared buffer: a monotonic sequence via `INCR` and a capped
 * sorted set (score = id) holding the recent events. Any replica reads the same
 * authoritative history, so cross-replica resume works. The id-assigning `INCR`
 * is awaited (the caller needs the id); the store/trim writes are best-effort
 * (a failure only degrades replay, never live delivery).
 */
export class RedisEventBuffer implements MonitoringEventBuffer {
  private readonly seqKey = "aiperator:monitoring:seq";
  private readonly bufKey = "aiperator:monitoring:buffer";

  constructor(
    private readonly client: RedisClientLike,
    private readonly max = 1000,
    private readonly logger?: Logger,
  ) {}

  async append(event: NodeExecutionEvent): Promise<string> {
    const raw = await this.client.send("INCR", [this.seqKey]);
    const id = String(typeof raw === "number" ? raw : Number(raw));
    const member = `${id}:${JSON.stringify(event)}`;
    // Store + trim to the most recent `max` entries. Best-effort.
    this.client
      .send("ZADD", [this.bufKey, id, member])
      .then(() =>
        this.client.send("ZREMRANGEBYRANK", [
          this.bufKey,
          "0",
          String(-(this.max + 1)),
        ]),
      )
      .catch((err) => {
        this.logger?.warn(
          "Monitoring buffer ZADD/trim failed (resume degraded)",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
      });
    return id;
  }

  async since(
    lastId: string,
  ): Promise<Array<{ id: string; event: NodeExecutionEvent }>> {
    const n = Number(lastId);
    if (!Number.isFinite(n) || n <= 0) return [];
    try {
      const res = await this.client.send("ZRANGEBYSCORE", [
        this.bufKey,
        `(${n}`,
        "+inf",
        "LIMIT",
        "0",
        String(this.max),
      ]);
      const arr = Array.isArray(res) ? res : [];
      const out: Array<{ id: string; event: NodeExecutionEvent }> = [];
      for (const m of arr) {
        const s = typeof m === "string" ? m : String(m);
        const idx = s.indexOf(":");
        if (idx === -1) continue;
        const id = s.slice(0, idx);
        try {
          out.push({
            id,
            event: JSON.parse(s.slice(idx + 1)) as NodeExecutionEvent,
          });
        } catch {
          /* skip malformed member */
        }
      }
      return out;
    } catch (err) {
      this.logger?.warn("Monitoring buffer read failed — no resume backfill", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

/**
 * Builds the shared Redis event buffer, or undefined when Bun's RedisClient is
 * unavailable (the service then falls back to a per-replica in-memory ring).
 */
export function createRedisEventBuffer(
  redisUrl: string,
  logger?: Logger,
): MonitoringEventBuffer | undefined {
  const client = createRedisClient<RedisClientLike>(
    redisUrl,
    "Monitoring shared event buffer",
    logger,
  );
  return client ? new RedisEventBuffer(client, 1000, logger) : undefined;
}

// ---------------------------------------------------------------------------
// MonitoringService interface
// ---------------------------------------------------------------------------

export interface MonitoringServiceInterface {
  emitNodeEvent(
    executionId: string,
    event: NodeExecutionEvent,
    meta?: ExecutionEventMeta,
  ): void;
  subscribe(client: MonitoringClient): () => void;
  /**
   * Recent events buffered after the given sequence id (exclusive), used to
   * replay what an SSE client missed while briefly disconnected (`Last-Event-ID`
   * resume). Shared across replicas when Redis is wired, per-replica otherwise.
   * Optional — fakes without a buffer omit it and callers treat that as "no
   * replay available".
   */
  getBufferedEventsSince?(
    lastId: string,
  ): Promise<Array<{ id: string; event: NodeExecutionEvent }>>;
  /**
   * Whether another dashboard connection can be accepted. Bounds the number of
   * concurrent SSE/WebSocket subscribers per replica so a client cannot exhaust
   * sockets/memory. Always true when the limit is 0 (unlimited).
   */
  hasConnectionCapacity(): boolean;
  /** Current number of connected dashboard clients (this replica). */
  getConnectionCount(): number;
  getTransportType(): "sse" | "websocket";
  /** Recent execution rollups for the dashboard history view. */
  getHistory(limit: number): Promise<ExecutionSummary[]>;
  /**
   * A filterable, paginated page of execution rollups (plus the total matching
   * count) for the dashboard history view.
   */
  getHistoryPage(query: HistoryQuery): Promise<HistoryPage>;
  /** Distinct flow ids and user names available as history filters. */
  getHistoryFacets(): Promise<HistoryFacets>;
  /**
   * Per-flow run statistics (runs, avg runtime, avg/total cost) for every
   * execution started at or after the given ISO timestamp. Optional — fakes
   * without a backing store omit it and callers treat that as "no stats".
   */
  getFlowStats?(sinceIso: string): Promise<FlowStats[]>;
  /**
   * Recent permanent per-request token-usage records (flow, time, duration,
   * tokens, model, user, prompt preview, cost). Survive retention purges.
   */
  getUsageLog(limit: number): Promise<UsageLogEntry[]>;
  /** All node events for one execution (audit detail). */
  getExecutionEvents(executionId: string): Promise<NodeExecutionEvent[]>;
  /** Clears the entire execution history. Returns the number of runs removed. */
  clearHistory(): Promise<number>;
}

// ---------------------------------------------------------------------------
// MonitoringService implementation
// ---------------------------------------------------------------------------

export class MonitoringService implements MonitoringServiceInterface {
  private readonly clients = new Set<MonitoringClient>();
  private readonly transportType: "sse" | "websocket";
  private readonly pubsub: MonitoringPubSub | undefined;
  private readonly logger: Logger | undefined;
  private readonly executionStore: ExecutionStore;
  /** Max concurrent dashboard connections (0 = unlimited). */
  private readonly maxConnections: number;
  /**
   * Per-replica sequence + bounded ring used for Last-Event-ID resume when NO
   * shared Redis buffer is available (single replica, or Redis buffer down).
   */
  private localSeq = 0;
  private readonly localRing: Array<{ id: number; event: NodeExecutionEvent }> =
    [];
  private readonly ringMax = 1000;
  /**
   * Shared, cluster-wide event buffer (Redis). When present it supersedes the
   * local ring: ids come from a shared sequence and any replica can serve the
   * backfill, so resume works across replicas.
   */
  private readonly buffer: MonitoringEventBuffer | undefined;
  /** This replica's id — lets us skip re-broadcasting our OWN pub/sub echoes. */
  private readonly replicaId = randomUUID();
  /** Serialises shared-id assignment so ids and delivery order stay aligned. */
  private emitChain: Promise<void> = Promise.resolve();

  constructor(
    transportType: "sse" | "websocket",
    pubsub?: MonitoringPubSub,
    logger?: Logger,
    executionStore?: ExecutionStore,
    maxConnections = 0,
    buffer?: MonitoringEventBuffer,
  ) {
    this.transportType = transportType;
    this.pubsub = pubsub;
    this.logger = logger;
    this.maxConnections = Math.max(0, maxConnections);
    this.buffer = buffer;
    // Always have a store so the history endpoint works even without Postgres.
    this.executionStore = executionStore ?? new InMemoryExecutionStore();
    // When Redis is present, subscribe so events from OTHER replicas reach
    // this instance's locally connected clients. We SKIP our own echoes
    // (origin === this.replicaId) — they were already delivered locally.
    if (this.pubsub !== undefined) {
      void this.pubsub
        .subscribe((event, id, origin) => {
          if (origin === this.replicaId) return;
          this.broadcastLocal(event, id);
        })
        .catch((err) => {
          this.logger?.warn(
            "Monitoring Redis subscribe failed; cross-replica events unavailable",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        });
    }
  }

  subscribe(client: MonitoringClient): () => void {
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  hasConnectionCapacity(): boolean {
    return this.maxConnections === 0 || this.clients.size < this.maxConnections;
  }

  getConnectionCount(): number {
    return this.clients.size;
  }

  /** Broadcasts to locally connected clients only (no re-publish). */
  private broadcastLocal(event: NodeExecutionEvent, id?: string): void {
    for (const client of this.clients) {
      try {
        client.send(event, id);
      } catch {
        /* ignore per-client errors (Req 9.1) */
      }
    }
  }

  /**
   * Events buffered after `lastId` (exclusive), for SSE resume. Uses the shared
   * Redis buffer when available (cross-replica), else the local ring.
   */
  async getBufferedEventsSince(
    lastId: string,
  ): Promise<Array<{ id: string; event: NodeExecutionEvent }>> {
    if (this.buffer !== undefined) return this.buffer.since(lastId);
    const n = Number(lastId);
    if (!Number.isFinite(n) || n <= 0) return [];
    return this.localRing
      .filter((e) => e.id > n)
      .map((e) => ({ id: String(e.id), event: e.event }));
  }

  emitNodeEvent(
    executionId: string,
    event: NodeExecutionEvent,
    meta?: ExecutionEventMeta,
  ): void {
    const enriched: NodeExecutionEvent = {
      ...event,
      execution_id: executionId,
    };
    // Persist for audit/history at the ORIGIN only (cross-replica events arrive
    // via subscribe→broadcastLocal and must not be double-written).
    this.executionStore.recordEvent(enriched, meta);

    const pubsub = this.pubsub;
    const buffer = this.buffer;
    if (pubsub === undefined || buffer === undefined) {
      // Single replica (or no shared buffer): synchronous local fan-out with a
      // per-replica sequence id. Preserves the "emit → delivered now" contract.
      const id = ++this.localSeq;
      this.localRing.push({ id, event: enriched });
      if (this.localRing.length > this.ringMax) this.localRing.shift();
      this.broadcastLocal(enriched, String(id));
      // Still fan out live to other replicas when a pub/sub exists (ids are
      // per-replica in this degraded mode, so cross-replica resume is limited).
      if (this.pubsub !== undefined) {
        void this.pubsub
          .publish(enriched, String(id), this.replicaId)
          .catch((err) => {
            this.logger?.warn(
              "Monitoring Redis publish failed; event not fanned out cross-replica",
              { error: err instanceof Error ? err.message : String(err) },
            );
          });
      }
      return;
    }

    // Multi-replica with a shared Redis sequence: assign a cluster-wide id, then
    // fan out locally + cross-replica. Serialised so ids and delivery order stay
    // aligned even under concurrent emits.
    this.emitChain = this.emitChain
      .then(async () => {
        const id = await buffer.append(enriched);
        this.broadcastLocal(enriched, id);
        await pubsub.publish(enriched, id, this.replicaId);
      })
      .catch((err) => {
        this.logger?.warn("Monitoring shared-sequence emit failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  getTransportType(): "sse" | "websocket" {
    return this.transportType;
  }

  getHistory(limit: number): Promise<ExecutionSummary[]> {
    return this.executionStore.listRecent(limit);
  }

  getHistoryPage(query: HistoryQuery): Promise<HistoryPage> {
    return this.executionStore.listHistory(query);
  }

  getHistoryFacets(): Promise<HistoryFacets> {
    return this.executionStore.listHistoryFacets();
  }

  getFlowStats(sinceIso: string): Promise<FlowStats[]> {
    return this.executionStore.listFlowStats(sinceIso);
  }

  getUsageLog(limit: number): Promise<UsageLogEntry[]> {
    return this.executionStore.listRecentUsage(limit);
  }

  getExecutionEvents(executionId: string): Promise<NodeExecutionEvent[]> {
    return this.executionStore.listEvents(executionId);
  }

  clearHistory(): Promise<number> {
    return this.executionStore.clear();
  }
}

// ---------------------------------------------------------------------------
// Monitoring auth helper
// ---------------------------------------------------------------------------

/**
 * Validates the monitoring connection's token. Returns true if access is
 * allowed (auth disabled, or a valid JWT-format token is present).
 * Token sources: `Authorization: Bearer` header or `?token=` query param.
 */
export function isMonitoringAuthorized(
  authHeader: string | undefined,
  queryToken: string | undefined,
  required: boolean,
): boolean {
  if (!required) return true;
  const headerToken = extractBearerToken(authHeader);
  const token = headerToken ?? queryToken ?? null;
  return token !== null && isValidJwtFormat(token);
}

// ---------------------------------------------------------------------------
// createMonitoringRouter
// ---------------------------------------------------------------------------

export function createMonitoringRouter(
  service: MonitoringServiceInterface,
  options?: {
    authRequired?: boolean;
    operatorAuth?: import("../middleware/operator-rbac.js").OperatorAuthorizer;
    auditLog?: import("./../observability/audit-log.js").AuditLog;
    /**
     * HMAC secret for short-lived stream tickets. When set, `POST
     * /monitoring/ticket` issues a signed ticket the dashboard uses as `?token=`
     * instead of the long-lived operator token, and stream auth accepts a valid
     * ticket. When unset, the feature is inert (legacy token-in-URL only).
     */
    ticketSecret?: string;
    /** Ticket lifetime in seconds (default 60). */
    ticketTtlSeconds?: number;
  },
): Hono {
  const router = new Hono();
  const authRequired = options?.authRequired ?? false;
  const operatorAuth =
    options?.operatorAuth ?? createOperatorAuthorizer({ authRequired });
  const auditLog = options?.auditLog;
  const ticketSecret = options?.ticketSecret;
  const ticketTtlSeconds = options?.ticketTtlSeconds ?? 60;

  /**
   * Authorizes a request for a permission, accepting EITHER a valid short-lived
   * ticket in `?token=` (when ticketing is enabled) OR the standard operator
   * token / JWT. The ticket path lets the stream URL carry a disposable
   * credential instead of the reusable operator token.
   */
  const authorize = (
    authHeader: string | undefined,
    queryToken: string | undefined,
    permission: import("../middleware/operator-rbac.js").OperatorPermission,
  ): Promise<{ ok: boolean }> => {
    if (ticketSecret !== undefined && queryToken !== undefined) {
      const ticket = verifyMonitoringTicket(ticketSecret, queryToken);
      if (ticket !== undefined) {
        return Promise.resolve({
          ok: roleHasPermission(ticket.role, permission),
        });
      }
    }
    return operatorAuth.authorize(authHeader, queryToken, permission);
  };

  // Ticket endpoint — exchange the operator token (sent as a normal header,
  // never in a URL) for a short-lived signed ticket used by the SSE/WS stream.
  if (ticketSecret !== undefined) {
    router.post("/monitoring/ticket", async (ctx) => {
      const r = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:read",
      );
      if (!r.ok || r.actor === undefined) {
        return ctx.json(
          {
            error: {
              message: "Unauthorized monitoring access.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
      const { ticket, expiresIn } = signMonitoringTicket(
        ticketSecret,
        r.actor.role,
        ticketTtlSeconds,
      );
      return ctx.json({ ticket, expires_in: expiresIn, token_type: "ticket" });
    });
  }

  /** Read-plane auth (viewer+). Returns true when allowed. */
  const authedRead = async (ctx: {
    req: {
      header: (k: string) => string | undefined;
      query: (k: string) => string | undefined;
    };
  }): Promise<boolean> =>
    (
      await authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:read",
      )
    ).ok;

  // Bounded diagnostic view over the same ring used by SSE Last-Event-ID resume.
  router.get("/monitoring/events/buffer", async (ctx) => {
    if (!(await authedRead(ctx))) {
      return ctx.json(
        {
          error: {
            message: "Unauthorized monitoring access.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    const rawAfter = ctx.req.query("after");
    const afterNumber = rawAfter === undefined ? Number.NaN : Number(rawAfter);
    if (!Number.isSafeInteger(afterNumber) || afterNumber <= 0) {
      return ctx.json(
        {
          error: {
            message: "Query parameter 'after' must be a positive sequence id.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "100", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 500)
      : 100;
    const buffered =
      service.getBufferedEventsSince === undefined
        ? []
        : await service.getBufferedEventsSince(String(afterNumber));
    const events = buffered.slice(0, limit);
    const firstId = events[0] === undefined ? undefined : Number(events[0].id);
    return ctx.json({
      after: String(afterNumber),
      events,
      nextAfter: events.at(-1)?.id ?? String(afterNumber),
      gap:
        firstId !== undefined &&
        Number.isFinite(firstId) &&
        firstId > afterNumber + 1,
      scope: "resume-buffer",
    });
  });

  // History endpoints — durable execution audit for the dashboard "History" tab.
  // Protected by the same token gate as the live event stream.
  router.get("/monitoring/history", async (ctx) => {
    if (!(await authedRead(ctx))) {
      return ctx.json(
        {
          error: {
            message: "Unauthorized monitoring access.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 500)
      : 50;
    const rawOffset = Number.parseInt(ctx.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
    const parseFlows = (value: string | undefined): string[] | undefined => {
      const flows = value
        ?.split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      return flows !== undefined && flows.length > 0 ? flows : undefined;
    };
    const includeFlows = parseFlows(ctx.req.query("includeFlows"));
    const excludeFlows = parseFlows(ctx.req.query("excludeFlows"));
    const user = ctx.req.query("user");
    // Sorting: only whitelisted columns are accepted (see historySortClause);
    // anything else falls back to the default (started_at desc).
    const sortColumn = parseHistorySortColumn(ctx.req.query("sortBy"));
    const rawSortDir = ctx.req.query("sortDir");
    const sortDir =
      rawSortDir === "asc" || rawSortDir === "desc" ? rawSortDir : undefined;
    const query: HistoryQuery = {
      limit,
      offset,
      ...(includeFlows !== undefined ? { includeFlows } : {}),
      ...(excludeFlows !== undefined ? { excludeFlows } : {}),
      ...(user !== undefined && user !== "" ? { userName: user } : {}),
      ...(sortColumn !== undefined ? { sortColumn } : {}),
      ...(sortDir !== undefined ? { sortDir } : {}),
    };
    const { executions, total } = await service.getHistoryPage(query);
    return ctx.json({ executions, total, limit, offset });
  });

  // Distinct flow ids and user names for the History view's filter dropdowns.
  router.get("/monitoring/history/facets", async (ctx) => {
    if (!(await authedRead(ctx))) {
      return ctx.json(
        {
          error: {
            message: "Unauthorized monitoring access.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    const facets = await service.getHistoryFacets();
    return ctx.json(facets);
  });

  // Per-flow run statistics (runs, avg runtime, avg/total cost) over a time
  // window — powers the flow table's stats columns. `since` is a required
  // ISO-8601 timestamp (the client picks the window, e.g. last 1h/1d/7d/30d).
  // Same read gate as the history endpoints.
  router.get("/monitoring/flow-stats", async (ctx) => {
    if (!(await authedRead(ctx))) {
      return ctx.json(
        {
          error: {
            message: "Unauthorized monitoring access.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    const sinceRaw = ctx.req.query("since");
    const sinceMs = sinceRaw === undefined ? Number.NaN : Date.parse(sinceRaw);
    if (!Number.isFinite(sinceMs)) {
      return ctx.json(
        {
          error: {
            message: "Query parameter 'since' must be an ISO-8601 timestamp.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (service.getFlowStats === undefined) {
      return ctx.json({ stats: [], since: new Date(sinceMs).toISOString() });
    }
    const stats = await service.getFlowStats(new Date(sinceMs).toISOString());
    return ctx.json({ stats, since: new Date(sinceMs).toISOString() });
  });

  // Permanent per-request token-usage log — the durable cost record (flow,
  // time, duration, tokens, model, user, prompt preview, cost). Unlike
  // /monitoring/history it is never pruned by retention. Same read gate.
  router.get("/monitoring/usage", async (ctx) => {
    if (!(await authedRead(ctx))) {
      return ctx.json(
        {
          error: {
            message: "Unauthorized monitoring access.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 500)
      : 50;
    const usage = await service.getUsageLog(limit);
    return ctx.json({ usage });
  });

  router.get("/monitoring/history/:id", async (ctx) => {
    if (!(await authedRead(ctx))) {
      return ctx.json(
        {
          error: {
            message: "Unauthorized monitoring access.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    // Accept the bare uuid or the `chatcmpl-<uuid>` id the chat endpoints report.
    const events = await service.getExecutionEvents(
      normalizeExecutionId(ctx.req.param("id")),
    );
    return ctx.json({ events });
  });

  // Clear the entire execution history (destructive operator action). Gated by
  // monitoring:write (operator/admin) — viewers cannot clear. Best-effort audit.
  router.delete("/monitoring/history", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:write",
    );
    if (!r.ok) {
      return ctx.json(
        {
          error: {
            message:
              "Unauthorized — clearing history requires operator access.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    const removed = await service.clearHistory();
    auditLog?.record({
      actor: r.actor?.name ?? "operator",
      ...(r.actor?.role !== undefined ? { role: r.actor.role } : {}),
      action: "monitoring.history.clear",
      outcome: "success",
      details: { removed },
    });
    return ctx.json({ cleared: removed });
  });

  // Audit trail — operator-plane action log (admin only). Only registered when
  // an audit log is wired (it always is in production wiring).
  if (auditLog !== undefined) {
    router.get("/monitoring/audit", async (ctx) => {
      const r = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "audit:read",
      );
      if (!r.ok) {
        return ctx.json(
          {
            error: {
              message: "Unauthorized — audit access requires admin.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
      const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "100", 10);
      const actor = ctx.req.query("actor");
      const action = ctx.req.query("action");
      const entries = await auditLog.list({
        ...(Number.isFinite(rawLimit) ? { limit: rawLimit } : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(action !== undefined ? { actionPrefix: action } : {}),
      });
      return ctx.json({ entries });
    });

    // ── SIEM-compatible audit export ─────────────────────────────────────────
    // GET /monitoring/audit/export?format=jsonl|cef&limit=N&actor=&action=
    //
    // Exports the audit log in machine-readable formats suitable for ingestion
    // into SIEM platforms (Splunk, Elastic SIEM, Microsoft Sentinel, etc.):
    //
    //   jsonl  — JSON Lines, one JSON object per line. Standard for Elastic/Splunk.
    //   cef    — ArcSight Common Event Format v0. Compatible with most SIEM vendors.
    //
    // Both formats include all fields from AuditRecord. The response is streamed
    // with Content-Type text/plain so large exports don't buffer in memory.
    router.get("/monitoring/audit/export", async (ctx) => {
      const r = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "audit:read",
      );
      if (!r.ok) {
        return ctx.json(
          {
            error: {
              message: "Unauthorized — audit export requires admin.",
              type: "authentication_error",
            },
          },
          401,
        );
      }

      const format = ctx.req.query("format") ?? "jsonl";
      if (format !== "jsonl" && format !== "cef") {
        return ctx.json(
          {
            error: {
              message: "Invalid format. Supported: 'jsonl' (default), 'cef'.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }

      const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "10000", 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 100_000)
        : 10_000;

      const actor = ctx.req.query("actor");
      const action = ctx.req.query("action");
      const entries = await auditLog.list({
        limit,
        ...(actor !== undefined ? { actor } : {}),
        ...(action !== undefined ? { actionPrefix: action } : {}),
      });

      const filename = `audit-export-${new Date().toISOString().slice(0, 10)}.${format === "cef" ? "txt" : "jsonl"}`;
      ctx.header("Content-Disposition", `attachment; filename="${filename}"`);
      ctx.header("Content-Type", "text/plain; charset=utf-8");
      ctx.header("X-Export-Count", String(entries.length));

      if (format === "jsonl") {
        // JSON Lines: one compact JSON object per line, newest first.
        const body = entries.map((e) => JSON.stringify(e)).join("\n");
        return ctx.text(body.length > 0 ? `${body}\n` : "");
      }

      // CEF (ArcSight Common Event Format v0)
      // Format: CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
      const CEF_VENDOR = "aiperator";
      const CEF_PRODUCT = "AuditLog";
      const CEF_VERSION_STR = "1.0";

      const escapeCef = (s: string): string =>
        s
          .replace(/\\/g, "\\\\")
          .replace(/\|/g, "\\|")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r");

      const severityForOutcome = (outcome?: string): number => {
        if (outcome === "denied") return 7;
        if (outcome === "error") return 5;
        return 3;
      };

      const lines = entries.map((e) => {
        const sev = severityForOutcome(e.outcome);
        const sig = escapeCef(e.action);
        const name = escapeCef(e.action);
        const ext: string[] = [
          `rt=${new Date(e.at).getTime()}`,
          `suser=${escapeCef(e.actor)}`,
          `act=${escapeCef(e.action)}`,
          `outcome=${escapeCef(e.outcome ?? "success")}`,
        ];
        if (e.target !== undefined) ext.push(`target=${escapeCef(e.target)}`);
        if (e.role !== undefined)
          ext.push(`cs1Label=role cs1=${escapeCef(e.role)}`);
        if (e.details !== undefined) {
          const detailsStr = JSON.stringify(e.details).slice(0, 512);
          ext.push(`msg=${escapeCef(detailsStr)}`);
        }
        return `CEF:0|${CEF_VENDOR}|${CEF_PRODUCT}|${CEF_VERSION_STR}|${sig}|${name}|${sev}|${ext.join(" ")}`;
      });

      return ctx.text(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    });

    // ── Tamper-evident hash-chain verification ──────────────────────────────
    // GET /monitoring/audit/verify?limit=N
    //
    // Recomputes each record's chain hash and confirms it both matches the
    // stored hash AND chains onto the previous record's stored hash. Any
    // mutation, deletion, or reordering of a historical row surfaces here as
    // `valid: false` with the first offending record id. Without `limit`,
    // verifies the FULL history from genesis — the only way to catch a
    // consistent wholesale rewrite of an early segment (see the caveat in
    // `verifyAuditChain`'s doc comment in src/observability/audit-log.ts).
    router.get("/monitoring/audit/verify", async (ctx) => {
      const r = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "audit:read",
      );
      if (!r.ok) {
        return ctx.json(
          {
            error: {
              message: "Unauthorized — audit verification requires admin.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
      const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "", 10);
      const result = await auditLog.verifyChain(
        Number.isFinite(rawLimit) ? rawLimit : undefined,
      );
      auditLog.record({
        actor: r.actor?.name ?? "operator",
        ...(r.actor?.role !== undefined ? { role: r.actor.role } : {}),
        action: "audit.chain.verify",
        outcome: result.valid ? "success" : "error",
        details: { checked: result.checked, brokenAt: result.brokenAt },
      });
      return ctx.json(result);
    });
  }

  if (service.getTransportType() === "sse") {
    router.get("/monitoring/events", async (ctx) => {
      // Auth check (Req: secure the monitoring endpoint)
      if (!(await authedRead(ctx))) {
        return ctx.json(
          {
            error: {
              message: "Unauthorized monitoring access.",
              type: "authentication_error",
            },
          },
          401,
        );
      }

      // Reject when at connection capacity (DoS guard) before opening a stream.
      if (!service.hasConnectionCapacity()) {
        ctx.header("Retry-After", "5");
        return ctx.json(
          {
            error: {
              message: "Monitoring connection limit reached.",
              type: "overloaded_error",
            },
          },
          503,
        );
      }

      // Resume support: EventSource re-sends the last id it saw via the
      // `Last-Event-ID` header; our manual reconnects pass it as ?lastEventId=.
      const lastEventId =
        ctx.req.header("Last-Event-ID") ?? ctx.req.query("lastEventId");

      return streamSSE(ctx, async (stream) => {
        let active = true;

        // Replay whatever the client missed while it was disconnected (only
        // when it presented a Last-Event-ID; a fresh connection starts live).
        if (
          lastEventId !== undefined &&
          lastEventId !== "" &&
          service.getBufferedEventsSince
        ) {
          const missed = await service.getBufferedEventsSince(lastEventId);
          for (const { id, event } of missed) {
            await stream.writeSSE({ id, data: JSON.stringify(event) });
          }
        }

        const client: MonitoringClient = {
          send(event: NodeExecutionEvent, id?: string): void {
            if (!active) return;
            stream
              .writeSSE({
                ...(id !== undefined ? { id } : {}),
                data: JSON.stringify(event),
              })
              .catch(() => {
                active = false;
              });
          },
        };

        const unsubscribe = service.subscribe(client);
        stream.onAbort(() => {
          active = false;
          unsubscribe();
        });

        const HEARTBEAT_INTERVAL_MS = 30_000;
        while (active) {
          await stream.sleep(HEARTBEAT_INTERVAL_MS);
          if (!active) break;
          try {
            await stream.write(": heartbeat\n\n");
          } catch {
            active = false;
          }
        }
      });
    });
  } else {
    router.get(
      "/monitoring/events",
      upgradeWebSocket(async (ctx) => {
        const authorized = await authedRead(ctx);
        let unsubscribe: (() => void) | null = null;

        return {
          onOpen(_event: Event, ws: WSContext) {
            if (!authorized) {
              ws.close(1008, "Unauthorized");
              return;
            }
            if (!service.hasConnectionCapacity()) {
              // 1013 = Try Again Later
              ws.close(1013, "Monitoring connection limit reached");
              return;
            }
            const client: MonitoringClient = {
              send(event: NodeExecutionEvent): void {
                try {
                  ws.send(JSON.stringify(event));
                } catch {
                  /* closed */
                }
              },
            };
            unsubscribe = service.subscribe(client);
          },
          onClose() {
            if (unsubscribe !== null) {
              unsubscribe();
              unsubscribe = null;
            }
          },
        };
      }),
    );
  }

  return router;
}

// ---------------------------------------------------------------------------
// createMonitoringService — factory function
// ---------------------------------------------------------------------------

export function createMonitoringService(
  config: AppConfig,
  pubsub?: MonitoringPubSub,
  logger?: Logger,
  executionStore?: ExecutionStore,
): MonitoringService {
  // Shared, cluster-wide resume buffer when Redis is configured — so a dashboard
  // reconnecting to a different replica still resumes from its Last-Event-ID.
  const buffer =
    config.redisUrl !== undefined
      ? createRedisEventBuffer(config.redisUrl, logger)
      : undefined;
  return new MonitoringService(
    config.monitoringTransport,
    pubsub,
    logger,
    executionStore,
    config.monitoringMaxConnections ?? 0,
    buffer,
  );
}
