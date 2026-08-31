// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the monitoring connection limit (DoS guard).
 */

import { describe, it, expect } from "bun:test";
import {
  MonitoringService,
  type MonitoringClient,
} from "../monitoring-service.js";

const noopClient = (): MonitoringClient => ({ send: () => {} });

describe("MonitoringService connection limit", () => {
  it("is unbounded when maxConnections is 0", () => {
    const svc = new MonitoringService(
      "sse",
      undefined,
      undefined,
      undefined,
      0,
    );
    for (let i = 0; i < 1000; i++) svc.subscribe(noopClient());
    expect(svc.hasConnectionCapacity()).toBe(true);
    expect(svc.getConnectionCount()).toBe(1000);
  });

  it("reports no capacity once the limit is reached", () => {
    const svc = new MonitoringService(
      "sse",
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(svc.hasConnectionCapacity()).toBe(true);
    svc.subscribe(noopClient());
    expect(svc.hasConnectionCapacity()).toBe(true);
    svc.subscribe(noopClient());
    expect(svc.hasConnectionCapacity()).toBe(false);
  });

  it("frees capacity when a client unsubscribes", () => {
    const svc = new MonitoringService(
      "sse",
      undefined,
      undefined,
      undefined,
      1,
    );
    const unsub = svc.subscribe(noopClient());
    expect(svc.hasConnectionCapacity()).toBe(false);
    unsub();
    expect(svc.hasConnectionCapacity()).toBe(true);
    expect(svc.getConnectionCount()).toBe(0);
  });
});
