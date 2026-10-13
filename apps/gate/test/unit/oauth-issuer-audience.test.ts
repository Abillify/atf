// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `auth.oauth` now requires BOTH `issuer` and `audience` to be pinned.
 *
 * Previously both were merely optional, which meant the safe configuration was
 * the one an operator had to discover and the audience-confusion configuration
 * was the default: a token minted by the same IdP for a *different* service
 * verified successfully here and got the full tool surface. Making the pin
 * mandatory — with an explicit, named opt-out — moves that decision into the
 * open.
 */

import { describe, expect, test } from "bun:test";
import { AppConfigSchema } from "../../src/config/schema.ts";

function parseAuth(oauth: Record<string, unknown>) {
  return AppConfigSchema.shape.auth.safeParse({ mode: "oauth", oauth });
}

const JWKS = "https://id.example.com/jwks";

describe("required pinning", () => {
  test("accepts a fully pinned issuer", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      audience: "mcpgate",
    });
    expect(result.success).toBe(true);
  });

  test("rejects a missing issuer", () => {
    const result = parseAuth({ jwksUri: JWKS, audience: "mcpgate" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("issuer is required"))).toBe(
        true,
      );
    }
  });

  test("rejects a missing audience and names the risk", () => {
    const result = parseAuth({ jwksUri: JWKS, issuer: "https://id.example.com/" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("audience is required");
      expect(msg).toContain("audience confusion");
    }
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test title quotes the ${VAR:-} interpolation syntax
  test("rejects an empty-string issuer/audience (the ${VAR:-} interpolation case)", () => {
    // config/loader.ts substitutes an unset `${VAR:-}` with "", not undefined,
    // so a blank value must not count as "pinned".
    const result = parseAuth({ jwksUri: JWKS, issuer: "", audience: "" });
    expect(result.success).toBe(false);
  });

  test("rejects an audience array whose entries are all blank", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      audience: ["", ""],
    });
    expect(result.success).toBe(false);
  });

  test("accepts an audience array with at least one real entry", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      audience: ["mcpgate", "mcpgate-alt"],
    });
    expect(result.success).toBe(true);
  });
});

describe("explicit opt-out", () => {
  test("allowAnyIssuer no longer permits omitting the issuer", () => {
    const result = parseAuth({ jwksUri: JWKS, audience: "mcpgate", allowAnyIssuer: true });
    expect(result.success).toBe(false);
  });

  test("allowAnyAudience no longer permits omitting the audience", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      allowAnyAudience: true,
    });
    expect(result.success).toBe(false);
  });

  test("the opt-outs default to false, so silence means 'pin it'", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      audience: "mcpgate",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.oauth?.allowAnyIssuer).toBe(false);
      expect(result.data.oauth?.allowAnyAudience).toBe(false);
    }
  });

  test("the string form cannot disable required audience pinning", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      allowAnyAudience: "true",
    });
    expect(result.success).toBe(false);
  });
});

describe("additionalIssuers are held to the same standard", () => {
  test("an unpinned additional issuer is rejected", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      audience: "mcpgate",
      additionalIssuers: [{ jwksUri: "https://id2.example.com/jwks" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("additionalIssuers[0]");
    }
  });

  test("the error path points at the offending entry", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      audience: "mcpgate",
      additionalIssuers: [
        { jwksUri: "https://ok.example.com/jwks", issuer: "https://ok.example.com/", audience: "a" },
        { jwksUri: "https://bad.example.com/jwks", issuer: "https://bad.example.com/" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.path.join(".") === "oauth.additionalIssuers.1.audience",
        ),
      ).toBe(true);
    }
  });

  test("a per-entry opt-out cannot bypass audience pinning", () => {
    const result = parseAuth({
      jwksUri: JWKS,
      issuer: "https://id.example.com/",
      audience: "mcpgate",
      additionalIssuers: [
        {
          jwksUri: "https://id2.example.com/jwks",
          issuer: "https://id2.example.com/",
          allowAnyAudience: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("modes without oauth are unaffected", () => {
  test("static mode does not require issuer/audience", () => {
    const result = AppConfigSchema.shape.auth.safeParse({
      mode: "static",
      static: { tokens: [{ token: "t".repeat(40) }] },
    });
    expect(result.success).toBe(true);
  });

  test("mode 'both' still requires a pinned oauth block", () => {
    const result = AppConfigSchema.shape.auth.safeParse({
      mode: "both",
      static: { tokens: [{ token: "t".repeat(40) }] },
      oauth: { jwksUri: JWKS },
    });
    expect(result.success).toBe(false);
  });
});
