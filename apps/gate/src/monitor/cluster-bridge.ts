// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { randomUUID } from "node:crypto";
import type { MonitorBus, MonitorEvent } from "./events.ts";
import { logger } from "../logger.ts";

/**
 * Optional Redis pub/sub bridge for the MonitorBus.
 *
 * ## What this solves (and what it does not)
 *
 * mcpgate's MCP sessions (Streamable HTTP `/mcp` and legacy `/sse`) are held
 * as in-memory objects (an SDK `Server` + transport bound to one Node
 * process). Migrating a live MCP session between processes would require
 * rebuilding the MCP SDK's transport layer around external state - out of
 * scope here, and not something most deployments need: put mcpgate behind a
 * load balancer with **sticky sessions** (route by `Mcp-Session-Id` /
 * cookie) and each instance serves its own sessions independently. Sticky
 * sessions remain a HARD REQUIREMENT for horizontal scaling.
 *
 * What multiple instances *can* usefully share without touching sessions:
 *   - result/router-decision caches -> already pluggable per-tool (see
 *     cache.ts); a Redis-backed TtlCache is a natural follow-up if needed.
 *   - the IP and per-identity rate limits -> already support a shared Redis
 *     store (server/rate-limit-store.ts, server/identity-rate-limit.ts).
 *   - the **monitoring dashboard / audit trail** -> today each instance only
 *     sees its own MonitorBus events, so an operator watching the dashboard
 *     on instance A misses tool calls served by instance B. This bridge
 *     fixes exactly that: it republishes every local MonitorEvent to a Redis
 *     pub/sub channel and re-emits events received from other instances onto
 *     the local bus, so the dashboard/SSE feed/audit log are cluster-wide
 *     regardless of which instance a request landed on.
 *
 * Entirely optional: disabled by default, and a complete no-op unless the
 * `redis` package is installed and `monitoring.cluster.redisUrl` is set.
 */
export interface MonitorClusterBridge {
  close(): Promise<void>;
}

interface RedisLike {
  connect(): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  quit(): Promise<unknown>;
  duplicate(): RedisLike;
  on?(event: string, listener: (err: Error) => void): void;
}

/** Envelope so a re-published event can be told apart from a locally originated one. */
interface Envelope {
  origin: string;
  event: MonitorEvent;
}

export async function createMonitorClusterBridge(
  bus: MonitorBus,
  redisUrl: string,
  channel: string = "mcpgate:monitor",
): Promise<MonitorClusterBridge> {
  let redisMod: { createClient: (opts: { url: string }) => RedisLike };
  try {
    const redisName = "redis";
    redisMod = (await import(redisName)) as typeof redisMod;
  } catch {
    throw new Error(
      "monitoring.cluster.redisUrl is set but the optional 'redis' package is missing. " +
        "Install it with: bun add redis",
    );
  }

  const origin = randomUUID();
  const publisher = redisMod.createClient({ url: redisUrl });
  publisher.on?.("error", (err: Error) => logger.error(`monitor cluster bridge (publisher) error: ${err.message}`));
  await publisher.connect();

  const subscriber = publisher.duplicate();
  subscriber.on?.("error", (err: Error) => logger.error(`monitor cluster bridge (subscriber) error: ${err.message}`));
  await subscriber.connect();

  await subscriber.subscribe(channel, (message: string) => {
    try {
      const envelope = JSON.parse(message) as Envelope;
      if (envelope.origin === origin) return; // ignore our own publications
      bus.ingestRemote(envelope.event);
    } catch (err) {
      logger.warn("monitor cluster bridge: failed to parse remote event", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const unsubscribeLocal = bus.subscribe((event) => {
    // Never re-publish an event that itself came from the cluster bridge -
    // otherwise every event would bounce between instances indefinitely.
    if (event.remote) return;
    const envelope: Envelope = { origin, event };
    publisher.publish(channel, JSON.stringify(envelope)).catch((err: Error) => {
      logger.warn("monitor cluster bridge: failed to publish event", { error: err.message });
    });
  });

  logger.info(`monitor cluster bridge connected (redis pub/sub, channel=${channel})`);

  return {
    async close() {
      unsubscribeLocal();
      await Promise.all([publisher.quit(), subscriber.quit()]).catch(() => { /* best-effort */ });
    },
  };
}
