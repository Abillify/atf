// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for checkLimits (src/graph/agent-harness.ts).
 *
 * Feature: agent-harness-node, Property 12: Iteration limit bounds the loop
 * Feature: agent-harness-node, Property 13: Cost limit stops before the next task
 * Feature: agent-harness-node, Property 14: Time limit stops before the next task
 *
 * Validates: Requirements 5.1, 5.2, 6.1, 6.2, 7.1, 7.2, 12.3
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  checkLimits,
  DEFAULT_MAX_ITERATIONS,
  type HarnessConfig,
  type HarnessProgress,
} from "../agent-harness.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a positive integer for iteration limits (1–1000). */
const arbMaxIterations: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 1000,
});

/** Generate a positive cost value. */
const arbCostValue: fc.Arbitrary<number> = fc.double({
  min: 0.001,
  max: 10000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Generate a non-negative cost value (can be 0). */
const arbNonNegativeCost: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 10000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Generate a positive time limit in ms (1–3_600_000). */
const arbMaxTimeMs: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 3_600_000,
});

/** Generate a start time (epoch-like value). */
const arbStartTime: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: 1_700_000_000_000,
});

/** Generate a minimal HarnessProgress with specific iterations and cost. */
function makeProgress(iterations: number, cost: number): HarnessProgress {
  return {
    tasks: [],
    iterations,
    cost,
  };
}

// ---------------------------------------------------------------------------
// Property 12: Iteration limit bounds the loop
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 12: Iteration limit bounds the loop", () => {
  test("when iterations >= maxIterations, returns 'iteration-limit'", () => {
    fc.assert(
      fc.property(
        arbMaxIterations,
        fc.integer({ min: 0, max: 500 }),
        (maxIterations, extra) => {
          // iterations >= maxIterations (at or above the limit)
          const iterations = maxIterations + extra;
          const progress = makeProgress(iterations, 0);
          const cfg: HarnessConfig = { allowlist: ["a"], maxIterations };

          const result = checkLimits(progress, cfg, 0, () => 0);
          expect(result).toBe("iteration-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("when iterations < maxIterations (and no other limit hit), does NOT return 'iteration-limit'", () => {
    fc.assert(
      fc.property(
        arbMaxIterations.filter((n) => n > 1),
        (maxIterations) => {
          // iterations is strictly below the limit
          const sampled = fc.sample(
            fc.integer({ min: 0, max: maxIterations - 1 }),
            1,
          )[0];
          if (sampled === undefined) throw new Error("expected a sampled value");
          const iterations = sampled;
          const progress = makeProgress(iterations, 0);
          const cfg: HarnessConfig = { allowlist: ["a"], maxIterations };

          const result = checkLimits(progress, cfg, 0, () => 0);
          expect(result).not.toBe("iteration-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("default limit (DEFAULT_MAX_ITERATIONS) is applied when maxIterations is absent", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (extra) => {
        const iterations = DEFAULT_MAX_ITERATIONS + extra;
        const progress = makeProgress(iterations, 0);
        const cfg: HarnessConfig = { allowlist: ["a"] }; // no maxIterations

        const result = checkLimits(progress, cfg, 0, () => 0);
        expect(result).toBe("iteration-limit");
      }),
      { numRuns: 200 },
    );
  });

  test("when iterations < DEFAULT_MAX_ITERATIONS and no maxIterations configured, does NOT stop", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DEFAULT_MAX_ITERATIONS - 1 }),
        (iterations) => {
          const progress = makeProgress(iterations, 0);
          const cfg: HarnessConfig = { allowlist: ["a"] }; // no maxIterations

          const result = checkLimits(progress, cfg, 0, () => 0);
          expect(result).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  test("at most N iterations can pass before 'iteration-limit' is returned", () => {
    fc.assert(
      fc.property(arbMaxIterations, (maxIterations) => {
        const cfg: HarnessConfig = { allowlist: ["a"], maxIterations };

        // Simulate the loop: check limits at each iteration count
        for (let i = 0; i <= maxIterations; i++) {
          const progress = makeProgress(i, 0);
          const result = checkLimits(progress, cfg, 0, () => 0);
          if (i >= maxIterations) {
            expect(result).toBe("iteration-limit");
          } else {
            // Should not be iteration-limit (may still be undefined since no other limits)
            expect(result).not.toBe("iteration-limit");
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13: Cost limit stops before the next task
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 13: Cost limit stops before the next task", () => {
  test("when costUsd >= maxCost (and iteration limit not hit), returns 'cost-limit'", () => {
    fc.assert(
      fc.property(arbCostValue, arbNonNegativeCost, (maxCost, extra) => {
        // cost >= maxCost
        const cost = maxCost + extra;
        const progress = makeProgress(0, cost);
        const cfg: HarnessConfig = {
          allowlist: ["a"],
          maxIterations: 1000, // high enough to not trigger iteration limit
          maxCost,
        };

        const result = checkLimits(progress, cfg, 0, () => 0);
        expect(result).toBe("cost-limit");
      }),
      { numRuns: 200 },
    );
  });

  test("when costUsd < maxCost (and no other limit hit), does NOT return 'cost-limit'", () => {
    fc.assert(
      fc.property(
        arbCostValue.filter((c) => c > 0.01),
        (maxCost) => {
          // cost is strictly below the limit
          const cost = maxCost * 0.5; // always below
          const progress = makeProgress(0, cost);
          const cfg: HarnessConfig = {
            allowlist: ["a"],
            maxIterations: 1000,
            maxCost,
          };

          const result = checkLimits(progress, cfg, 0, () => 0);
          expect(result).not.toBe("cost-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("when maxCost is not configured, cost never triggers a stop", () => {
    fc.assert(
      fc.property(arbNonNegativeCost, (cost) => {
        const progress = makeProgress(0, cost);
        const cfg: HarnessConfig = {
          allowlist: ["a"],
          maxIterations: 1000,
          // no maxCost
        };

        const result = checkLimits(progress, cfg, 0, () => 0);
        expect(result).not.toBe("cost-limit");
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: Time limit stops before the next task
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 14: Time limit stops before the next task", () => {
  test("when elapsed time >= maxTimeMs (and other limits not hit), returns 'time-limit'", () => {
    fc.assert(
      fc.property(
        arbMaxTimeMs,
        fc.integer({ min: 0, max: 3_600_000 }),
        arbStartTime,
        (maxTimeMs, extra, startTime) => {
          // Injected clock: now() - startTime >= maxTimeMs
          const elapsed = maxTimeMs + extra;
          const now = () => startTime + elapsed;
          const progress = makeProgress(0, 0);
          const cfg: HarnessConfig = {
            allowlist: ["a"],
            maxIterations: 1000,
            maxTimeMs,
          };

          const result = checkLimits(progress, cfg, startTime, now);
          expect(result).toBe("time-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("when elapsed time < maxTimeMs (and no other limit hit), does NOT return 'time-limit'", () => {
    fc.assert(
      fc.property(
        arbMaxTimeMs.filter((t) => t > 1),
        arbStartTime,
        (maxTimeMs, startTime) => {
          // Elapsed is strictly below the limit
          const elapsed = Math.floor(maxTimeMs * 0.5); // always below
          const now = () => startTime + elapsed;
          const progress = makeProgress(0, 0);
          const cfg: HarnessConfig = {
            allowlist: ["a"],
            maxIterations: 1000,
            maxTimeMs,
          };

          const result = checkLimits(progress, cfg, startTime, now);
          expect(result).not.toBe("time-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("when maxTimeMs is not configured, time never triggers a stop", () => {
    fc.assert(
      fc.property(arbStartTime, (startTime) => {
        // Even with a very late clock, no time stop without config
        const now = () => startTime + 999_999_999;
        const progress = makeProgress(0, 0);
        const cfg: HarnessConfig = {
          allowlist: ["a"],
          maxIterations: 1000,
          // no maxTimeMs
        };

        const result = checkLimits(progress, cfg, startTime, now);
        expect(result).not.toBe("time-limit");
      }),
      { numRuns: 200 },
    );
  });

  test("injected clock is used (not Date.now) for time calculations", () => {
    // Verify the clock injection works: with a fake clock that reports
    // time has passed, the limit triggers; with one that says no time passed, it doesn't
    fc.assert(
      fc.property(arbMaxTimeMs, arbStartTime, (maxTimeMs, startTime) => {
        const cfg: HarnessConfig = {
          allowlist: ["a"],
          maxIterations: 1000,
          maxTimeMs,
        };
        const progress = makeProgress(0, 0);

        // Clock says time is exceeded
        const overClock = () => startTime + maxTimeMs;
        expect(checkLimits(progress, cfg, startTime, overClock)).toBe(
          "time-limit",
        );

        // Clock says no time has passed
        const underClock = () => startTime;
        expect(checkLimits(progress, cfg, startTime, underClock)).not.toBe(
          "time-limit",
        );
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Priority order: iteration-limit > cost-limit > time-limit
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 12/13/14: Limit priority order", () => {
  test("iteration-limit takes precedence over cost-limit", () => {
    fc.assert(
      fc.property(arbMaxIterations, arbCostValue, (maxIterations, maxCost) => {
        // Both iteration and cost limits are exceeded
        const progress = makeProgress(maxIterations, maxCost);
        const cfg: HarnessConfig = {
          allowlist: ["a"],
          maxIterations,
          maxCost,
        };

        const result = checkLimits(progress, cfg, 0, () => 0);
        expect(result).toBe("iteration-limit");
      }),
      { numRuns: 200 },
    );
  });

  test("iteration-limit takes precedence over time-limit", () => {
    fc.assert(
      fc.property(
        arbMaxIterations,
        arbMaxTimeMs,
        arbStartTime,
        (maxIterations, maxTimeMs, startTime) => {
          // Both iteration and time limits are exceeded
          const progress = makeProgress(maxIterations, 0);
          const now = () => startTime + maxTimeMs;
          const cfg: HarnessConfig = {
            allowlist: ["a"],
            maxIterations,
            maxTimeMs,
          };

          const result = checkLimits(progress, cfg, startTime, now);
          expect(result).toBe("iteration-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("cost-limit takes precedence over time-limit", () => {
    fc.assert(
      fc.property(
        arbCostValue,
        arbMaxTimeMs,
        arbStartTime,
        (maxCost, maxTimeMs, startTime) => {
          // Cost and time limits exceeded, but iterations are below
          const progress = makeProgress(0, maxCost);
          const now = () => startTime + maxTimeMs;
          const cfg: HarnessConfig = {
            allowlist: ["a"],
            maxIterations: 1000, // high, won't trigger
            maxCost,
            maxTimeMs,
          };

          const result = checkLimits(progress, cfg, startTime, now);
          expect(result).toBe("cost-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("all three limits exceeded returns iteration-limit (highest priority)", () => {
    fc.assert(
      fc.property(
        arbMaxIterations,
        arbCostValue,
        arbMaxTimeMs,
        arbStartTime,
        (maxIterations, maxCost, maxTimeMs, startTime) => {
          // All three limits exceeded simultaneously
          const progress = makeProgress(maxIterations, maxCost);
          const now = () => startTime + maxTimeMs;
          const cfg: HarnessConfig = {
            allowlist: ["a"],
            maxIterations,
            maxCost,
            maxTimeMs,
          };

          const result = checkLimits(progress, cfg, startTime, now);
          expect(result).toBe("iteration-limit");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("no limits configured except default iteration: returns undefined when below default", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DEFAULT_MAX_ITERATIONS - 1 }),
        arbNonNegativeCost,
        arbStartTime,
        (iterations, cost, startTime) => {
          const progress = makeProgress(iterations, cost);
          const now = () => startTime + 999_999_999;
          const cfg: HarnessConfig = { allowlist: ["a"] }; // bare minimum config

          const result = checkLimits(progress, cfg, startTime, now);
          expect(result).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });
});
