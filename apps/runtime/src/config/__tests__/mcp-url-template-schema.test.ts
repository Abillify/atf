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

function issues(over: Record<string, unknown>): string[] {
  const r = McpServerConfigSchema.safeParse({ ...base, ...over });
  return r.success
    ? []
    : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("McpServerConfigSchema — urlTemplate", () => {
  test("urlTemplate-only config is accepted (with forwardAuthToken)", () => {
    expect(
      issues({ urlTemplate: "{{requestParams.deployment.url}}/mcp" }),
    ).toEqual([]);
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
