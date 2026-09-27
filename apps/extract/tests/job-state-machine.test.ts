// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-state-machine.test.ts
 *
 * The job lifecycle transition table and the snapshot / resume_policy logic
 * (task 1.5, requirements 4.1, 4.11, 4.12). Pure functions, no database.
 */

import { describe, expect, it } from "vitest";
import type { JobStatus } from "@atf/extract-contract/v2";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
  isWorking,
  resolveAction,
} from "../src/jobs/state-machine.js";
import { buildSnapshot, decideResume, hashObject } from "../src/jobs/snapshot.js";

const ALL_STATUSES: JobStatus[] = [
  "queued",
  "preparing",
  "processing",
  "emitting",
  "committing",
  "completed",
  "failed",
  "paused",
  "cancelled",
];

describe("job state machine · transitions", () => {
  it("walks the happy path queued → … → completed", () => {
    const path: JobStatus[] = [
      "queued",
      "preparing",
      "processing",
      "emitting",
      "committing",
      "completed",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      if (from === undefined || to === undefined) continue;
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("rejects a self-transition", () => {
    for (const s of ALL_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("completed", "processing")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("processing", "committing")).toBe(false); // must pass through emitting
  });

  it("assertTransition throws InvalidTransitionError on an illegal move", () => {
    expect(() => assertTransition("completed", "queued")).toThrow(InvalidTransitionError);
    expect(assertTransition("queued", "preparing")).toBe("preparing");
  });

  it("classifies working and terminal states", () => {
    expect(isWorking("processing")).toBe(true);
    expect(isWorking("queued")).toBe(false);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("paused")).toBe(false);
  });

  it("allows failed → queued for retry-failed but not completed → queued", () => {
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("completed", "queued")).toBe(false);
  });
});

describe("job state machine · operator actions", () => {
  it("pause holds a working or queued job", () => {
    expect(resolveAction("processing", "pause")).toEqual({ next: "paused", pauseReason: "manual" });
    expect(resolveAction("queued", "pause")).toEqual({ next: "paused", pauseReason: "manual" });
  });

  it("pause on an already-paused or terminal job is a no-op", () => {
    expect(resolveAction("paused", "pause")).toBeNull();
    expect(resolveAction("completed", "pause")).toBeNull();
  });

  it("resume re-queues only a paused job", () => {
    expect(resolveAction("paused", "resume")).toEqual({ next: "queued", pauseReason: null });
    expect(resolveAction("processing", "resume")).toBeNull();
  });

  it("cancel abandons any non-terminal job", () => {
    expect(resolveAction("processing", "cancel")).toEqual({ next: "cancelled", pauseReason: null });
    expect(resolveAction("queued", "cancel")).toEqual({ next: "cancelled", pauseReason: null });
    expect(resolveAction("completed", "cancel")).toBeNull();
    expect(resolveAction("cancelled", "cancel")).toBeNull();
  });
});

describe("snapshot · hashing", () => {
  it("is stable across key order", () => {
    expect(hashObject({ a: 1, b: 2 })).toBe(hashObject({ b: 2, a: 1 }));
  });

  it("changes when a value changes", () => {
    expect(hashObject({ dpi: 200 })).not.toBe(hashObject({ dpi: 300 }));
  });

  it("builds distinct pipeline and prompt hashes", () => {
    const snap = buildSnapshot(
      { extractor: "poppler", renderer: "pdftoppm", visionModel: "vlm", renderDpi: 200, figureDpi: 300 },
      { pass1: "template A" },
    );
    expect(snap.pipelineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.pipelineHash).not.toBe(snap.promptHash);
  });
});

describe("resume_policy · decision against a changed hash", () => {
  const base = { pipelineHash: "p1", promptHash: "q1" };

  it("continues unchanged when the stand still matches (any policy)", () => {
    for (const policy of ["pin", "continue", "restart-stage"] as const) {
      const d = decideResume({ snapshot: base, current: { ...base }, policy });
      expect(d).toEqual({ action: "continue-pinned", changed: false });
    }
  });

  it("pin pauses when the pipeline hash changed", () => {
    const d = decideResume({ snapshot: base, current: { pipelineHash: "p2", promptHash: "q1" }, policy: "pin" });
    expect(d).toEqual({ action: "pause", changed: true, reason: "dependency" });
  });

  it("pin pauses when the prompt hash changed", () => {
    const d = decideResume({ snapshot: base, current: { pipelineHash: "p1", promptHash: "q2" }, policy: "pin" });
    expect(d.action).toBe("pause");
  });

  it("continue runs the rest under the new stand", () => {
    const d = decideResume({ snapshot: base, current: { pipelineHash: "p2", promptHash: "q1" }, policy: "continue" });
    expect(d).toEqual({ action: "continue-new", changed: true });
  });

  it("restart-stage recomputes from the configured stage, defaulting to analyzed", () => {
    const changed = { pipelineHash: "p2", promptHash: "q1" };
    const d1 = decideResume({ snapshot: base, current: changed, policy: "restart-stage" });
    expect(d1).toEqual({ action: "restart-stage", changed: true, fromStage: "analyzed" });
    const d2 = decideResume({ snapshot: base, current: changed, policy: "restart-stage", restartStage: "vision1" });
    expect(d2).toEqual({ action: "restart-stage", changed: true, fromStage: "vision1" });
  });
});

// ─── Property-based invariants ───────────────────────────────────────────────

import fc from "fast-check";

const statusArb = fc.constantFrom(...ALL_STATUSES);

describe("job state machine · properties", () => {
  it("terminal states have no outgoing transitions except failed → queued", () => {
    fc.assert(
      fc.property(statusArb, (to) => {
        // completed and cancelled are strictly terminal.
        expect(canTransition("completed", to)).toBe(false);
        expect(canTransition("cancelled", to)).toBe(false);
        // failed only re-queues.
        if (to !== "queued") expect(canTransition("failed", to)).toBe(false);
      }),
    );
  });

  it("canTransition is never true for a self-transition", () => {
    fc.assert(
      fc.property(statusArb, (s) => {
        expect(canTransition(s, s)).toBe(false);
      }),
    );
  });

  it("assertTransition throws exactly when canTransition is false", () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        const allowed = canTransition(from, to);
        if (allowed) {
          expect(assertTransition(from, to)).toBe(to);
        } else {
          expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
        }
      }),
    );
  });

  it("resolveAction never yields an illegal transition", () => {
    fc.assert(
      fc.property(statusArb, fc.constantFrom("pause", "resume", "cancel" as const), (status, action) => {
        const resolved = resolveAction(status, action);
        if (resolved !== null) {
          expect(canTransition(status, resolved.next)).toBe(true);
        }
      }),
    );
  });
});
