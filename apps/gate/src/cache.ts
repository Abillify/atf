// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import type { AuthContext } from "./auth/context.ts";

/**
 * A small TTL + LRU cache. Entries expire after `ttlMs` and the least-recently
 * used entry is evicted once `maxEntries` is exceeded. Map iteration order gives
 * the LRU behaviour: a `get`/`set` re-inserts the key at the end.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(private readonly maxEntries: number = 1000) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Touch: move to most-recently-used position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Deterministic, opaque fingerprint of every authorization-relevant context field. */
export function authContextFingerprint(ctx: AuthContext): string {
  const context = {
    method: ctx.method,
    subject: ctx.subject,
    username: ctx.username,
    scopes: [...ctx.scopes].sort(),
    claims: ctx.claims,
    headers: ctx.headers,
  };
  return createHash("sha256").update(stableStringify(context)).digest("hex");
}

/** Opaque identity cache partition; no claims, headers, subjects or tokens are stored in plaintext. */
export function identityScopeKey(ctx: AuthContext): string {
  return authContextFingerprint(ctx);
}

/** Opaque deterministic digest suitable for cache key material that may contain secrets. */
export function cacheKeyDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Deterministic JSON with sorted object keys, so argument order never matters. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
