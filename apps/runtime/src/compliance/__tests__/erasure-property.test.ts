// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Property tests for erasure honesty (Req 2.10 / Property 4):
 * "For arbitrary combinations of store results the overall status is `ok`
 * exactly when no store reports `failed`; the `erased` total is the sum of
 * the partial values."
 *
 * Tested on two levels: the pure aggregation function `aggregateStatus` and the
 * full orchestrator round-trip (local retention stores + remote stores).
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { randomUUID } from "node:crypto";

import type {
  ErasureRequest,
  ErasureStoreResult,
} from "@atf/erasure-contract";

import {
  aggregateStatus,
  createErasureOrchestrator,
} from "../erasure-orchestrator.js";
import type { ErasureTargetConfig } from "../erasure-targets.js";
import {
  RetentionService,
  type ErasureSubject,
  type RetentionTarget,
} from "../../observability/retention.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary per-store outcome: ok / failed / not_configured with a count. */
const storeResultArb: fc.Arbitrary<ErasureStoreResult> = fc
  .record({
    store: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `s-${s}`),
    status: fc.constantFrom("ok", "failed", "not_configured") as fc.Arbitrary<
      ErasureStoreResult["status"]
    >,
    erased: fc.nat({ max: 1000 }),
  })
  .map((r) =>
    r.status === "failed"
      ? { ...r, erased: 0, error: "boom" }
      : r,
  );

const resultsArb = fc.array(storeResultArb, { minLength: 0, maxLength: 8 });

// ---------------------------------------------------------------------------
// Property 4 — pure aggregation
// ---------------------------------------------------------------------------

describe("Property 4: aggregateStatus honesty", () => {
  it("is complete iff no store reports failed (not_configured never fails)", () => {
    fc.assert(
      fc.property(resultsArb, (results) => {
        const anyFailed = results.some((r) => r.status === "failed");
        const status = aggregateStatus(results);
        return (status === "complete") === !anyFailed;
      }),
      { numRuns: 500 },
    );
  });

  it("is failed iff every store failed, partial otherwise", () => {
    fc.assert(
      fc.property(resultsArb, (results) => {
        const failed = results.filter((r) => r.status === "failed").length;
        const status = aggregateStatus(results);
        if (results.length === 0) return status === "complete";
        if (failed === 0) return status === "complete";
        if (failed === results.length) return status === "failed";
        return status === "partial";
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — full orchestrator round-trip
// ---------------------------------------------------------------------------

interface StoreOutcome {
  status: "ok" | "failed";
  erased: number;
}

function localTarget(name: string, outcome: StoreOutcome): RetentionTarget {
  return {
    name,
    eraseSubject: async (_s: ErasureSubject): Promise<number> => {
      if (outcome.status === "failed") throw new Error(`local ${name} failed`);
      return outcome.erased;
    },
  };
}

function remoteTarget(
  service: string,
  stores: { name: string; outcome: StoreOutcome }[],
): { target: ErasureTargetConfig; fetchImpl: typeof fetch } {
  const target: ErasureTargetConfig = {
    service,
    url: `http://${service}.test/v1/erasure`,
    tokenEnv: `${service.toUpperCase()}_TOKEN`,
  };
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        requestId: "ignored",
        service,
        results: stores.map((s) => ({
          store: s.name,
          status: s.outcome.status,
          erased: s.outcome.status === "failed" ? 0 : s.outcome.erased,
          ...(s.outcome.status === "failed" ? { error: "remote boom" } : {}),
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  return { target, fetchImpl };
}

describe("Property 4: orchestrator erasure honesty", () => {
  it("status is complete iff no store failed; erased is the exact sum", async () => {
    const outcomeArb = fc.record({
      status: fc.constantFrom("ok", "failed") as fc.Arbitrary<"ok" | "failed">,
      erased: fc.nat({ max: 500 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(outcomeArb, { minLength: 0, maxLength: 4 }),
        fc.array(outcomeArb, { minLength: 0, maxLength: 4 }),
        async (localOutcomes, remoteOutcomes) => {
          const retention = new RetentionService(
            localOutcomes.map((o, i) => localTarget(`local-${i}`, o)),
          );
          const remote = remoteTarget("search", remoteOutcomes.map((o, i) => ({ name: `chunk-${i}`, outcome: o })));
          const orch = createErasureOrchestrator({
            retention,
            targets: [remote.target],
            envLookup: () => "tok",
            fetchImpl: remote.fetchImpl,
          });
          const req: ErasureRequest = {
            requestId: randomUUID(),
            tenantId: "acme",
            subject: { userId: "u@x.de", externalIds: [] },
            scope: "subject",
            dryRun: false,
          };
          const op = await orch.execute(req);

          // Overall status is complete exactly when no store reports failed.
          const anyFailed = op.results.some((r) => r.status === "failed");
          expect(op.status === "complete").toBe(!anyFailed);

          // The erased total is exactly the sum of the partial values.
          expect(op.erased).toBe(
            op.results.reduce((n, r) => n + r.erased, 0),
          );

          // Consistency with the pure aggregation function.
          expect(op.status).toBe(aggregateStatus(op.results));
        },
      ),
      { numRuns: 100 },
    );
  });
});
