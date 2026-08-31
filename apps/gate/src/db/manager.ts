// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import knex, { type Knex } from "knex";
import type { DatabaseConfig } from "../config/schema.ts";
import { logger } from "../logger.ts";

/** A minimal query runner (Knex satisfies this; tests can fake it). */
export interface QueryRunner {
  raw(sql: string, bindings?: unknown): Promise<unknown> | unknown;
}

/** The database access surface used by tools and the prompt provider. */
export interface DbProvider {
  get(name: string): QueryRunner;
  names(): string[];
  /** Knex client identifier for the named database (e.g. "pg", "mysql2", "mssql"). */
  clientName(name: string): string | undefined;
  healthcheck(name: string): Promise<boolean>;
  destroyAll(): Promise<void>;
}

/**
 * The per-dialect SQL that arms a server-side statement timeout, or undefined
 * when the dialect has no equivalent knob.
 *
 * Exported for testing: the mapping is the whole substance of the feature, and
 * getting a dialect name wrong would silently leave the cap off.
 */
export function statementTimeoutSql(
  client: string,
  timeoutMs: number,
): string | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  const ms = Math.floor(timeoutMs);
  // Knex client aliases, e.g. "pg" / "postgres" / "postgresql".
  if (/^(pg|postgres|postgresql|cockroachdb)$/i.test(client)) {
    return `SET statement_timeout = ${ms}`;
  }
  if (/^(mysql|mysql2|mariadb)$/i.test(client)) {
    // MySQL 5.7.8+/8.x: milliseconds, SELECT-only. MariaDB uses seconds via a
    // different variable, so it is intentionally left to the MySQL form only
    // when the driver accepts it — a failure here is swallowed by the caller.
    return `SET SESSION MAX_EXECUTION_TIME = ${ms}`;
  }
  if (/^(mssql|tedious)$/i.test(client)) {
    // SQL Server has no server-side total-statement timeout; LOCK_TIMEOUT
    // (milliseconds) is the closest session-level cap and covers the common
    // failure mode of a tool query blocking on a lock. A CPU-bound scan is NOT
    // capped by this — that limitation is stated rather than papered over.
    return `SET LOCK_TIMEOUT ${ms}`;
  }
  // sqlite3, oracledb, others: no session-level statement timeout.
  return undefined;
}

/**
 * Build the Knex pool `afterCreate` hook that arms the statement timeout on
 * every freshly opened connection. Returns an empty object when the dialect has
 * no timeout support, so the pool config stays untouched.
 *
 * A failure to apply the timeout is deliberately non-fatal: it must not take
 * down a database whose user lacks permission to change the setting. It is
 * surfaced as a warning so the missing cap is visible rather than assumed.
 */
export function statementTimeoutHook(
  client: string,
  timeoutMs: number,
): Pick<Knex.PoolConfig, "afterCreate"> {
  const sql = statementTimeoutSql(client, timeoutMs);
  if (sql === undefined) return {};
  return {
    afterCreate: (conn: unknown, done: (err?: unknown, conn?: unknown) => void) => {
      const query = (conn as { query?: unknown }).query;
      if (typeof query !== "function") {
        // Driver without a raw `query` (e.g. mssql via tedious) — skip rather
        // than crash the pool; the warning makes the gap visible.
        logger.warn("statement timeout not applied: driver has no query()", {
          client,
          timeoutMs,
        });
        done(undefined, conn);
        return;
      }
      (query as (sql: string, cb: (err?: unknown) => void) => void).call(
        conn,
        sql,
        (err?: unknown) => {
          if (err) {
            logger.warn("failed to apply statement timeout", {
              client,
              timeoutMs,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          done(undefined, conn);
        },
      );
    },
  };
}

/**
 * Lazily creates and caches one Knex instance per configured database.
 *
 * `client` and `connection` are passed straight through to Knex, so any
 * supported dialect works (pg, mysql2, sqlite3, mssql, oracledb, ...). This is
 * the "universal" data-access layer: adding a new database is pure config.
 */
export class DatabaseManager implements DbProvider {
  private readonly instances = new Map<string, Knex>();

  constructor(private readonly configs: Record<string, DatabaseConfig>) {}

  /** Return (creating if needed) the Knex instance for a configured database. */
  get(name: string): Knex {
    const existing = this.instances.get(name);
    if (existing) return existing;

    const cfg = this.configs[name];
    if (!cfg) {
      throw new Error(`Unknown database '${name}'. Define it under 'databases' in the config.`);
    }

    const instance = knex({
      client: cfg.client,
      connection: cfg.connection as Knex.Config["connection"],
      pool: {
        ...cfg.pool,
        ...statementTimeoutHook(cfg.client, cfg.statementTimeoutMs),
      },
      searchPath: cfg.searchPath,
    });

    // PostgreSQL DATE (OID 1082) is calendar data, not a moment in time. Keep
    // it as the database's YYYY-MM-DD text rather than allowing a JavaScript
    // Date conversion whose serialisation can shift the calendar day by zone.
    // Knex already loads the configured driver, so using its driver avoids a
    // separate runtime `pg` import that production bundles do not carry.
    if (/^(pg|postgres|postgresql|cockroachdb)$/i.test(cfg.client)) {
      const pgTypes = (instance.client.driver as {
        types?: { setTypeParser(oid: number, parser: (value: string) => string): void };
      }).types;
      pgTypes?.setTypeParser(1082, (value: string) => value);
    }

    this.instances.set(name, instance);
    return instance;
  }

  /** Names of all configured databases. */
  names(): string[] {
    return Object.keys(this.configs);
  }

  /** Knex client identifier, e.g. "pg", "mysql2", "sqlite3". */
  clientName(name: string): string | undefined {
    const client = this.configs[name]?.client;
    return typeof client === "string" ? client : undefined;
  }

  /** Run a lightweight connectivity check against one database. */
  async healthcheck(name: string): Promise<boolean> {
    const db = this.get(name);
    await db.raw("select 1");
    return true;
  }

  /** Close every open pool (graceful shutdown). */
  async destroyAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((k) => k.destroy()));
    this.instances.clear();
  }
}
