// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration test for the monitoring ticket flow: exchange an operator token
 * (header) for a short-lived ticket, then use that ticket as `?token=` on a
 * read endpoint — without ever putting the operator token in a URL.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
  createMonitoringRouter,
  type MonitoringServiceInterface,
} from "../monitoring-service.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

const fakeService = {
  getHistory: async () => [],
  getHistoryPage: async () => ({ executions: [], total: 0 }),
  getHistoryFacets: async () => ({ flows: [], users: [] }),
  getUsageLog: async () => [],
  getExecutionEvents: async () => [],
  getTransportType: () => "sse",
  hasConnectionCapacity: () => true,
  subscribe: () => () => {},
  emitNodeEvent: () => {},
} as unknown as MonitoringServiceInterface;

const authorizer = createOperatorAuthorizer({
  authRequired: true,
  tokens: [{ token: "viewer-tok", role: "viewer", name: "vicky" }],
});

const SECRET = "ticket-secret-at-least-16-chars";

function app() {
  const a = new Hono();
  a.route(
    "/",
    createMonitoringRouter(fakeService, {
      operatorAuth: authorizer,
      ticketSecret: SECRET,
      ticketTtlSeconds: 60,
    }),
  );
  return a;
}

describe("monitoring ticket endpoint", () => {
  it("issues a ticket for a valid operator token sent as a header", async () => {
    const res = await app().request("/monitoring/ticket", {
      method: "POST",
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expires_in: number };
    expect(typeof body.ticket).toBe("string");
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("rejects ticket issuance for an unknown token", async () => {
    const res = await app().request("/monitoring/ticket", {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the issued ticket as ?token= on a read endpoint", async () => {
    const a = app();
    const ticketRes = await a.request("/monitoring/ticket", {
      method: "POST",
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    const res = await a.request(
      `/monitoring/history?token=${encodeURIComponent(ticket)}`,
    );
    expect(res.status).toBe(200);
  });

  it("still rejects a bogus ?token= ticket", async () => {
    const res = await app().request("/monitoring/history?token=forged.0.0.0");
    expect(res.status).toBe(401);
  });
});
