// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The periodic expiry sweep of the semantic cache: it runs `purgeExpired()` on
 * a timer, survives a failing sweep, and stops when asked to (shutdown).
 */

import { describe, expect, it } from "bun:test";
import type { SemanticCache } from "../../graph/semantic-cache.js";
import type { Logger } from "../../observability/logger.js";
import { startSemanticCachePurge } from "../cache.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function cacheWith(purgeExpired: (() => Promise<number>) | undefined): SemanticCache {
  return {
    enabled: true,
    get: async () => undefined,
    set: async () => undefined,
    isCacheable: () => true,
    eraseUser: async () => 0,
    ...(purgeExpired !== undefined ? { purgeExpired } : {}),
  };
}

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    error: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
  } as unknown as Logger;
  return { logger, warnings };
}

describe("startSemanticCachePurge", () => {
  it("runs the sweep repeatedly and stops on request", async () => {
    let calls = 0;
    const { logger } = recordingLogger();
    const stop = startSemanticCachePurge(
      cacheWith(async () => {
        calls++;
        return 0;
      }),
      5,
      logger,
    );
    await sleep(60);
    stop();
    const atStop = calls;
    expect(atStop).toBeGreaterThanOrEqual(2);
    await sleep(40);
    expect(calls).toBe(atStop);
  });

  it("logs a failing sweep and keeps going", async () => {
    let calls = 0;
    const { logger, warnings } = recordingLogger();
    const stop = startSemanticCachePurge(
      cacheWith(async () => {
        calls++;
        throw new Error("database unavailable");
      }),
      5,
      logger,
    );
    await sleep(40);
    stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("does nothing without a cache or without a sweep", () => {
    const { logger } = recordingLogger();
    expect(startSemanticCachePurge(undefined, 5, logger)()).toBeUndefined();
    expect(startSemanticCachePurge(cacheWith(undefined), 5, logger)()).toBeUndefined();
  });
});
