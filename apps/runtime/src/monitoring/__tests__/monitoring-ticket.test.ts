// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for short-lived monitoring tickets: round-trip sign/verify, expiry,
 * tamper rejection, and wrong-secret rejection.
 */

import { describe, test, expect } from "bun:test";
import {
  signMonitoringTicket,
  verifyMonitoringTicket,
} from "../monitoring-ticket.js";

const SECRET = "test-secret-at-least-16-chars-long";

describe("monitoring tickets", () => {
  test("round-trips a valid ticket and preserves the role", () => {
    const { ticket, expiresIn } = signMonitoringTicket(SECRET, "operator", 60);
    expect(expiresIn).toBeGreaterThan(0);
    const decoded = verifyMonitoringTicket(SECRET, ticket);
    expect(decoded).toBeDefined();
    if (decoded === undefined) throw new Error("expected a decoded ticket");
    expect(decoded.role).toBe("operator");
  });

  test("rejects an expired ticket", () => {
    const { ticket } = signMonitoringTicket(SECRET, "viewer", 10);
    // Verify at a time 11s in the future.
    const future = Date.now() + 11_000;
    expect(verifyMonitoringTicket(SECRET, ticket, future)).toBeUndefined();
  });

  test("rejects a ticket signed with a different secret", () => {
    const { ticket } = signMonitoringTicket(SECRET, "admin", 60);
    expect(
      verifyMonitoringTicket("another-secret-16chars+", ticket),
    ).toBeUndefined();
  });

  test("rejects a tampered role", () => {
    const { ticket } = signMonitoringTicket(SECRET, "viewer", 60);
    const parts = ticket.split(".");
    const tampered = ["admin", parts[1], parts[2], parts[3]].join(".");
    expect(verifyMonitoringTicket(SECRET, tampered)).toBeUndefined();
  });

  test("rejects malformed tokens", () => {
    expect(verifyMonitoringTicket(SECRET, undefined)).toBeUndefined();
    expect(verifyMonitoringTicket(SECRET, "")).toBeUndefined();
    expect(verifyMonitoringTicket(SECRET, "a.b.c")).toBeUndefined();
    expect(verifyMonitoringTicket(SECRET, "not-a-ticket")).toBeUndefined();
  });

  test("two tickets issued in the same second differ (nonce)", () => {
    const a = signMonitoringTicket(SECRET, "viewer", 60).ticket;
    const b = signMonitoringTicket(SECRET, "viewer", 60).ticket;
    expect(a).not.toBe(b);
  });
});
