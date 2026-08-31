// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for src/config/defaults.ts — secure configuration defaults.
 *
 * Validates: Requirements 3.3 — missing/invalid security config yields secure
 * values regardless of APP_ENV.
 */

import { describe, test, expect } from "bun:test";
import { SECURE_DEFAULTS, applySecureDefaults } from "../defaults.js";
import type { AppConfig } from "../index.js";

describe("SECURE_DEFAULTS", () => {
  test("CORS origins are restrictive (empty — no cross-origin allowed)", () => {
    expect(SECURE_DEFAULTS.corsOrigins).toEqual([]);
  });

  test("monitoring auth is required", () => {
    expect(SECURE_DEFAULTS.monitoringAuthRequired).toBe(true);
  });

  test("metrics auth is required", () => {
    expect(SECURE_DEFAULTS.metricsAuthRequired).toBe(true);
  });

  test("tenant RLS is enabled", () => {
    expect(SECURE_DEFAULTS.tenantRlsEnabled).toBe(true);
  });

  test("debug credential capture is disabled", () => {
    expect(SECURE_DEFAULTS.debugCaptureRequestTokens).toBe(false);
  });

  test("tool authz fails closed", () => {
    expect(SECURE_DEFAULTS.toolAuthzFailClosed).toBe(true);
  });

  test("rate-limit fail mode is closed", () => {
    expect(SECURE_DEFAULTS.rateLimitFailMode).toBe("closed");
  });

  test("unverified JWT is not accepted", () => {
    expect(SECURE_DEFAULTS.allowUnverifiedJwt).toBe(false);
  });

  test("defaults object is frozen (immutable)", () => {
    expect(Object.isFrozen(SECURE_DEFAULTS)).toBe(true);
  });
});

describe("applySecureDefaults", () => {
  test("fills missing security fields with secure values", () => {
    const partial: Partial<AppConfig> = {
      port: 3000,
      flowsDir: "./flows",
    };

    const result = applySecureDefaults(partial);

    expect(result.corsOrigins).toEqual([]);
    expect(result.monitoringAuthRequired).toBe(true);
    expect(result.metricsAuthRequired).toBe(true);
    expect(result.tenantRlsEnabled).toBe(true);
    expect(result.debugCaptureRequestTokens).toBe(false);
    expect(result.toolAuthzFailClosed).toBe(true);
    expect(result.rateLimitFailMode).toBe("closed");
    expect(result.allowUnverifiedJwt).toBe(false);
  });

  test("does not overwrite explicitly set permissive values", () => {
    const explicit: Partial<AppConfig> = {
      corsOrigins: ["*"],
      monitoringAuthRequired: false,
      metricsAuthRequired: false,
      tenantRlsEnabled: false,
      debugCaptureRequestTokens: true,
      toolAuthzFailClosed: false,
      rateLimitFailMode: "open",
      allowUnverifiedJwt: true,
    };

    const result = applySecureDefaults(explicit);

    // Explicit values preserved — operator owns the final decision
    expect(result.corsOrigins).toEqual(["*"]);
    expect(result.monitoringAuthRequired).toBe(false);
    expect(result.metricsAuthRequired).toBe(false);
    expect(result.tenantRlsEnabled).toBe(false);
    expect(result.debugCaptureRequestTokens).toBe(true);
    expect(result.toolAuthzFailClosed).toBe(false);
    expect(result.rateLimitFailMode).toBe("open");
    expect(result.allowUnverifiedJwt).toBe(true);
  });

  test("preserves non-security fields unchanged", () => {
    const partial: Partial<AppConfig> = {
      port: 8080,
      flowsDir: "/custom",
      logLevel: "debug",
      maxToolSteps: 10,
    };

    const result = applySecureDefaults(partial);

    expect(result.port).toBe(8080);
    expect(result.flowsDir).toBe("/custom");
    expect(result.logLevel).toBe("debug");
    expect(result.maxToolSteps).toBe(10);
  });

  test("works identically regardless of APP_ENV", () => {
    const devConfig: Partial<AppConfig> = { appEnv: "development" };
    const prodConfig: Partial<AppConfig> = { appEnv: "production" };

    const devResult = applySecureDefaults(devConfig);
    const prodResult = applySecureDefaults(prodConfig);

    // Security defaults are the same in both environments
    expect(devResult.corsOrigins).toEqual(prodResult.corsOrigins);
    expect(devResult.monitoringAuthRequired).toEqual(
      prodResult.monitoringAuthRequired,
    );
    expect(devResult.metricsAuthRequired).toEqual(
      prodResult.metricsAuthRequired,
    );
    expect(devResult.tenantRlsEnabled).toEqual(prodResult.tenantRlsEnabled);
    expect(devResult.toolAuthzFailClosed).toEqual(
      prodResult.toolAuthzFailClosed,
    );
    expect(devResult.rateLimitFailMode).toEqual(prodResult.rateLimitFailMode);
    expect(devResult.allowUnverifiedJwt).toEqual(prodResult.allowUnverifiedJwt);
  });

  test("replaces invalid corsOrigins (non-array) with secure default", () => {
    const config = {
      corsOrigins: "not-an-array",
    } as unknown as Partial<AppConfig>;
    const result = applySecureDefaults(config);
    expect(result.corsOrigins).toEqual([]);
  });

  test("replaces invalid boolean fields (non-boolean) with secure defaults", () => {
    const config = {
      monitoringAuthRequired: "yes" as unknown as boolean,
      metricsAuthRequired: 1 as unknown as boolean,
      tenantRlsEnabled: "true" as unknown as boolean,
      debugCaptureRequestTokens: null as unknown as boolean,
      toolAuthzFailClosed: 0 as unknown as boolean,
      allowUnverifiedJwt: "false" as unknown as boolean,
    } as Partial<AppConfig>;

    const result = applySecureDefaults(config);

    expect(result.monitoringAuthRequired).toBe(true);
    expect(result.metricsAuthRequired).toBe(true);
    expect(result.tenantRlsEnabled).toBe(true);
    expect(result.debugCaptureRequestTokens).toBe(false);
    expect(result.toolAuthzFailClosed).toBe(true);
    expect(result.allowUnverifiedJwt).toBe(false);
  });

  test("replaces invalid rateLimitFailMode with secure default", () => {
    const config = {
      rateLimitFailMode: "invalid-mode" as unknown as "closed" | "open",
    } as Partial<AppConfig>;

    const result = applySecureDefaults(config);
    expect(result.rateLimitFailMode).toBe("closed");
  });

  test("APP_ENV-unabhängig: invalid values produce secure defaults in all environments", () => {
    const invalidConfig = {
      corsOrigins: 42 as unknown as string[],
      monitoringAuthRequired: "nope" as unknown as boolean,
      rateLimitFailMode: "maybe" as unknown as "closed" | "open",
    };

    const devResult = applySecureDefaults({
      ...invalidConfig,
      appEnv: "development",
    } as unknown as Partial<AppConfig>);

    const prodResult = applySecureDefaults({
      ...invalidConfig,
      appEnv: "production",
    } as unknown as Partial<AppConfig>);

    // Both environments apply the same secure defaults for invalid config
    expect(devResult.corsOrigins).toEqual([]);
    expect(devResult.monitoringAuthRequired).toBe(true);
    expect(devResult.rateLimitFailMode).toBe("closed");

    expect(prodResult.corsOrigins).toEqual([]);
    expect(prodResult.monitoringAuthRequired).toBe(true);
    expect(prodResult.rateLimitFailMode).toBe("closed");
  });
});
