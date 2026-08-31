// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OIDC refresh-session store (`src/routes/oidc-session-store.ts`)
 *
 * The backend-driven (BFF) OIDC login (see `src/routes/auth-oidc.ts`) mints a
 * short-lived HS256 operator session token for the dashboard. To renew that
 * token WITHOUT sending the operator back through a full interactive login, the
 * backend must hold the IdP `refresh_token` — and it must stay on the BACKEND,
 * never in the browser (that is the whole point of the confidential-client BFF
 * pattern).
 *
 * This module owns that server-side storage: an opaque session id (kept in an
 * HttpOnly cookie) maps to the stored refresh token. `GET /monitoring/auth/refresh`
 * looks the refresh token up, exchanges it at the IdP for a fresh id_token, and
 * mints a new session token.
 *
 * Two implementations:
 *   - {@link InMemoryOidcSessionStore} — per-replica, fine for a single backend.
 *   - {@link RedisOidcSessionStore}    — cluster-wide, so a renewal that lands on
 *                                        another replica still finds the token.
 *
 * The store is opt-in end-to-end: when no store is wired the login still works,
 * it just cannot silently renew (the pre-refresh behaviour).
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import {
  createRedisClient,
  type RedisClientLike,
} from "../util/redis-client.js";

/** The persisted per-session secret material. Kept minimal on purpose. */
export interface OidcSessionRecord {
  /** The IdP refresh token used to obtain a fresh id/access token. */
  refreshToken: string;
  /** The identity subject, for audit/log correlation (never a credential). */
  sub?: string;
}

export interface OidcSessionStore {
  /** Persists (or overwrites) the record for `sessionId`, (re)setting its TTL. */
  set(
    sessionId: string,
    record: OidcSessionRecord,
    ttlSeconds: number,
  ): Promise<void>;
  /** Returns the record for `sessionId`, or undefined when absent/expired. */
  get(sessionId: string): Promise<OidcSessionRecord | undefined>;
  /** Removes the record (logout / failed refresh). Idempotent. */
  delete(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory (per-replica)
// ---------------------------------------------------------------------------

interface Entry {
  record: OidcSessionRecord;
  expiresAt: number;
}

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

export class InMemoryOidcSessionStore implements OidcSessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;

  constructor(clock: Clock = Date.now) {
    this.clock = clock;
  }

  async set(
    sessionId: string,
    record: OidcSessionRecord,
    ttlSeconds: number,
  ): Promise<void> {
    this.entries.set(sessionId, {
      record,
      expiresAt: this.clock() + Math.max(1, ttlSeconds) * 1000,
    });
  }

  async get(sessionId: string): Promise<OidcSessionRecord | undefined> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return undefined;
    if (this.clock() > entry.expiresAt) {
      this.entries.delete(sessionId);
      return undefined;
    }
    return entry.record;
  }

  async delete(sessionId: string): Promise<void> {
    this.entries.delete(sessionId);
  }

  /** Current entry count (diagnostics/tests). */
  size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Redis-backed (cluster-wide)
// ---------------------------------------------------------------------------

const KEY_PREFIX = "aiperator:oidc:session";

/**
 * Cluster-wide refresh-session store via Bun's native RedisClient. The record
 * is stored as JSON under a TTL'd key so an operator's renewal that lands on a
 * different replica still finds the refresh token. On any Redis error reads
 * fail CLOSED (return undefined → the client re-authenticates interactively),
 * which is the safe direction for a credential store.
 */
export class RedisOidcSessionStore implements OidcSessionStore {
  constructor(
    private readonly client: RedisClientLike,
    private readonly logger?: Logger,
  ) {}

  private key(sessionId: string): string {
    return `${KEY_PREFIX}:${sessionId}`;
  }

  async set(
    sessionId: string,
    record: OidcSessionRecord,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.client.send("SET", [
        this.key(sessionId),
        JSON.stringify(record),
        "EX",
        String(Math.max(1, ttlSeconds)),
      ]);
    } catch (err) {
      this.logger?.warn(
        "OIDC session store SET failed (silent renew may be unavailable)",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  async get(sessionId: string): Promise<OidcSessionRecord | undefined> {
    try {
      const res = await this.client.send("GET", [this.key(sessionId)]);
      if (res === null || res === undefined) return undefined;
      const str = typeof res === "string" ? res : String(res);
      if (str === "") return undefined;
      const parsed = JSON.parse(str) as OidcSessionRecord;
      if (typeof parsed.refreshToken !== "string") return undefined;
      return parsed;
    } catch (err) {
      this.logger?.warn(
        "OIDC session store GET failed — treating as no session",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return undefined;
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.client.send("DEL", [this.key(sessionId)]);
    } catch (err) {
      this.logger?.warn(
        "OIDC session store DEL failed (key will expire via TTL)",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

/**
 * Builds the refresh-session store: Redis-backed when a URL is configured and
 * Bun's RedisClient is available, otherwise the per-replica in-memory store.
 * Never returns undefined — silent renew always has SOMEWHERE to persist the
 * refresh token (a single-replica deployment is fully served by memory).
 */
export function createOidcSessionStore(
  redisUrl: string | undefined,
  logger?: Logger,
): OidcSessionStore {
  if (redisUrl !== undefined) {
    const client = createRedisClient<RedisClientLike>(
      redisUrl,
      "OIDC refresh-session store",
      logger,
    );
    if (client !== undefined) return new RedisOidcSessionStore(client, logger);
  }
  return new InMemoryOidcSessionStore();
}
