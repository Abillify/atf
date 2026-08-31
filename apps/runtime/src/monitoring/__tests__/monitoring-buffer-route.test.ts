// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import { createMonitoringRouter, MonitoringService } from "../monitoring-service.js";

const event = (node: string): NodeExecutionEvent => ({
  execution_id: "execution-1",
  node_id: node,
  status: "running",
  start_time: "2026-08-29T00:00:00.000Z",
  end_time: null,
  latency_ms: null,
});

describe("GET /monitoring/events/buffer", () => {
  test("returns a bounded resume page with the next cursor", async () => {
    const service = new MonitoringService("sse");
    service.emitNodeEvent("execution-1", event("one"));
    service.emitNodeEvent("execution-1", event("two"));
    service.emitNodeEvent("execution-1", event("three"));
    const response = await createMonitoringRouter(service).request("/monitoring/events/buffer?after=1&limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as { events: Array<{ id: string }>; nextAfter: string; gap: boolean };
    expect(body.events.map((entry) => entry.id)).toEqual(["2"]);
    expect(body.nextAfter).toBe("2");
    expect(body.gap).toBe(false);
  });

  test("rejects missing or non-positive cursors", async () => {
    const router = createMonitoringRouter(new MonitoringService("sse"));
    expect((await router.request("/monitoring/events/buffer")).status).toBe(400);
    expect((await router.request("/monitoring/events/buffer?after=0")).status).toBe(400);
  });
});
