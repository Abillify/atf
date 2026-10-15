// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * The OIDC callback must not write the user's email in clear into the logs.
 * Driving the callback needs a live IdP (discovery, token endpoint, JWKS), so
 * this is a source-level guard: every log call that mentions the email passes
 * the `hashIdentifier` handle, never the raw value.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashIdentifier } from "@atf/security-kit";

const source = readFileSync(new URL("../src/oidc.ts", import.meta.url), "utf8");

describe("OIDC login logging", () => {
  it("logs a hash of the email instead of the clear address", () => {
    const logCalls = source.match(/log\.(?:info|warn|error)\(\s*\{[^}]*\}/g) ?? [];
    const emailCalls = logCalls.filter((c) => /email/i.test(c));
    expect(emailCalls.length).toBe(2);
    for (const call of emailCalls) {
      expect(call).toContain("emailHash: hashIdentifier(email)");
      expect(call).not.toMatch(/[{,]\s*email\s*[,}]/);
    }
  });

  it("the handle is stable, case-insensitive and does not contain the address", () => {
    const handle = hashIdentifier("User@Example.test");
    expect(handle).toMatch(/^[0-9a-f]{12}$/);
    expect(handle).toBe(hashIdentifier(" user@example.test "));
    expect(handle).not.toContain("example");
  });
});
