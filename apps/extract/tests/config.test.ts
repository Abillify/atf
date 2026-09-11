// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { loadTestConfig } from "./helpers.js";

describe("loadConfig", () => {
  it("requires the vision endpoint and model", () => {
    expect(() => loadTestConfig({ VISION_URL: undefined })).toThrow(/VISION_URL/);
    expect(() => loadTestConfig({ VISION_MODEL: undefined })).toThrow(/VISION_MODEL/);
  });

  it("defaults to port 3004, after runtime, control, search and gate", () => {
    expect(loadTestConfig().port).toBe(3004);
  });

  it("strips a trailing slash from the vision URL so the path is not doubled", () => {
    expect(loadTestConfig({ VISION_URL: "http://model:8000/" }).visionUrl).toBe("http://model:8000");
  });

  it("leaves the vision API key unset for an unauthenticated local endpoint", () => {
    expect(loadTestConfig().visionApiKey).toBeNull();
  });

  describe("token budget escalation", () => {
    it("defaults to an ascending ladder", () => {
      expect(loadTestConfig().visionMaxTokenVariants).toEqual([8192, 16_384, 32_768]);
    });

    it("sorts and de-duplicates, because escalation only makes sense upwards", () => {
      const config = loadTestConfig({ VISION_MAX_TOKEN_VARIANTS: "32768,4096,8192,8192" });
      expect(config.visionMaxTokenVariants).toEqual([4096, 8192, 32_768]);
    });

    it("rejects a non-numeric list", () => {
      expect(() => loadTestConfig({ VISION_MAX_TOKEN_VARIANTS: "8192,lots" })).toThrow(
        /positive integers/,
      );
    });
  });

  describe("render resolution", () => {
    it("renders figures at least as sharply as the model input", () => {
      // A crop coarser than the page the model saw is never what an operator wants,
      // and discovering it per figure at upload time wastes a conversion.
      expect(() => loadTestConfig({ RENDER_DPI: "300", FIGURE_DPI: "150" })).toThrow(
        /FIGURE_DPI \(150\) must be >= RENDER_DPI \(300\)/,
      );
    });

    it("accepts equal resolutions", () => {
      const config = loadTestConfig({ RENDER_DPI: "200", FIGURE_DPI: "200" });
      expect(config.figureDpi).toBe(200);
    });

    it("bounds the resolution to something a rasteriser can survive", () => {
      expect(() => loadTestConfig({ RENDER_DPI: "5000" })).toThrow(/between 36 and 1200/);
    });
  });

  describe("page label", () => {
    it("defaults to the German marker used by existing corpora", () => {
      expect(loadTestConfig().pageLabel).toBe("Seite");
    });

    it("accepts either contract label, case-insensitively", () => {
      expect(loadTestConfig({ PAGE_LABEL: "page" }).pageLabel).toBe("Page");
    });

    it("rejects anything the contract cannot parse back", () => {
      expect(() => loadTestConfig({ PAGE_LABEL: "Sida" })).toThrow(/PAGE_LABEL/);
    });
  });

  describe("authentication mode", () => {
    it("infers disabled when no credential is configured", () => {
      expect(loadTestConfig({ AUTHN_MODE: undefined }).authnMode).toBe("disabled");
    });

    it("infers token from API_TOKEN alone", () => {
      const config = loadTestConfig({ AUTHN_MODE: undefined, API_TOKEN: "x".repeat(40) });
      expect(config.authnMode).toBe("token");
    });

    it("infers oidc from issuers alone", () => {
      const config = loadTestConfig({
        AUTHN_MODE: undefined,
        API_OIDC_ISSUERS: '[{"issuer":"https://idp.example","audience":"atf-extract"}]',
      });
      expect(config.authnMode).toBe("oidc");
    });

    it("infers token_or_oidc when both are present", () => {
      const config = loadTestConfig({
        AUTHN_MODE: undefined,
        API_TOKEN: "x".repeat(40),
        API_OIDC_ISSUERS: '[{"issuer":"https://idp.example"}]',
      });
      expect(config.authnMode).toBe("token_or_oidc");
    });

    it("refuses a mode whose credential is missing", () => {
      // Otherwise the service starts with a middleware that can never succeed.
      expect(() => loadTestConfig({ AUTHN_MODE: "token" })).toThrow(/API_TOKEN is required/);
      expect(() => loadTestConfig({ AUTHN_MODE: "oidc" })).toThrow(/API_OIDC_ISSUERS is required/);
    });

    it("refuses tenant isolation with no way to establish a tenant", () => {
      expect(() =>
        loadTestConfig({ AUTHN_MODE: "disabled", TENANT_ISOLATION_ENABLED: "true" }),
      ).toThrow(/cannot be used with TENANT_ISOLATION_ENABLED/);
    });

    it("requires a service tenant for token auth under isolation", () => {
      expect(() =>
        loadTestConfig({
          AUTHN_MODE: "token",
          API_TOKEN: "x".repeat(40),
          TENANT_ISOLATION_ENABLED: "true",
        }),
      ).toThrow(/API_SERVICE_TENANT_ID is required/);
    });
  });

  describe("OIDC block", () => {
    it("stays disabled without an issuer", () => {
      expect(loadTestConfig().oidc).toBeNull();
    });

    it("refuses a half-configured provider rather than silently doing nothing", () => {
      expect(() => loadTestConfig({ OIDC_ISSUER: "https://idp.example" })).toThrow(
        /missing: OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_SESSION_SECRET/,
      );
    });

    it("rejects a session secret too short to sign with", () => {
      expect(() =>
        loadTestConfig({
          OIDC_ISSUER: "https://idp.example",
          OIDC_CLIENT_ID: "id",
          OIDC_CLIENT_SECRET: "secret",
          OIDC_SESSION_SECRET: "short",
        }),
      ).toThrow(/at least 16 characters/);
    });

    it("normalises the issuer and the allow-lists", () => {
      const config = loadTestConfig({
        OIDC_ISSUER: "https://idp.example/app/o/atf//",
        OIDC_CLIENT_ID: "id",
        OIDC_CLIENT_SECRET: "secret",
        OIDC_SESSION_SECRET: "0123456789abcdef",
        OIDC_ALLOWED_EMAIL_DOMAINS: "@Example.COM, other.test",
      });
      expect(config.oidc?.issuer).toBe("https://idp.example/app/o/atf");
      expect(config.oidc?.allowedEmailDomains).toEqual(["example.com", "other.test"]);
    });
  });

  describe("API OIDC issuers", () => {
    it("reports the offending index on a malformed entry", () => {
      expect(() =>
        loadTestConfig({ API_OIDC_ISSUERS: '[{"issuer":"https://a"},{"audience":"b"}]' }),
      ).toThrow(/API_OIDC_ISSUERS\[1\]/);
    });

    it("reports invalid JSON with the expected shape", () => {
      expect(() => loadTestConfig({ API_OIDC_ISSUERS: "not json" })).toThrow(/invalid JSON/);
    });
  });

  describe("Search target", () => {
    it("stays null so the ingest route is never mounted", () => {
      expect(loadTestConfig().search).toBeNull();
    });

    it("is populated from SEARCH_URL and normalised", () => {
      const config = loadTestConfig({
        SEARCH_URL: "http://search:3002/",
        SEARCH_TOKEN: "t",
        SEARCH_COLLECTION: "specs",
      });
      expect(config.search).toEqual({
        url: "http://search:3002",
        token: "t",
        collection: "specs",
        timeoutMs: 120_000,
        uploadAssets: true,
      });
    });
  });

  describe("callback allow-list", () => {
    it("is empty by default, which the production gate flags", () => {
      expect(loadTestConfig().callbackAllowedHosts).toEqual([]);
    });

    it("lower-cases entries so matching is case-insensitive", () => {
      expect(
        loadTestConfig({ CALLBACK_ALLOWED_HOSTS: ".SVC.Cluster.Local, Localhost" })
          .callbackAllowedHosts,
      ).toEqual([".svc.cluster.local", "localhost"]);
    });
  });

  it("requires a positive callback timeout so delivery is always bounded", () => {
    expect(() => loadTestConfig({ CALLBACK_TIMEOUT_MS: "0" })).toThrow(
      /CALLBACK_TIMEOUT_MS.*>= 1/,
    );
    expect(loadTestConfig({ CALLBACK_TIMEOUT_MS: "1" }).callbackTimeoutMs).toBe(1);
  });

  it("treats MAX_PAGES=0 as unlimited but keeps the value distinguishable", () => {
    expect(loadTestConfig({ MAX_PAGES: "0" }).maxPages).toBe(0);
    expect(loadTestConfig({ MAX_PAGES: "50" }).maxPages).toBe(50);
  });

  it("allows the vision timeout to be disabled explicitly", () => {
    expect(loadTestConfig({ VISION_TIMEOUT_MS: "0" }).visionTimeoutMs).toBe(0);
  });
});
