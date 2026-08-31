// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { MonitorBus } from "../../src/monitor/events.ts";

describe("MonitorBus.ingestRemote", () => {
  it("tags a remotely-ingested event and replays it to subscribers", () => {
    const bus = new MonitorBus(10);
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.ingestRemote({ id: 42, ts: "2024-01-01T00:00:00.000Z", type: "tool_call", tool: "x" });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { remote?: boolean }).remote).toBe(true);
    expect((seen[0] as { id: number }).id).toBe(42);
  });

  it("includes remotely-ingested events in recent() replay", () => {
    const bus = new MonitorBus(10);
    bus.ingestRemote({ id: 1, ts: "t", type: "auth", username: "bob" });
    bus.publish({ type: "auth", username: "alice" });
    const recent = bus.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]!.remote).toBe(true);
    expect(recent[1]!.remote).toBeUndefined();
  });
});
