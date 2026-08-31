// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * RLS degradation must be loud.
 *
 * `withTenant` sets `app.current_tenant` transaction-locally, which requires
 * connection affinity via `sql.reserve()`. When the driver exposes no
 * `reserve()`, the wrapper correctly declines to set a GUC on a connection the
 * queries might not run on — but it used to do so SILENTLY. That is the worst
 * possible failure mode for this control: the operator enabled
 * `TENANT_RLS_ENABLED`, believes Postgres is enforcing isolation, and is in fact
 * relying entirely on application-level `WHERE tenant_id = $1` predicates. A
 * single missing predicate then leaks across tenants instead of returning no
 * rows.
 */

import { describe, test, expect } from "bun:test";
import { wrapBunSql } from "../database.js";
import type { Database } from "../database.js";
import type { Logger, LogFields } from "../../observability/logger.js";

/**
 * `Database.withTenant` is optional on the interface (a store may be built on a
 * driver without it), but `wrapBunSql` always provides it. Narrow once here so
 * the tests read as calls rather than as a chain of non-null assertions.
 */
function withTenant<T>(
  db: Database,
  tenantId: string,
  cb: (db: Database) => Promise<T>,
): Promise<T> {
  if (db.withTenant === undefined) {
    throw new Error("wrapBunSql should always provide withTenant");
  }
  return db.withTenant(tenantId, cb);
}

interface Captured {
  message: string;
  fields?: LogFields;
}

function recordingLogger(): { logger: Logger; warns: Captured[] } {
  const warns: Captured[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, fields) => {
      warns.push({ message, ...(fields !== undefined ? { fields } : {}) });
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

/** A driver WITHOUT reserve() — the degradation trigger. */
function sqlWithoutReserve(): {
  sql: Parameters<typeof wrapBunSql>[0];
  queries: string[];
} {
  const queries: string[] = [];
  const sql = {
    unsafe: async (text: string) => {
      queries.push(text);
      return [];
    },
  } as unknown as Parameters<typeof wrapBunSql>[0];
  return { sql, queries };
}

/** A driver WITH reserve() — the healthy path. */
function sqlWithReserve(): {
  sql: Parameters<typeof wrapBunSql>[0];
  queries: string[];
} {
  const queries: string[] = [];
  const reserved = {
    unsafe: async (text: string) => {
      queries.push(text);
      return [];
    },
    release: () => {},
  };
  const sql = {
    unsafe: async (text: string) => {
      queries.push(text);
      return [];
    },
    reserve: async () => reserved,
  } as unknown as Parameters<typeof wrapBunSql>[0];
  return { sql, queries };
}

describe("withTenant degradation without reserve()", () => {
  test("warns that RLS is NOT enforced", async () => {
    const { logger, warns } = recordingLogger();
    const { sql } = sqlWithoutReserve();
    const db = wrapBunSql(sql, { tenantScoping: true, logger });

    await withTenant(db, "acme", async (scoped) => {
      await scoped.query("SELECT 1");
    });

    expect(warns).toHaveLength(1);
    const warn0 = warns[0];
    if (warn0 === undefined) throw new Error("expected a warning");
    expect(warn0.message).toContain("RLS is NOT enforced");
    expect(warn0.fields?.degraded).toBe("tenant_rls_passthrough");
  });

  test("the callback still runs (availability over silence, but reported)", async () => {
    const { logger } = recordingLogger();
    const { sql } = sqlWithoutReserve();
    const db = wrapBunSql(sql, { tenantScoping: true, logger });

    let ran = false;
    const result = await withTenant(db, "acme", async () => {
      ran = true;
      return "value";
    });
    expect(ran).toBe(true);
    expect(result).toBe("value");
  });

  test("no GUC is set on a connection the queries may not use", async () => {
    const { logger } = recordingLogger();
    const { sql, queries } = sqlWithoutReserve();
    const db = wrapBunSql(sql, { tenantScoping: true, logger });

    await withTenant(db, "acme", async (scoped) => {
      await scoped.query("SELECT 1");
    });
    expect(queries.some((q) => q.includes("set_config"))).toBe(false);
  });

  test("the warning is latched — one line, not one per query", async () => {
    const { logger, warns } = recordingLogger();
    const { sql } = sqlWithoutReserve();
    const db = wrapBunSql(sql, { tenantScoping: true, logger });

    for (let i = 0; i < 25; i++) {
      await withTenant(db, `tenant-${i}`, async () => undefined);
    }
    expect(warns).toHaveLength(1);
  });
});

describe("no false alarms", () => {
  test("a driver WITH reserve() sets the GUC and does not warn", async () => {
    const { logger, warns } = recordingLogger();
    const { sql, queries } = sqlWithReserve();
    const db = wrapBunSql(sql, { tenantScoping: true, logger });

    await withTenant(db, "acme", async (scoped) => {
      await scoped.query("SELECT 1");
    });

    expect(warns).toHaveLength(0);
    expect(queries.some((q) => q.includes("set_config"))).toBe(true);
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");
  });

  test("tenant scoping disabled is a pass-through and does not warn", async () => {
    // Not a degradation: the operator never asked for RLS enforcement.
    const { logger, warns } = recordingLogger();
    const { sql } = sqlWithoutReserve();
    const db = wrapBunSql(sql, { tenantScoping: false, logger });

    await withTenant(db, "acme", async () => undefined);
    expect(warns).toHaveLength(0);
  });

  test("works without a logger (never throws for lack of one)", async () => {
    const { sql } = sqlWithoutReserve();
    const db = wrapBunSql(sql, { tenantScoping: true });
    await expect(
      withTenant(db, "acme", async () => "ok"),
    ).resolves.toBe("ok");
  });
});
