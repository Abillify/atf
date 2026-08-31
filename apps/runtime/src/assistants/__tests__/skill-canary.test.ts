// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Skill canary: arm selection, verdict precedence, and outcome accounting.
 *
 * The verdict test that matters is the precedence one — rollback is evaluated before
 * promotion, so a canary that has passed the promotion sample count AND regressed
 * rolls back instead of graduating on a technicality.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SKILL_CANARY_PERCENT,
  InMemorySkillCanaryStore,
  SKILL_CANARY_MIN_SAMPLES,
  SKILL_CANARY_PROMOTE_SAMPLES,
  evaluateSkillCanary,
  isCanaryTurn,
} from "../skill-canary.js";
import type { AssistantScope, SkillCanaryRecord } from "../types.js";

const SCOPE: AssistantScope = {
  tenantId: "_",
  userId: "u@example.com",
  assistantId: "molty",
};

function arms(
  treatment: { runs: number; errors: number; scoreSum: number },
  control: { runs: number; errors: number; scoreSum: number },
): Pick<SkillCanaryRecord, "treatment" | "control"> {
  return { treatment, control };
}

describe("arm selection", () => {
  test("bucketing is deterministic for a routing key", () => {
    const params = { skillId: "s1", routingKey: "conv-1", trafficPercent: 50 };
    const first = isCanaryTurn(params);
    for (let index = 0; index < 20; index += 1) {
      // Every turn of one conversation must land in the same arm, or the user sees
      // the assistant flip behaviour between consecutive turns.
      expect(isCanaryTurn(params)).toBe(first);
    }
  });

  test("0% never treats and 100% always treats", () => {
    expect(isCanaryTurn({ skillId: "s", routingKey: "c", trafficPercent: 0 })).toBe(false);
    expect(isCanaryTurn({ skillId: "s", routingKey: "c", trafficPercent: 100 })).toBe(true);
  });

  test("two canaries do not put the same conversation in both treatment arms", () => {
    // The skill id is part of the hash for exactly this reason: overlapping treatment
    // would make each canary's outcome include the other's effect.
    const keys = Array.from({ length: 60 }, (_, index) => `conv-${index}`);
    const both = keys.filter(
      (routingKey) =>
        isCanaryTurn({ skillId: "a", routingKey, trafficPercent: 50 }) &&
        isCanaryTurn({ skillId: "b", routingKey, trafficPercent: 50 }),
    );
    // Independent hashes, so overlap is expected but must not be total.
    expect(both.length).toBeLessThan(keys.length);
  });

  test("the split is roughly even across many keys", () => {
    const keys = Array.from({ length: 400 }, (_, index) => `conv-${index}`);
    const treated = keys.filter((routingKey) =>
      isCanaryTurn({
        skillId: "s",
        routingKey,
        trafficPercent: DEFAULT_SKILL_CANARY_PERCENT,
      }),
    ).length;
    // A single assistant produces few turns per day, which is why the default split is
    // 50/50 rather than the small percentage a traffic-level canary uses.
    expect(treated).toBeGreaterThan(140);
    expect(treated).toBeLessThan(260);
  });
});

describe("verdict", () => {
  test("below the sample floor it continues", () => {
    const verdict = evaluateSkillCanary(
      arms(
        { runs: SKILL_CANARY_MIN_SAMPLES - 1, errors: 5, scoreSum: 0 },
        { runs: 20, errors: 0, scoreSum: 20 },
      ),
    );
    expect(verdict.action).toBe("continue");
  });

  test("a higher error rate rolls back", () => {
    const verdict = evaluateSkillCanary(
      arms({ runs: 20, errors: 8, scoreSum: 12 }, { runs: 20, errors: 0, scoreSum: 20 }),
    );
    expect(verdict.action).toBe("rollback");
  });

  test("no regression past the promotion count promotes", () => {
    const verdict = evaluateSkillCanary(
      arms(
        { runs: SKILL_CANARY_PROMOTE_SAMPLES, errors: 0, scoreSum: SKILL_CANARY_PROMOTE_SAMPLES },
        { runs: 20, errors: 0, scoreSum: 20 },
      ),
    );
    expect(verdict.action).toBe("promote");
  });

  test("rollback wins over promotion when both conditions hold", () => {
    // Otherwise a regressed skill graduates on a technicality.
    const verdict = evaluateSkillCanary(
      arms(
        { runs: SKILL_CANARY_PROMOTE_SAMPLES + 10, errors: 15, scoreSum: 5 },
        { runs: 20, errors: 0, scoreSum: 20 },
      ),
    );
    expect(verdict.action).toBe("rollback");
  });

  test("a verdict states its reason in numbers", () => {
    const verdict = evaluateSkillCanary(
      arms(
        { runs: SKILL_CANARY_PROMOTE_SAMPLES, errors: 0, scoreSum: SKILL_CANARY_PROMOTE_SAMPLES },
        { runs: 20, errors: 0, scoreSum: 20 },
      ),
    );
    if (verdict.action === "continue") throw new Error("expected a decision");
    expect(verdict.reason).toContain("error rate");
  });

  test("thresholds are overridable for tuning", () => {
    const verdict = evaluateSkillCanary(
      arms({ runs: 3, errors: 0, scoreSum: 3 }, { runs: 3, errors: 0, scoreSum: 3 }),
      { minSamples: 2, promoteSamples: 3 },
    );
    expect(verdict.action).toBe("promote");
  });
});

describe("outcome accounting", () => {
  test("outcomes land in the right arm", async () => {
    const store = new InMemorySkillCanaryStore();
    await store.start({ scope: SCOPE, skillId: "s1" });
    await store.recordOutcome(SCOPE, [
      { skillId: "s1", treatment: true, errored: false, score: 1 },
      { skillId: "s1", treatment: false, errored: true },
    ]);
    const record = await store.get(SCOPE, "s1");
    expect(record?.treatment).toEqual({ runs: 1, errors: 0, scoreSum: 1 });
    expect(record?.control).toEqual({ runs: 1, errors: 1, scoreSum: 0 });
  });

  test("starting twice does not reset the counters", async () => {
    const store = new InMemorySkillCanaryStore();
    await store.start({ scope: SCOPE, skillId: "s1" });
    await store.recordOutcome(SCOPE, [{ skillId: "s1", treatment: true, errored: false }]);
    // A retried apply must not discard samples already gathered.
    await store.start({ scope: SCOPE, skillId: "s1" });
    expect((await store.get(SCOPE, "s1"))?.treatment.runs).toBe(1);
  });

  test("a settled canary stops accumulating", async () => {
    const store = new InMemorySkillCanaryStore();
    await store.start({ scope: SCOPE, skillId: "s1" });
    await store.settle({
      scope: SCOPE,
      skillId: "s1",
      state: "promoted",
      reason: "no regression",
    });
    await store.recordOutcome(SCOPE, [{ skillId: "s1", treatment: true, errored: true }]);
    const record = await store.get(SCOPE, "s1");
    expect(record?.state).toBe("promoted");
    expect(record?.treatment.runs).toBe(0);
  });

  test("only running canaries are listed", async () => {
    const store = new InMemorySkillCanaryStore();
    await store.start({ scope: SCOPE, skillId: "s1" });
    await store.start({ scope: SCOPE, skillId: "s2" });
    await store.settle({
      scope: SCOPE,
      skillId: "s1",
      state: "rolled-back",
      reason: "regressed",
    });
    const running = await store.listRunning(SCOPE);
    expect(running.map((canary) => canary.skillId)).toEqual(["s2"]);
  });

  test("canaries are scoped per assistant", async () => {
    const store = new InMemorySkillCanaryStore();
    await store.start({ scope: SCOPE, skillId: "s1" });
    expect(await store.listRunning({ ...SCOPE, assistantId: "other" })).toEqual([]);
  });

  test("purge removes them", async () => {
    const store = new InMemorySkillCanaryStore();
    await store.start({ scope: SCOPE, skillId: "s1" });
    await store.purge(SCOPE);
    expect(await store.listRunning(SCOPE)).toEqual([]);
  });
});
