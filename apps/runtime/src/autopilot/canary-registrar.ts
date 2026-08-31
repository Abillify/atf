// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Canary Registrar (`src/autopilot/canary-registrar.ts`)
 *
 * Implements the {@link CanaryRegistrar} contract for the Autopilot engine.
 * When a promoted version should be rolled out as a canary, this module
 * writes (or updates) the runtime canary policy so that the existing
 * `CanaryManager` picks it up on the next hot-reload without a server restart.
 *
 * Strategy:
 *   - Uses the in-memory CanaryManager's `reload()` hook directly (fast path).
 *   - Additionally writes/updates the `canary.yaml` file in FLOWS_DIR so the
 *     policy survives restarts and is visible in version control.
 *
 * No `any` at module boundaries.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { CanaryManager } from "../graph/canary.js";
import type { Logger } from "../observability/logger.js";
import type { CanaryRegistrar } from "./autopilot-engine.js";

interface CanaryFileEntry {
  flow: string;
  candidate: string;
  trafficPercent: number;
  minSamples?: number;
  maxErrorRateDelta?: number;
  minScoreDelta?: number;
  autoRollback?: boolean;
}

interface CanaryFile {
  deployments: CanaryFileEntry[];
}

/**
 * Builds a {@link CanaryRegistrar} that:
 *   1. Resolves the candidate flow id as `<flowId>@<version>` (the versioned
 *      id scheme used by the A/B / versioned registry overlay).
 *   2. Upserts the canary entry in `<flowsDir>/canary.yaml`.
 *   3. Calls `canaryManager.reload()` so the change takes effect immediately
 *      without a file-watcher delay.
 */
export function createCanaryFileRegistrar(
  flowsDir: string,
  canaryManager: CanaryManager,
  logger?: Logger,
): CanaryRegistrar {
  return async ({ flowId, candidateVersion, trafficPercent }) => {
    const candidateId = `${flowId}@${candidateVersion}`;
    const filePath = path.join(flowsDir, "canary.yaml");

    // Load existing policy (or start fresh).
    let policy: CanaryFile = { deployments: [] };
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = parseYaml(raw) as CanaryFile | null;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray(parsed.deployments)
      ) {
        policy = parsed;
      }
    } catch {
      // File doesn't exist yet or is malformed — start with empty policy.
    }

    // Upsert the entry for this flow.
    const existing = policy.deployments.findIndex((d) => d.flow === flowId);
    const entry: CanaryFileEntry = {
      flow: flowId,
      candidate: candidateId,
      trafficPercent,
      minSamples: 20,
      maxErrorRateDelta: 0.05,
      minScoreDelta: 0.05,
      autoRollback: true,
    };

    if (existing >= 0) {
      policy.deployments[existing] = entry;
    } else {
      policy.deployments.push(entry);
    }

    // Write atomically: write to a temp file, then rename into place.
    const tmpPath = `${filePath}.tmp-autopilot`;
    try {
      await fs.promises.mkdir(flowsDir, { recursive: true });
      await fs.promises.writeFile(
        tmpPath,
        stringifyYaml(policy, { lineWidth: 120 }),
        "utf-8",
      );
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    // Hot-reload the canary manager immediately.
    canaryManager.reload();

    logger?.info("[Autopilot] Canary entry written and reloaded", {
      flowId,
      candidateId,
      trafficPercent,
      file: filePath,
    });
  };
}
