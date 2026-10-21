// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { checkProductionReadiness, isAuthDisabled } from "../src/prod-gate.js";
import { loadTestConfig } from "./helpers.js";

/** The permissive development profile, which the gate must reject in production. */
function devConfig() {
  return loadTestConfig();
}

/** A configuration intended to satisfy the gate. */
function prodConfig(overrides: Record<string, string | undefined> = {}) {
  return loadTestConfig({
    NODE_ENV: "production",
    AUTHN_MODE: "oidc",
    API_OIDC_ISSUERS:
      '[{"issuer":"https://idp.example","audience":"atf-extract","scopesClaim":"scopes","tenantClaim":"tenant"}]',
    AUTHZ_ENABLED: "true",
    TENANT_ISOLATION_ENABLED: "true",
    DEFAULT_TENANT_ID: "acme",
    TRUST_PROXY: "true",
    RATE_LIMIT: "120",
    MAX_PAGES: "200",
    // The reference production shape runs the converter in its own container;
    // a local converter is fatal without an explicit acknowledgement.
    CONVERTER_MODE: "isolated",
    CALLBACK_ALLOWED_HOSTS: ".svc.cluster.local",
    SEARCH_URL: "https://search.example",
    SEARCH_TOKEN: "s".repeat(40),
    ...overrides,
  });
}

describe("operational profile resolution", () => {
  // ATF_PROFILE ist der plattformweite Schalter; unbekannte Werte brechen den
  // Start ab, statt die Prod-Gates stillschweigend abzuschalten — Extract
  // normalisierte sein NODE_ENV zuvor weder getrimmt noch kleingeschrieben.
  it("lets ATF_PROFILE override NODE_ENV", () => {
    const config = loadTestConfig({
      ATF_PROFILE: "production",
      NODE_ENV: "development",
    });
    expect(config.nodeEnv).toBe("production");
  });

  it("normalises case and whitespace", () => {
    const config = loadTestConfig({ NODE_ENV: "  PRODUCTION " });
    expect(config.nodeEnv).toBe("production");
  });

  it("fails fast on an unknown profile", () => {
    expect(() => loadTestConfig({ NODE_ENV: "prod" })).toThrow("NODE_ENV");
    expect(() =>
      loadTestConfig({ NODE_ENV: "development", ATF_PROFILE: "PRODUCTIVE" }),
    ).toThrow("ATF_PROFILE");
  });

  it("treats staging as warn mode, not production", () => {
    const config = loadTestConfig({ ATF_PROFILE: "staging" });
    expect(config.nodeEnv).toBe("staging");
    const report = checkProductionReadiness(config);
    expect(report.fatal).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(3);
  });
});

describe("checkProductionReadiness", () => {
  it("passes for a hardened production profile", () => {
    const report = checkProductionReadiness(prodConfig());
    expect(report.fatal).toEqual([]);
  });

  it("reports the development profile as warnings, not failures", () => {
    // The same list an operator sees before promoting the config — that is the
    // point of reporting in both environments.
    const report = checkProductionReadiness(devConfig(), "development");
    expect(report.fatal).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(3);
  });

  it("turns the same findings fatal in production", () => {
    const report = checkProductionReadiness(devConfig(), "production");
    expect(report.fatal.length).toBeGreaterThan(3);
    expect(report.warnings).not.toContain(expect.stringContaining("AUTHN_MODE"));
  });

  describe("authentication", () => {
    it("flags disabled authentication and says what is exposed", () => {
      const report = checkProductionReadiness(devConfig(), "development");
      expect(report.warnings.join(" ")).toContain("AUTHN_MODE=disabled");
      expect(report.warnings.join(" ")).toContain("Search ingest");
      expect(isAuthDisabled(devConfig())).toBe(true);
    });

    it("requires OIDC in production, not merely some credential", () => {
      const report = checkProductionReadiness(
        prodConfig({
          AUTHN_MODE: "token",
          API_TOKEN: "t".repeat(40),
          API_SERVICE_TENANT_ID: "acme",
          API_SERVICE_SCOPES: "extract.convert,extract.ingest",
        }),
      );
      expect(report.fatal.join(" ")).toContain(
        "Production requires AUTHN_MODE=oidc",
      );
    });

    it("refuses a leftover static token in the production profile", () => {
      const report = checkProductionReadiness(
        prodConfig({
          AUTHN_MODE: "token_or_oidc",
          API_TOKEN: "t".repeat(40),
          API_SERVICE_TENANT_ID: "acme",
        }),
      );
      expect(report.fatal.join(" ")).toContain(
        "API_TOKEN, API_TOKEN_NEXT and MONITOR_TOKEN must be unset",
      );
    });

    it("flags a low-entropy token", () => {
      const report = checkProductionReadiness(
        loadTestConfig({ AUTHN_MODE: "token", API_TOKEN: "short" }),
        "development",
      );
      expect(report.warnings.join(" ")).toContain(
        "API_TOKEN is shorter than 32 characters",
      );
    });

    it("flags a shared UI and API credential", () => {
      const shared = "s".repeat(40);
      const report = checkProductionReadiness(
        loadTestConfig({
          AUTHN_MODE: "token",
          API_TOKEN: shared,
          MONITOR_TOKEN: shared,
        }),
        "development",
      );
      expect(report.warnings.join(" ")).toContain(
        "cannot then be rotated or revoked independently",
      );
    });

    // Req 11.8: the rotation token is held to the same standards as API_TOKEN.
    it("flags a low-entropy rotation token", () => {
      const report = checkProductionReadiness(
        loadTestConfig({
          AUTHN_MODE: "token",
          API_TOKEN: "x".repeat(40),
          API_TOKEN_NEXT: "short",
        }),
        "development",
      );
      expect(report.warnings.join(" ")).toContain(
        "API_TOKEN_NEXT is shorter than 32 characters",
      );
    });

    it("flags a rotation token identical to the primary token", () => {
      const same = "x".repeat(40);
      const report = checkProductionReadiness(
        loadTestConfig({
          AUTHN_MODE: "token",
          API_TOKEN: same,
          API_TOKEN_NEXT: same,
        }),
        "development",
      );
      expect(report.warnings.join(" ")).toContain(
        "API_TOKEN and API_TOKEN_NEXT are identical",
      );
    });

    it("refuses a leftover rotation token in the production profile", () => {
      const report = checkProductionReadiness(
        prodConfig({
          AUTHN_MODE: "token_or_oidc",
          API_TOKEN_NEXT: "y".repeat(40),
          API_SERVICE_TENANT_ID: "acme",
        }),
      );
      expect(report.fatal.join(" ")).toContain(
        "API_TOKEN, API_TOKEN_NEXT and MONITOR_TOKEN must be unset",
      );
    });
  });

  describe("JWT issuer pinning", () => {
    it("flags a missing audience as audience confusion", () => {
      const report = checkProductionReadiness(
        prodConfig({
          API_OIDC_ISSUERS:
            '[{"issuer":"https://idp.example","scopesClaim":"scopes","tenantClaim":"tenant"}]',
        }),
      );
      expect(report.fatal.join(" ")).toContain("audience confusion");
    });

    it("flags a plaintext issuer", () => {
      const report = checkProductionReadiness(
        prodConfig({
          API_OIDC_ISSUERS:
            '[{"issuer":"http://idp.example","audience":"a","scopesClaim":"s","tenantClaim":"t"}]',
        }),
      );
      expect(report.fatal.join(" ")).toContain("is not https");
    });

    it("requires a scopes claim when authorisation is on", () => {
      const report = checkProductionReadiness(
        prodConfig({
          API_OIDC_ISSUERS: '[{"issuer":"https://idp.example","audience":"a","tenantClaim":"t"}]',
        }),
      );
      expect(report.fatal.join(" ")).toContain("scopesClaim");
    });
  });

  describe("resource ceilings", () => {
    it("requires a page limit, because tokens are spent per page", () => {
      const report = checkProductionReadiness(prodConfig({ MAX_PAGES: "0" }));
      expect(report.fatal.join(" ")).toContain("MAX_PAGES is 0");
    });

    it("refuses an unbounded vision timeout", () => {
      const report = checkProductionReadiness(prodConfig({ VISION_TIMEOUT_MS: "0" }));
      expect(report.fatal.join(" ")).toContain("VISION_TIMEOUT_MS is 0");
    });

    it("refuses a disabled subprocess timeout (requirement 5.5)", () => {
      const report = checkProductionReadiness(
        prodConfig({ SUBPROCESS_TIMEOUT_MS: "0" }),
      );
      expect(report.fatal.join(" ")).toContain("SUBPROCESS_TIMEOUT_MS is 0");
    });

    it("refuses disabled throttling and explains the cost", () => {
      const report = checkProductionReadiness(prodConfig({ RATE_LIMIT: "0" }));
      expect(report.fatal.join(" ")).toContain("spends model tokens");
    });

    it("flags REPLICAS > 1 without a shared Redis store (per-replica budget)", () => {
      const report = checkProductionReadiness(
        prodConfig({ REPLICAS: "3", RATE_LIMIT_REDIS_URL: undefined }),
      );
      expect(report.fatal.join(" ")).toContain("REPLICAS is 3");
      expect(report.fatal.join(" ")).toContain("RATE_LIMIT_REDIS_URL");
    });

    it("stays quiet on REPLICAS > 1 once RATE_LIMIT_REDIS_URL is set", () => {
      const report = checkProductionReadiness(
        prodConfig({
          REPLICAS: "3",
          RATE_LIMIT_REDIS_URL: "redis://redis:6379",
        }),
      );
      expect(report.fatal.join(" ")).not.toContain("REPLICAS");
    });

    it("stays quiet on the single-replica default", () => {
      const report = checkProductionReadiness(prodConfig());
      expect(report.fatal.join(" ")).not.toContain("REPLICAS");
    });

    // Task 7.7 (requirement 5.8): the daily tenant cap is a warning, not a
    // fatal — the per-job token budget still caps one job, so disabling the
    // daily axis is a risk call, not a broken deployment (design §Prod-Gate).
    it("warns when the per-tenant daily vision budget is disabled", () => {
      const report = checkProductionReadiness(prodConfig());
      expect(report.warnings.join(" ")).toContain(
        "VISION_BUDGET_PAGES_PER_DAY is 0",
      );
      expect(report.fatal).toEqual([]);
    });

    it("stays quiet once a daily vision budget is configured", () => {
      const report = checkProductionReadiness(
        prodConfig({ VISION_BUDGET_PAGES_PER_DAY: "5000" }),
      );
      expect(report.warnings.join(" ")).not.toContain(
        "VISION_BUDGET_PAGES_PER_DAY",
      );
      expect(report.fatal).toEqual([]);
    });
  });

  describe("server-side request forgery", () => {
    it("flags an open callback allow-list", () => {
      const report = checkProductionReadiness(prodConfig({ CALLBACK_ALLOWED_HOSTS: undefined }));
      expect(report.fatal.join(" ")).toContain("server-side request forgery");
    });

    it("accepts a configured allow-list", () => {
      const report = checkProductionReadiness(prodConfig({ CALLBACK_ALLOWED_HOSTS: "orchestrator.internal" }));
      expect(report.fatal.join(" ")).not.toContain("CALLBACK_ALLOWED_HOSTS");
    });

    it("fails closed on an empty SOURCE_URL_ALLOWED_HOSTS when source_url is live (database set)", () => {
      const report = checkProductionReadiness(
        prodConfig({ EXTRACT_DATABASE_URL: "postgres://extract:secret@db.internal:5432/extract" }),
      );
      expect(report.fatal.join(" ")).toContain("SOURCE_URL_ALLOWED_HOSTS is empty");
    });

    it("accepts a configured SOURCE_URL_ALLOWED_HOSTS", () => {
      const report = checkProductionReadiness(
        prodConfig({
          EXTRACT_DATABASE_URL: "postgres://extract:secret@db.internal:5432/extract",
          SOURCE_URL_ALLOWED_HOSTS: ".files.example",
        }),
      );
      expect(report.fatal.join(" ")).not.toContain("SOURCE_URL_ALLOWED_HOSTS");
    });
  });

  describe("persistence", () => {
    it("only warns when EXTRACT_DATABASE_URL is unset in production", () => {
      const report = checkProductionReadiness(prodConfig());
      expect(report.fatal.join(" ")).not.toContain("EXTRACT_DATABASE_URL");
      expect(report.warnings.join(" ")).toContain("EXTRACT_DATABASE_URL is unset");
    });
  });

  describe("outbound credentials", () => {
    it("flags Search configured without a token", () => {
      const report = checkProductionReadiness(prodConfig({ SEARCH_TOKEN: undefined }));
      expect(report.fatal.join(" ")).toContain("SEARCH_TOKEN");
    });

    it("requires TLS for ingest in production, since it carries document content", () => {
      const report = checkProductionReadiness(prodConfig({ SEARCH_URL: "http://search.internal" }));
      expect(report.fatal.join(" ")).toContain("SEARCH_URL must be https");
    });
  });

  it("flags error-detail disclosure and names what leaks", () => {
    const report = checkProductionReadiness(prodConfig({ EXPOSE_ERROR_DETAIL: "true" }));
    expect(report.fatal.join(" ")).toContain("converter command lines");
  });

  it("warns about a missing proxy trust without failing", () => {
    const report = checkProductionReadiness(prodConfig({ TRUST_PROXY: "false" }));
    expect(report.warnings.join(" ")).toContain("TRUST_PROXY is disabled");
    expect(report.fatal.join(" ")).not.toContain("TRUST_PROXY");
  });

  describe("in-process converter (requirement 5.7)", () => {
    it("is fatal in production: HTML is converted by LibreOffice inside this container", () => {
      const report = checkProductionReadiness(prodConfig({ CONVERTER_MODE: "local" }));
      expect(report.fatal.join(" ")).toContain("CONVERTER_MODE is local");
      expect(report.fatal.join(" ")).toContain("CONVERTER_ALLOW_LOCAL_HTML");
    });
    it("defaults to local without the acknowledgement", () => {
      const config = loadTestConfig({});
      expect(config.converterMode).toBe("local");
      expect(config.converterAllowLocalHtml).toBe(false);
    });
    it("is only a warning with the explicit CONVERTER_ALLOW_LOCAL_HTML=true opt-out", () => {
      const report = checkProductionReadiness(
        prodConfig({ CONVERTER_MODE: "local", CONVERTER_ALLOW_LOCAL_HTML: "true" }),
      );
      expect(report.fatal.join(" ")).not.toContain("CONVERTER_MODE");
      expect(report.warnings.join(" ")).toContain("CONVERTER_ALLOW_LOCAL_HTML=true");
    });
    it("is silent with CONVERTER_MODE=isolated, with or without the flag", () => {
      for (const extra of [{}, { CONVERTER_ALLOW_LOCAL_HTML: "true" }]) {
        const report = checkProductionReadiness(
          prodConfig({ CONVERTER_MODE: "isolated", ...extra }),
        );
        expect(report.fatal.join(" ")).not.toContain("CONVERTER_MODE");
        expect(report.warnings.join(" ")).not.toContain("CONVERTER_MODE");
      }
    });
    it("is a warning, not a failure, in development and staging", () => {
      for (const env of [{ NODE_ENV: "development" }, { ATF_PROFILE: "staging" }]) {
        const report = checkProductionReadiness(loadTestConfig(env));
        expect(report.fatal.join(" ")).not.toContain("CONVERTER_MODE");
        expect(report.warnings.join(" ")).toContain("CONVERTER_MODE is local");
      }
    });
  });
});
describe("job retention", () => {
  const database = { EXTRACT_DATABASE_URL: "postgres://extract:secret@db.internal:5432/extract" };
  it("warns, but does not fail, when finished jobs are kept forever in production", () => {
    const report = checkProductionReadiness(prodConfig(database));
    expect(report.warnings.join(" ")).toContain("JOB_RETENTION_DAYS is 0");
    expect(report.fatal.join(" ")).not.toContain("JOB_RETENTION_DAYS");
  });
  it("is silent once a retention period is set, and without a database", () => {
    const withRule = checkProductionReadiness(prodConfig({ ...database, JOB_RETENTION_DAYS: "30" }));
    expect(withRule.warnings.join(" ")).not.toContain("JOB_RETENTION_DAYS");
    const noDb = checkProductionReadiness(prodConfig());
    expect(noDb.warnings.join(" ")).not.toContain("JOB_RETENTION_DAYS");
  });
});
