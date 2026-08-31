// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { parseHarnessConfig } from "../../agent-harness/types.js";

const nodes = [
  { id: "router", type: "router" },
  { id: "orchestrator", type: "agent-harness", systemPrompt: "Plan parallelizable work and verify PASS." },
  { id: "worker", type: "llm" },
  { id: "verifier", type: "llm", systemPrompt: "Return PASS when review succeeds." },
];
const edges = [{ source: "router", target: "orchestrator", conditions: "needsOrchestration" }];
const config = parseHarnessConfig({ allowlist: ["worker"], verification: { target: "verifier", passSignal: "PASS", maxAttempts: 1 }, maxIterations: 3, maxConcurrentTasks: 2, maxTaskAttempts: 1, maxDelegationDepth: 0, consequentialTargets: [] });

const node = (id: string) => nodes.find((item) => item.id === id);

describe("public agent-harness branch fixture", () => {
  test("routes complex work to an orchestrator with valid allowlist targets", () => {
    expect(edges.some((edge) => edge.source === "router" && edge.target === "orchestrator" && edge.conditions.includes("needsOrchestration"))).toBe(true);
    for (const target of config.allowlist) expect(node(target)).toBeDefined();
  });

  test("uses an isolated tool-free verification target with a matching sentinel", () => {
    const verification = config.verification;
    if (verification === undefined) throw new Error("expected verification");
    const verifier = node(verification.target);
    expect(config.allowlist).not.toContain(verification.target);
    expect(verifier?.type).toBe("llm");
    expect(verifier?.systemPrompt).toContain(verification.passSignal);
    expect(config.maxIterations).toBeGreaterThan((verification.maxAttempts ?? 1) * 2);
    expect(config.maxDelegationDepth).toBe(0);
  });
});
