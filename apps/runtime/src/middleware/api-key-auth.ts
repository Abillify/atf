// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * API-key auth adapter (`src/middleware/api-key-auth.ts`)
 *
 * Allows the `/v1/*` inference plane to authenticate with an aiperator API key
 * (`aip-...`) in place of a JWT.  If the header/body token looks like a managed
 * API key (starts with "aip-"), the adapter looks it up in the {@link TenantStore},
 * resolves the tenant identity, and rewrites the request context so downstream
 * middleware (budget check, rate-limit, flow dispatch, monitoring) sees the same
 * client/plan attributes they would from a decoded JWT — without needing to
 * issue full JWTs to machine clients.
 *
 * The adapter wraps the JWT flow: if the token is NOT an API key (i.e. it is a
 * regular JWT-format token), it is passed through unchanged. This means the
 * middleware stack is unchanged for existing JWT callers.
 *
 * No `any` at module boundaries.
 */

import type { TenantStore } from "../graph/tenant-manager.js";
import type { Logger } from "../observability/logger.js";

export const API_KEY_PREFIX = "aip-";

export interface ResolvedApiKeyIdentity {
  tenantId: string;
  tenantName: string;
  plan: string;
}

/**
 * Looks up an API key and returns the associated tenant identity. Returns
 * `undefined` when the key does not match a live active key.
 */
export async function resolveApiKey(
  rawKey: string,
  store: TenantStore,
  logger?: Logger,
): Promise<ResolvedApiKeyIdentity | undefined> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) return undefined;
  try {
    const tenant = await store.lookupByApiKey(rawKey);
    if (tenant === undefined) return undefined;
    return { tenantId: tenant.id, tenantName: tenant.name, plan: tenant.plan };
  } catch (err) {
    logger?.warn("API key lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
