// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the watcher and the credential trigger (Task 18.7).
 *
 * **Validates: Requirements 10.2, 6.17**
 *
 * Fake timers: a change event leads to a run within 30 s
 * (debounce 5 s, at the latest 30 s with ongoing events).
 * `credentialChanged` starts a run immediately for a source in the state
 * `needs-authorization`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outpostConfigSchema, type OutpostConfig, type SourceConfig } from "../../src/config/schema.js";
import { Scheduler } from "../../src/schedule/scheduler.js";
import { startWatcher, type WatchBackendFactory, type WatchHandle } from "../../src/schedule/watcher.js";
import { newCounters } from "../../src/sync/counters.js";
import type { RunReport } from "../../src/sync/run.js";
import { testLogger } from "../fakes/test-logger.js";

interface CapturedBackend {
  factory: WatchBackendFactory;
  change: () => void;
  closed: number;
}

function captureBackend(): CapturedBackend {
  const box: Partial<CapturedBackend> = {};
  box.factory = async (_dir, onChange): Promise<WatchHandle> => {
    box.change = onChange;
    return {
      async close(): Promise<void> {
        box.closed = (box.closed ?? 0) + 1;
      },
    };
  };
  return box as CapturedBackend;
}

describe("Watcher: debouncing and the 30 s deadline (10.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a run 5 s after the last change", async () => {
    const backend = captureBackend();
    const trigger = vi.fn();
    const handle = await startWatcher({ dir: "/tmp/x", trigger, backend: backend.factory });

    backend.change();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(trigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(trigger).toHaveBeenCalledTimes(1);

    await handle.close();
    expect(backend.closed).toBe(1);
  });

  it("postpones the start on further events (debounce)", async () => {
    const backend = captureBackend();
    const trigger = vi.fn();
    await startWatcher({ dir: "/tmp/x", trigger, backend: backend.factory });

    backend.change();
    await vi.advanceTimersByTimeAsync(4_000);
    backend.change();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(trigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("starts after 30 s at the latest with ongoing events", async () => {
    const backend = captureBackend();
    const trigger = vi.fn();
    await startWatcher({ dir: "/tmp/x", trigger, backend: backend.factory });

    // An event every 1 s; the debounce window would be postponed forever.
    for (let i = 0; i < 40; i += 1) {
      backend.change();
      await vi.advanceTimersByTimeAsync(1_000);
      if (trigger.mock.calls.length > 0) break;
    }
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("close() prevents firing after pending timers", async () => {
    const backend = captureBackend();
    const trigger = vi.fn();
    const handle = await startWatcher({ dir: "/tmp/x", trigger, backend: backend.factory });

    backend.change();
    await handle.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(trigger).not.toHaveBeenCalled();
  });
});

function makeCfg(): OutpostConfig {
  const base = outpostConfigSchema.parse({
    extractUrl: "https://extract.example.com",
    collection: "main",
    syncIntervalSec: 900,
  });
  const src = {
    type: "local",
    path: "/src/a",
    id: "a",
    watch: false,
  } as unknown as SourceConfig;
  return { ...base, sources: [src] };
}

describe("Credential trigger: immediate run after needs-authorization (6.17)", () => {
  it("credentialChanged starts another run immediately", async () => {
    let runs = 0;
    const scheduler = new Scheduler({
      cfg: makeCfg(),
      logger: testLogger(),
      flushSource: async () => undefined,
      runSource: async (): Promise<RunReport> => {
        runs += 1;
        const outcome = runs === 1 ? "needs-authorization" : "ok";
        return {
          outcome,
          ...(runs === 1 ? { reason: "missing" as const } : {}),
          counters: newCounters(),
          deletePhase: "none",
        };
      },
    });

    scheduler.trigger("a");
    await vi.waitFor(() => {
      expect(scheduler.status()[0]?.status).toBe("needs-authorization");
    });
    expect(runs).toBe(1);

    // Credential stored → immediate new run, without the interval.
    scheduler.credentialChanged("a");
    await vi.waitFor(() => {
      expect(scheduler.status()[0]?.status).toBe("idle");
    });
    expect(runs).toBe(2);
  });

  it("a trigger on a needs-authorization source still starts runs", async () => {
    let runs = 0;
    const scheduler = new Scheduler({
      cfg: makeCfg(),
      logger: testLogger(),
      flushSource: async () => undefined,
      runSource: async (): Promise<RunReport> => {
        runs += 1;
        return {
          outcome: "needs-authorization",
          reason: "missing",
          counters: newCounters(),
          deletePhase: "none",
        };
      },
    });

    scheduler.trigger("a");
    await vi.waitFor(() => expect(runs).toBe(1));
    scheduler.trigger("a");
    await vi.waitFor(() => expect(runs).toBe(2));
  });
});
