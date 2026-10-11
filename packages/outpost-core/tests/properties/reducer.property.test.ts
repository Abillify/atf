// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 17: reducer semantics
 *
 * **Validates: Requirements 7.6, 8.7, 8.8, 8.10, 9.2, 9.3**
 *
 * `ingested` (ok/skipped) and `job-final` with `completed` yield `synced`
 * with the checksum and marker taken over and the reference unchanged;
 * `client-error` and `retries-exhausted` yield `failed` with an error message
 * and leave the last synchronized checksum unchanged; `deleted`
 * yields `null`; `missing-in-source` with Mirror_Delete disabled yields
 * `deleted-in-source`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduce, type ItemState, type Outcome } from "../../src/index.js";
import { itemStateArb, sha256Arb } from "../fakes/sync-arb.js";

const referenceArb = fc.stringMatching(/^outpost:s1:[A-Za-z0-9_-]{32}$/);

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.record({
    kind: fc.constant("ingested" as const),
    status: fc.constantFrom("ok" as const, "skipped" as const),
    sha256: sha256Arb,
    marker: fc.string({ minLength: 1, maxLength: 30 }),
  }),
  fc.record({
    kind: fc.constant("accepted" as const),
    jobId: fc.uuid(),
    sha256: sha256Arb,
    marker: fc.string({ minLength: 1, maxLength: 30 }),
  }),
  fc.record({
    kind: fc.constant("job-final" as const),
    jobStatus: fc.constantFrom("completed" as const, "failed" as const, "cancelled" as const),
    sha256: sha256Arb,
    marker: fc.string({ minLength: 1, maxLength: 30 }),
  }),
  fc.record({
    kind: fc.constant("marker-only" as const),
    marker: fc.string({ minLength: 1, maxLength: 30 }),
  }),
  fc.record({
    kind: fc.constant("client-error" as const),
    status: fc.constantFrom(400, 403, 404, 409, 413, 422),
    message: fc.string({ minLength: 1, maxLength: 60 }),
  }),
  fc.record({
    kind: fc.constant("retries-exhausted" as const),
    message: fc.string({ minLength: 1, maxLength: 60 }),
  }),
  fc.record({ kind: fc.constant("deleted" as const) }),
  fc.record({
    kind: fc.constant("missing-in-source" as const),
    mirrorDelete: fc.constant(false as const),
  }),
);

const NOW = "2026-02-02T12:00:00.000Z";
const now = () => NOW;

describe("Property 17: Reducer-Semantik", () => {
  it("the reference stays unchanged across every outcome", () => {
    fc.assert(
      fc.property(fc.option(itemStateArb, { nil: undefined }), referenceArb, outcomeArb, (prev, ref, outcome) => {
        const next = reduce(prev, ref, outcome, now);
        if (next === null) {
          expect(outcome.kind).toBe("deleted");
        } else {
          expect(next.reference).toBe(ref);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("ingested and job-final/completed yield synced with sha256 and marker", () => {
    fc.assert(
      fc.property(fc.option(itemStateArb, { nil: undefined }), referenceArb, outcomeArb, (prev, ref, outcome) => {
        const next = reduce(prev, ref, outcome, now);
        const success =
          outcome.kind === "ingested" || (outcome.kind === "job-final" && outcome.jobStatus === "completed");
        if (success && next !== null) {
          expect(next.status).toBe("synced");
          expect(next.sha256).toBe(outcome.sha256);
          expect(next.marker).toBe(outcome.marker);
          expect(next.jobId).toBeUndefined();
          expect(next.lastError).toBeUndefined();
          expect(next.syncedAt).toBe(NOW);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("client-error and retries-exhausted yield failed without changing sha256", () => {
    fc.assert(
      fc.property(
        fc.option(itemStateArb, { nil: undefined }),
        referenceArb,
        outcomeArb.filter((o) => o.kind === "client-error" || o.kind === "retries-exhausted"),
        (prev, ref, outcome) => {
          const syncedPrev = prev !== undefined && prev.status === "synced" ? prev : undefined;
          const next = reduce(syncedPrev, ref, outcome, now);
          expect(next).not.toBeNull();
          if (next !== null) {
            expect(next.status).toBe("failed");
            expect(next.lastError).toBeDefined();
            expect(next.lastError?.at).toBe(NOW);
            if (outcome.kind === "client-error") {
              expect(next.lastError?.message).toBe(outcome.message);
              expect(next.lastError?.code).toBe(`HTTP_${outcome.status}`);
            } else {
              expect(next.lastError?.message).toBe(outcome.message);
            }
            // The last synchronized checksum stays unchanged (8.10).
            if (syncedPrev !== undefined) {
              expect(next.sha256).toBe(syncedPrev.sha256);
              expect(next.marker).toBe(syncedPrev.marker);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("deleted removes the entry (null)", () => {
    fc.assert(
      fc.property(fc.option(itemStateArb, { nil: undefined }), referenceArb, (prev, ref) => {
        expect(reduce(prev, ref, { kind: "deleted" }, now)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("missing-in-source ergibt deleted-in-source", () => {
    fc.assert(
      fc.property(fc.option(itemStateArb, { nil: undefined }), referenceArb, (prev, ref) => {
        const next = reduce(prev, ref, { kind: "missing-in-source", mirrorDelete: false }, now);
        expect(next).not.toBeNull();
        expect(next?.status).toBe("deleted-in-source");
        expect(next?.reference).toBe(ref);
      }),
      { numRuns: 100 },
    );
  });

  it("accepted yields pending-job with jobId, marker-only only moves the marker", () => {
    fc.assert(
      fc.property(fc.option(itemStateArb, { nil: undefined }), referenceArb, outcomeArb, (prev, ref, outcome) => {
        const next = reduce(prev, ref, outcome, now);
        if (outcome.kind === "accepted" && next !== null) {
          expect(next.status).toBe("pending-job");
          expect(next.jobId).toBe(outcome.jobId);
          expect(next.sha256).toBe(outcome.sha256);
        }
        if (outcome.kind === "marker-only" && next !== null && prev !== undefined) {
          expect(next.marker).toBe(outcome.marker);
          expect(next.sha256).toBe(prev.sha256);
          expect(next.status).toBe(prev.status);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("job-final failed/cancelled yields failed with an error", () => {
    fc.assert(
      fc.property(
        fc.option(itemStateArb, { nil: undefined }),
        referenceArb,
        fc.constantFrom("failed" as const, "cancelled" as const),
        sha256Arb,
        (prev, ref, jobStatus, sha256) => {
          const next = reduce(prev, ref, { kind: "job-final", jobStatus, sha256, marker: "m" }, now);
          expect(next).not.toBeNull();
          expect(next?.status).toBe("failed");
          expect(next?.lastError?.code).toBe(`JOB_${jobStatus.toUpperCase()}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("the reducer is deterministic: same outcome, same result", () => {
    fc.assert(
      fc.property(fc.option(itemStateArb, { nil: undefined }), referenceArb, outcomeArb, (prev, ref, outcome) => {
        const a = reduce(prev, ref, outcome, now);
        const b = reduce(prev, ref, outcome, now);
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });

  it("type: reduce never returns an object without a reference", () => {
    const state: ItemState = { reference: "outpost:s1:x", marker: "m", size: 1, status: "synced" };
    const next = reduce(state, "outpost:s1:y", { kind: "marker-only", marker: "n" }, now);
    expect(next?.reference).toBe("outpost:s1:y");
  });
});
