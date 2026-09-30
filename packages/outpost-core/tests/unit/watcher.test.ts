// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit-Tests fuer den Watcher und den Credential-Trigger (Task 18.7).
 *
 * **Validates: Requirements 10.2, 6.17**
 *
 * Fake-Timer: Ein Aenderungsereignis fuehrt innerhalb von 30 s zu einem Lauf
 * (Debounce 5 s, spaetestens 30 s bei anhaltenden Ereignissen).
 * `credentialChanged` startet sofort einen Lauf fuer eine Quelle im Zustand
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

describe("Watcher: Entprellung und 30-s-Frist (10.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("startet einen Lauf 5 s nach der letzten Änderung", async () => {
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

  it("verschiebt den Start bei weiteren Ereignissen (Debounce)", async () => {
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

  it("startet spätestens nach 30 s bei anhaltenden Ereignissen", async () => {
    const backend = captureBackend();
    const trigger = vi.fn();
    await startWatcher({ dir: "/tmp/x", trigger, backend: backend.factory });

    // Ereignis alle 1 s — das Debounce-Fenster würde ewig verschoben.
    for (let i = 0; i < 40; i += 1) {
      backend.change();
      await vi.advanceTimersByTimeAsync(1_000);
      if (trigger.mock.calls.length > 0) break;
    }
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("close() verhindert Auslösen nach offenen Timern", async () => {
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

describe("Credential-Trigger: sofortiger Run nach needs-authorization (6.17)", () => {
  it("credentialChanged startet sofort einen weiteren Lauf", async () => {
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

    // Credential hinterlegt → sofortiger neuer Lauf, ohne Intervall.
    scheduler.credentialChanged("a");
    await vi.waitFor(() => {
      expect(scheduler.status()[0]?.status).toBe("idle");
    });
    expect(runs).toBe(2);
  });

  it("Trigger auf needs-authorization-Quelle startet weiterhin Läufe", async () => {
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
