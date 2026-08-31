// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import type { MqttBroker, MqttTool } from "../config/schema.ts";
import type { CachedMessage, MqttProvider } from "../mqtt/manager.ts";
import { logger } from "../logger.ts";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.ts";

type Transform = "auto" | "json" | "string" | "number" | "boolean";

/**
 * MQTT-backed tool.
 *
 * Returns the most recent retained value(s) for the configured topic(s):
 *   - single-topic mode (`topic`):   returns the transformed value directly
 *   - multi-topic mode (`topics[]`): returns a JSON object keyed by each
 *                                    mapping's `path`
 *
 * Subscriptions are established at construction time so values are already
 * cached by the time the first MCP call arrives.
 */
export class MqttToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly broker: MqttBroker;

  constructor(
    private readonly cfg: MqttTool,
    private readonly mqtt: MqttProvider & { resolveBroker(b?: MqttBroker): MqttBroker },
  ) {
    this.definition = {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.inputSchema as Record<string, unknown>,
      ...(cfg.outputSchema !== undefined
        ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
        : {}),
    };

    this.broker = this.mqtt.resolveBroker(cfg.broker);

    // Subscribe up front so the cache is warm.
    if (cfg.topic) {
      this.mqtt.subscribe(this.broker, cfg.topic);
    }
    for (const mapping of cfg.topics ?? []) {
      this.mqtt.subscribe(this.broker, mapping.topic);
    }
  }

  async execute(_args: Record<string, unknown>, _ctx: AuthContext): Promise<ToolResult> {
    // Multi-topic mode → object keyed by mapping.path
    if (this.cfg.topics && this.cfg.topics.length > 0) {
      const out: Record<string, unknown> = {};
      const stale: string[] = [];
      for (const mapping of this.cfg.topics) {
        const msg = this.mqtt.latest(this.broker, mapping.topic);
        const fresh = this.isFresh(msg);
        if (msg && fresh) {
          out[mapping.path] = decode(msg.raw, mapping.transform);
        } else if (mapping.defaultValue !== undefined) {
          out[mapping.path] = mapping.defaultValue;
        } else if (this.cfg.defaultValue !== undefined) {
          out[mapping.path] = this.cfg.defaultValue;
        } else {
          out[mapping.path] = null;
          stale.push(mapping.path);
        }
      }
      logger.debug("mqtt multi-topic read", { tool: this.cfg.name, keys: Object.keys(out).length, stale });
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
        meta: { source: "mqtt", topics: this.cfg.topics.length, stale },
      };
    }

    // Single-topic mode → transformed value directly.
    const msg = this.mqtt.latest(this.broker, this.cfg.topic!);
    if (!this.isFresh(msg)) {
      if (this.cfg.defaultValue !== undefined) {
        return {
          content: [{ type: "text", text: stringify(this.cfg.defaultValue) }],
          meta: { source: "mqtt", topic: this.cfg.topic, state: msg ? "expired" : "empty", usedDefault: true },
        };
      }
      const reason = msg
        ? `last message older than ttl (${this.cfg.ttlSeconds}s)`
        : "no message received yet";
      return {
        content: [{ type: "text", text: `No fresh MQTT value for '${this.cfg.topic}': ${reason}.` }],
        isError: true,
        meta: { source: "mqtt", topic: this.cfg.topic, state: msg ? "expired" : "empty" },
      };
    }

    const value = decode(msg!.raw, this.cfg.transform);
    const structured = value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
    return {
      content: [{ type: "text", text: stringify(value) }],
      structuredContent: structured,
      meta: {
        source: "mqtt",
        topic: msg!.topic,
        receivedAt: new Date(msg!.receivedAt).toISOString(),
        ageMs: Date.now() - msg!.receivedAt,
      },
    };
  }

  private isFresh(msg: CachedMessage | undefined): boolean {
    if (!msg) return false;
    if (this.cfg.ttlSeconds === undefined) return true;
    return Date.now() - msg.receivedAt <= this.cfg.ttlSeconds * 1000;
  }
}

/** Convert raw payload bytes according to the configured transform. */
function decode(raw: Buffer, transform: Transform): unknown {
  const text = raw.toString("utf8");
  switch (transform) {
    case "string":
      return text;
    case "number": {
      const n = parseFloat(text);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return ["true", "1", "yes", "on"].includes(text.trim().toLowerCase());
    case "json":
      return JSON.parse(text);
    case "auto":
    default:
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
  }
}

function stringify(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
