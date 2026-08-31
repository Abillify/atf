// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property-Based Tests for Monitoring Service
 *
 * Feature: ai-agent-orchestration-platform, Property 23: Monitoring Event Completeness
 *
 * Validates: Requirements 9.1
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  MonitoringService,
  type MonitoringClient,
} from "../monitoring-service.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * ISO-8601 timestamp arbitrary.
 * `noInvalidDate: true` is required (fast-check v4+) so the generator never
 * produces an unrepresentable `Date` that would throw in `.toISOString()`.
 */
const arbitraryIso8601 = fc
  .date({
    min: new Date("2024-01-01"),
    max: new Date("2030-01-01"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

/** NodeExecutionEvent with status "running" */
const arbitraryRunningEvent = fc.record({
  execution_id: fc.string({ minLength: 1, maxLength: 36 }),
  node_id: fc.string({ minLength: 1, maxLength: 64 }),
  status: fc.constant("running" as const),
  start_time: arbitraryIso8601,
  end_time: fc.constant(null),
  latency_ms: fc.constant(null),
});

/** NodeExecutionEvent with status "completed" or "error" */
const arbitraryCompletedEvent = fc.record({
  execution_id: fc.string({ minLength: 1, maxLength: 36 }),
  node_id: fc.string({ minLength: 1, maxLength: 64 }),
  status: fc.constantFrom("completed" as const, "error" as const),
  start_time: arbitraryIso8601,
  end_time: arbitraryIso8601,
  latency_ms: fc.integer({ min: 0, max: 100000 }),
  error_message: fc.option(fc.string({ minLength: 1, maxLength: 100 }), {
    nil: undefined,
  }),
});

/** Any NodeExecutionEvent */
const arbitraryNodeEvent = fc.oneof(
  arbitraryRunningEvent,
  arbitraryCompletedEvent,
);

// ---------------------------------------------------------------------------
// Helper: create a capturing MonitoringClient
// ---------------------------------------------------------------------------

function createCapturingClient(): {
  client: MonitoringClient;
  received: NodeExecutionEvent[];
} {
  const received: NodeExecutionEvent[] = [];
  const client: MonitoringClient = {
    send(event: NodeExecutionEvent): void {
      received.push(event);
    },
  };
  return { client, received };
}

// ---------------------------------------------------------------------------
// Property 23: Monitoring Event Completeness
// Feature: ai-agent-orchestration-platform, Property 23: Monitoring Event Completeness
// ---------------------------------------------------------------------------

describe("Property 23: Monitoring Event Completeness", () => {
  // -------------------------------------------------------------------------
  // Test 1 — Event completeness: all required fields are present and intact
  // -------------------------------------------------------------------------
  test("emitted event contains all required fields with correct values", () => {
    // Feature: ai-agent-orchestration-platform, Property 23: Monitoring Event Completeness
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 36 }),
        arbitraryNodeEvent,
        (executionId, event) => {
          const service = new MonitoringService("sse");
          const { client, received } = createCapturingClient();
          service.subscribe(client);

          service.emitNodeEvent(executionId, event);

          expect(received).toHaveLength(1);
          const received0 = at(received, 0);

          // All required fields must be present
          expect(typeof received0.node_id).toBe("string");
          expect(received0.node_id.length).toBeGreaterThanOrEqual(1);
          expect(["running", "completed", "error"]).toContain(received0.status);
          expect(typeof received0.start_time).toBe("string");

          // end_time: string or null
          expect(
            received0.end_time === null ||
              typeof received0.end_time === "string",
          ).toBe(true);

          // latency_ms: number or null
          expect(
            received0.latency_ms === null ||
              typeof received0.latency_ms === "number",
          ).toBe(true);

          // Values must be identical to the emitted event
          expect(received0.node_id).toBe(event.node_id);
          expect(received0.status).toBe(event.status);
          expect(received0.start_time).toBe(event.start_time);
          expect(received0.end_time).toBe(event.end_time);
          expect(received0.latency_ms).toBe(event.latency_ms);
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — Running node invariant: end_time and latency_ms must be null
  // -------------------------------------------------------------------------
  test("running node event has end_time=null and latency_ms=null", () => {
    // Feature: ai-agent-orchestration-platform, Property 23: Monitoring Event Completeness
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 36 }),
        arbitraryRunningEvent,
        (executionId, event) => {
          const service = new MonitoringService("sse");
          const { client, received } = createCapturingClient();
          service.subscribe(client);

          service.emitNodeEvent(executionId, event);

          expect(received).toHaveLength(1);
          const received0 = at(received, 0);
          expect(received0.status).toBe("running");
          expect(received0.end_time).toBeNull();
          expect(received0.latency_ms).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Test 3 — Completed/error node: end_time is non-null, latency_ms is a
  //           non-negative integer
  // -------------------------------------------------------------------------
  test("completed or error node event has non-null end_time and non-negative latency_ms", () => {
    // Feature: ai-agent-orchestration-platform, Property 23: Monitoring Event Completeness
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 36 }),
        arbitraryCompletedEvent,
        (executionId, event) => {
          const service = new MonitoringService("sse");
          const { client, received } = createCapturingClient();
          service.subscribe(client);

          service.emitNodeEvent(executionId, event);

          expect(received).toHaveLength(1);
          const received0 = at(received, 0);
          expect(["completed", "error"]).toContain(received0.status);
          expect(received0.end_time).not.toBeNull();
          expect(typeof received0.end_time).toBe("string");
          expect(received0.latency_ms).not.toBeNull();
          expect(typeof received0.latency_ms).toBe("number");
          expect(received0.latency_ms as number).toBeGreaterThanOrEqual(0);
          // Must be an integer
          expect(Number.isInteger(received0.latency_ms)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Test 4 — Subscribe/unsubscribe: after unsubscribe, no events are received
  // -------------------------------------------------------------------------
  test("unsubscribed client does not receive further events", () => {
    // Feature: ai-agent-orchestration-platform, Property 23: Monitoring Event Completeness
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 36 }),
        arbitraryNodeEvent,
        arbitraryNodeEvent,
        (executionId, firstEvent, secondEvent) => {
          const service = new MonitoringService("sse");
          const { client, received } = createCapturingClient();
          const unsubscribe = service.subscribe(client);

          // First event: client is still subscribed → should receive it
          service.emitNodeEvent(executionId, firstEvent);
          expect(received).toHaveLength(1);

          // Unsubscribe, then emit a second event
          unsubscribe();
          service.emitNodeEvent(executionId, secondEvent);

          // Client must NOT receive the second event
          expect(received).toHaveLength(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 — Multiple clients: all subscribers receive the same event
  // -------------------------------------------------------------------------
  test("all subscribed clients receive the same event", () => {
    // Feature: ai-agent-orchestration-platform, Property 23: Monitoring Event Completeness
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 36 }),
        arbitraryNodeEvent,
        fc.integer({ min: 2, max: 10 }),
        (executionId, event, clientCount) => {
          const service = new MonitoringService("sse");

          const capturers = Array.from({ length: clientCount }, () =>
            createCapturingClient(),
          );

          for (const { client } of capturers) {
            service.subscribe(client);
          }

          service.emitNodeEvent(executionId, event);

          for (const { received } of capturers) {
            // Each client must have received exactly one event
            expect(received).toHaveLength(1);
            // And the event content must match
            expect(at(received, 0).node_id).toBe(event.node_id);
            expect(at(received, 0).status).toBe(event.status);
            expect(at(received, 0).start_time).toBe(event.start_time);
            expect(at(received, 0).end_time).toBe(event.end_time);
            expect(at(received, 0).latency_ms).toBe(event.latency_ms);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
