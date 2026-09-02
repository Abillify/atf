// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PostgreSQL connection layer (`src/db/database.ts`)
 *
 * Thin wrapper around Bun's native `SQL` client exposing a narrow, mockable
 * `Database` interface. The rest of the codebase depends only on this interface
 * — never on Bun's SQL directly — so persistence-backed services can be unit
 * tested against an in-memory fake.
 *
 * Persistence is OPTIONAL. When `DATABASE_URL` is not configured the factory
 * returns `undefined` and every store falls back to its in-memory variant,
 * mirroring the existing Redis-optional pattern. A connection failure at
 * startup is fatal only when persistence was explicitly requested.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";

/**
 * Narrow database contract. `query` runs a parameterised statement (positional
 * `$1, $2, …` placeholders) and resolves to an array of row objects.
 */
export interface Database {
  /** Runs a parameterised query and returns all rows. */
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  /** Closes the underlying connection pool. */
  close(): Promise<void>;
  /** Executes a callback with a dedicated database client from the pool (or itself if not pooled). */
  withConnection?<T>(cb: (db: Database) => Promise<T>): Promise<T>;
  /**
   * Runs `cb` with the PostgreSQL Row-Level-Security tenant context bound to
   * `tenantId` for the duration of a single transaction. On a connection that
   * has tenant scoping enabled this:
   *   1. reserves a dedicated pooled connection,
   *   2. opens a transaction and sets the `app.current_tenant` GUC
   *      (`set_config(..., true)` → transaction-local, never leaks to the next
   *      lease of the pooled connection),
   *   3. runs `cb` against a `Database` bound to that connection,
   *   4. COMMITs (or ROLLBACKs on error) and releases the connection.
   *
   * When tenant scoping is disabled (the default) this is a pure pass-through
   * — `cb` runs against the shared client with no transaction and no GUC — so
   * behaviour is byte-for-byte identical to a direct `query`. The RLS policies
   * installed by `bun run scripts/cli.ts rls-setup --confirm` only take effect
   * once the GUC is set (`TENANT_RLS_ENABLED=true`) and the application uses a
   * least-privilege role. See docs/adr/0005-tenant-data-isolation.md.
   *
   * Only tenant-scoped data paths should use this. Cross-tenant/privileged
   * paths (API-key authentication lookup, the operator history/audit plane,
   * retention purges) intentionally do NOT set a tenant GUC and require a
   * BYPASSRLS role when enforced RLS is enabled.
   */
  withTenant?<T>(
    tenantId: string,
    cb: (db: Database) => Promise<T>,
  ): Promise<T>;
  /**
   * Runs `cb` on a dedicated **operator-plane** connection that carries the
   * BYPASSRLS Postgres role (configured via `DATABASE_OPERATOR_URL`). This is
   * required for cross-tenant reads — execution history, cost/billing
   * dashboards, audit log, retention purges — that are intentionally
   * tenant-agnostic and must not be filtered by the per-tenant RLS policy.
   *
   * When `DATABASE_OPERATOR_URL` is not configured (or TENANT_RLS_ENABLED is
   * false) this is a pure pass-through that runs `cb` on the regular app
   * connection, matching the previous behaviour exactly. Callers do NOT need to
   * check for the presence of this method — it is always defined once
   * constructed through {@link wrapBunSql} / {@link createDatabase}.
   *
   * ⚠️ The operator connection must connect as a role that has BYPASSRLS (or
   * is a Postgres superuser). Never use it for tenant-scoped writes.
   */
  withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T>;
}

/** Bun's `SQL` instance exposes an `unsafe(text, params)` method returning rows. */
interface BunSqlLike {
  unsafe(text: string, params?: readonly unknown[]): Promise<unknown>;
  close?: () => Promise<void> | void;
  end?: () => Promise<void> | void;
  reserve?(): Promise<BunSqlLike & { release(): void }>;
}

type BunSqlCtor = new (url: string, options?: { max?: number }) => BunSqlLike;

/**
 * Adapts a Bun `SQL` instance to the `Database` interface.
 * Exported for direct use/testing with a compatible client.
 *
 * @param options.tenantScoping When true, {@link Database.withTenant} reserves
 *   a connection, opens a transaction and sets the `app.current_tenant` GUC so
 *   PostgreSQL RLS policies are enforced. When false/omitted (the default),
 *   `withTenant` is a pure pass-through with no transaction overhead.
 * @param options.operatorSql When provided, {@link Database.withOperator} uses
 *   this separate BYPASSRLS pool for cross-tenant operator-plane reads.
 *   When absent, `withOperator` is a pass-through to the regular `sql` pool.
 */
export function wrapBunSql(
  sql: BunSqlLike,
  options?: {
    tenantScoping?: boolean;
    operatorSql?: BunSqlLike;
    /** Used to report a silent RLS degradation — see `withTenant`. */
    logger?: Logger;
  },
): Database {
  const tenantScoping = options?.tenantScoping === true;
  // Latch so the RLS-degradation warning is emitted once per wrapper, not once
  // per tenant-scoped query.
  let warnedMissingReserve = false;
  const operatorSql = options?.operatorSql;
  // Pre-wrap the operator pool once so `withOperator` does not recreate the
  // wrapper on every call. Only instantiated when `operatorSql` is provided.
  const cachedOperatorDb: Database | undefined =
    operatorSql !== undefined
      ? wrapBunSql(operatorSql, { tenantScoping: false })
      : undefined;

  const db: Database = {
    async query<T = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      const rows = await sql.unsafe(text, params);
      return (Array.isArray(rows) ? rows : []) as T[];
    },
    async close(): Promise<void> {
      if (typeof sql.close === "function") {
        await sql.close();
      } else if (typeof sql.end === "function") {
        await sql.end();
      }
      // Also close the dedicated operator pool when one was opened.
      if (cachedOperatorDb !== undefined) {
        await cachedOperatorDb.close();
      }
    },
    async withConnection<T>(cb: (db: Database) => Promise<T>): Promise<T> {
      if (typeof sql.reserve === "function") {
        const reserved = await sql.reserve();
        try {
          return await cb(boundToReserved(reserved));
        } finally {
          reserved.release();
        }
      }
      return cb(this);
    },
    async withTenant<T>(
      tenantId: string,
      cb: (db: Database) => Promise<T>,
    ): Promise<T> {
      // Disabled (default): pure pass-through — no transaction, no GUC.
      if (!tenantScoping) return cb(this);
      // Tenant scoping requires connection affinity (the GUC and the queries
      // must share one connection). Without reserve() we cannot guarantee that,
      // so we degrade to pass-through rather than set a GUC on a connection a
      // query might not run on.
      //
      // This degradation is SECURITY-RELEVANT and must never be silent: the
      // caller asked for RLS enforcement and is getting application-level
      // filtering only, so a missing `WHERE tenant_id = $1` predicate would
      // leak across tenants instead of returning no rows. Logged once (not per
      // query) so a real deployment gets one loud line rather than a flood.
      if (typeof sql.reserve !== "function") {
        if (!warnedMissingReserve) {
          warnedMissingReserve = true;
          options?.logger?.warn(
            "Tenant scoping (RLS) is enabled but the SQL driver exposes no reserve() — " +
              "per-request app.current_tenant CANNOT be set, so Postgres RLS is NOT enforced. " +
              "Isolation now depends solely on application-level tenant_id predicates. " +
              "Verify the driver supports connection reservation before relying on TENANT_RLS_ENABLED.",
            { degraded: "tenant_rls_passthrough" },
          );
        }
        return cb(this);
      }

      const reserved = await sql.reserve();
      try {
        await reserved.unsafe("BEGIN");
        // Parameter-bound (never string-interpolated) → injection-safe even
        // though tenantId originates from the authenticated request context.
        // `true` = transaction-local: released on COMMIT/ROLLBACK, so a pooled
        // connection never carries one tenant's GUC into another's query.
        await reserved.unsafe(
          "SELECT set_config('app.current_tenant', $1, true)",
          [tenantId],
        );
        const result = await cb(boundToReserved(reserved));
        await reserved.unsafe("COMMIT");
        return result;
      } catch (err) {
        try {
          await reserved.unsafe("ROLLBACK");
        } catch {
          // A rollback failure must not mask the original error.
        }
        throw err;
      } finally {
        reserved.release();
      }
    },
    async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
      // No dedicated operator pool → pass-through (pre-RLS behaviour).
      if (cachedOperatorDb === undefined) return cb(this);
      // Delegate to the pre-wrapped BYPASSRLS pool.
      return cb(cachedOperatorDb);
    },
  };
  return db;
}

/**
 * Wraps a reserved (pinned) Bun SQL connection as a `Database`. All queries run
 * on that single connection, so a transaction/GUC opened on it stays in effect.
 * `close` is a no-op (the pool owns the connection lifecycle); nested
 * `withConnection`/`withTenant` reuse the same pinned connection.
 */
function boundToReserved(reserved: BunSqlLike & { release(): void }): Database {
  const bound: Database = {
    async query<U = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<U[]> {
      const rows = await reserved.unsafe(text, params);
      return (Array.isArray(rows) ? rows : []) as U[];
    },
    async close(): Promise<void> {},
    async withConnection<U>(cb: (db: Database) => Promise<U>): Promise<U> {
      return cb(this);
    },
    // The tenant GUC is already set on this pinned connection; nested calls just
    // reuse it rather than opening another (illegal) nested transaction.
    async withTenant<U>(
      _tenantId: string,
      cb: (db: Database) => Promise<U>,
    ): Promise<U> {
      return cb(this);
    },
    async withOperator<U>(cb: (db: Database) => Promise<U>): Promise<U> {
      return cb(this);
    },
  };
  return bound;
}

/**
 * Creates a `Database` from a Postgres connection URL using Bun's native SQL
 * client. Returns `undefined` when the runtime does not expose `SQL` (e.g. a
 * non-Bun runtime), letting the caller degrade to in-memory stores.
 *
 * The returned database is verified with a `SELECT 1` round-trip; a failure
 * rejects so the caller can decide whether to abort startup.
 *
 * @param options.operatorUrl When set AND `tenantScoping` is true, a second
 *   Postgres pool is opened at this URL and used for all {@link Database.withOperator}
 *   calls. That pool should connect as a BYPASSRLS role so cross-tenant
 *   operator-plane reads (dashboard history, cost snapshots, audit log) are not
 *   filtered by the per-tenant RLS policy. When absent, `withOperator` falls
 *   through to the regular app pool (matching the pre-RLS behaviour).
 */
export async function createDatabase(
  url: string,
  logger?: Logger,
  options?: { poolMax?: number; tenantScoping?: boolean; operatorUrl?: string },
): Promise<Database | undefined> {
  // Bun exposes the native SQL client as `Bun.SQL` (and, in some versions, as a
  // bare `SQL` global). Resolve either so persistence works across Bun versions
  // rather than silently degrading to in-memory when only `Bun.SQL` is present.
  const SqlCtor =
    (globalThis as { SQL?: BunSqlCtor }).SQL ??
    (globalThis as { Bun?: { SQL?: BunSqlCtor } }).Bun?.SQL;
  if (typeof SqlCtor !== "function") {
    logger?.warn(
      "DATABASE_URL is set but Bun's native SQL client is unavailable; persistence disabled",
    );
    return undefined;
  }

  let sql: BunSqlLike;
  try {
    // Bound the connection pool so a burst of concurrent queries cannot open an
    // unbounded number of Postgres connections (a common source of "too many
    // clients" outages under load).
    sql =
      options?.poolMax !== undefined
        ? new SqlCtor(url, { max: options.poolMax })
        : new SqlCtor(url);
  } catch (err) {
    throw new Error(
      `Failed to construct Postgres client: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const db = wrapBunSql(sql, {
    tenantScoping: options?.tenantScoping === true,
    ...(logger !== undefined ? { logger } : {}),
  });
  // Connectivity probe — surfaces bad credentials/host before the server starts.
  await db.query("SELECT 1");

  // Optional BYPASSRLS operator pool. Only opened when tenantScoping is enabled
  // and an operatorUrl is explicitly set, so existing deployments that don't use
  // enforced RLS are completely unaffected.
  if (options?.tenantScoping === true && options.operatorUrl !== undefined) {
    let opSql: BunSqlLike;
    try {
      opSql =
        options.poolMax !== undefined
          ? new SqlCtor(options.operatorUrl, {
              max: Math.max(2, Math.floor((options.poolMax ?? 10) / 4)),
            })
          : new SqlCtor(options.operatorUrl);
    } catch (err) {
      // Clean up the already-opened app pool before aborting.
      await db.close().catch(() => {});
      throw new Error(
        `Failed to construct operator Postgres client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Re-wrap the app client WITH the operator pool so a single Database routes
    // tenant-scoped reads to the app pool and cross-tenant operator reads to the
    // BYPASSRLS pool. Its close() tears down both pools (see wrapBunSql).
    const scopedDb = wrapBunSql(sql, {
      tenantScoping: true,
      operatorSql: opSql,
      ...(logger !== undefined ? { logger } : {}),
    });
    try {
      await scopedDb.withOperator((op) => op.query("SELECT 1"));
    } catch (err) {
      // Operator pool unreachable — tear down both pools before aborting.
      await scopedDb.close().catch(() => {});
      throw new Error(
        `Operator Postgres pool connectivity probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    logger?.info("Connected to PostgreSQL operator pool (BYPASSRLS)", {
      operatorUrl: options.operatorUrl.replace(/:[^:@]+@/, ":***@"),
    });
    return scopedDb;
  }

  logger?.info("Connected to PostgreSQL", {
    tenantRls: options?.tenantScoping === true,
  });
  return db;
}
