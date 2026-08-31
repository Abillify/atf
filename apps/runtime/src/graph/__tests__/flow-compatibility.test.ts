// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { FlowDefinition } from "../../types/flow.js";
import { analyzeFlowCompatibility } from "../flow-compatibility.js";

const flow = (overrides: Partial<FlowDefinition> = {}): FlowDefinition => ({
  id: "flow-a",
  name: "Flow A",
  nodes: [{ id: "answer", type: "llm", llm: { provider: "openai", model: "gpt-4o" } }],
  edges: [],
  ...overrides,
});

describe("analyzeFlowCompatibility", () => {
  test("classifies added required scopes as breaking", () => {
    const report = analyzeFlowCompatibility(flow(), flow({ requiredScopes: ["flow:execute"] }));
    expect(report.status).toBe("breaking");
    expect(report.findings.some((finding) => finding.code === "required-scope-added")).toBe(true);
  });

  test("keeps display-only changes compatible", () => {
    const report = analyzeFlowCompatibility(flow(), flow({ name: "Renamed", description: "Better docs" }));
    expect(report.status).toBe("compatible");
  });

  test("treats a metadata version-only change as compatible provenance", () => {
    const report = analyzeFlowCompatibility(
      flow({ metadata: { version: "1.0.0" } }),
      flow({ metadata: { version: "1.0.1" } }),
    );
    expect(report.status).toBe("compatible");
    expect(report.structuralDiff.metadataChanged).toBe(true);
    expect(report.findings.map((finding) => finding.code)).toContain("metadata-version-changed");
  });

  test("still requires review when version and other metadata change", () => {
    const report = analyzeFlowCompatibility(
      flow({ metadata: { version: "1.0.0", owner: "team-a" } }),
      flow({ metadata: { version: "1.0.1", owner: "team-b" } }),
    );
    expect(report.status).toBe("unknown");
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["metadata-version-changed", "metadata-changed"]),
    );
  });

  test("requires review for prompt or topology changes", () => {
    const report = analyzeFlowCompatibility(flow(), flow({
      nodes: [{ id: "answer", type: "llm", systemPrompt: "New behavior" }],
    }));
    expect(report.status).toBe("unknown");
  });
});
