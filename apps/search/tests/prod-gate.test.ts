// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Production-readiness gate.
 *
 * Same contract as aiperator and mcpgate: a permissive setting is FATAL in
 * production and a warning elsewhere. This service needed it most — with no
 * credentials configured at all, the auth middleware waves every request
 * through, so an unprotected deployment has open ingest, delete, search and MCP.
 * Nothing in the process previously said so.
 */

import { describe, expect, it } from "vitest";
import { checkProductionReadiness, isAuthDisabled } from "../src/prod-gate.js";
import type { Config } from "../src/config.js";

const LONG = "x".repeat(40);

/** A config that passes cleanly, as the baseline to perturb. */
function cfg(over: Partial<Config> = {}): Config {
  return {
    apiToken: null,
    monitorToken: null,
    oidc: null,
    apiOidcIssuers: [
      {
        issuer: "https://id.example.com",
        audience: "vectorsearch",
        tenantClaim: "tenant_id",
        scopesClaim: "scope",
      },
    ],
    authnMode: "oidc",
    authzEnabled: true,
    tenantIsolationEnabled: true,
    defaultTenantId: "default",
    aclRequireIdentity: true,
    aclRequireIdentityWaiver: "",
    documentAclDefault: "deny",
    exposeErrorDetail: false,
    rateLimit: 120,
    rateLimitRedisUrl: null,
    replicas: 1,
    trustProxy: true,
    nodeEnv: "production",
    authzEnforcement: "required",
    apiServiceTenantId: "service-tenant",
    apiOidcDefaultTenantId: "tenant-default",
    apiServiceScopes: [
      "vectorsearch.read",
      "vectorsearch.write",
      "vectorsearch.delete",
      "vectorsearch.admin",
      "vectorsearch.acl.manage",
      "vectorsearch.metrics",
    ],
    transactionEnforcement: "required",
    transactionSecret: LONG,
    transactionIssuer: "agent-runtime",
    transactionAudience: "vectorsearch",
    transactionMaxTtlSeconds: 60,
    ...over,
  } as unknown as Config;
}

const fatals = (c: Config) => checkProductionReadiness(c, "production").fatal;
const warns = (c: Config) => checkProductionReadiness(c, "production").warnings;

describe("isAuthDisabled", () => {
  it("is true only when every credential mechanism is unset", () => {
    expect(
      isAuthDisabled(
        cfg({ authnMode: "disabled", apiToken: null, monitorToken: null, oidc: null, apiOidcIssuers: [] }),
      ),
    ).toBe(true);
  });

  it("is false when any one mechanism is configured", () => {
    expect(isAuthDisabled(cfg({ authnMode: "oidc", monitorToken: null }))).toBe(false);
    expect(
      isAuthDisabled(
        cfg({
          authnMode: "oidc",
          apiToken: null,
          monitorToken: null,
          apiOidcIssuers: [{ issuer: "https://id.example.com", audience: "vs" }],
        }),
      ),
    ).toBe(false);
  });
});

describe("a well-configured deployment passes", () => {
  it("reports no fatal issues", () => {
    expect(checkProductionReadiness(cfg(), "production").fatal).toEqual([]);
  });
});

describe("the fatal/warning split", () => {
  it("makes the same finding fatal in production and a warning in development", () => {
    const open = cfg({ authnMode: "disabled", apiToken: null, monitorToken: null, apiOidcIssuers: [] });
    expect(fatals(open).some((m) => m.includes("No authentication"))).toBe(true);
    const dev = checkProductionReadiness(open, "development");
    expect(dev.fatal).toEqual([]);
    expect(dev.warnings.some((m) => m.includes("No authentication"))).toBe(true);
  });

  it("reports the environment it judged against", () => {
    expect(checkProductionReadiness(cfg(), "staging").environment).toBe("staging");
  });

  it("defaults to the config's nodeEnv", () => {
    expect(checkProductionReadiness(cfg({ nodeEnv: "staging" })).environment).toBe(
      "staging",
    );
  });
});

describe("authentication findings", () => {
  it("flags a completely open deployment and names what is exposed", () => {
    const msg = fatals(cfg({ authnMode: "disabled", apiToken: null, monitorToken: null, apiOidcIssuers: [] })).join(" ");
    expect(msg).toContain("ingest, delete, search and the MCP");
  });

  it("flags a short API_TOKEN", () => {
    expect(fatals(cfg({ authnMode: "token", apiToken: "short" })).some((m) => m.includes("API_TOKEN is shorter"))).toBe(
      true,
    );
  });

  it("flags a short MONITOR_TOKEN", () => {
    expect(
      fatals(cfg({ monitorToken: "short" })).some((m) =>
        m.includes("MONITOR_TOKEN is shorter"),
      ),
    ).toBe(true);
  });

  it("flags reusing one secret for both tokens", () => {
    // They must be independently rotatable: one is a human UI credential, the
    // other a machine credential with different exposure and lifetime.
    expect(
      fatals(cfg({ apiToken: LONG, monitorToken: LONG })).some((m) =>
        m.includes("identical"),
      ),
    ).toBe(true);
  });
});

describe("JWT issuer pinning", () => {
  it("flags a missing audience as audience confusion", () => {
    const msg = fatals(
      cfg({ apiOidcIssuers: [{ issuer: "https://id.example.com" }] }),
    ).join(" ");
    expect(msg).toContain("audience confusion");
    expect(msg).toContain("API_OIDC_ISSUERS[0]");
  });

  it("flags a blank audience the same as a missing one", () => {
    expect(
      fatals(
        cfg({ apiOidcIssuers: [{ issuer: "https://id.example.com", audience: "  " }] }),
      ).some((m) => m.includes("audience confusion")),
    ).toBe(true);
  });

  it("flags a non-https issuer", () => {
    expect(
      fatals(
        cfg({ apiOidcIssuers: [{ issuer: "http://id.example.com", audience: "vs" }] }),
      ).some((m) => m.includes("not https")),
    ).toBe(true);
  });

  it("accepts a fully pinned https issuer", () => {
    expect(
      fatals(
        cfg({ apiOidcIssuers: [{ issuer: "https://id.example.com", audience: "vs", tenantClaim: "tenant_id", scopesClaim: "scope" }] }),
      ),
    ).toEqual([]);
  });

  it("rejects an issuer without tenantClaim even when a server default exists", () => {
    expect(
      fatals(
        cfg({ apiOidcIssuers: [{ issuer: "https://id.example.com", audience: "vs", scopesClaim: "scope" }] }),
      ).join(" "),
    ).toContain("tenantClaim");
  });

  it("requires an issuer-specific tenantClaim when isolation is enabled", () => {
    expect(
      fatals(
        cfg({
          apiOidcDefaultTenantId: undefined,
          apiOidcIssuers: [{ issuer: "https://id.example.com", audience: "vs", scopesClaim: "scope" }],
        }),
      ).join(" "),
    ).toContain("tenantClaim");
  });

  it("still requires scopesClaim when a server fallback is configured", () => {
    expect(
      fatals(
        cfg({ apiOidcIssuers: [{ issuer: "https://id.example.com", audience: "vs" }] }),
      ).join(" "),
    ).toContain("scopesClaim");
  });

  it("reports the index of each offending issuer", () => {
    const msg = fatals(
      cfg({
        apiOidcIssuers: [
          { issuer: "https://ok.example.com", audience: "vs" },
          { issuer: "https://bad.example.com" },
        ],
      }),
    ).join(" ");
    expect(msg).toContain("API_OIDC_ISSUERS[1]");
    expect(msg).not.toContain("API_OIDC_ISSUERS[0]");
  });
});

describe("access control findings", () => {
  /**
   * Req 3.3: in production a disabled identity requirement is fatal unless the
   * operator records an explicit waiver. Outside production it stays a warning
   * because a service-to-service ingest legitimately has no end user.
   */
  it("refuses a disabled identity requirement in production without a waiver", () => {
    const report = checkProductionReadiness(
      cfg({ aclRequireIdentity: false }),
      "production",
    );
    expect(report.fatal.some((m) => m.includes("ACL_REQUIRE_IDENTITY"))).toBe(
      true,
    );
    expect(
      report.warnings.some((m) => m.includes("ACL_REQUIRE_IDENTITY")),
    ).toBe(false);
  });

  it("accepts a documented waiver, downgrading the finding to a warning", () => {
    const report = checkProductionReadiness(
      cfg({
        aclRequireIdentity: false,
        aclRequireIdentityWaiver: "TICKET-4711",
      }),
      "production",
    );
    expect(report.fatal.some((m) => m.includes("ACL_REQUIRE_IDENTITY"))).toBe(
      false,
    );
    const warning = report.warnings.find((m) =>
      m.includes("ACL_REQUIRE_IDENTITY"),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain("TICKET-4711");
  });

  it("warns but does not refuse outside production", () => {
    const report = checkProductionReadiness(
      cfg({ aclRequireIdentity: false }),
      "development",
    );
    expect(report.fatal).toEqual([]);
    expect(
      report.warnings.some((m) => m.includes("ACL_REQUIRE_IDENTITY")),
    ).toBe(true);
  });

  it("warns about the permissive DOCUMENT_ACL_DEFAULT in production", () => {
    expect(
      warns(cfg({ documentAclDefault: "allow" })).some((m) =>
        m.includes("DOCUMENT_ACL_DEFAULT"),
      ),
    ).toBe(true);
    expect(
      warns(cfg({ documentAclDefault: "deny" })).some((m) =>
        m.includes("DOCUMENT_ACL_DEFAULT"),
      ),
    ).toBe(false);
  });
});

describe("error disclosure findings", () => {
  it("flags exposing internal error messages", () => {
    expect(
      fatals(cfg({ exposeErrorDetail: true })).some((m) =>
        m.includes("EXPOSE_ERROR_DETAIL"),
      ),
    ).toBe(true);
  });
});

describe("throttling findings", () => {
  it("flags a disabled rate limit", () => {
    expect(fatals(cfg({ rateLimit: 0 })).some((m) => m.includes("RATE_LIMIT is 0"))).toBe(
      true,
    );
  });

  it("warns when TRUST_PROXY is off, since the per-IP limit then collapses", () => {
    expect(
      warns(cfg({ trustProxy: false })).some((m) => m.includes("TRUST_PROXY")),
    ).toBe(true);
  });

  it("flags REPLICAS > 1 without a shared Redis store (per-replica budget)", () => {
    expect(
      fatals(cfg({ replicas: 3, rateLimitRedisUrl: null })).some(
        (m) =>
          m.includes("REPLICAS is 3") && m.includes("RATE_LIMIT_REDIS_URL"),
      ),
    ).toBe(true);
  });

  it("stays quiet on REPLICAS > 1 once RATE_LIMIT_REDIS_URL is set", () => {
    expect(
      fatals(
        cfg({ replicas: 3, rateLimitRedisUrl: "redis://redis:6379" }),
      ).some((m) => m.includes("REPLICAS")),
    ).toBe(false);
  });

  it("stays quiet on the single-replica default", () => {
    expect(
      fatals(cfg({ replicas: 1, rateLimitRedisUrl: null })).some((m) =>
        m.includes("REPLICAS"),
      ),
    ).toBe(false);
  });
});


describe("transaction and static-service production contract", () => {
  it("fails production unless transaction enforcement is required", () => {
    expect(
      fatals(cfg({ transactionEnforcement: "optional" })).some((message) =>
        message.includes("TRANSACTION_ENFORCEMENT"),
      ),
    ).toBe(true);
  });

  describe("transaction token algorithms (ADR-0035)", () => {
    it("HS256 only: needs the shared secret, and says it is a shared secret (warning, not fatal)", () => {
      const hs = cfg({ transactionAlgorithms: ["HS256"], transactionJwksUri: null });
      expect(fatals(hs)).toEqual([]);
      expect(warns(hs).some((message) => message.includes("accepts HS256"))).toBe(true);
      expect(
        fatals(cfg({ transactionAlgorithms: ["HS256"], transactionSecret: "short" })).some((m) =>
          m.includes("TRANSACTION_HS256_SECRET"),
        ),
      ).toBe(true);
    });
    it("EdDSA through an https JWKS needs no shared secret and raises no warning", () => {
      const asym = cfg({
        transactionAlgorithms: ["EdDSA"],
        transactionSecret: null,
        transactionJwksUri: "https://runtime.internal/.well-known/atf-transaction-jwks.json",
      });
      expect(fatals(asym)).toEqual([]);
      expect(warns(asym).some((message) => message.includes("TRANSACTION_ALGORITHMS"))).toBe(false);
    });
    it("a rolling migration (HS256 + EdDSA) is allowed but keeps warning until HS256 is dropped", () => {
      const both = cfg({
        transactionAlgorithms: ["HS256", "EdDSA"],
        transactionJwksUri: "https://runtime.internal/jwks",
      });
      expect(fatals(both)).toEqual([]);
      expect(warns(both).some((message) => message.includes("accepts HS256"))).toBe(true);
    });
    it("refuses an asymmetric algorithm without an https JWKS URL in production", () => {
      const missing = fatals(cfg({ transactionAlgorithms: ["EdDSA"], transactionSecret: null, transactionJwksUri: null }));
      expect(missing.some((m) => m.includes("TRANSACTION_JWKS_URI"))).toBe(true);
      const plain = fatals(
        cfg({ transactionAlgorithms: ["ES256"], transactionSecret: null, transactionJwksUri: "http://runtime.internal/jwks" }),
      );
      expect(plain.some((m) => m.includes("https"))).toBe(true);
    });
  });
  it("requires the documented tenant and complete static-service scopes", () => {
    const report = fatals(
      cfg({
        authnMode: "token",
        apiToken: LONG,
        defaultTenantId: "",
        apiServiceTenantId: undefined,
        apiServiceScopes: ["vectorsearch.read"],
      }),
    ).join(" ");
    expect(report).toContain("DEFAULT_TENANT_ID");
    expect(report).toContain("vectorsearch.metrics");
    expect(report).toContain("vectorsearch.write");
  });
});

// Req 11.8: the rotation token is held to the same standards as API_TOKEN.
describe("rotation token (API_TOKEN_NEXT) findings", () => {
  it("flags a rotation token shorter than 32 characters", () => {
    expect(
      fatals(
        cfg({
          authnMode: "token",
          apiToken: LONG,
          apiTokenNext: "too-short-rotation-token",
        }),
      ).some((message) => message.includes("API_TOKEN_NEXT is shorter")),
    ).toBe(true);
  });

  it("flags a rotation token identical to the primary token", () => {
    expect(
      fatals(
        cfg({
          authnMode: "token",
          apiToken: LONG,
          apiTokenNext: LONG,
        }),
      ).some((message) =>
        message.includes("API_TOKEN and API_TOKEN_NEXT are identical"),
      ),
    ).toBe(true);
  });

  it("accepts a distinct high-entropy rotation token", () => {
    expect(
      fatals(
        cfg({
          authnMode: "token",
          apiToken: LONG,
          apiTokenNext: "y".repeat(40),
        }),
      ).some(
        (message) =>
          message.includes("API_TOKEN_NEXT is shorter") ||
          message.includes("API_TOKEN and API_TOKEN_NEXT are identical"),
      ),
    ).toBe(false);
  });

  it("is fatal in production when the OIDC-only profile still has a rotation token", () => {
    expect(
      fatals(cfg({ authnMode: "oidc", apiTokenNext: LONG })).some((message) =>
        message.includes(
          "API_TOKEN, API_TOKEN_NEXT and MONITOR_TOKEN must be unset",
        ),
      ),
    ).toBe(true);
  });
});