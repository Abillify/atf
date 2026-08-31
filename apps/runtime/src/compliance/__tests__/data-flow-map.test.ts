// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the RoPA / data-flow map generator (`src/compliance/data-flow-map.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  buildDataFlowMap,
  buildRoPAEntry,
  formatDataFlowMapAsMarkdown,
} from "../data-flow-map.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { CompliancePolicy } from "../policy-schema.js";

function flow(over: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    id: "f",
    name: "Flow",
    nodes: [
      { id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
    ],
    edges: [],
    ...over,
  } as FlowDefinition;
}

const policy = (over: Partial<CompliancePolicy> = {}): CompliancePolicy =>
  ({
    version: "1",
    failClosed: true,
    dataRules: [
      {
        dataClass: "personal",
        allowedProviders: [
          { provider: "azure", allowedRegions: ["germanywestcentral"] },
          { provider: "ollama", allowedRegions: [] },
        ],
      },
    ],
    ...over,
  }) as CompliancePolicy;

describe("buildRoPAEntry", () => {
  it("marks a flow with no dataClasses as undeclared", () => {
    const e = buildRoPAEntry(flow(), policy());
    expect(e.status).toBe("undeclared");
    expect(e.warnings.some((w) => w.includes("no dataClasses"))).toBe(true);
    expect(e.processors[0]?.provider).toBe("openai");
  });

  it("flags a residency violation when a provider is not permitted", () => {
    const e = buildRoPAEntry(flow({ dataClasses: ["personal"] }), policy());
    // openai is not on the personal allow-list (azure/ollama only).
    expect(e.status).toBe("violation");
    expect(e.residency.some((r) => r.provider === "openai" && !r.permitted)).toBe(
      true,
    );
  });

  it("is compliant when the provider is permitted", () => {
    const f = flow({
      dataClasses: ["personal"],
      nodes: [
        { id: "n1", type: "llm", llm: { provider: "azure", model: "gpt-4o" } },
      ],
    } as Partial<FlowDefinition>);
    const e = buildRoPAEntry(f, policy());
    expect(e.status).toBe("compliant");
    const r = e.residency.find((x) => x.provider === "azure");
    expect(r?.permitted).toBe(true);
    expect(r?.allowedRegions).toEqual(["germanywestcentral"]);
  });

  it("treats a local provider as always permitted", () => {
    const f = flow({
      dataClasses: ["personal"],
      nodes: [
        { id: "n1", type: "llm", llm: { provider: "ollama", model: "llama3" } },
      ],
    } as Partial<FlowDefinition>);
    const e = buildRoPAEntry(f, policy());
    expect(e.status).toBe("compliant");
    expect(e.processors[0]?.local).toBe(true);
  });

  it("reports no-policy when dataClasses are declared but no dataRules exist", () => {
    const e = buildRoPAEntry(flow({ dataClasses: ["personal"] }), undefined);
    expect(e.status).toBe("no-policy");
  });

  it("flags a region violation when the provider's actual region is not allowed", () => {
    const f = flow({
      dataClasses: ["personal"],
      nodes: [{ id: "n1", type: "llm", llm: { provider: "azure", model: "m" } }],
    } as Partial<FlowDefinition>);
    // azure is allow-listed for personal with region germanywestcentral, but it
    // actually runs in eastus → residency violation.
    const e = buildRoPAEntry(f, policy(), {
      providerRegions: { azure: "eastus" },
    });
    expect(e.status).toBe("violation");
    const r = e.residency.find((x) => x.provider === "azure");
    if (r === undefined) throw new Error("expected an azure residency entry");
    expect(r.regionStatus).toBe("violation");
    expect(r.region).toBe("eastus");
    expect(r.permitted).toBe(false);
    expect(e.warnings.some((w) => w.includes("NOT among the allowed regions"))).toBe(true);
  });

  it("is compliant when the provider's region is allowed", () => {
    const f = flow({
      dataClasses: ["personal"],
      nodes: [{ id: "n1", type: "llm", llm: { provider: "azure", model: "m" } }],
    } as Partial<FlowDefinition>);
    const e = buildRoPAEntry(f, policy(), {
      providerRegions: { azure: "germanywestcentral" },
    });
    expect(e.status).toBe("compliant");
    expect(e.residency[0]?.regionStatus).toBe("ok");
  });

  it("reports region unverified when the provider region is unknown", () => {
    const f = flow({
      dataClasses: ["personal"],
      nodes: [{ id: "n1", type: "llm", llm: { provider: "azure", model: "m" } }],
    } as Partial<FlowDefinition>);
    const e = buildRoPAEntry(f, policy()); // no providerRegions
    expect(e.residency[0]?.regionStatus).toBe("unverified");
    expect(e.status).toBe("compliant"); // allowed, just unconfirmed
    expect(e.warnings.some((w) => w.includes("region is unknown"))).toBe(true);
  });

  it("honours a custom local-provider set (treats a provider as on-prem)", () => {
    // A self-hosted OpenAI-compatible gateway declared local via config: even
    // though "openai" is normally external, the custom set marks it on-prem.
    const f = flow({
      dataClasses: ["personal"],
      nodes: [{ id: "n1", type: "llm", llm: { provider: "openai", model: "m" } }],
    } as Partial<FlowDefinition>);
    const e = buildRoPAEntry(f, policy(), {
      localProviders: new Set(["openai"]),
    });
    expect(e.processors[0]?.local).toBe(true);
    expect(e.status).toBe("compliant");
  });
});

describe("buildDataFlowMap", () => {
  it("aggregates a summary and renders markdown", () => {
    const map = buildDataFlowMap(
      [
        flow({ id: "a", dataClasses: ["personal"] }),
        flow({
          id: "b",
          dataClasses: ["personal"],
          nodes: [
            { id: "n", type: "llm", llm: { provider: "azure", model: "m" } },
          ],
        } as Partial<FlowDefinition>),
      ],
      policy(),
      () => 0,
    );
    expect(map.summary.flows).toBe(2);
    expect(map.summary.withDataClasses).toBe(2);
    expect(map.summary.violations).toBe(1); // flow "a" uses openai
    expect(map.summary.providers).toContain("openai");
    const md = formatDataFlowMapAsMarkdown(map);
    expect(md).toContain("Record of Processing Activities");
    expect(md).toContain("azure");
  });
});
