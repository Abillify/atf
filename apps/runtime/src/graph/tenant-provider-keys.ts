// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tenant BYOK provider keys (`src/graph/tenant-provider-keys.ts`)
 *
 * "Bring Your Own Key": an enterprise tenant supplies its own provider API keys
 * (OpenAI/Google/Azure/Bedrock) so its traffic is billed to, and isolated on,
 * its own provider account rather than the platform's shared credentials. This
 * is a classic B2B requirement — data-residency, separate billing, and the
 * ability to use a tenant-specific model deployment.
 *
 * At request time the platform resolves the calling tenant's key for the
 * provider a node uses; when present it overrides the shared key/pool, when
 * absent the platform falls back to the existing behaviour (key pool → single
 * AppConfig key). So the feature is strictly additive and opt-in per tenant.
 *
 * Unlike an incoming client API key (stored as a one-way hash for verification),
 * a BYOK key must be recovered to call the provider — so the durable store
 * encrypts it at rest with {@link SecretCipher}. The in-memory store keeps raw
 * keys in process memory only (never persisted).
 *
 * No `any` at module boundaries.
 */

import type { KeyedProvider } from "./provider-key-pool.js";
import { maskKey } from "./provider-key-pool.js";
import type { Database } from "../db/database.js";
import type { SecretCipher } from "./secret-cipher.js";
import type { Logger } from "../observability/logger.js";

/**
 * Associated-data string binding a BYOK key's ciphertext to the exact
 * (tenantId, provider) row it was written for. See {@link SecretCipher} for
 * why: without it, an `encrypted_key` value copied from one tenant's row into
 * another's (SQL-injection, backup restore, or insider DB access) would
 * decrypt successfully and let tenant B bill/act on tenant A's provider key.
 */
function byokAad(tenantId: string, provider: ByokProvider): string {
  return `byok:${tenantId}:${provider}`;
}

/** Providers that authenticate with a rotatable/replaceable API key. */
export type ByokProvider = KeyedProvider;

const BYOK_PROVIDERS: readonly ByokProvider[] = [
  "openai",
  "google",
  "azure",
  "bedrock",
  "anthropic",
];

/** True when a string is a supported BYOK provider. */
export function isByokProvider(value: string): value is ByokProvider {
  return (BYOK_PROVIDERS as readonly string[]).includes(value);
}

export interface BedrockByokCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Parses the atomic Bedrock credential bundle; partial/platform mixing is forbidden. */
export function parseBedrockByokCredentials(value: string): BedrockByokCredentials | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.accessKeyId !== "string" || record.accessKeyId.trim() === "" ||
      typeof record.secretAccessKey !== "string" || record.secretAccessKey.trim() === ""
    ) return undefined;
    return {
      accessKeyId: record.accessKeyId,
      secretAccessKey: record.secretAccessKey,
      ...(typeof record.sessionToken === "string" && record.sessionToken !== ""
        ? { sessionToken: record.sessionToken }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Public (masked) view of a tenant's configured BYOK key for a provider. */
export interface TenantProviderKeyInfo {
  provider: ByokProvider;
  keyMask: string;
  updatedAt: string;
}

export interface TenantProviderKeyStore {
  /** Upserts a tenant's BYOK key for a provider. */
  setKey(
    tenantId: string,
    provider: ByokProvider,
    rawKey: string,
  ): Promise<void>;
  /** Removes a tenant's BYOK key for a provider. Returns true when one existed. */
  removeKey(tenantId: string, provider: ByokProvider): Promise<boolean>;
  /** Lists a tenant's configured providers (masked — never raw values). */
  list(tenantId: string): Promise<TenantProviderKeyInfo[]>;
  /** Resolves all of a tenant's raw keys, keyed by provider (decrypted). */
  getAll(tenantId: string): Promise<Partial<Record<ByokProvider, string>>>;
}

// ---------------------------------------------------------------------------
// In-memory store (per replica; raw keys never leave process memory)
// ---------------------------------------------------------------------------

interface MemEntry {
  rawKey: string;
  updatedAt: string;
}

export class InMemoryTenantProviderKeyStore implements TenantProviderKeyStore {
  private readonly byTenant = new Map<string, Map<ByokProvider, MemEntry>>();

  async setKey(
    tenantId: string,
    provider: ByokProvider,
    rawKey: string,
  ): Promise<void> {
    let m = this.byTenant.get(tenantId);
    if (m === undefined) {
      m = new Map();
      this.byTenant.set(tenantId, m);
    }
    m.set(provider, { rawKey, updatedAt: new Date().toISOString() });
  }

  async removeKey(tenantId: string, provider: ByokProvider): Promise<boolean> {
    const m = this.byTenant.get(tenantId);
    if (m === undefined) return false;
    const existed = m.delete(provider);
    if (m.size === 0) this.byTenant.delete(tenantId);
    return existed;
  }

  async list(tenantId: string): Promise<TenantProviderKeyInfo[]> {
    const m = this.byTenant.get(tenantId);
    if (m === undefined) return [];
    return [...m.entries()].map(([provider, e]) => ({
      provider,
      keyMask: maskKey(e.rawKey),
      updatedAt: e.updatedAt,
    }));
  }

  async getAll(
    tenantId: string,
  ): Promise<Partial<Record<ByokProvider, string>>> {
    const m = this.byTenant.get(tenantId);
    if (m === undefined) return {};
    const out: Partial<Record<ByokProvider, string>> = {};
    for (const [provider, e] of m) out[provider] = e.rawKey;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Postgres store (durable; keys encrypted at rest)
// ---------------------------------------------------------------------------

interface KeyRow {
  provider: string;
  encrypted_key: string;
  updated_at: string | Date;
}

export class PostgresTenantProviderKeyStore implements TenantProviderKeyStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
    private readonly logger?: Logger,
  ) {}

  /** Runs `cb` with the RLS tenant context bound (pass-through when disabled). */
  private scoped<T>(
    tenantId: string,
    cb: (db: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.withTenant ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  async setKey(
    tenantId: string,
    provider: ByokProvider,
    rawKey: string,
  ): Promise<void> {
    const encrypted = this.cipher.encrypt(rawKey, byokAad(tenantId, provider));
    await this.scoped(tenantId, (db) =>
      db.query(
        `INSERT INTO tenant_provider_keys (tenant_id, provider, encrypted_key, updated_at)
           VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, provider)
           DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key, updated_at = now()`,
        [tenantId, provider, encrypted],
      ),
    );
  }

  async removeKey(tenantId: string, provider: ByokProvider): Promise<boolean> {
    const rows = await this.scoped(tenantId, (db) =>
      db.query<{ tenant_id: string }>(
        `DELETE FROM tenant_provider_keys WHERE tenant_id = $1 AND provider = $2
           RETURNING tenant_id`,
        [tenantId, provider],
      ),
    );
    return rows.length > 0;
  }

  async list(tenantId: string): Promise<TenantProviderKeyInfo[]> {
    const rows = await this.scoped(tenantId, (db) =>
      db.query<KeyRow>(
        `SELECT provider, encrypted_key, updated_at FROM tenant_provider_keys
           WHERE tenant_id = $1 ORDER BY provider`,
        [tenantId],
      ),
    );
    const out: TenantProviderKeyInfo[] = [];
    for (const r of rows) {
      if (!isByokProvider(r.provider)) continue;
      let mask = "****";
      try {
        mask = maskKey(
          this.cipher.decrypt(r.encrypted_key, byokAad(tenantId, r.provider)),
        );
      } catch (err) {
        this.logger?.warn("Failed to decrypt BYOK key for masking", {
          tenant: tenantId,
          provider: r.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      out.push({
        provider: r.provider,
        keyMask: mask,
        updatedAt:
          r.updated_at instanceof Date
            ? r.updated_at.toISOString()
            : r.updated_at,
      });
    }
    return out;
  }

  async getAll(
    tenantId: string,
  ): Promise<Partial<Record<ByokProvider, string>>> {
    const rows = await this.scoped(tenantId, (db) =>
      db.query<KeyRow>(
        `SELECT provider, encrypted_key, updated_at FROM tenant_provider_keys
           WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    const out: Partial<Record<ByokProvider, string>> = {};
    for (const r of rows) {
      if (!isByokProvider(r.provider)) continue;
      try {
        out[r.provider] = this.cipher.decrypt(
          r.encrypted_key,
          byokAad(tenantId, r.provider),
        );
      } catch (err) {
        this.logger?.warn("Failed to decrypt BYOK key", {
          tenant: tenantId,
          provider: r.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Resolver (short-TTL cache so we don't decrypt on every request)
// ---------------------------------------------------------------------------

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

interface CacheEntry {
  keys: Partial<Record<ByokProvider, string>>;
  expiresAt: number;
}

/**
 * Resolves a tenant's BYOK keys with a short-lived per-tenant cache, so a busy
 * tenant does not trigger a database read + decrypt on every request. The cache
 * is invalidated immediately on a key change via {@link invalidate}.
 */
export class ByokResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(
    private readonly store: TenantProviderKeyStore,
    options: { ttlSeconds?: number; clock?: Clock } = {},
  ) {
    this.ttlMs = Math.max(1, options.ttlSeconds ?? 60) * 1000;
    this.clock = options.clock ?? Date.now;
  }

  /** Returns the tenant's provider→key map (cached). Empty when none configured. */
  async resolve(
    tenantId: string,
  ): Promise<Partial<Record<ByokProvider, string>>> {
    const now = this.clock();
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && now <= cached.expiresAt) return cached.keys;
    const keys = await this.store.getAll(tenantId);
    this.cache.set(tenantId, { keys, expiresAt: now + this.ttlMs });
    return keys;
  }

  /** Drops the cached keys for a tenant (call after set/remove). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
