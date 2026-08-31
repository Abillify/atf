// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { MonitorBus } from "../../src/monitor/events.ts";
import { Metrics } from "../../src/monitor/metrics.ts";

describe("Metrics", () => {
  it("aggregates monitor events into Prometheus text", () => {
    const bus = new MonitorBus(50);
    const metrics = new Metrics();
    metrics.attach(bus);

    bus.publish({ type: "connection", sessionId: "s1", username: "u" });
    bus.publish({ type: "auth_failure", status: "error", message: "bad token" });
    bus.publish({ type: "tool_result", tool: "my_orders", status: "ok", durationMs: 42 });
    bus.publish({ type: "tool_result", tool: "my_orders", status: "ok", durationMs: 7 });
    bus.publish({ type: "tool_result", tool: "my_orders", status: "error", durationMs: 5 });

    const out = metrics.render();

    expect(out).toContain("mcpgate_connections_total 1");
    expect(out).toContain("mcpgate_auth_failures_total 1");
    expect(out).toContain('mcpgate_tool_calls_total{tool="my_orders",status="ok"} 2');
    expect(out).toContain('mcpgate_tool_calls_total{tool="my_orders",status="error"} 1');
    expect(out).toContain('mcpgate_tool_duration_ms_count{tool="my_orders"} 3');
    expect(out).toContain('mcpgate_tool_duration_ms_sum{tool="my_orders"} 54');
    // 50ms bucket should include all three observations (42, 7, 5 <= 50).
    expect(out).toContain('mcpgate_tool_duration_ms_bucket{tool="my_orders",le="50"} 3');
    // 10ms bucket should include only 7 and 5.
    expect(out).toContain('mcpgate_tool_duration_ms_bucket{tool="my_orders",le="10"} 2');

    metrics.detach();
  });

  it("stops recording after detach", () => {
    const bus = new MonitorBus(50);
    const metrics = new Metrics();
    metrics.attach(bus);
    metrics.detach();
    bus.publish({ type: "connection" });
    expect(metrics.render()).toContain("mcpgate_connections_total 0");
  });
});
