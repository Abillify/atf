// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { hostname } from "node:os";
import mqtt, { type MqttClient, type IClientOptions } from "mqtt";
import type { MqttBroker } from "../config/schema.ts";
import { logger } from "../logger.ts";

/** A single retained message for a topic. */
export interface CachedMessage {
  /** Raw payload bytes as received. */
  raw: Buffer;
  /** Topic the message arrived on (may differ from the subscribed filter). */
  topic: string;
  receivedAt: number;
}

/** The MQTT surface used by mqtt-type tools. */
export interface MqttProvider {
  /** Ensure a subscription exists for the given broker + topic filter. */
  subscribe(broker: MqttBroker, topicFilter: string): void;
  /** Latest cached message matching a topic filter, or undefined. */
  latest(broker: MqttBroker, topicFilter: string): CachedMessage | undefined;
  /** Close all broker connections. */
  destroyAll(): Promise<void>;
}

/**
 * Manages one MQTT connection per distinct broker URL and keeps the most
 * recent message per subscribed topic in memory, so an mqtt-type tool can
 * return the latest value(s) synchronously on an MCP call.
 *
 * Topic wildcards (`+`, `#`) are supported: a subscription to `sensors/#`
 * stores the latest message for every concrete topic underneath it, and
 * `latest()` resolves a concrete topic by matching it against stored messages.
 */
export class MqttManager implements MqttProvider {
  /** brokerKey -> connection state */
  private readonly conns = new Map<
    string,
    {
      client: MqttClient;
      /** subscribed topic filters */
      filters: Set<string>;
      /** concrete topic -> latest message */
      messages: Map<string, CachedMessage>;
    }
  >();
  /** brokerKey -> TTL sweep timer (only when cacheTtlSeconds is configured) */
  private readonly sweeps = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly globalBroker?: MqttBroker) {}

  private brokerKey(broker: MqttBroker): string {
    // One connection per URL + identity. clientId differences are intentional.
    return `${broker.url}|${broker.username ?? ""}|${broker.clientId ?? ""}`;
  }

  /** Resolve the effective broker: per-tool override or the global default. */
  resolveBroker(override?: MqttBroker): MqttBroker {
    const broker = override ?? this.globalBroker;
    if (!broker) {
      throw new Error(
        "MQTT tool requires a broker: set a per-tool 'broker' or a top-level 'mqtt' config block.",
      );
    }
    return broker;
  }

  private connect(broker: MqttBroker): {
    client: MqttClient;
    filters: Set<string>;
    messages: Map<string, CachedMessage>;
  } {
    const key = this.brokerKey(broker);
    const existing = this.conns.get(key);
    if (existing) return existing;

    const options: IClientOptions = {
      clientId: broker.clientId ?? `mcpgate-${hostname()}-${Math.random().toString(16).slice(2, 8)}`,
      clean: broker.clean,
      keepalive: broker.keepalive,
      reconnectPeriod: broker.reconnectPeriod,
      connectTimeout: broker.connectTimeout,
      ...(broker.username ? { username: broker.username } : {}),
      ...(broker.password ? { password: broker.password } : {}),
      ...(broker.protocolVersion ? { protocolVersion: broker.protocolVersion as 4 | 5 } : {}),
    };

    const messages = new Map<string, CachedMessage>();
    const filters = new Set<string>();
    const client = mqtt.connect(broker.url, options);

    const maxTopics = broker.maxCachedTopics;
    const ttlMs = broker.cacheTtlSeconds !== undefined ? broker.cacheTtlSeconds * 1000 : undefined;

    client.on("connect", () => {
      logger.info(`mqtt connected to ${broker.url}`);
      // Re-subscribe everything on (re)connect.
      for (const f of filters) {
        client.subscribe(f, (err) => {
          if (err) logger.warn(`mqtt subscribe failed`, { topic: f, error: err.message });
        });
      }
    });
    client.on("reconnect", () => logger.debug(`mqtt reconnecting to ${broker.url}`));
    client.on("error", (err) => logger.warn(`mqtt error`, { url: broker.url, error: err.message }));
    client.on("close", () => logger.debug(`mqtt connection closed`, { url: broker.url }));
    client.on("message", (topic, payload) => {
      // LRU: re-inserting moves the topic to the end of the Map's order.
      messages.delete(topic);
      messages.set(topic, { raw: Buffer.from(payload), topic, receivedAt: Date.now() });
      // Bound memory for high-cardinality wildcard subscriptions.
      while (messages.size > maxTopics) {
        const oldest = messages.keys().next().value;
        if (oldest === undefined) break;
        messages.delete(oldest);
      }
    });

    const state = { client, filters, messages };
    this.conns.set(key, state);

    // Optional periodic TTL sweep to drop stale messages even when no new
    // message arrives to trigger LRU eviction.
    if (ttlMs !== undefined) {
      const sweep = setInterval(() => {
        const cutoff = Date.now() - ttlMs;
        for (const [topic, msg] of messages) {
          if (msg.receivedAt < cutoff) messages.delete(topic);
        }
      }, Math.max(ttlMs, 30_000));
      sweep.unref?.();
      this.sweeps.set(key, sweep);
    }

    return state;
  }

  subscribe(broker: MqttBroker, topicFilter: string): void {
    const state = this.connect(broker);
    if (state.filters.has(topicFilter)) return;
    state.filters.add(topicFilter);
    if (state.client.connected) {
      state.client.subscribe(topicFilter, (err) => {
        if (err) logger.warn(`mqtt subscribe failed`, { topic: topicFilter, error: err.message });
        else logger.debug(`mqtt subscribed`, { topic: topicFilter });
      });
    }
    // If not yet connected, the "connect" handler subscribes all filters.
  }

  latest(broker: MqttBroker, topicFilter: string): CachedMessage | undefined {
    const key = this.brokerKey(broker);
    const state = this.conns.get(key);
    if (!state) return undefined;

    // Exact match first.
    const exact = state.messages.get(topicFilter);
    if (exact) return exact;

    // Otherwise resolve the most recent message whose topic matches the filter.
    let best: CachedMessage | undefined;
    for (const msg of state.messages.values()) {
      if (topicMatches(topicFilter, msg.topic)) {
        if (!best || msg.receivedAt > best.receivedAt) best = msg;
      }
    }
    return best;
  }

  async destroyAll(): Promise<void> {
    for (const timer of this.sweeps.values()) clearInterval(timer);
    this.sweeps.clear();
    await Promise.all(
      [...this.conns.values()].map(
        (s) =>
          new Promise<void>((resolve) => {
            s.client.end(true, {}, () => resolve());
          }),
      ),
    );
    this.conns.clear();
  }
}

/**
 * MQTT topic-filter matching with `+` (single level) and `#` (multi level).
 */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    const seg = f[i]!;
    if (seg === "#") return true; // matches remainder (including zero levels)
    if (t[i] === undefined) return false;
    if (seg === "+") continue;
    if (seg !== t[i]) return false;
  }
  return f.length === t.length;
}
