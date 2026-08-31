// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Composite flow registry (`src/graph/flow-registry-composite.ts`)
 *
 * Lets the platform be configured *fully online* OR *fully file/image based*
 * (or any mix) without the engine knowing the difference. It overlays the
 * online {@link FlowStore}'s published flows on top of the file-based
 * {@link FlowRegistry}:
 *
 *   - File-only deploy  → DB source is empty, behaves exactly as before.
 *   - Fully online       → FLOWS_DIR is empty, every flow comes from the DB.
 *   - Mixed              → DB-published flows OVERRIDE a same-id file flow
 *                          (an explicit online edit is the newer intent).
 *
 * The DB side is an in-memory snapshot refreshed (a) immediately after a local
 * mutation (publish/rollback/delete via the editor) and (b) periodically, so a
 * publish on another replica is picked up within the poll interval — matching
 * the existing ~10s file hot-reload latency. The engine recompiles a flow lazily
 * by checksum, so a changed definition is rebuilt automatically; no explicit
 * cache invalidation is needed here.
 *
 * No `any` at module boundaries.
 */

import type { FlowDefinition } from "../types/flow.js";
import type { FlowRegistry } from "./flow-parser.js";
import type { FlowStore } from "./flow-store.js";
import type { Logger } from "../observability/logger.js";

/** Read snapshot of the online (DB) published flows. */
export interface DbFlowSource {
  get(id: string): FlowDefinition | undefined;
  list(): FlowDefinition[];
  /** Reloads the snapshot from the store. */
  refresh(): Promise<void>;
  /** Starts periodic background refresh. */
  startPolling(intervalMs: number): void;
  /** Stops the background refresh. */
  stop(): void;
}

class DbFlowSourceImpl implements DbFlowSource {
  private snapshot = new Map<string, FlowDefinition>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: FlowStore,
    private readonly logger?: Logger,
  ) {}

  get(id: string): FlowDefinition | undefined {
    return this.snapshot.get(id);
  }

  list(): FlowDefinition[] {
    return [...this.snapshot.values()];
  }

  async refresh(): Promise<void> {
    try {
      const published = await this.store.listPublished();
      this.snapshot = new Map(published.map((f) => [f.id, f]));
    } catch (err) {
      this.logger?.warn("Failed to refresh online flow snapshot", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  startPolling(intervalMs: number): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function createDbFlowSource(
  store: FlowStore,
  logger?: Logger,
): DbFlowSource {
  return new DbFlowSourceImpl(store, logger);
}

/**
 * Builds a {@link FlowRegistry} that serves DB-published flows over file flows.
 * `get` prefers the DB; `list` merges with DB entries winning on id collision.
 */
export function createCompositeRegistry(
  fileRegistry: FlowRegistry,
  dbSource: Pick<DbFlowSource, "get" | "list">,
): FlowRegistry {
  return {
    get(id: string): FlowDefinition | undefined {
      return dbSource.get(id) ?? fileRegistry.get(id);
    },
    list(): FlowDefinition[] {
      const byId = new Map<string, FlowDefinition>();
      for (const f of fileRegistry.list()) byId.set(f.id, f);
      for (const f of dbSource.list()) byId.set(f.id, f); // DB overrides file
      return [...byId.values()];
    },
  };
}

/**
 * Wraps a registry so synthetic versioned flow ids (`flow@version`) produced by
 * A/B experiments resolve to the pinned version definition, while every other
 * id delegates to the base registry. `list()` is unchanged (versioned ids are
 * never advertised). This lets the engine execute a specific flow version by id
 * without any version awareness of its own.
 */
export function createVersionedRegistry(
  base: FlowRegistry,
  resolveVersioned: (id: string) => FlowDefinition | undefined,
): FlowRegistry {
  return {
    get(id: string): FlowDefinition | undefined {
      if (id.includes("@")) {
        const pinned = resolveVersioned(id);
        if (pinned !== undefined) return pinned;
      }
      return base.get(id);
    },
    list(): FlowDefinition[] {
      return base.list();
    },
  };
}
