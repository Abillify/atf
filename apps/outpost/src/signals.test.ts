// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test, vi } from "vitest";
import { installShutdown } from "./signals.js";
import type { Scheduler } from "@atf/outpost-core";

describe("graceful shutdown", () => {
  test("waits for idle and exits after the first signal", async () => {
    const handlers = new Map<string, () => void>();
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    const beginShutdown = vi.fn();
    const stopAll = vi.fn(async () => undefined);
    const scheduler = { beginShutdown, awaitIdle: () => idle, stopAll } as unknown as Scheduler;
    const exit = vi.fn();
    const handle = installShutdown(scheduler, {
      handler: { on: (signal, callback) => { handlers.set(signal, callback); return () => handlers.delete(signal); } },
      exit,
      graceMs: 1000,
      setTimeoutFn: () => undefined,
      clearTimeoutFn: () => undefined,
    });

    handlers.get("SIGTERM")?.();
    expect(beginShutdown).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    resolveIdle();
    await handle.done();
    expect(stopAll).toHaveBeenCalledWith("shutdown");
    expect(exit).toHaveBeenCalledWith(0);
    handle.dispose();
  });
});
