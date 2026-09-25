// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Studio test runs (`src/graph/flow-registry-studio.ts`).
 *
 * The Studio's "Run & Trace" must execute what is on the CANVAS — unsaved
 * edits and drafts included — not the version that happens to be live. The
 * Studio therefore registers the (expanded) canvas definition here and runs it
 * under a throwaway model id `<flowId>@studio-<nonce>`.
 *
 * - Entries live in memory only, expire after `ttlMs` and are capped at `max`
 *   (oldest evicted first): a test definition never outlives the session that
 *   made it and never touches files or the flow store.
 * - They are resolvable by id but never LISTED, so they don't show up in
 *   `/v1/models`, health or any other catalogue.
 * - The definition keeps its real `id`, so access policy, guardrails, metering
 *   and monitoring treat the run as that flow; the compiled-graph cache keys on
 *   id + checksum, so a test definition can't collide with the live one.
 */

import * as crypto from "node:crypto";
import type { FlowDefinition } from "../types/flow.js";
import type { FlowRegistry } from "./flow-parser.js";

export const STUDIO_TEST_MARKER = "@studio-";

export function isStudioTestModel(model: string): boolean {
  return model.includes(STUDIO_TEST_MARKER);
}

export interface StudioTestRegistry extends FlowRegistry {
  /** Registers a runnable definition; returns the model id to run it with. */
  register(def: FlowDefinition): { model: string; expiresAt: string };
}

export function createStudioTestRegistry(
  base: FlowRegistry,
  opts: { ttlMs?: number; max?: number; now?: () => number } = {},
): StudioTestRegistry {
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const max = opts.max ?? 50;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { def: FlowDefinition; expires: number }>();

  const prune = (): void => {
    const t = now();
    for (const [id, e] of entries) if (e.expires <= t) entries.delete(id);
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    get(flowId: string): FlowDefinition | undefined {
      if (!isStudioTestModel(flowId)) return base.get(flowId);
      prune();
      return entries.get(flowId)?.def;
    },
    list(): FlowDefinition[] {
      return base.list();
    },
    ...(base.getSource !== undefined
      ? { getSource: (id: string) => base.getSource?.(id) }
      : {}),
    register(def: FlowDefinition) {
      const model = `${def.id}${STUDIO_TEST_MARKER}${crypto.randomBytes(6).toString("hex")}`;
      const expires = now() + ttlMs;
      entries.set(model, { def, expires });
      prune();
      return { model, expiresAt: new Date(expires).toISOString() };
    },
  };
}
