// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Periodic tree-head sealing for the Decision_Receipt transparency log
 * (Req 15.3, design.md §Receipts: "periodic signed tree heads").
 *
 * Runs on the audit-anchor interval (`AUDIT_ANCHOR_INTERVAL_MS`) whenever
 * audit anchoring is active, so receipt tree heads are signed on the same
 * cadence as the audit-chain anchors. Each sealed head is persisted by the
 * log's durable sink in the append-only `receipt_tree_heads` table; the
 * audit-anchor JSONL file is not touched. A tick seals only when the log
 * grew since the latest sealed head, so an idle replica writes no rows.
 * Sealing failures are logged and never stop the timer.
 */

import type { Logger } from "../observability/logger.js";
import type { TransparencyLog } from "./transparency-log.js";

export interface TreeHeadSealer {
  /** Seal now if the log grew since the latest sealed head. */
  sealIfGrown(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createTreeHeadSealer(
  log: TransparencyLog,
  intervalMs: number,
  logger?: Logger,
): TreeHeadSealer {
  let timer: ReturnType<typeof setInterval> | undefined;
  const sealIfGrown = async (): Promise<boolean> => {
    const latest = log.latestTreeHead();
    if (log.size() === 0 || (latest !== undefined && latest.treeSize >= log.size())) {
      return false;
    }
    try {
      const head = await log.sealTreeHead();
      logger?.info("Receipt tree head sealed", { treeSize: head.treeSize });
      return true;
    } catch (err) {
      logger?.warn("Receipt tree-head sealing failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
  return {
    sealIfGrown,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void sealIfGrown();
      }, intervalMs);
      // Never keep the process alive just for sealing.
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
