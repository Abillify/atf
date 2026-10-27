// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tenant and API-key manager (`src/graph/tenant-manager.ts`)
 *
 * The billing/identity unit for multi-tenant deployments. Each tenant has an
 * independent budget, plan and a pool of API keys. API keys authenticate
 * requests to the `/v1/` inference plane — the caller supplies a key instead
 * of (or in addition to) a JWT, and aiperator maps it to a tenant identity.
 *
 * Security model:
 *   - Only a one-way hash of the raw key is stored (`key_hash` column). The
 *     raw key is returned exactly once, at creation time, and never again.
 *   - With `API_KEY_PEPPER` configured, the hash is HMAC-SHA-256 keyed with
 *     the server-side pepper (`hash_alg` = `hmac-sha256`), so a database
 *     dump alone cannot be brute-forced offline (Req 7.9). Without a pepper
 *     the original unsalted SHA-256 form is used (`hash_alg` = `sha256`).
 *   - Lookup checks the HMAC form first, then the SHA-256 form; a SHA-256
 *     hit is migrated in place to HMAC on the next successful lookup.
 *   - The display prefix (first 8 chars, e.g. `aip-abcd`) lets operators
 *     identify a key without the secret.
 *
 * Two backends:
 *   - {@link InMemoryTenantStore} — per-replica, for dev/tests.
 *   - {@link PostgresTenantStore} — durable, cross-replica.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import { safeSqlIdentifier } from "../db/sql-identifier.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface Tenant {
  id: string;
  name: string;
  plan: string;
  dailyBudget?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  status: "active" | "revoked";
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
  /**
   * Optional expiry (ISO-8601). When set and in the past, {@link
   * TenantStore.lookupByApiKey} treats the key as invalid even though its
   * `status` is still `"active"` — expiry is a separate lifecycle axis from
   * revocation (a key can lapse on its own schedule without an operator
   * having to act), and `listApiKeys` still surfaces it (with `status`
   * unchanged) so an operator can see it lapsed rather than having it vanish.
   */
  expiresAt?: string;
}

export interface ApiKeyCreated extends ApiKey {
  /** Raw key — returned ONCE on creation; not stored. */
  rawKey: string;
}

export interface TenantStore {
  createTenant(input: {
    name: string;
    plan?: string;
    dailyBudget?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | undefined>;
  listTenants(limit?: number): Promise<Tenant[]>;
  updateTenant(
    id: string,
    updates: {
      name?: string;
      plan?: string;
      dailyBudget?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Tenant | undefined>;
  deleteTenant(id: string): Promise<boolean>;
  /**
   * Creates a new API key. `expiresAt` (ISO-8601) is optional — omitted means
   * the key never expires on its own (the pre-expiry behaviour), matching
   * every existing caller unchanged.
   */
  createApiKey(
    tenantId: string,
    name: string,
    expiresAt?: string,
  ): Promise<ApiKeyCreated>;
  revokeApiKey(id: string): Promise<boolean>;
  listApiKeys(tenantId: string): Promise<ApiKey[]>;
  /**
   * Returns the tenant whose active, non-expired key matches, or undefined.
   * Updates last_used_at. A key whose `expiresAt` has passed is treated as
   * invalid here even though its `status` remains `"active"` — see
   * {@link ApiKey.expiresAt}.
   */
  lookupByApiKey(rawKey: string): Promise<Tenant | undefined>;
}

// ---------------------------------------------------------------------------
// Key generation + hashing
// ---------------------------------------------------------------------------

/** Fixed prefix for all aiperator API keys (for recognition in logs/UIs). */
const KEY_PREFIX_FIXED = "aip-";
/** Total raw key length (prefix + random suffix). */
const KEY_LENGTH = 40;

/**
 * Which one-way function produced a stored `key_hash` (column `hash_alg`,
 * migration 45). `sha256` is the original unsalted form; `hmac-sha256` is the
 * peppered form introduced with Req 7.9. Rows written before the pepper
 * existed keep `sha256` until a successful lookup migrates them lazily.
 */
export type ApiKeyHashAlg = "sha256" | "hmac-sha256";

/**
 * Optional server-side pepper for API-key hashing (Req 7.9, `API_KEY_PEPPER`).
 * When provided, new keys are stored as HMAC-SHA-256(pepper, rawKey) and
 * lookups prefer the HMAC form, migrating legacy SHA-256 rows on hit.
 */
export interface ApiKeyPepper {
  readonly pepper?: string;
}

function normalizePepper(pepper: string | undefined): string | undefined {
  return pepper !== undefined && pepper.trim().length > 0
    ? pepper
    : undefined;
}

/** Unsalted SHA-256 — the original (pre-pepper) key-hash form. */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/** Peppered HMAC-SHA-256 — the form used when `API_KEY_PEPPER` is set. */
export function hmacApiKeyHash(rawKey: string, pepper: string): string {
  return crypto
    .createHmac("sha256", pepper)
    .update(rawKey)
    .digest("hex");
}

/**
 * Hash a raw key the way it should be stored right now: HMAC when a pepper
 * is configured, plain SHA-256 otherwise. Returns the hash together with the
 * algorithm label for the `hash_alg` column.
 */
export function hashApiKeyForStorage(
  rawKey: string,
  pepper?: string,
): { keyHash: string; hashAlg: ApiKeyHashAlg } {
  const p = normalizePepper(pepper);
  if (p !== undefined)
    return { keyHash: hmacApiKeyHash(rawKey, p), hashAlg: "hmac-sha256" };
  return { keyHash: hashApiKey(rawKey), hashAlg: "sha256" };
}

export function generateApiKey(pepper?: string): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
  hashAlg: ApiKeyHashAlg;
} {
  const random = crypto
    .randomBytes(Math.ceil((KEY_LENGTH - KEY_PREFIX_FIXED.length) * 0.75))
    .toString("base64url")
    .slice(0, KEY_LENGTH - KEY_PREFIX_FIXED.length);
  const rawKey = `${KEY_PREFIX_FIXED}${random}`;
  const keyPrefix = rawKey.slice(0, 8);
  const { keyHash, hashAlg } = hashApiKeyForStorage(rawKey, pepper);
  return { rawKey, keyPrefix, keyHash, hashAlg };
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export class InMemoryTenantStore implements TenantStore {
  private readonly tenants = new Map<string, Tenant>();
  private readonly keys = new Map<
    string,
    ApiKey & { keyHash: string; hashAlg: ApiKeyHashAlg }
  >();
  private readonly pepper: string | undefined;

  /** `options.pepper` mirrors `API_KEY_PEPPER` (Req 7.9). */
  constructor(options?: ApiKeyPepper) {
    this.pepper = normalizePepper(options?.pepper);
  }

  async createTenant(input: {
    name: string;
    plan?: string;
    dailyBudget?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Tenant> {
    const now = new Date().toISOString();
    const t: Tenant = {
      id: crypto.randomUUID(),
      name: input.name,
      plan: input.plan ?? "free",
      ...(input.dailyBudget !== undefined
        ? { dailyBudget: input.dailyBudget }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(t.id, t);
    return { ...t };
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const t = this.tenants.get(id);
    return t ? { ...t } : undefined;
  }

  async listTenants(limit = 100): Promise<Tenant[]> {
    return [...this.tenants.values()]
      .slice(0, Math.max(1, limit))
      .map((t) => ({ ...t }));
  }

  async updateTenant(
    id: string,
    updates: {
      name?: string;
      plan?: string;
      dailyBudget?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Tenant | undefined> {
    const t = this.tenants.get(id);
    if (t === undefined) return undefined;
    if (updates.name !== undefined) t.name = updates.name;
    if (updates.plan !== undefined) t.plan = updates.plan;
    if (updates.dailyBudget !== undefined) t.dailyBudget = updates.dailyBudget;
    if (updates.metadata !== undefined) t.metadata = updates.metadata;
    t.updatedAt = new Date().toISOString();
    return { ...t };
  }

  async deleteTenant(id: string): Promise<boolean> {
    for (const [kid, k] of this.keys)
      if (k.tenantId === id) this.keys.delete(kid);
    return this.tenants.delete(id);
  }

  async createApiKey(
    tenantId: string,
    name: string,
    expiresAt?: string,
  ): Promise<ApiKeyCreated> {
    if (!this.tenants.has(tenantId)) throw new TenantNotFoundError(tenantId);
    const { rawKey, keyPrefix, keyHash, hashAlg } = generateApiKey(this.pepper);
    const now = new Date().toISOString();
    const key: ApiKey & { keyHash: string; hashAlg: ApiKeyHashAlg } = {
      id: crypto.randomUUID(),
      tenantId,
      name,
      keyPrefix,
      keyHash,
      hashAlg,
      status: "active",
      createdAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.keys.set(key.id, key);
    const { keyHash: _h, hashAlg: _a, ...pub } = key;
    void _h;
    void _a;
    return { ...pub, rawKey };
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const k = this.keys.get(id);
    if (k === undefined || k.status === "revoked") return false;
    k.status = "revoked";
    k.revokedAt = new Date().toISOString();
    return true;
  }

  async listApiKeys(tenantId: string): Promise<ApiKey[]> {
    return [...this.keys.values()]
      .filter((k) => k.tenantId === tenantId)
      .map(({ keyHash: _h, ...pub }) => {
        void _h;
        return pub;
      });
  }

  async lookupByApiKey(rawKey: string): Promise<Tenant | undefined> {
    // Req 7.9: with a pepper configured, check the HMAC form first; only on a
    // miss fall back to the legacy SHA-256 form and migrate the row in place
    // on a successful (active, non-expired) hit.
    const candidates: Array<{ hash: string; alg: ApiKeyHashAlg }> = [];
    if (this.pepper !== undefined) {
      candidates.push({
        hash: hmacApiKeyHash(rawKey, this.pepper),
        alg: "hmac-sha256",
      });
    }
    candidates.push({ hash: hashApiKey(rawKey), alg: "sha256" });

    for (const { hash, alg } of candidates) {
      const key = [...this.keys.values()].find(
        (k) => k.keyHash === hash && k.hashAlg === alg,
      );
      if (key === undefined || key.status !== "active") continue;
      if (
        key.expiresAt !== undefined &&
        Date.parse(key.expiresAt) <= Date.now()
      ) {
        return undefined;
      }
      if (alg === "sha256" && this.pepper !== undefined) {
        // Lazy migration to the peppered form (Req 7.9).
        key.keyHash = hmacApiKeyHash(rawKey, this.pepper);
        key.hashAlg = "hmac-sha256";
      }
      key.lastUsedAt = new Date().toISOString();
      return this.tenants.get(key.tenantId);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

interface TenantRow {
  id: string;
  name: string;
  plan: string;
  daily_budget: number | string | null;
  metadata: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  key_hash?: string;
  hash_alg?: string;
  status: string;
  last_used_at: string | Date | null;
  created_at: string | Date;
  revoked_at: string | Date | null;
  expires_at: string | Date | null;
}

function toIso(v: string | Date | null): string {
  if (v === null) return "";
  return v instanceof Date ? v.toISOString() : v;
}

function toNum(v: number | string | null): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseMeta(v: unknown): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function rowToTenant(r: TenantRow): Tenant {
  const t: Tenant = {
    id: r.id,
    name: r.name,
    plan: r.plan,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
  const budget = toNum(r.daily_budget);
  if (budget !== undefined) t.dailyBudget = budget;
  const meta = parseMeta(r.metadata);
  if (meta !== undefined) t.metadata = meta;
  return t;
}

function rowToApiKey(r: ApiKeyRow): ApiKey {
  const k: ApiKey = {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    keyPrefix: r.key_prefix,
    status: r.status as "active" | "revoked",
    createdAt: toIso(r.created_at),
  };
  if (r.last_used_at !== null) k.lastUsedAt = toIso(r.last_used_at);
  if (r.revoked_at !== null) k.revokedAt = toIso(r.revoked_at);
  if (r.expires_at !== null) k.expiresAt = toIso(r.expires_at);
  return k;
}

export class TenantNotFoundError extends Error {
  constructor(id: string) {
    super(`Tenant "${id}" not found`);
    this.name = "TenantNotFoundError";
  }
}

export class PostgresTenantStore implements TenantStore {
  private readonly pepper: string | undefined;

  /** `options.pepper` mirrors `API_KEY_PEPPER` (Req 7.9). */
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
    options?: ApiKeyPepper,
  ) {
    this.pepper = normalizePepper(options?.pepper);
  }

  /** Runs `cb` with the RLS tenant context bound (pass-through when disabled). */
  private scoped<T>(
    tenantId: string,
    cb: (db: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.withTenant ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  async createTenant(input: {
    name: string;
    plan?: string;
    dailyBudget?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Tenant> {
    const id = crypto.randomUUID();
    await this.db.query(
      `INSERT INTO tenants (id, name, plan, daily_budget, metadata)
       VALUES ($1, $2, $3, $4, $5::text::jsonb)`,
      [
        id,
        input.name,
        input.plan ?? "free",
        input.dailyBudget ?? null,
        input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      ],
    );
    const created = await this.getTenant(id);
    if (created === undefined) {
      // Unreachable: the INSERT above just created this row.
      throw new Error(`Failed to read back newly created tenant "${id}".`);
    }
    return created;
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const rows = await this.db.query<TenantRow>(
      `SELECT id,name,plan,daily_budget,metadata,created_at,updated_at
         FROM tenants WHERE id=$1`,
      [id],
    );
    return rows[0] ? rowToTenant(rows[0]) : undefined;
  }

  async listTenants(limit = 100): Promise<Tenant[]> {
    const rows = await this.db.query<TenantRow>(
      `SELECT id,name,plan,daily_budget,metadata,created_at,updated_at
         FROM tenants ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, limit)],
    );
    return rows.map(rowToTenant);
  }

  async updateTenant(
    id: string,
    updates: {
      name?: string;
      plan?: string;
      dailyBudget?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Tenant | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    // Every column name interpolated into the dynamic SET clause goes through
    // the central identifier whitelist (Req 7.10); values stay parameterised.
    const addSet = (column: string, value: unknown, cast = ""): void => {
      params.push(value);
      sets.push(
        `${safeSqlIdentifier(column, "tenant update column")}=$${params.length}${cast}`,
      );
    };
    if (updates.name !== undefined) addSet("name", updates.name);
    if (updates.plan !== undefined) addSet("plan", updates.plan);
    if (updates.dailyBudget !== undefined)
      addSet("daily_budget", updates.dailyBudget);
    if (updates.metadata !== undefined)
      addSet("metadata", JSON.stringify(updates.metadata), "::jsonb");
    if (sets.length === 0) return this.getTenant(id);
    sets.push("updated_at=now()");
    await this.db.query(
      `UPDATE tenants SET ${sets.join(",")} WHERE id=$1`,
      params,
    );
    return this.getTenant(id);
  }

  async deleteTenant(id: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM tenants WHERE id=$1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  async createApiKey(
    tenantId: string,
    name: string,
    expiresAt?: string,
  ): Promise<ApiKeyCreated> {
    const tenant = await this.getTenant(tenantId);
    if (tenant === undefined) throw new TenantNotFoundError(tenantId);
    const { rawKey, keyPrefix, keyHash, hashAlg } = generateApiKey(this.pepper);
    const id = crypto.randomUUID();
    // api_keys is RLS-scoped: insert + read-back run under the tenant GUC.
    const rows = await this.scoped(tenantId, async (db) => {
      await db.query(
        `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, hash_alg, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [id, tenantId, name, keyPrefix, keyHash, hashAlg, expiresAt ?? null],
      );
      return db.query<ApiKeyRow>(
        `SELECT id,tenant_id,name,key_prefix,status,last_used_at,created_at,revoked_at,expires_at
           FROM api_keys WHERE id=$1`,
        [id],
      );
    });
    const row = rows[0];
    if (row === undefined) {
      // Unreachable: the INSERT above just created this row.
      throw new Error(`Failed to read back newly created API key "${id}".`);
    }
    return { ...rowToApiKey(row), rawKey };
  }

  // revokeApiKey targets a key by its id without knowing the tenant, so it is
  // NOT tenant scoped — an admin-plane action that needs a BYPASSRLS role under
  // enforced RLS (see ADR-0005).
  async revokeApiKey(id: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE api_keys SET status='revoked', revoked_at=now()
        WHERE id=$1 AND status='active'
        RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  async listApiKeys(tenantId: string): Promise<ApiKey[]> {
    const rows = await this.scoped(tenantId, (db) =>
      db.query<ApiKeyRow>(
        `SELECT id,tenant_id,name,key_prefix,status,last_used_at,created_at,revoked_at,expires_at
           FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC`,
        [tenantId],
      ),
    );
    return rows.map(rowToApiKey);
  }

  // lookupByApiKey resolves identity FROM the key, so it must search across all
  // tenants BEFORE a tenant is known — it cannot be tenant scoped. Under
  // enforced RLS, api_keys is excluded from the forced-RLS table set (or this
  // path runs as a BYPASSRLS role); see the RLS onboarding CLI and ADR-0005.
  async lookupByApiKey(rawKey: string): Promise<Tenant | undefined> {
    // Req 7.9: with a pepper configured, probe the HMAC form first. Only on a
    // miss probe the legacy SHA-256 form; a SHA-256 hit is migrated to the
    // peppered HMAC form in place (lazy migration) so the next lookup — and
    // every future one — resolves via HMAC only.
    const candidates: Array<{ hash: string; alg: ApiKeyHashAlg }> = [];
    if (this.pepper !== undefined) {
      candidates.push({
        hash: hmacApiKeyHash(rawKey, this.pepper),
        alg: "hmac-sha256",
      });
    }
    candidates.push({ hash: hashApiKey(rawKey), alg: "sha256" });

    for (const { hash, alg } of candidates) {
      // `expires_at IS NULL OR expires_at > now()` is evaluated IN the query
      // (not after fetching) so an expired key is indistinguishable, at the
      // SQL level, from one that never existed — the same defence-in-depth
      // reasoning as filtering by `status='active'` here rather than in
      // application code. `hash_alg` is part of the predicate so a row that
      // was already migrated can never be matched by its stale SHA-256 hash.
      const rows = await this.db.query<ApiKeyRow & { tenant_id: string }>(
        `SELECT k.id, k.tenant_id
           FROM api_keys k
          WHERE k.key_hash=$1 AND k.hash_alg=$2 AND k.status='active'
            AND (k.expires_at IS NULL OR k.expires_at > now())
          LIMIT 1`,
        [hash, alg],
      );
      const row = rows[0];
      if (row === undefined) continue;
      const { id: keyId, tenant_id: tenantId } = row;
      if (alg === "sha256" && this.pepper !== undefined) {
        // Lazy migration (Req 7.9): replace the SHA-256 hash with the peppered
        // HMAC. Awaited — a key must not keep authenticating through the
        // weaker form after the pepper was introduced.
        try {
          await this.db.query(
            `UPDATE api_keys SET key_hash=$2, hash_alg='hmac-sha256'
              WHERE id=$1 AND hash_alg='sha256'`,
            [keyId, hmacApiKeyHash(rawKey, this.pepper)],
          );
        } catch (err) {
          // The lookup itself already succeeded; a failed migration only means
          // the next lookup takes the fallback path again. Never fail auth
          // over bookkeeping.
          this.logger?.warn("Failed to migrate api key hash to peppered HMAC", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Update last_used_at (best-effort, don't await on the hot path)
      void this.db
        .query(`UPDATE api_keys SET last_used_at=now() WHERE id=$1`, [keyId])
        .catch((err) =>
          this.logger?.warn("Failed to update api key last_used_at", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return this.getTenant(tenantId);
    }
    return undefined;
  }
}
