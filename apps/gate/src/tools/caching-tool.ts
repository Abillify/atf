// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import type { CacheConfig } from "../config/schema.ts";
import { TtlCache, cacheKeyDigest, identityScopeKey } from "../cache.ts";
import { logger } from "../logger.ts";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.ts";

/**
 * Wraps a tool executor with a result cache. Successful results are cached for
 * `ttlSeconds`; error results are never cached. The key combines the tool name,
 * the (stably serialised) arguments and — unless `scope` is `global` — the
 * caller identity, so identity-aware output is never served across users.
 *
 * Dry-run (`explain`) always bypasses the cache and delegates to the inner tool.
 */
export class CachingToolExecutor implements ToolExecutor {
  private readonly cache: TtlCache<ToolResult>;

  constructor(
    private readonly inner: ToolExecutor,
    private readonly cfg: CacheConfig,
  ) {
    this.cache = new TtlCache<ToolResult>(cfg.maxEntries);
  }

  get definition(): ToolDefinition {
    return this.inner.definition;
  }

  private keyFor(args: Record<string, unknown>, ctx: AuthContext): string {
    const scope = this.cfg.scope === "identity" ? identityScopeKey(ctx) : "*";
    return `${this.inner.definition.name}|${scope}|${cacheKeyDigest(args ?? {})}`;
  }

  async execute(
    args: Record<string, unknown>,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const key = this.keyFor(args, ctx);
    const hit = this.cache.get(key);
    if (hit) {
      logger.debug("tool cache hit", { tool: this.inner.definition.name });
      return { ...hit, meta: { ...hit.meta, cached: true } };
    }

    const result = await this.inner.execute(args, ctx, signal);
    if (!result.isError) {
      this.cache.set(key, result, this.cfg.ttlSeconds * 1000);
    }
    return { ...result, meta: { ...result.meta, cached: false } };
  }

  explain(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> | undefined {
    return this.inner.explain?.(args, ctx);
  }
}
