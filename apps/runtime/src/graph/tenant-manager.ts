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
 *   - Only the SHA-256 hash of the raw key is stored (`key_hash` column). The
 *     raw key is returned exactly once, at creation time, and never again.
 *   - The display prefix (first 8 chars, e.g. `aip-abcd`) lets operators
 *     identify a key without the secret.
 *   - Key lookup is a constant-time hash compare (SHA-256 → hex).
 *
 * Two backends:
 *   - {@link InMemoryTenantStore} — per-replica, for dev/tests.
 *   - {@link PostgresTenantStore} — durable, cross-replica.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
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

export function generateApiKey(): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const random = crypto
    .randomBytes(Math.ceil((KEY_LENGTH - KEY_PREFIX_FIXED.length) * 0.75))
    .toString("base64url")
    .slice(0, KEY_LENGTH - KEY_PREFIX_FIXED.length);
  const rawKey = `${KEY_PREFIX_FIXED}${random}`;
  const keyPrefix = rawKey.slice(0, 8);
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  return { rawKey, keyPrefix, keyHash };
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export class InMemoryTenantStore implements TenantStore {
  private readonly tenants = new Map<string, Tenant>();
  private readonly keys = new Map<string, ApiKey & { keyHash: string }>();

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
    if (updates.dailyBudget !== undefined)
      t.dailyBudget = updates.dailyBudget;
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
    const { rawKey, keyPrefix, keyHash } = generateApiKey();
    const now = new Date().toISOString();
    const key: ApiKey & { keyHash: string } = {
      id: crypto.randomUUID(),
      tenantId,
      name,
      keyPrefix,
      keyHash,
      status: "active",
      createdAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.keys.set(key.id, key);
    const { keyHash: _h, ...pub } = key;
    void _h;
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
    const hash = hashApiKey(rawKey);
    const key = [...this.keys.values()].find(
      (k) => k.keyHash === hash && k.status === "active",
    );
    if (key === undefined) return undefined;
    if (key.expiresAt !== undefined && Date.parse(key.expiresAt) <= Date.now()) {
      return undefined;
    }
    key.lastUsedAt = new Date().toISOString();
    return this.tenants.get(key.tenantId);
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
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

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
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
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
    if (updates.name !== undefined) {
      params.push(updates.name);
      sets.push(`name=$${params.length}`);
    }
    if (updates.plan !== undefined) {
      params.push(updates.plan);
      sets.push(`plan=$${params.length}`);
    }
    if (updates.dailyBudget !== undefined) {
      params.push(updates.dailyBudget);
      sets.push(`daily_budget=$${params.length}`);
    }
    if (updates.metadata !== undefined) {
      params.push(JSON.stringify(updates.metadata));
      sets.push(`metadata=$${params.length}::jsonb`);
    }
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
    const { rawKey, keyPrefix, keyHash } = generateApiKey();
    const id = crypto.randomUUID();
    // api_keys is RLS-scoped: insert + read-back run under the tenant GUC.
    const rows = await this.scoped(tenantId, async (db) => {
      await db.query(
        `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [id, tenantId, name, keyPrefix, keyHash, expiresAt ?? null],
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
  // path runs as a BYPASSRLS role); see deploy/postgres-rls.sql and ADR-0005.
  async lookupByApiKey(rawKey: string): Promise<Tenant | undefined> {
    const hash = hashApiKey(rawKey);
    // `expires_at IS NULL OR expires_at > now()` is evaluated IN the query
    // (not after fetching) so an expired key is indistinguishable, at the SQL
    // level, from one that never existed — the same defence-in-depth reasoning
    // as filtering by `status='active'` here rather than in application code.
    const rows = await this.db.query<ApiKeyRow & { tenant_id: string }>(
      `SELECT k.id, k.tenant_id
         FROM api_keys k
        WHERE k.key_hash=$1 AND k.status='active'
          AND (k.expires_at IS NULL OR k.expires_at > now())
        LIMIT 1`,
      [hash],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const { id: keyId, tenant_id: tenantId } = row;
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
}
