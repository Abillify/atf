// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure release-gate logic: SemVer comparison, the version gate
 * message, p50 statistics over even/odd sample counts, threshold checks,
 * baseline regression and the bench runner wiring (token capture through a
 * fake executor).
 */
import { describe, expect, test } from "bun:test";
import {
  aggregateStats,
  buildReleaseReceipt,
  compareBaseline,
  compareSemVer,
  computeBenchDigest,
  evaluateThresholds,
  FlowReleaseReceiptSchema,
  percentile50,
  releaseReceiptSigningBytes,
  resolveReleaseThresholds,
  revisionBindingProblems,
  runBenchCases,
  signReleaseReceipt,
  totalTokensOf,
  verifyReleaseReceiptSignature,
  versionGateProblem,
  type FlowReleaseReceipt,
  type ReleaseStats,
} from "../flow-release.js";
import type { BenchFile } from "../bench-contract.js";
import type { FlowExecutionResult, FlowExecutor } from "../eval-runner.js";
import type { BenchExecutionExtras } from "../run.js";
import { parseEvidenceSigningKey } from "../../observability/evidence-key.js";

describe("compareSemVer", () => {
  test("orders numeric cores", () => {
    expect(compareSemVer("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemVer("1.2.4", "1.2.3")).toBe(1);
    expect(compareSemVer("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemVer("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemVer("1.10.0", "1.9.9")).toBe(1);
  });

  test("a release is greater than its prerelease", () => {
    expect(compareSemVer("1.2.3", "1.2.3-alpha")).toBe(1);
    expect(compareSemVer("1.2.3-alpha", "1.2.3")).toBe(-1);
  });

  test("prereleases compare by identifier rules", () => {
    expect(compareSemVer("1.0.0-alpha", "1.0.0-alpha")).toBe(0);
    expect(compareSemVer("1.0.0-alpha.1", "1.0.0-alpha.0")).toBe(1);
    expect(compareSemVer("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareSemVer("1.0.0-rc.1", "1.0.0-beta.9")).toBe(1);
  });

  test("throws on invalid versions", () => {
    expect(() => compareSemVer("1.2", "1.2.3")).toThrow();
    expect(() => compareSemVer("v1.2.3", "1.2.3")).toThrow();
    expect(() => compareSemVer("1.2.3", "not-a-version")).toThrow();
  });
});

describe("percentile50", () => {
  test("odd count takes the middle value", () => {
    expect(percentile50([3, 1, 2])).toBe(2);
    expect(percentile50([42])).toBe(42);
  });

  test("even count averages the two middle values", () => {
    expect(percentile50([1, 2, 3, 4])).toBe(2.5);
    expect(percentile50([10, 20])).toBe(15);
  });

  test("throws on an empty sample", () => {
    expect(() => percentile50([])).toThrow();
  });
});

describe("evaluateThresholds", () => {
  const stats: ReleaseStats = {
    cases: 4,
    passed: 4,
    passRate: 1,
    latencyMsP50: 100,
    tokensP50: 50,
  };

  test("passes when every threshold is met", () => {
    expect(
      evaluateThresholds(stats, { passRate: 1, maxLatencyMsP50: 100, maxTokensP50: 50 }),
    ).toEqual([]);
  });

  test("reports a pass rate below the threshold", () => {
    const failures = evaluateThresholds({ ...stats, passRate: 0.75 }, { passRate: 0.9 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("passRate");
    expect(failures[0]).toContain("75.0%");
    expect(failures[0]).toContain("90.0%");
  });

  test("reports latency and token medians above their maxima", () => {
    const failures = evaluateThresholds(
      { ...stats, latencyMsP50: 101, tokensP50: 51 },
      { passRate: 1, maxLatencyMsP50: 100, maxTokensP50: 50 },
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("p50 latency");
    expect(failures[1]).toContain("p50 tokens");
  });

  test("reports cascade escalation, budget stops and p95 wall time above their maxima", () => {
    const failures = evaluateThresholds(
      {
        ...stats,
        cascadeEscalationRate: 0.4,
        budgetExceededCount: 2,
        wallMsP50: 300,
        wallMsP95: 1_200,
      },
      {
        passRate: 1,
        maxCascadeEscalationRate: 0.3,
        maxBudgetExceeded: 1,
        maxWallMsP95: 1_000,
      },
    );
    expect(failures).toEqual([
      "cascade escalation rate 40.0% above max 30.0%",
      "budget exceeded 2 above max 1",
      "p95 wall time 1200ms above max 1000ms",
    ]);
  });

  test("new thresholds pass at their exact limit and are unchecked when unset", () => {
    expect(
      evaluateThresholds(
        { ...stats, cascadeEscalationRate: 0.3, budgetExceededCount: 1, wallMsP95: 1_000 },
        { passRate: 1, maxCascadeEscalationRate: 0.3, maxBudgetExceeded: 1, maxWallMsP95: 1_000 },
      ),
    ).toEqual([]);
    // Unset thresholds never fire, even on bad numbers.
    expect(
      evaluateThresholds(
        { ...stats, cascadeEscalationRate: 1, budgetExceededCount: 9, wallMsP95: 9_000 },
        { passRate: 1 },
      ),
    ).toEqual([]);
  });

  test("a null cascade rate is never a violation", () => {
    expect(
      evaluateThresholds(
        { ...stats, cascadeEscalationRate: null },
        { passRate: 1, maxCascadeEscalationRate: 0 },
      ),
    ).toEqual([]);
  });
});

describe("resolveReleaseThresholds", () => {
  test("the bench file value always wins over the flow's slo", () => {
    const resolved = resolveReleaseThresholds(
      { passRate: 1, maxLatencyMsP50: 200, maxTokensP50: 40 },
      { p50LatencyMs: 999, maxTokensP50: 999 },
    );
    expect(resolved.thresholds).toEqual({
      passRate: 1,
      maxLatencyMsP50: 200,
      maxTokensP50: 40,
    });
    expect(resolved.sources).toEqual({
      maxLatencyMsP50: "bench",
      maxTokensP50: "bench",
    });
  });

  test("the slo fills a threshold the bench file leaves out", () => {
    const resolved = resolveReleaseThresholds(
      { passRate: 1 },
      { p50LatencyMs: 300, maxTokensP50: 50 },
    );
    expect(resolved.thresholds).toEqual({
      passRate: 1,
      maxLatencyMsP50: 300,
      maxTokensP50: 50,
    });
    expect(resolved.sources).toEqual({
      maxLatencyMsP50: "slo",
      maxTokensP50: "slo",
    });
  });

  test("sources mix when only one threshold comes from the slo", () => {
    const resolved = resolveReleaseThresholds(
      { passRate: 1, maxTokensP50: 40 },
      { p50LatencyMs: 300 },
    );
    expect(resolved.thresholds.maxLatencyMsP50).toBe(300);
    expect(resolved.thresholds.maxTokensP50).toBe(40);
    expect(resolved.sources).toEqual({
      maxLatencyMsP50: "slo",
      maxTokensP50: "bench",
    });
  });

  test("without a slo the thresholds stay as the bench file has them", () => {
    const resolved = resolveReleaseThresholds({ passRate: 0.9 });
    expect(resolved.thresholds).toEqual({ passRate: 0.9 });
    expect("maxLatencyMsP50" in resolved.thresholds).toBe(false);
    expect("maxTokensP50" in resolved.thresholds).toBe(false);
    expect(resolved.sources).toEqual({});
  });

  test("slo objectives without a bench counterpart are not applied", () => {
    const resolved = resolveReleaseThresholds(
      { passRate: 1 },
      { p95LatencyMs: 10, maxErrorRate: 0.1 },
    );
    expect(resolved.thresholds).toEqual({ passRate: 1 });
    expect(resolved.sources).toEqual({});
  });
});

describe("compareBaseline", () => {
  test("a pass rate drop is a failure", () => {
    const comparison = compareBaseline(
      { results: { passRate: 1 } },
      { cases: 2, passed: 1, passRate: 0.5, latencyMsP50: 10, tokensP50: 5 },
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.failures.some((f) => f.includes("passRate regressed"))).toBe(true);
  });

  test("equal or better pass rate passes and reports deltas", () => {
    const comparison = compareBaseline(
      { results: { passRate: 0.5, latencyMsP50: 120, tokensP50: 40 } },
      { cases: 2, passed: 2, passRate: 1, latencyMsP50: 100, tokensP50: 50 },
    );
    expect(comparison.ok).toBe(true);
    expect(comparison.failures).toEqual([]);
    expect(comparison.deltas.some((d) => d.includes("passRate 50.0% → 100.0%"))).toBe(true);
    expect(comparison.deltas.some((d) => d.includes("-20ms"))).toBe(true);
    expect(comparison.deltas.some((d) => d.includes("+10"))).toBe(true);
  });

  test("a slower latency alone is only a delta, not a failure", () => {
    const comparison = compareBaseline(
      { results: { passRate: 1, latencyMsP50: 100 } },
      { cases: 1, passed: 1, passRate: 1, latencyMsP50: 500, tokensP50: 0 },
    );
    expect(comparison.ok).toBe(true);
    expect(comparison.deltas.some((d) => d.includes("+400ms"))).toBe(true);
  });
});

describe("versionGateProblem", () => {
  test("changed digest with an unchanged version fails with the exact message", () => {
    expect(
      versionGateProblem({ digestChanged: true, baseVersion: "1.2.3", headVersion: "1.2.3" }),
    ).toBe("flow changed but metadata.version was not raised (1.2.3 → 1.2.3)");
  });

  test("changed digest with a raised version passes", () => {
    expect(
      versionGateProblem({ digestChanged: true, baseVersion: "1.2.3", headVersion: "1.2.4" }),
    ).toBeUndefined();
  });

  test("changed digest with a lower version fails", () => {
    const problem = versionGateProblem({
      digestChanged: true,
      baseVersion: "2.0.0",
      headVersion: "1.9.9",
    });
    expect(problem).toContain("was not raised (2.0.0 → 1.9.9)");
  });

  test("an unchanged digest never fails the gate", () => {
    expect(
      versionGateProblem({ digestChanged: false, baseVersion: "1.2.3", headVersion: "1.2.3" }),
    ).toBeUndefined();
  });

  test("a missing head version on a changed flow fails", () => {
    const problem = versionGateProblem({ digestChanged: true, baseVersion: "1.2.3" });
    expect(problem).toContain("was not raised");
  });
});

describe("totalTokensOf", () => {
  test("prefers total_tokens, else sums prompt and completion", () => {
    expect(totalTokensOf({ total_tokens: 7, prompt_tokens: 3, completion_tokens: 4 })).toBe(7);
    expect(totalTokensOf({ prompt_tokens: 3, completion_tokens: 4 })).toBe(7);
    expect(totalTokensOf(undefined)).toBeUndefined();
    expect(totalTokensOf({})).toBeUndefined();
  });
});

describe("runBenchCases + aggregateStats", () => {
  const bench: BenchFile = {
    version: 1,
    flow: "demo",
    cases: [
      {
        id: "greeting",
        messages: [{ role: "user", content: "Hallo" }],
        assert: [{ type: "contains", value: "Hallo" }],
      },
      {
        id: "farewell",
        messages: [{ role: "user", content: "Tschüss" }],
        assert: [{ type: "contains", value: "Tschüss" }],
      },
      {
        id: "broken",
        messages: [{ role: "user", content: "Fail" }],
        assert: [{ type: "contains", value: "never-matches" }],
      },
    ],
    thresholds: { passRate: 0.5 },
  };

  /** Echoes the last message when its content is a plain string. */
  const lastText = (messages: { content: string | unknown }[]): string => {
    const content = messages[messages.length - 1]?.content;
    return typeof content === "string" ? content : "";
  };

  test("runs cases through the executor and captures latency and tokens", async () => {
    const seenFlows: string[] = [];
    const executor: FlowExecutor = async (flowId, messages): Promise<FlowExecutionResult> => {
      seenFlows.push(flowId);
      return {
        response: lastText(messages),
        latencyMs: 10,
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      };
    };

    const { report, stats } = await runBenchCases(bench, executor, 2);
    expect(seenFlows).toEqual(["demo", "demo", "demo"]);
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(stats).toHaveLength(3);
    expect(stats.every((s) => s.tokens === 10)).toBe(true);

    const aggregated = aggregateStats(report, stats);
    expect(aggregated.cases).toBe(3);
    expect(aggregated.passed).toBe(2);
    expect(aggregated.passRate).toBeCloseTo(2 / 3);
    expect(aggregated.latencyMsP50).toBe(10);
    expect(aggregated.tokensP50).toBe(10);
  });

  test("token median excludes cases without usage; zero when none reported", async () => {
    const executor: FlowExecutor = async (_flowId, messages): Promise<FlowExecutionResult> => {
      const content = lastText(messages);
      const withUsage = content !== "Fail";
      return {
        response: content,
        latencyMs: 4,
        ...(withUsage ? { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } : {}),
      };
    };
    const { report, stats } = await runBenchCases(bench, executor, 1);
    expect(stats.filter((s) => s.tokens === undefined)).toHaveLength(1);
    expect(aggregateStats(report, stats).tokensP50).toBe(20);

    const noUsage: FlowExecutor = async (_f, messages) => ({
      response: lastText(messages),
    });
    const bare = await runBenchCases(bench, noUsage, 1);
    expect(aggregateStats(bare.report, bare.stats).tokensP50).toBe(0);
  });

  test("aggregates cascade escalations, budget stops and wall time over mixed cases", async () => {
    const mixedBench: BenchFile = {
      version: 1,
      flow: "demo",
      cases: [
        { id: "plain", messages: [{ role: "user", content: "a" }] },
        { id: "cascade-kept", messages: [{ role: "user", content: "b" }] },
        { id: "cascade-escalated", messages: [{ role: "user", content: "c" }] },
        { id: "budget", messages: [{ role: "user", content: "d" }] },
      ],
      thresholds: { passRate: 0 },
    };
    const executor: FlowExecutor = async (
      _flowId,
      messages,
    ): Promise<FlowExecutionResult & BenchExecutionExtras> => {
      const content = lastText(messages);
      const base: FlowExecutionResult & BenchExecutionExtras = {
        response: content,
        latencyMs: 10,
      };
      if (content === "a") return { ...base, wallMs: 100 };
      if (content === "b") return { ...base, cascadeNodes: 1, cascadeEscalated: false, wallMs: 200 };
      if (content === "c") return { ...base, cascadeNodes: 2, cascadeEscalated: true, wallMs: 300 };
      return { ...base, finishReason: "budget_exceeded", budgetExceeded: true, wallMs: 900 };
    };
    const { report, stats } = await runBenchCases(mixedBench, executor, 1);
    // The plain case reports no cascade observation at all.
    expect(stats.find((s) => s.id === "plain")?.cascadeNodes).toBeUndefined();
    expect(stats.find((s) => s.id === "cascade-escalated")?.cascadeEscalated).toBe(true);
    expect(stats.find((s) => s.id === "budget")?.budgetExceeded).toBe(true);

    const aggregated = aggregateStats(report, stats);
    // Only the two cascade cases count: one of two escalated.
    expect(aggregated.cascadeEscalationRate).toBeCloseTo(0.5);
    expect(aggregated.budgetExceededCount).toBe(1);
    expect(aggregated.wallMsP50).toBe(250);
    expect(aggregated.wallMsP95).toBe(900);
  });

  test("the cascade rate is null when no case ran a cascade node", async () => {
    const { report, stats } = await runBenchCases(bench, async (_f, messages) => ({
      response: lastText(messages),
      latencyMs: 5,
    }), 1);
    const aggregated = aggregateStats(report, stats);
    expect(aggregated.cascadeEscalationRate).toBeNull();
    expect(aggregated.budgetExceededCount).toBe(0);
    // Wall time falls back to the case latency when the executor reports none.
    expect(aggregated.wallMsP50).toBe(5);
    expect(aggregated.wallMsP95).toBe(5);
  });
});

describe("revision binding", () => {
  const head = { flowDigest: "sha256:head", flowVersion: "1.2.3" };

  test("no problems when every case ran the head revision", () => {
    expect(
      revisionBindingProblems(
        [
          { caseId: "a", flowDigest: "sha256:head", flowVersion: "1.2.3" },
          { caseId: "b", flowDigest: "sha256:head", flowVersion: "1.2.3" },
        ],
        head,
      ),
    ).toEqual([]);
  });

  test("reports a case that ran another digest or version", () => {
    expect(
      revisionBindingProblems(
        [
          { caseId: "a", flowDigest: "sha256:other", flowVersion: "1.2.3" },
          { caseId: "b", flowDigest: "sha256:head", flowVersion: "1.2.2" },
        ],
        head,
      ),
    ).toEqual([
      "a: the server ran flow digest sha256:other, not the local sha256:head",
      "b: the server ran flow version 1.2.2, not the local 1.2.3",
    ]);
  });

  test("reports a case without a readable trace", () => {
    expect(revisionBindingProblems([{ caseId: "a" }], head)).toEqual([
      "a: no flow_digest in the debug trace (is the trace readable with this token?)",
    ]);
  });

  test("an empty run cannot be bound", () => {
    expect(revisionBindingProblems([], head)).toEqual([
      "no bench case reported the flow revision it ran",
    ]);
  });

  test("the version is not compared when the head has none", () => {
    expect(
      revisionBindingProblems([{ caseId: "a", flowDigest: "sha256:head" }], {
        flowDigest: "sha256:head",
      }),
    ).toEqual([]);
  });

  test("runBenchCases reports the revision each case ran", async () => {
    const bench: BenchFile = {
      version: 1,
      flow: "demo",
      cases: [
        { id: "one", messages: [{ role: "user", content: "x" }], assert: [{ type: "contains", value: "x" }] },
        { id: "two", messages: [{ role: "user", content: "y" }], assert: [{ type: "contains", value: "y" }] },
      ],
      thresholds: { passRate: 1 },
    };
    const executor: FlowExecutor = async (_flowId, messages): Promise<FlowExecutionResult> => {
      const content = messages[messages.length - 1]?.content;
      const text = typeof content === "string" ? content : "";
      return text === "x"
        ? { response: text, flowDigest: "sha256:head", flowVersion: "1.2.3" }
        : { response: text };
    };
    const { revisions } = await runBenchCases(bench, executor, 1);
    expect(revisions).toEqual([
      { caseId: "one", flowDigest: "sha256:head", flowVersion: "1.2.3" },
      { caseId: "two" },
    ]);
  });
});

describe("release receipts", () => {
  // Fixed synthetic seed: deterministic key, kid and signature.
  const key = parseEvidenceSigningKey(Buffer.alloc(32, 7).toString("base64"));
  if (key === undefined) throw new Error("fixture signing key missing");

  const unsigned = buildReleaseReceipt({
    flowId: "demo",
    flowVersion: "1.2.4",
    flowDigest: "sha256:aaa",
    baseRef: "v1.2.3",
    baseFlowVersion: "1.2.3",
    benchDigest: "sha256:bbb",
    results: { cases: 3, passed: 3, passRate: 1, latencyMsP50: 12, tokensP50: 20 },
    thresholds: { passRate: 1, maxLatencyMsP50: 30_000 },
    createdAt: "2026-02-22T12:00:00.000Z",
  });

  test("computeBenchDigest is deterministic and sha256-formatted", () => {
    const bench: BenchFile = {
      version: 1,
      flow: "demo",
      cases: [{ id: "a", messages: [{ role: "user", content: "hi" }] }],
      thresholds: { passRate: 1 },
    };
    const d1 = computeBenchDigest(bench);
    const d2 = computeBenchDigest({ ...bench, cases: [...bench.cases] });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeBenchDigest({ ...bench, flow: "other" })).not.toBe(d1);
  });

  test("sign adds an EdDSA signature with the key thumbprint kid", () => {
    const receipt = signReleaseReceipt(unsigned, key);
    expect(receipt.signature.alg).toBe("EdDSA");
    expect(receipt.signature.kid).toBe(key.kid);
    expect(receipt.signature.value.length).toBeGreaterThan(0);
    expect(FlowReleaseReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  test("verify accepts the signature over the canonical bytes without signature", () => {
    const receipt = signReleaseReceipt(unsigned, key);
    expect(verifyReleaseReceiptSignature(receipt, key.publicKeyRaw)).toBe(true);
    // The signing input excludes the signature field itself.
    const bytes = releaseReceiptSigningBytes(receipt);
    expect(bytes).not.toContain("signature");
    expect(bytes).toContain('"flowId":"demo"');
  });

  test("verify rejects a tampered field", () => {
    const receipt = signReleaseReceipt(unsigned, key);
    const tampered: FlowReleaseReceipt = {
      ...receipt,
      results: { ...receipt.results, passRate: 0.5 },
    };
    expect(verifyReleaseReceiptSignature(tampered, key.publicKeyRaw)).toBe(false);
  });

  test("verify rejects a different key", () => {
    const receipt = signReleaseReceipt(unsigned, key);
    const other = parseEvidenceSigningKey(Buffer.alloc(32, 8).toString("base64"));
    if (other === undefined) throw new Error("fixture signing key missing");
    expect(verifyReleaseReceiptSignature(receipt, other.publicKeyRaw)).toBe(false);
  });

  test("omitted optional fields stay absent and verify", () => {
    const minimal = buildReleaseReceipt({
      flowId: "demo",
      flowVersion: "1.0.0",
      flowDigest: "sha256:ccc",
      benchDigest: "sha256:ddd",
      results: { cases: 1, passed: 1, passRate: 1, latencyMsP50: 1, tokensP50: 0 },
      thresholds: { passRate: 1 },
      createdAt: "2026-02-22T12:00:00.000Z",
    });
    expect("baseRef" in minimal).toBe(false);
    expect("baseFlowVersion" in minimal).toBe(false);
    const receipt = signReleaseReceipt(minimal, key);
    expect(verifyReleaseReceiptSignature(receipt, key.publicKeyRaw)).toBe(true);
    expect(FlowReleaseReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  test("schema rejects malformed receipts", () => {
    const receipt = signReleaseReceipt(unsigned, key);
    expect(
      FlowReleaseReceiptSchema.safeParse({ ...receipt, type: "other" }).success,
    ).toBe(false);
    expect(
      FlowReleaseReceiptSchema.safeParse({ ...receipt, version: 2 }).success,
    ).toBe(false);
    expect(
      FlowReleaseReceiptSchema.safeParse({
        ...receipt,
        results: { ...receipt.results, passRate: 2 },
      }).success,
    ).toBe(false);
    expect(
      FlowReleaseReceiptSchema.safeParse({
        ...receipt,
        signature: { ...receipt.signature, alg: "HS256" },
      }).success,
    ).toBe(false);
    expect(
      FlowReleaseReceiptSchema.safeParse({ ...receipt, unknown: true }).success,
    ).toBe(false);
    expect(
      FlowReleaseReceiptSchema.safeParse({
        ...receipt,
        thresholds: { ...receipt.thresholds, sources: { maxLatencyMsP50: "config" } },
      }).success,
    ).toBe(false);
    expect(
      FlowReleaseReceiptSchema.safeParse({
        ...receipt,
        thresholds: { ...receipt.thresholds, sources: { maxErrorRate: "slo" } },
      }).success,
    ).toBe(false);
  });

  test("the receipt records the source of each applied threshold", () => {
    const receipt = signReleaseReceipt(
      buildReleaseReceipt({
        ...unsigned,
        thresholds: {
          passRate: 1,
          maxLatencyMsP50: 30_000,
          maxTokensP50: 120,
          sources: { maxLatencyMsP50: "bench", maxTokensP50: "slo" },
        },
      }),
      key,
    );
    expect(receipt.thresholds.sources).toEqual({
      maxLatencyMsP50: "bench",
      maxTokensP50: "slo",
    });
    expect(FlowReleaseReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(verifyReleaseReceiptSignature(receipt, key.publicKeyRaw)).toBe(true);
  });

  test("a receipt written without threshold sources stays valid", () => {
    const receipt = signReleaseReceipt(unsigned, key);
    expect(receipt.thresholds.sources).toBeUndefined();
    const restored = FlowReleaseReceiptSchema.parse(
      JSON.parse(JSON.stringify(receipt)),
    );
    expect(restored.thresholds.sources).toBeUndefined();
    expect(verifyReleaseReceiptSignature(restored, key.publicKeyRaw)).toBe(true);
  });

  test("the new statistics travel through results and keep the receipt valid", () => {
    const receipt = signReleaseReceipt(
      buildReleaseReceipt({
        ...unsigned,
        results: {
          ...unsigned.results,
          cascadeEscalationRate: 0.25,
          budgetExceededCount: 1,
          wallMsP50: 30,
          wallMsP95: 90,
        },
        thresholds: { ...unsigned.thresholds, maxWallMsP95: 100 },
      }),
      key,
    );
    expect(receipt.results.cascadeEscalationRate).toBe(0.25);
    expect(receipt.results.budgetExceededCount).toBe(1);
    expect(receipt.results.wallMsP50).toBe(30);
    expect(receipt.results.wallMsP95).toBe(90);
    expect(receipt.thresholds.maxWallMsP95).toBe(100);
    expect(FlowReleaseReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(verifyReleaseReceiptSignature(receipt, key.publicKeyRaw)).toBe(true);
  });

  test("a receipt written without the new statistics still parses and verifies", () => {
    const receipt = signReleaseReceipt(unsigned, key);
    const restored = FlowReleaseReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)));
    expect(restored.results.cascadeEscalationRate).toBeUndefined();
    expect(restored.results.wallMsP95).toBeUndefined();
    expect(verifyReleaseReceiptSignature(restored, key.publicKeyRaw)).toBe(true);
  });
});
