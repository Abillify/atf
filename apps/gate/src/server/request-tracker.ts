// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Express, NextFunction, Request, Response } from "express";
import { logger } from "../logger.ts";

export interface RequestTracker {
  activeRequests(): number;
  drain(timeoutMs?: number): Promise<void>;
}

/** Installs request tracking at the caller-selected middleware position. */
export function installRequestTracker(app: Express): RequestTracker {
  let activeRequests = 0;
  app.use((_req: Request, res: Response, next: NextFunction) => {
    activeRequests++;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      activeRequests--;
    };
    res.once("finish", settle);
    res.once("close", settle);
    next();
  });
  return {
    activeRequests: () => activeRequests,
    async drain(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (activeRequests > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (activeRequests > 0) logger.warn(`drain timed out with ${activeRequests} request(s) still in flight`);
    },
  };
}
