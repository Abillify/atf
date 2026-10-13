// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { AppConfigSchema } from "../../src/config/schema.ts";

const baseAuth = { mode: "static" as const, static: { tokens: [{ token: "t" }] } };

  // biome-ignore lint/suspicious/noTemplateCurlyInString: describe title quotes the ${VAR:-} interpolation syntax
describe("optional URL fields tolerate an empty string (env interpolation leaves unset ${VAR:-} as \"\")", () => {
  it("accepts server.publicUrl: \"\" as unset", () => {
    const result = AppConfigSchema.safeParse({ auth: baseAuth, server: { publicUrl: "" } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.server.publicUrl).toBeUndefined();
  });

  it("accepts tracing.otlpEndpoint: \"\" as unset", () => {
    const result = AppConfigSchema.safeParse({
      auth: baseAuth,
      tracing: { enabled: false, otlpEndpoint: "" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tracing.otlpEndpoint).toBeUndefined();
  });

  it("still rejects a genuinely invalid (non-empty) URL", () => {
    const result = AppConfigSchema.safeParse({ auth: baseAuth, server: { publicUrl: "not-a-url" } });
    expect(result.success).toBe(false);
  });

  it("still accepts a valid URL", () => {
    const result = AppConfigSchema.safeParse({
      auth: baseAuth,
      server: { publicUrl: "https://mcpgate.example.com" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.server.publicUrl).toBe("https://mcpgate.example.com");
  });
});
