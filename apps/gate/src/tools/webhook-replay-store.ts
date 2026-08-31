// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { logger } from "../logger.ts";

export interface WebhookReplayStore {
  readonly backing: "memory" | "redis";
  /** Atomically reserve a nonce key for ttlMs. False means it was already reserved. */
  reserve(key: string, ttlMs: number): Promise<boolean>;
  healthcheck?(): Promise<void>;
  close?(): Promise<void>;
}

/** Explicit single-process Development fallback; never evicts a live nonce. */
export class MemoryWebhookReplayStore implements WebhookReplayStore {
  readonly backing = "memory" as const;
  private readonly expiresAt = new Map<string, number>();

  async reserve(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    for (const [candidate, expiry] of this.expiresAt) {
      if (expiry <= now) this.expiresAt.delete(candidate);
    }
    const current = this.expiresAt.get(key);
    if (current !== undefined && current > now) return false;
    this.expiresAt.set(key, now + ttlMs);
    return true;
  }
}

interface RedisLike {
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  on?(event: string, listener: (error: Error) => void): void;
}

class RedisWebhookReplayStore implements WebhookReplayStore {
  readonly backing = "redis" as const;
  constructor(private readonly client: RedisLike, private readonly prefix: string) {}

  async reserve(key: string, ttlMs: number): Promise<boolean> {
    return (await this.client.set(`${this.prefix}${key}`, "1", { NX: true, PX: ttlMs })) === "OK";
  }

  async healthcheck(): Promise<void> {
    if ((await this.client.ping()) !== "PONG") throw new Error("Webhook replay Redis did not return PONG");
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export async function createWebhookReplayStore(
  redisUrl: string | undefined,
  environment: string,
  prefix = "mcpgate:webhook:nonce:",
): Promise<WebhookReplayStore> {
  if (!redisUrl) {
    if (environment === "production") {
      throw new Error("Production webhook replay protection requires a shared Redis store");
    }
    logger.warn("webhook replay protection using explicit single-process development fallback");
    return new MemoryWebhookReplayStore();
  }
  const redis = await import("redis");
  const client = redis.createClient({ url: redisUrl }) as unknown as RedisLike;
  client.on?.("error", (error) => logger.error(`webhook replay redis error: ${error.message}`));
  await client.connect();
  return new RedisWebhookReplayStore(client, prefix);
}
