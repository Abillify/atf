// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Express } from "express";
import { logger } from "../logger.ts";

interface HealthDatabase {
  names(): string[];
  healthcheck(name: string): Promise<unknown>;
}
interface HealthDependency {
  backing: string;
  healthcheck?: () => Promise<unknown>;
}

export function installHealthRoutes(
  app: Express,
  dependencies: {
    db: HealthDatabase;
    toolCount: () => number;
    transactionLedger: HealthDependency;
    webhookReplayStore?: HealthDependency;
    approvalStore?: HealthDependency;
    /**
     * `auth.mode: disabled`: both probes then carry `auth: "disabled"`, so an
     * instance that answers every request anonymously says so.
     */
    authDisabled?: boolean;
  },
): void {
  const authField = dependencies.authDisabled === true ? { auth: "disabled" } : {};
  app.get("/healthz", (_req, res) => res.json({ status: "ok", ...authField }));
  app.get("/readyz", async (_req, res) => {
    const databases = dependencies.db.names();
    const timeoutMs = 2_000;
    const bounded = async (label: string, check: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          check,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} readiness timed out`)),
              timeoutMs,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      await Promise.all([
        ...databases.map((name) =>
          bounded(`database:${name}`, dependencies.db.healthcheck(name)),
        ),
        ...(dependencies.transactionLedger.healthcheck
          ? [
              bounded(
                "transaction-redis",
                dependencies.transactionLedger.healthcheck(),
              ),
            ]
          : []),
        ...(dependencies.webhookReplayStore?.healthcheck
          ? [
              bounded(
                "webhook-replay-redis",
                dependencies.webhookReplayStore.healthcheck(),
              ),
            ]
          : []),
        ...(dependencies.approvalStore?.healthcheck
          ? [
              bounded(
                "approval-redis",
                dependencies.approvalStore.healthcheck(),
              ),
            ]
          : []),
      ]);
      res.json({
        status: "ok",
        ...authField,
        tools: dependencies.toolCount(),
        databases,
        dependencies: {
          transactionLedger: dependencies.transactionLedger.backing,
          ...(dependencies.webhookReplayStore
            ? { webhookReplay: dependencies.webhookReplayStore.backing }
            : {}),
          ...(dependencies.approvalStore
            ? { approvalConsumption: dependencies.approvalStore.backing }
            : {}),
        },
      });
    } catch (error) {
      logger.warn("readiness dependency check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res
        .status(503)
        .json({
          status: "unready",
          tools: dependencies.toolCount(),
          databases,
        });
    }
  });
}
