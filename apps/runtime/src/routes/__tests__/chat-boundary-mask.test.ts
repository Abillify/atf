// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the `__request__` boundary-node text builder.
 *
 * Verifies that credentials (raw bearer token + credential-bearing headers)
 * are masked to a non-reusable fingerprint by default, and only captured
 * verbatim when `captureSecrets: true` (DEBUG_CAPTURE_REQUEST_TOKENS).
 */

import { describe, it, expect } from "bun:test";
import { buildRequestNodeText, buildVariableOverview } from "../chat.js";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.s1gn4tur3value";

function headers(init: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(init)) h.set(k, v);
  return h;
}

describe("buildRequestNodeText — credential masking", () => {
  it("masks the raw token by default", () => {
    const text = buildRequestNodeText({
      payload: { model: "f" },
      headers: headers({}),
      rawToken: TOKEN,
      claims: { sub: "abc" },
      captureSecrets: false,
    });
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("«masked");
    // Fingerprint reveals only length + last 4 chars, never the secret body.
    expect(text).toContain(`len=${TOKEN.length}`);
    expect(text).toContain("…alue");
  });

  it("masks credential-bearing headers by default", () => {
    const text = buildRequestNodeText({
      payload: {},
      headers: headers({
        Authorization: `Bearer ${TOKEN}`,
        Cookie: `token=${TOKEN}; other=1`,
        "X-Api-Key": "sk-secret-123456",
        "Content-Type": "application/json",
      }),
      rawToken: TOKEN,
      claims: null,
      captureSecrets: false,
    });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("sk-secret-123456");
    // Non-sensitive headers are preserved verbatim.
    expect(text).toContain("content-type: application/json");
  });

  it("captures the raw token and headers verbatim when captureSecrets is true", () => {
    const text = buildRequestNodeText({
      payload: {},
      headers: headers({ Authorization: `Bearer ${TOKEN}` }),
      rawToken: TOKEN,
      claims: null,
      captureSecrets: true,
    });
    expect(text).toContain(TOKEN);
    expect(text).toContain(`Bearer ${TOKEN}`);
    expect(text).not.toContain("«masked");
  });

  it("renders (none) for an empty token regardless of mode", () => {
    const masked = buildRequestNodeText({
      payload: {},
      headers: headers({}),
      rawToken: "",
      claims: null,
      captureSecrets: false,
    });
    expect(masked).toContain("(none)");
  });
});

describe("buildVariableOverview — resolved variables", () => {
  it("prefers JWT claims over OWUI headers for email, userId, and userName", () => {
    const text = buildVariableOverview({
      claims: {
        role: "user",
        email: "claim@x.de",
        sub: "jwt-sub",
        name: "JWT Name",
      },
      metadata: {},
      owui: {
        id: "owui-1",
        email: "owui@x.de",
        role: "admin",
        name: "OWUI+Name",
      },
    });
    // JWT claim wins for email, userId, and userName.
    expect(text).toContain('userEmail  = "claim@x.de"   ← JWT claim "email"');
    expect(text).toContain('userId     = "jwt-sub"   ← JWT claim "sub"');
    expect(text).toContain('userName   = "JWT Name"   ← JWT claim "name"');
    // OWUI header still wins for role (unchanged).
    expect(text).toContain(
      'role       = "admin"   ← OWUI header X-OpenWebUI-User-Role',
    );
  });

  it("falls back to JWT claims and metadata with correct provenance", () => {
    const text = buildVariableOverview({
      claims: { tid: "tenant-9", plan: "gold", groups: ["enterprise"] },
      metadata: { language: "de-AT" },
    });
    expect(text).toContain('clientId   = "tenant-9"   ← JWT claim "tid"');
    expect(text).toContain('plan       = "gold"   ← JWT claim "plan"');
    expect(text).toContain(
      'groups     = ["enterprise"]   ← JWT claim "groups"',
    );
    expect(text).toContain('language   = "de-AT"   ← metadata.language');
  });

  it("derives language from Accept-Language when not in metadata", () => {
    const text = buildVariableOverview({
      claims: null,
      metadata: {},
      acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
    });
    expect(text).toContain('language   = "fr-FR"   ← Accept-Language header');
  });

  it("lists request params and JWT claim names usable in conditions", () => {
    const text = buildVariableOverview({
      claims: { sub: "u1", tid: "t1", custom_scope: "x" },
      metadata: {},
      requestParams: { channel: "mobile", inputRiskScore: 0 },
    });
    expect(text).toContain("channel");
    expect(text).toContain('"mobile"');
    expect(text).toContain("inputRiskScore");
    // Claim names are surfaced for whenClaim expressions.
    expect(text).toContain("sub, tid, custom_scope");
  });

  it("marks unset attributes as (not set)", () => {
    const text = buildVariableOverview({ claims: null, metadata: {} });
    expect(text).toContain("role       = (not set)");
    expect(text).toContain("(no decodable JWT claims)");
    expect(text).toContain("(none)"); // no request params
  });

  it("is embedded as the leading section of the request node text", () => {
    const overview = buildVariableOverview({
      claims: { sub: "u1" },
      metadata: {},
      owui: { role: "operator" },
    });
    const text = buildRequestNodeText({
      payload: { model: "f" },
      headers: new Headers(),
      rawToken: "a.b.c",
      claims: { sub: "u1" },
      variablesOverview: overview,
      captureSecrets: false,
    });
    expect(text).toContain("RESOLVED VARIABLES (set + usable downstream)");
    // Overview appears before the payload section.
    expect(text.indexOf("RESOLVED VARIABLES")).toBeLessThan(
      text.indexOf("PAYLOAD (request body)"),
    );
  });
});
