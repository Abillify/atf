// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 17: Reducer-Semantik
 *
 * **Validates: Requirements 7.6, 8.7, 8.8, 8.10, 9.2, 9.3**
 *
 * `ingested` (ok/skipped) und `job-final` mit `completed` ergeben `synced`
 * mit übernommener Prüfsumme, Marker und unveränderter Reference;
 * `client-error` und `retries-exhausted` ergeben `failed` mit Fehlermeldung
 * und lassen die zuletzt synchronisierte Prüfsumme unverändert; `deleted`
 * ergibt `null`; `missing-in-source` bei deaktiviertem Mirror_Delete ergibt
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
  it("Referenz bleibt über jedes Outcome unverändert", () => {
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

  it("ingested und job-final/completed ergeben synced mit sha256 und Marker", () => {
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

  it("client-error und retries-exhausted ergeben failed ohne sha256 zu ändern", () => {
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
            // Die zuletzt synchronisierte Prüfsumme bleibt unverändert (8.10).
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

  it("deleted entfernt den Eintrag (null)", () => {
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

  it("accepted ergibt pending-job mit jobId, marker-only verschiebt nur den Marker", () => {
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

  it("job-final failed/cancelled ergibt failed mit Fehler", () => {
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

  it("Reducer ist deterministisch: gleiches Outcome, gleiches Ergebnis", () => {
    fc.assert(
      fc.property(fc.option(itemStateArb, { nil: undefined }), referenceArb, outcomeArb, (prev, ref, outcome) => {
        const a = reduce(prev, ref, outcome, now);
        const b = reduce(prev, ref, outcome, now);
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });

  it("Typ: reduce liefert nie ein Objekt ohne Referenz", () => {
    const state: ItemState = { reference: "outpost:s1:x", marker: "m", size: 1, status: "synced" };
    const next = reduce(state, "outpost:s1:y", { kind: "marker-only", marker: "n" }, now);
    expect(next?.reference).toBe("outpost:s1:y");
  });
});
