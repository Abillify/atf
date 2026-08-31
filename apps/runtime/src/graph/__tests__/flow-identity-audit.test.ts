// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow ↔ MCP-server identity audit.
 *
 * The distinction this module exists to make: a downstream server that receives
 * NO caller identity cannot apply a per-user ACL, so the only separation left is
 * whatever filter the flow chose to send — flow logic, not an enforced boundary.
 * A server that receives an identity (proven or asserted) can.
 *
 * The tests are written so the audit cannot drift into crying wolf. An
 * argument-asserted identity is a legitimate, documented model and must NOT
 * warn; only the total absence of an identity does.
 */

import { describe, expect, test } from "bun:test";
import {
  IDENTITY_SENSITIVE_CLASSES,
  auditFlowIdentityForwarding,
  classifyIdentityConveyance,
  formatIdentityAuditWarnings,
  referencedMcpServers,
} from "../flow-identity-audit.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { McpServerConfig } from "../../config/schema.js";

/** Minimal flow with one tool node. */
function mkFlow(
  id: string,
  tools: string[],
  dataClasses?: FlowDefinition["dataClasses"],
): FlowDefinition {
  return {
    id,
    name: id,
    ...(dataClasses !== undefined ? { dataClasses } : {}),
    nodes: [
      { id: "n1", type: "tool", tools } as FlowDefinition["nodes"][number],
    ],
    edges: [],
  };
}

const server = (
  name: string,
  extra: Partial<McpServerConfig> = {},
): McpServerConfig => ({
  name,
  url: `http://${name}.test/mcp`,
  transport: "http",
  ...extra,
});

// ---------------------------------------------------------------------------
// classifyIdentityConveyance
// ---------------------------------------------------------------------------

describe("classifyIdentityConveyance", () => {
  test("forwardAuthToken is the strongest form — the server verifies the bearer itself", () => {
    expect(classifyIdentityConveyance({ forwardAuthToken: true })).toBe(
      "forwarded-token",
    );
  });

  test("an identity placeholder in injectedParams counts as asserted", () => {
    expect(
      classifyIdentityConveyance({
        injectedParams: { user: "{{ctx.userId}}" },
      }),
    ).toBe("asserted-param");
  });

  test("finds a placeholder nested inside injectedParams", () => {
    // Real configurations nest identity inside a context object — a shallow
    // check would miss the common case and warn about a correct setup.
    expect(
      classifyIdentityConveyance({
        injectedParams: {
          context: { source: "aiperator", user: { mail: "{{ctx.userEmail}}" } },
        },
      }),
    ).toBe("asserted-param");
  });

  test("recognises each identity placeholder", () => {
    for (const ph of [
      "{{ctx.userId}}",
      "{{ctx.userEmail}}",
      "{{ctx.userName}}",
      "{{ctx.clientId}}",
    ]) {
      expect(classifyIdentityConveyance({ injectedParams: { x: ph } })).toBe(
        "asserted-param",
      );
    }
  });

  test("a non-identity placeholder does not count", () => {
    // {{now.date}} is injected on every call and says nothing about who is asking.
    expect(
      classifyIdentityConveyance({ injectedParams: { today: "{{now.date}}" } }),
    ).toBe("none");
  });

  test("no forwarding and no identity params is 'none'", () => {
    expect(classifyIdentityConveyance({})).toBe("none");
    expect(classifyIdentityConveyance({ forwardAuthToken: false })).toBe(
      "none",
    );
    expect(classifyIdentityConveyance({ injectedParams: {} })).toBe("none");
  });

  test("forwardAuthToken wins over injectedParams", () => {
    expect(
      classifyIdentityConveyance({
        forwardAuthToken: true,
        injectedParams: { user: "{{ctx.userId}}" },
      }),
    ).toBe("forwarded-token");
  });
});

// ---------------------------------------------------------------------------
// referencedMcpServers
// ---------------------------------------------------------------------------

describe("referencedMcpServers", () => {
  test("extracts the server prefix from tool refs, de-duplicated and sorted", () => {
    const flow = mkFlow("f", [
      "vectorsearch/search",
      "vectorsearch/get_document",
      "base/datetime",
    ]);
    expect(referencedMcpServers(flow)).toEqual(["base", "vectorsearch"]);
  });

  test("ignores a ref without a server prefix", () => {
    expect(
      referencedMcpServers(mkFlow("f", ["bare-tool", "/leading"])),
    ).toEqual([]);
  });

  test("includes per-condition tool overrides", () => {
    // A branch that only fires sometimes still reaches the data when it does.
    const flow: FlowDefinition = {
      id: "f",
      name: "f",
      nodes: [
        {
          id: "n1",
          type: "tool",
          tools: ["vectorsearch/search"],
          conditions: [{ tools: ["parking/book_space"] }],
        } as unknown as FlowDefinition["nodes"][number],
      ],
      edges: [],
    };
    expect(referencedMcpServers(flow)).toEqual(["parking", "vectorsearch"]);
  });

  test("returns nothing for a flow without tools", () => {
    expect(referencedMcpServers(mkFlow("f", []))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// auditFlowIdentityForwarding
// ---------------------------------------------------------------------------

describe("auditFlowIdentityForwarding", () => {
  test("skips flows that declare no identity-sensitive class", () => {
    // The audit is built on the author's own declaration — an undeclared flow is
    // the declaration guard's problem, not this one's.
    const flows = [
      mkFlow("internal-only", ["vectorsearch/search"], ["internal"]),
    ];
    expect(
      auditFlowIdentityForwarding(flows, [server("vectorsearch")]),
    ).toEqual([]);
  });

  test("skips a flow with no dataClasses at all", () => {
    expect(
      auditFlowIdentityForwarding(
        [mkFlow("f", ["vectorsearch/search"])],
        [server("vectorsearch")],
      ),
    ).toEqual([]);
  });

  test("flags a personal-data flow whose server gets no identity", () => {
    const findings = auditFlowIdentityForwarding(
      [mkFlow("helpdesk", ["vectorsearch/search"], ["personal"])],
      [server("vectorsearch")],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.flowId).toBe("helpdesk");
    expect(findings[0]?.unidentifiedServers).toEqual(["vectorsearch"]);
    expect(findings[0]?.dataClasses).toEqual(["personal"]);
  });

  test("does not flag a server with forwardAuthToken", () => {
    expect(
      auditFlowIdentityForwarding(
        [mkFlow("helpdesk", ["vectorsearch/search"], ["personal"])],
        [server("vectorsearch", { forwardAuthToken: true })],
      ),
    ).toEqual([]);
  });

  test("records an asserted identity separately from an absent one", () => {
    const findings = auditFlowIdentityForwarding(
      [
        mkFlow(
          "helpdesk",
          ["mcpgate/query", "vectorsearch/search"],
          ["personal"],
        ),
      ],
      [
        server("mcpgate", { injectedParams: { user: "{{ctx.userId}}" } }),
        server("vectorsearch"),
      ],
    );
    expect(findings[0]?.assertedServers).toEqual(["mcpgate"]);
    expect(findings[0]?.unidentifiedServers).toEqual(["vectorsearch"]);
  });

  test("records a referenced server that is not configured", () => {
    const findings = auditFlowIdentityForwarding(
      [mkFlow("helpdesk", ["ghost/search"], ["personal"])],
      [],
    );
    expect(findings[0]?.unknownServers).toEqual(["ghost"]);
    expect(findings[0]?.unidentifiedServers).toEqual([]);
  });

  test("covers every identity-sensitive class", () => {
    for (const cls of IDENTITY_SENSITIVE_CLASSES) {
      const findings = auditFlowIdentityForwarding(
        [mkFlow("f", ["vs/search"], [cls])],
        [server("vs")],
      );
      expect(findings).toHaveLength(1);
    }
  });

  test("reports only the identity-sensitive subset of the declaration", () => {
    const findings = auditFlowIdentityForwarding(
      [mkFlow("f", ["vs/search"], ["internal", "personal", "financial"])],
      [server("vs")],
    );
    expect(findings[0]?.dataClasses).toEqual(["personal"]);
  });

  test("sorts findings by flow id so output is stable across runs", () => {
    const findings = auditFlowIdentityForwarding(
      [
        mkFlow("zeta", ["vs/search"], ["personal"]),
        mkFlow("alpha", ["vs/search"], ["personal"]),
      ],
      [server("vs")],
    );
    expect(findings.map((f) => f.flowId)).toEqual(["alpha", "zeta"]);
  });
});

// ---------------------------------------------------------------------------
// formatIdentityAuditWarnings
// ---------------------------------------------------------------------------

describe("formatIdentityAuditWarnings", () => {
  test("warns about an unidentified server and names the remedy", () => {
    const lines = formatIdentityAuditWarnings(
      auditFlowIdentityForwarding(
        [mkFlow("helpdesk", ["vectorsearch/search"], ["personal"])],
        [server("vectorsearch")],
      ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("helpdesk");
    expect(lines[0]).toContain("vectorsearch");
    expect(lines[0]).toContain("forwardAuthToken: true");
    // The warning must say WHY it matters, not just what is missing.
    expect(lines[0]).toContain("cannot apply");
  });

  /**
   * The anti-crying-wolf property. Argument-asserted identity is a documented,
   * legitimate integration model; warning about it would train operators to
   * ignore this check, which costs more than the check is worth.
   */
  test("does NOT warn when the identity is merely asserted", () => {
    const lines = formatIdentityAuditWarnings(
      auditFlowIdentityForwarding(
        [mkFlow("helpdesk", ["mcpgate/query"], ["personal"])],
        [server("mcpgate", { injectedParams: { user: "{{ctx.userId}}" } })],
      ),
    );
    expect(lines).toEqual([]);
  });

  test("does NOT warn about an unknown server (a startup error elsewhere)", () => {
    const lines = formatIdentityAuditWarnings(
      auditFlowIdentityForwarding([mkFlow("f", ["ghost/x"], ["personal"])], []),
    );
    expect(lines).toEqual([]);
  });

  test("produces one line per affected flow", () => {
    const lines = formatIdentityAuditWarnings(
      auditFlowIdentityForwarding(
        [
          mkFlow("a", ["vs/search"], ["personal"]),
          mkFlow("b", ["vs/search"], ["sensitive"]),
        ],
        [server("vs")],
      ),
    );
    expect(lines).toHaveLength(2);
  });

  test("empty findings produce no output", () => {
    expect(formatIdentityAuditWarnings([])).toEqual([]);
  });
});
