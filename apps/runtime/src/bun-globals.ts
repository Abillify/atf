// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Bun global bootstrap (`src/bun-globals.ts`)
 *
 * Several optional integrations probe for a Bun-native client on `globalThis`:
 *   - `globalThis.SQL`         → Postgres (persistence)
 *   - `globalThis.RedisClient` → Redis (cluster-wide rate limit, monitoring
 *                                fan-out, thread lock, semaphore, response cache)
 *
 * Bun ≥ 1.2 exposes these on the `Bun` namespace (`Bun.SQL`, `Bun.RedisClient`)
 * but NOT as bare globals, so the probes would see `undefined` and every
 * integration would silently degrade to its in-memory variant — i.e. with a
 * `DATABASE_URL`/`REDIS_URL` set, persistence and cluster-wide coordination
 * would be off without any error. This bootstrap mirrors the namespaced
 * constructors onto `globalThis` once at process startup so the probes resolve
 * them, while leaving the `globalThis.*` seam intact for tests (which inject
 * their own mocks there and never run this bootstrap).
 *
 * Idempotent and side-effect-light: it only assigns when the global is absent,
 * so a test that has set its own mock is never overwritten.
 *
 * No `any` at module boundaries.
 */

interface BunNamespace {
  SQL?: unknown;
  RedisClient?: unknown;
}

/**
 * Populates `globalThis.SQL` / `globalThis.RedisClient` from the `Bun`
 * namespace when they are not already present. Safe to call multiple times.
 */
export function ensureBunGlobals(): void {
  const g = globalThis as {
    SQL?: unknown;
    RedisClient?: unknown;
    Bun?: BunNamespace;
  };
  const bun = g.Bun;
  if (bun === undefined) return; // not running under Bun (e.g. some tooling)
  if (g.SQL === undefined && typeof bun.SQL === "function") {
    g.SQL = bun.SQL;
  }
  if (g.RedisClient === undefined && typeof bun.RedisClient === "function") {
    g.RedisClient = bun.RedisClient;
  }
}
