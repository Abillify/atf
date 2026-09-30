// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 23: Job-Polling endet im Endstatus
 *
 * **Validates: Requirements 8.7**
 *
 * Für jede endliche Folge von Job-Statuswerten, die in einem Endstatus
 * (`completed`, `failed`, `cancelled`) endet, beendet `pollJob` das Polling
 * genau beim ersten Endstatus und gibt ihn zurück. Für `paused` oder
 * nicht-terminale Folgen hält es das Intervall zwischen 2 s und 30 s ein.
 */

import fc from "fast-check";
import type { JobStatus } from "@atf/extract-contract/v2";
import { describe, expect, it } from "vitest";
import {
  ExtractHttpClient,
  pollDelayMs,
  pollJob,
  POLL_INITIAL_MS,
  POLL_MAX_MS,
} from "../../src/index.js";
import { FakeExtract } from "../fakes/fake-extract.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";

const NON_TERMINAL: JobStatus[] = [
  "queued",
  "preparing",
  "processing",
  "emitting",
  "committing",
  "paused",
];
const TERMINAL: JobStatus[] = ["completed", "failed", "cancelled"];

function clientWith(fake: FakeExtract): ExtractHttpClient {
  return new ExtractHttpClient({
    extractUrl: "https://extract.example.com",
    tokenProvider: new FakeTokenProvider("tok"),
    version: "0.1.0",
    runtime: "docker",
    fetchImpl: fake.fetchImpl as unknown as typeof globalThis.fetch,
  });
}

describe("Property 23: Job-Polling endet im Endstatus", () => {
  it(
    "stoppt genau beim ersten Endstatus und liefert ihn zurück",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...NON_TERMINAL), { maxLength: 12 }),
          fc.constantFrom(...TERMINAL),
          async (prefix, final) => {
            const fake = new FakeExtract();
            const jobId = "job-1";
            fake.scriptJob(jobId, [...prefix, final]);
            const client = clientWith(fake);
            const slept: number[] = [];
            const job = await pollJob(client, jobId, {
              sleep: async (ms) => {
                slept.push(ms);
              },
            });
            // Genau der erste Endstatus wird geliefert.
            expect(job.status).toBe(final);
            // Es wurde genau so oft gepollt wie Einträge vor dem Endstatus + 1.
            const job_ = fake.jobs.get(jobId);
            expect(job_?.reads).toBe(prefix.length + 1);
            // Sleeps: prefix.length mal, Intervall 2 s → 30 s.
            expect(slept.length).toBe(prefix.length);
            for (const ms of slept) {
              expect(ms).toBeGreaterThanOrEqual(POLL_INITIAL_MS);
              expect(ms).toBeLessThanOrEqual(POLL_MAX_MS);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it("hält das Intervall zwischen 2 s und 30 s (monoton steigend, gedeckelt)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 40 }), (round) => {
        const delay = pollDelayMs(round);
        expect(delay).toBeGreaterThanOrEqual(POLL_INITIAL_MS);
        expect(delay).toBeLessThanOrEqual(POLL_MAX_MS);
        if (round > 0) expect(delay).toBeGreaterThanOrEqual(pollDelayMs(round - 1));
      }),
      { numRuns: 100 },
    );
    expect(pollDelayMs(0)).toBe(2_000);
    expect(pollDelayMs(3)).toBe(16_000);
    expect(pollDelayMs(4)).toBe(30_000);
    expect(pollDelayMs(100)).toBe(30_000);
  });
});
