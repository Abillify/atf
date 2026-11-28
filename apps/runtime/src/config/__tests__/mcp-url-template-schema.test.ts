// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * McpServerConfigSchema — urlTemplate validation tests.
 */

import { describe, test, expect } from "bun:test";
import { McpServerConfigSchema } from "../schema.js";

const base = {
  name: "abiliware",
  transport: "http",
  forwardAuthToken: true,
};

const allow = { urlTemplateAllowedOrigins: ["https://*.abillify.io"] };

function issues(over: Record<string, unknown>): string[] {
  const r = McpServerConfigSchema.safeParse({ ...base, ...over });
  return r.success
    ? []
    : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("McpServerConfigSchema — urlTemplate", () => {
  test("urlTemplate with an origin allowlist is accepted (with forwardAuthToken)", () => {
    expect(
      issues({ urlTemplate: "{{requestParams.deployment.url}}/mcp", ...allow }),
    ).toEqual([]);
  });

  test("urlTemplate without urlTemplateAllowedOrigins is rejected", () => {
    expect(
      issues({ urlTemplate: "{{requestParams.deployment.url}}/mcp" }).join("\n"),
    ).toContain("requires urlTemplateAllowedOrigins");
    expect(
      issues({
        urlTemplate: "{{requestParams.deployment.url}}/mcp",
        urlTemplateAllowedOrigins: [],
      }).join("\n"),
    ).toContain("requires urlTemplateAllowedOrigins");
  });

  test("invalid origin patterns are reported at load time", () => {
    const out = issues({
      urlTemplate: "{{requestParams.deployment.url}}/mcp",
      urlTemplateAllowedOrigins: ["https://*.com", "https://erp.example.com/mcp"],
    }).join("\n");
    expect(out).toContain("urlTemplateAllowedOrigins.0");
    expect(out).toContain("urlTemplateAllowedOrigins.1");
  });

  test("urlTemplateAllowedOrigins without urlTemplate is rejected", () => {
    expect(issues({ url: "http://x/mcp", ...allow }).join("\n")).toContain(
      "without urlTemplate",
    );
  });

  test("neither url nor urlTemplate is rejected", () => {
    const out = issues({});
    expect(out.join("\n")).toContain("must set either url or urlTemplate");
  });

  test("both url and urlTemplate is rejected", () => {
    const out = issues({
      url: "http://x/mcp",
      urlTemplate: "{{requestParams.deployment.url}}/mcp",
    });
    expect(out.join("\n")).toContain("not both");
  });

  test("a template without a requestParams placeholder is rejected", () => {
    expect(
      issues({ urlTemplate: "http://fixed.example/mcp" }).join("\n"),
    ).toContain("exactly one");
    expect(
      issues({
        urlTemplate: "{{requestParams.deployment.url}}{{other.x}}/mcp",
      }).join("\n"),
    ).toContain("exactly one");
  });

  test("stdio transport cannot carry a urlTemplate", () => {
    const out = issues({
      transport: "stdio",
      urlTemplate: "{{requestParams.deployment.url}}",
    });
    expect(out.join("\n")).toContain('transport "stdio"');
  });

  test("urlTemplate requires forwardAuthToken: true", () => {
    const out = issues({
      forwardAuthToken: false,
      urlTemplate: "{{requestParams.deployment.url}}/mcp",
    });
    expect(out.join("\n")).toContain("requires forwardAuthToken: true");
  });

  test("a static url still validates its own rules (unchanged)", () => {
    expect(issues({ url: "http://x/mcp", forwardAuthToken: false })).toEqual(
      [],
    );
  });
});

describe("McpServerConfigSchema — tokenExchange.audienceByOrigin", () => {
  const exchange = {
    tokenEndpoint: "https://idp.example/token",
    clientId: "atf-token-broker",
    clientSecretEnv: "TOKEN_EXCHANGE_CLIENT_SECRET",
  };
  const templated = {
    urlTemplate: "{{requestParams.deployment.url}}/mcp",
    ...allow,
  };

  test("an audience map alone satisfies the audience requirement", () => {
    expect(
      issues({
        ...templated,
        tokenExchange: {
          ...exchange,
          audienceByOrigin: { "https://tenant-a.abillify.io": "abiliware-tenant-a" },
        },
      }),
    ).toEqual([]);
  });

  test("neither audience nor audienceByOrigin is rejected", () => {
    expect(
      issues({ ...templated, tokenExchange: exchange }).join("\n"),
    ).toContain("requires audience or a non-empty audienceByOrigin");
  });

  test("keys must be exact origins covered by the allowlist", () => {
    const out = issues({
      ...templated,
      tokenExchange: {
        ...exchange,
        audienceByOrigin: {
          "https://tenant-a.abillify.io/mcp": "a",
          "https://*.abillify.io": "b",
          "https://other.example": "c",
        },
      },
    }).join("\n");
    expect(out).toContain("https://tenant-a.abillify.io/mcp");
    expect(out).toContain("https://*.abillify.io");
    expect(out).toContain("not covered by urlTemplateAllowedOrigins");
  });

  test("audienceByOrigin on a static server is rejected", () => {
    expect(
      issues({
        url: "http://x/mcp",
        tokenExchange: { ...exchange, audienceByOrigin: { "http://x": "x" } },
      }).join("\n"),
    ).toContain("audienceByOrigin without urlTemplate");
  });
});
