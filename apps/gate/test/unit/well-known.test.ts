// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import {
  PROTECTED_RESOURCE_PATH,
  bearerChallenge,
  buildProtectedResourceMetadata,
  resourceMetadataUrl,
} from "../../src/auth/well-known.ts";
import { AppConfigSchema, type AuthConfig, type ServerConfig } from "../../src/config/schema.ts";

function serverConfig(publicUrl?: string): ServerConfig {
  return AppConfigSchema.shape.server.parse({ publicUrl });
}

function oauthAuthConfig(extra: Record<string, unknown> = {}): AuthConfig {
  return AppConfigSchema.shape.auth.parse({
    mode: "oauth",
    oauth: {
      jwksUri: "https://id.example.com/jwks",
      issuer: "https://id.example.com/",
      audience: "mcpgate",
      ...extra,
    },
  });
}

function staticAuthConfig(): AuthConfig {
  return AppConfigSchema.shape.auth.parse({
    mode: "static",
    static: { tokens: [{ token: "t" }] },
  });
}

describe("buildProtectedResourceMetadata", () => {
  it("is undefined for static-only auth", () => {
    expect(buildProtectedResourceMetadata(serverConfig("https://gw.example.com"), staticAuthConfig())).toBeUndefined();
  });

  it("is undefined when server.publicUrl is unset", () => {
    expect(buildProtectedResourceMetadata(serverConfig(undefined), oauthAuthConfig())).toBeUndefined();
  });

  it("builds metadata for oauth mode with a public URL", () => {
    const meta = buildProtectedResourceMetadata(serverConfig("https://gw.example.com/"), oauthAuthConfig());
    expect(meta).toEqual({
      resource: "https://gw.example.com",
      authorization_servers: ["https://id.example.com/"],
      bearer_methods_supported: ["header"],
    });
  });

  it("prefers an explicit oauth.resource override", () => {
    const meta = buildProtectedResourceMetadata(
      serverConfig("https://gw.example.com"),
      oauthAuthConfig({ resource: "https://api.example.com/mcp" }),
    );
    expect(meta?.resource).toBe("https://api.example.com/mcp");
  });

  it("includes additionalIssuers in authorization_servers", () => {
    const meta = buildProtectedResourceMetadata(
      serverConfig("https://gw.example.com"),
      oauthAuthConfig({
        additionalIssuers: [{ jwksUri: "https://id2.example.com/jwks", issuer: "https://id2.example.com/", audience: "mcpgate" }],
      }),
    );
    expect(meta?.authorization_servers).toEqual(["https://id.example.com/", "https://id2.example.com/"]);
  });

  it("includes scopes_supported when requiredScopes is non-empty", () => {
    const meta = buildProtectedResourceMetadata(
      serverConfig("https://gw.example.com"),
      oauthAuthConfig({ requiredScopes: ["mcp:read"] }),
    );
    expect(meta?.scopes_supported).toEqual(["mcp:read"]);
  });

  it("works for mode 'both'", () => {
    const cfg = AppConfigSchema.shape.auth.parse({
      mode: "both",
      static: { tokens: [{ token: "t" }] },
      oauth: { jwksUri: "https://id.example.com/jwks", issuer: "https://id.example.com/", audience: "mcpgate" },
    });
    expect(buildProtectedResourceMetadata(serverConfig("https://gw.example.com"), cfg)).toBeDefined();
  });
});

describe("resourceMetadataUrl", () => {
  it("returns undefined without a publicUrl", () => {
    expect(resourceMetadataUrl(serverConfig(undefined))).toBeUndefined();
  });

  it("joins publicUrl and the well-known path, stripping a trailing slash", () => {
    expect(resourceMetadataUrl(serverConfig("https://gw.example.com/"))).toBe(
      `https://gw.example.com${PROTECTED_RESOURCE_PATH}`,
    );
  });
});

describe("bearerChallenge", () => {
  it("is undefined for static-only auth", () => {
    expect(bearerChallenge(serverConfig("https://gw.example.com"), staticAuthConfig())).toBeUndefined();
  });

  it("is undefined when no publicUrl is configured", () => {
    expect(bearerChallenge(serverConfig(undefined), oauthAuthConfig())).toBeUndefined();
  });

  it("includes resource_metadata for oauth mode with a public URL", () => {
    const challenge = bearerChallenge(serverConfig("https://gw.example.com"), oauthAuthConfig());
    expect(challenge).toBe(
      `Bearer resource_metadata="https://gw.example.com${PROTECTED_RESOURCE_PATH}"`,
    );
  });

  it("appends error/error_description when given a message", () => {
    const challenge = bearerChallenge(
      serverConfig("https://gw.example.com"),
      oauthAuthConfig(),
      "Token verification failed: expired",
    );
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('error_description="Token verification failed: expired"');
  });
});
