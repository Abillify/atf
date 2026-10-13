// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { loadTestConfig } from "./helpers.js";

describe("loadConfig", () => {
  it("requires the vision endpoint and model", () => {
    expect(() => loadTestConfig({ VISION_URL: undefined })).toThrow(
      /VISION_URL/,
    );
    expect(() => loadTestConfig({ VISION_MODEL: undefined })).toThrow(
      /VISION_MODEL/,
    );
  });

  it("defaults to port 3004, after runtime, control, search and gate", () => {
    expect(loadTestConfig().port).toBe(3004);
  });

  it("strips a trailing slash from the vision URL so the path is not doubled", () => {
    expect(loadTestConfig({ VISION_URL: "http://model:8000/" }).visionUrl).toBe(
      "http://model:8000",
    );
  });

  describe("structured output capability (task 7.9)", () => {
    it("stays off by default, because many serving stacks reject response_format", () => {
      expect(loadTestConfig().visionSupportsJsonSchema).toBe(false);
    });

    it("can be switched on for a model that implements json_schema", () => {
      expect(
        loadTestConfig({ VISION_SUPPORTS_JSON_SCHEMA: "true" })
          .visionSupportsJsonSchema,
      ).toBe(true);
    });
  });

  it("leaves the vision API key unset for an unauthenticated local endpoint", () => {
    expect(loadTestConfig().visionApiKey).toBeNull();
  });

  describe("token budget escalation", () => {
    it("defaults to an ascending ladder", () => {
      expect(loadTestConfig().visionMaxTokenVariants).toEqual([
        8192, 16_384, 32_768,
      ]);
    });

    it("sorts and de-duplicates, because escalation only makes sense upwards", () => {
      const config = loadTestConfig({
        VISION_MAX_TOKEN_VARIANTS: "32768,4096,8192,8192",
      });
      expect(config.visionMaxTokenVariants).toEqual([4096, 8192, 32_768]);
    });

    it("rejects a non-numeric list", () => {
      expect(() =>
        loadTestConfig({ VISION_MAX_TOKEN_VARIANTS: "8192,lots" }),
      ).toThrow(/positive integers/);
    });
  });

  describe("render resolution", () => {
    it("renders figures at least as sharply as the model input", () => {
      // A crop coarser than the page the model saw is never what an operator wants,
      // and discovering it per figure at upload time wastes a conversion.
      expect(() =>
        loadTestConfig({ RENDER_DPI: "300", FIGURE_DPI: "150" }),
      ).toThrow(/FIGURE_DPI \(150\) must be >= RENDER_DPI \(300\)/);
    });

    it("accepts equal resolutions", () => {
      const config = loadTestConfig({ RENDER_DPI: "200", FIGURE_DPI: "200" });
      expect(config.figureDpi).toBe(200);
    });

    it("bounds the resolution to something a rasteriser can survive", () => {
      expect(() => loadTestConfig({ RENDER_DPI: "5000" })).toThrow(
        /between 36 and 1200/,
      );
    });
  });

  describe("figure Pass-2 gating (task 2.5)", () => {
    it("defaults to every structured figure kind", () => {
      expect(loadTestConfig().figurePass2Kinds).toEqual([
        "bpmn",
        "flowchart",
        "ui_mask",
        "technical_drawing",
        "chart",
        "table_image",
      ]);
    });

    it("parses and de-duplicates a custom kind list", () => {
      const config = loadTestConfig({
        FIGURE_PASS2_KINDS: "bpmn, chart ,bpmn",
      });
      expect(config.figurePass2Kinds).toEqual(["bpmn", "chart"]);
    });

    it("rejects an unknown kind rather than silently dropping it", () => {
      expect(() =>
        loadTestConfig({ FIGURE_PASS2_KINDS: "bpmn,banana" }),
      ).toThrow(/FIGURE_PASS2_KINDS/);
    });

    it("defaults the minimum area and the label-coverage threshold", () => {
      const config = loadTestConfig();
      expect(config.figurePass2MinArea).toBeCloseTo(0.02, 5);
      expect(config.labelCoverageMin).toBe(60);
    });

    it("bounds the minimum area to a fraction and coverage to a percentage", () => {
      expect(() => loadTestConfig({ FIGURE_PASS2_MIN_AREA: "1.5" })).toThrow(
        /FIGURE_PASS2_MIN_AREA/,
      );
      expect(() => loadTestConfig({ LABEL_COVERAGE_MIN: "150" })).toThrow(
        /LABEL_COVERAGE_MIN/,
      );
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
      expect(() => loadTestConfig({ PAGE_LABEL: "Sida" })).toThrow(
        /PAGE_LABEL/,
      );
    });
  });

  describe("authentication mode", () => {
    it("infers disabled when no credential is configured", () => {
      expect(loadTestConfig({ AUTHN_MODE: undefined }).authnMode).toBe(
        "disabled",
      );
    });

    it("infers token from API_TOKEN alone", () => {
      const config = loadTestConfig({
        AUTHN_MODE: undefined,
        API_TOKEN: "x".repeat(40),
      });
      expect(config.authnMode).toBe("token");
    });

    it("infers oidc from issuers alone", () => {
      const config = loadTestConfig({
        AUTHN_MODE: undefined,
        API_OIDC_ISSUERS:
          '[{"issuer":"https://idp.example","audience":"atf-extract"}]',
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
      expect(() => loadTestConfig({ AUTHN_MODE: "token" })).toThrow(
        /API_TOKEN is required/,
      );
      expect(() => loadTestConfig({ AUTHN_MODE: "oidc" })).toThrow(
        /API_OIDC_ISSUERS is required/,
      );
    });

    // Req 11.8: API_TOKEN_NEXT is the additive rotation token.
    it("infers token from API_TOKEN_NEXT alone", () => {
      const config = loadTestConfig({
        AUTHN_MODE: undefined,
        API_TOKEN_NEXT: "y".repeat(40),
      });
      expect(config.authnMode).toBe("token");
      expect(config.apiToken).toBeNull();
      expect(config.apiTokenNext).toBe("y".repeat(40));
    });

    it("loads both tokens during a rotation", () => {
      const config = loadTestConfig({
        AUTHN_MODE: undefined,
        API_TOKEN: "x".repeat(40),
        API_TOKEN_NEXT: "y".repeat(40),
      });
      expect(config.apiToken).toBe("x".repeat(40));
      expect(config.apiTokenNext).toBe("y".repeat(40));
    });

    it("refuses tenant isolation with no way to establish a tenant", () => {
      expect(() =>
        loadTestConfig({
          AUTHN_MODE: "disabled",
          TENANT_ISOLATION_ENABLED: "true",
        }),
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
      expect(() =>
        loadTestConfig({ OIDC_ISSUER: "https://idp.example" }),
      ).toThrow(
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
      expect(config.oidc?.allowedEmailDomains).toEqual([
        "example.com",
        "other.test",
      ]);
    });
  });

  describe("API OIDC issuers", () => {
    it("reports the offending index on a malformed entry", () => {
      expect(() =>
        loadTestConfig({
          API_OIDC_ISSUERS: '[{"issuer":"https://a"},{"audience":"b"}]',
        }),
      ).toThrow(/API_OIDC_ISSUERS\[1\]/);
    });

    it("reports invalid JSON with the expected shape", () => {
      expect(() => loadTestConfig({ API_OIDC_ISSUERS: "not json" })).toThrow(
        /invalid JSON/,
      );
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
        caCertFile: null,
      });
    });

    it("reads SEARCH_CA_CERT_FILE for trusting a self-signed Search TLS", () => {
      const config = loadTestConfig({
        SEARCH_URL: "https://search:3002",
        SEARCH_CA_CERT_FILE: "/etc/tls/search-ca.pem",
      });
      expect(config.search?.caCertFile).toBe("/etc/tls/search-ca.pem");
    });
  });

  // Req 11.8: optional server TLS, enabled by TLS_CERT_FILE + TLS_KEY_FILE.
  describe("server TLS", () => {
    it("is null by default", () => {
      expect(loadTestConfig().tls).toBeNull();
    });

    it("refuses TLS_CERT_FILE without TLS_KEY_FILE", () => {
      expect(() =>
        loadTestConfig({ TLS_CERT_FILE: "/etc/tls/server.crt" }),
      ).toThrow(/TLS_CERT_FILE and TLS_KEY_FILE must be set together/);
    });

    it("refuses TLS_KEY_FILE without TLS_CERT_FILE", () => {
      expect(() =>
        loadTestConfig({ TLS_KEY_FILE: "/etc/tls/server.key" }),
      ).toThrow(/TLS_CERT_FILE and TLS_KEY_FILE must be set together/);
    });

    it("loads cert, key and optional client CA for mTLS", () => {
      const config = loadTestConfig({
        TLS_CERT_FILE: "/etc/tls/server.crt",
        TLS_KEY_FILE: "/etc/tls/server.key",
        TLS_CLIENT_CA_FILE: "/etc/tls/client-ca.pem",
      });
      expect(config.tls).toEqual({
        certFile: "/etc/tls/server.crt",
        keyFile: "/etc/tls/server.key",
        clientCaFile: "/etc/tls/client-ca.pem",
      });
    });
  });

  describe("callback allow-list", () => {
    it("is empty by default, which the production gate flags", () => {
      expect(loadTestConfig().callbackAllowedHosts).toEqual([]);
    });

    it("lower-cases entries so matching is case-insensitive", () => {
      expect(
        loadTestConfig({
          CALLBACK_ALLOWED_HOSTS: ".SVC.Cluster.Local, Localhost",
        }).callbackAllowedHosts,
      ).toEqual([".svc.cluster.local", "localhost"]);
    });
  });

  it("requires a positive callback timeout so delivery is always bounded", () => {
    expect(() => loadTestConfig({ CALLBACK_TIMEOUT_MS: "0" })).toThrow(
      /CALLBACK_TIMEOUT_MS.*>= 1/,
    );
    expect(loadTestConfig({ CALLBACK_TIMEOUT_MS: "1" }).callbackTimeoutMs).toBe(
      1,
    );
  });

  it("treats MAX_PAGES=0 as unlimited but keeps the value distinguishable", () => {
    expect(loadTestConfig({ MAX_PAGES: "0" }).maxPages).toBe(0);
    expect(loadTestConfig({ MAX_PAGES: "50" }).maxPages).toBe(50);
  });

  // Task 7.7 (requirement 5.8): the page ceiling ships ON, not off — an
  // unset MAX_PAGES is 500, so an upload can no longer spend tokens without
  // a bound just because an operator never configured the variable.
  it("defaults MAX_PAGES to 500 (requirement 5.8)", () => {
    expect(loadTestConfig().maxPages).toBe(500);
  });

  describe("VISION_BUDGET_PAGES_PER_DAY (task 7.7, requirement 5.8)", () => {
    it("is unlimited (0) by default", () => {
      expect(loadTestConfig().visionBudgetPagesPerDay).toBe(0);
    });

    it("parses a positive daily cap", () => {
      expect(
        loadTestConfig({ VISION_BUDGET_PAGES_PER_DAY: "2000" })
          .visionBudgetPagesPerDay,
      ).toBe(2000);
    });

    it("rejects a negative daily cap", () => {
      expect(() =>
        loadTestConfig({ VISION_BUDGET_PAGES_PER_DAY: "-1" }),
      ).toThrow(/VISION_BUDGET_PAGES_PER_DAY/);
    });
  });

  it("allows the vision timeout to be disabled explicitly", () => {
    expect(loadTestConfig({ VISION_TIMEOUT_MS: "0" }).visionTimeoutMs).toBe(0);
  });

  describe("CONVERTER_MODE (task 7.6, requirement 5.7)", () => {
    it("runs converters in-process by default", () => {
      expect(loadTestConfig().converterMode).toBe("local");
      expect(loadTestConfig().converterSocket).toBe(
        "/run/atf-converter/converter.sock",
      );
    });

    it("accepts isolated mode with a custom socket path", () => {
      const config = loadTestConfig({
        CONVERTER_MODE: "isolated",
        CONVERTER_SOCKET: "/tmp/atf-conv.sock",
      });
      expect(config.converterMode).toBe("isolated");
      expect(config.converterSocket).toBe("/tmp/atf-conv.sock");
    });

    it("rejects an unknown mode instead of silently falling back", () => {
      expect(() => loadTestConfig({ CONVERTER_MODE: "sandbox" })).toThrow(
        /CONVERTER_MODE/,
      );
    });
  });

  describe("OCR_FALLBACK (task 7.10, requirement 5.11)", () => {
    it("stays off by default: a VLM outage retries rather than OCR-ing", () => {
      expect(loadTestConfig().ocrFallback).toBe("off");
    });

    it("can be switched to tesseract", () => {
      expect(loadTestConfig({ OCR_FALLBACK: "tesseract" }).ocrFallback).toBe(
        "tesseract",
      );
    });

    it("rejects an unknown backend instead of silently falling back", () => {
      expect(() => loadTestConfig({ OCR_FALLBACK: "ocrmypdf" })).toThrow(
        /OCR_FALLBACK/,
      );
    });

    it("defaults the binary and language, both overridable", () => {
      const config = loadTestConfig();
      expect(config.tesseractBin).toBe("tesseract");
      expect(config.ocrLang).toBe("deu");
      const custom = loadTestConfig({
        TESSERACT_BIN: "/usr/local/bin/tesseract",
        OCR_LANG: "eng+deu",
      });
      expect(custom.tesseractBin).toBe("/usr/local/bin/tesseract");
      expect(custom.ocrLang).toBe("eng+deu");
    });
  });

  // Req 12.4: migrations run at boot outside production by default;
  // production defaults to dedicated migration Jobs (`bun run migrate`).
  describe("MIGRATE_ON_START (requirement 12.4)", () => {
    it("defaults to true outside production", () => {
      expect(loadTestConfig().migrateOnStart).toBe(true);
      expect(loadTestConfig({ NODE_ENV: "development" }).migrateOnStart).toBe(
        true,
      );
    });

    it("defaults to false in production", () => {
      expect(loadTestConfig({ NODE_ENV: "production" }).migrateOnStart).toBe(
        false,
      );
    });

    it("lets an explicit value win over NODE_ENV", () => {
      expect(
        loadTestConfig({
          NODE_ENV: "production",
          MIGRATE_ON_START: "true",
        }).migrateOnStart,
      ).toBe(true);
      expect(
        loadTestConfig({
          NODE_ENV: "development",
          MIGRATE_ON_START: "false",
        }).migrateOnStart,
      ).toBe(false);
    });

    it("is carried into the database config when one is configured", () => {
      const dbUrl = "postgresql://user:pass@localhost:5432/extract";
      expect(
        loadTestConfig({
          EXTRACT_DATABASE_URL: dbUrl,
          NODE_ENV: "production",
        }).database?.migrateOnStart,
      ).toBe(false);
      expect(
        loadTestConfig({ EXTRACT_DATABASE_URL: dbUrl }).database
          ?.migrateOnStart,
      ).toBe(true);
    });
  });

  describe("FINALIZE_PASS (task 5.4, requirement 9.6)", () => {
    it("enables the optional outline finalize pass by default", () => {
      expect(loadTestConfig().emitter.finalizePass).toBe(true);
    });

    it("can be disabled to emit the streaming outline as-is", () => {
      expect(
        loadTestConfig({ FINALIZE_PASS: "false" }).emitter.finalizePass,
      ).toBe(false);
    });
  });
});
