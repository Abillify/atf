// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for configuration profiles / presets (`src/config/profiles.ts`).
 *
 * Core invariant: explicit env > profile default > built-in default. A profile
 * only fills variables the operator has NOT set, and never mutates the input.
 */

import { describe, it, expect } from "bun:test";
import {
  applyProfile,
  listProfiles,
  PROFILES,
  type RawEnv,
} from "../profiles.js";

describe("applyProfile", () => {
  it("returns the env unchanged when no PROFILE is set", () => {
    const env: RawEnv = { PORT: "3000" };
    const r = applyProfile(env);
    expect(r.profile).toBeUndefined();
    expect(r.applied).toEqual([]);
    expect(r.env).toEqual({ PORT: "3000" });
  });

  it("fills defaults for unset variables from the named profile", () => {
    const r = applyProfile({ PROFILE: "regulated" });
    expect(r.profile).toBe("regulated");
    expect(r.env.PII_VAULT_ENABLED).toBe("true");
    expect(r.env.PII_VAULT_MULTIMODAL_MODE).toBe("block");
    expect(r.env.MONITORING_AUTH).toBe("true");
    expect(r.env.INPUT_GUARDRAIL_MODE).toBe("block");
    expect(r.applied).toContain("PII_VAULT_ENABLED");
  });

  it("regulated presets fill the new controls and no decision receipts", () => {
    for (const name of ["regulated", "regulated-multitenant"]) {
      const r = applyProfile({ PROFILE: name });
      expect(r.env.TAINT_MODE).toBe("on-untrusted-source");
      expect(r.env.AI_DISCLOSURE).toBe("header");
      expect(r.env.COMPLIANCE_POLICY_REQUIRED).toBe("true");
      // Would abort the start without RECEIPT_SIGNING_KEY (profiles carry no secrets).
      expect(r.env.DECISION_RECEIPTS_ENABLED).toBeUndefined();
    }
    expect(applyProfile({ PROFILE: "secure" }).env.TAINT_MODE).toBeUndefined();
  });

  it("never overrides an explicitly-set variable (explicit env wins)", () => {
    const r = applyProfile({
      PROFILE: "regulated",
      PII_VAULT_MULTIMODAL_MODE: "redact", // operator override
      APP_ENV: "development",
    });
    expect(r.env.PII_VAULT_MULTIMODAL_MODE).toBe("redact");
    expect(r.env.APP_ENV).toBe("development");
    expect(r.applied).not.toContain("PII_VAULT_MULTIMODAL_MODE");
    expect(r.applied).not.toContain("APP_ENV");
  });

  it("treats an explicit empty string as set (does not fill it)", () => {
    const r = applyProfile({ PROFILE: "regulated", MONITORING_AUTH: "" });
    expect(r.env.MONITORING_AUTH).toBe("");
    expect(r.applied).not.toContain("MONITORING_AUTH");
  });

  it("does not mutate the input env object", () => {
    const env: RawEnv = { PROFILE: "regulated" };
    const before = { ...env };
    applyProfile(env);
    expect(env).toEqual(before);
  });

  it("adds tenant isolation + BYOK only in the multitenant profile", () => {
    const single = applyProfile({ PROFILE: "regulated" });
    const multi = applyProfile({ PROFILE: "regulated-multitenant" });
    expect(single.env.TENANT_MANAGEMENT_ENABLED).toBeUndefined();
    expect(multi.env.TENANT_MANAGEMENT_ENABLED).toBe("true");
    expect(multi.env.BYOK_ENABLED).toBe("true");
    expect(multi.env.TENANT_RLS_REQUIRED).toBe("true");
  });

  it("performance profile toggles only caches, no posture changes", () => {
    const r = applyProfile({ PROFILE: "performance" });
    expect(r.env.RESPONSE_CACHE_ENABLED).toBe("true");
    expect(r.env.SEMANTIC_CACHE_ENABLED).toBe("true");
    expect(r.env.EMBEDDING_CACHE_ENABLED).toBe("true");
    expect(r.env.APP_ENV).toBeUndefined();
    expect(r.env.PII_VAULT_ENABLED).toBeUndefined();
  });

  it("hardened presets keep the exact caches but not the semantic cache", () => {
    for (const name of ["secure", "regulated", "regulated-multitenant"]) {
      const r = applyProfile({ PROFILE: name });
      expect(r.env.RESPONSE_CACHE_ENABLED).toBe("true");
      expect(r.env.EMBEDDING_CACHE_ENABLED).toBe("true");
      // Similarity matching stays opt-in for regulated presets.
      expect(r.env.SEMANTIC_CACHE_ENABLED).toBeUndefined();
    }
    expect(applyProfile({ PROFILE: "performance" }).env.SEMANTIC_CACHE_ENABLED).toBe(
      "true",
    );
  });

  it("dev profile sets development env + debug logging", () => {
    const r = applyProfile({ PROFILE: "dev" });
    expect(r.env.APP_ENV).toBe("development");
    expect(r.env.LOG_LEVEL).toBe("debug");
  });

  it("reports an error for an unknown profile instead of silently ignoring it", () => {
    const r = applyProfile({ PROFILE: "regulateed" }); // typo
    expect(r.error).toBeDefined();
    expect(r.error).toContain("Unknown PROFILE");
    expect(r.error).toContain("regulated-multitenant"); // lists valid names
    expect(r.applied).toEqual([]);
  });

  it("trims and ignores a blank PROFILE", () => {
    expect(applyProfile({ PROFILE: "   " }).profile).toBeUndefined();
    expect(applyProfile({ PROFILE: "  regulated " }).profile).toBe("regulated");
  });

  it("ATF_PRESET applies the preset without the deprecated alias", () => {
    const r = applyProfile({ ATF_PRESET: "regulated" });
    expect(r.profile).toBe("regulated");
    expect(r.deprecatedAlias).toBe(false);
    expect(r.env.TAINT_MODE).toBe("on-untrusted-source");
    expect(r.error).toBeUndefined();
  });

  it("PROFILE is the deprecated alias and reports itself as such", () => {
    const r = applyProfile({ PROFILE: "regulated" });
    expect(r.profile).toBe("regulated");
    expect(r.deprecatedAlias).toBe(true);
    expect(r.env.TAINT_MODE).toBe("on-untrusted-source");
  });

  it("both variables set to the same value is fine", () => {
    const r = applyProfile({ ATF_PRESET: "secure", PROFILE: "secure" });
    expect(r.profile).toBe("secure");
    expect(r.deprecatedAlias).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it("both variables set to different values is an error", () => {
    const r = applyProfile({ ATF_PRESET: "regulated", PROFILE: "secure" });
    expect(r.error).toBe(
      'ATF_PRESET="regulated" and PROFILE="secure" disagree; set only ATF_PRESET.',
    );
    expect(r.profile).toBeUndefined();
    expect(r.applied).toEqual([]);
  });

  it("an unknown ATF_PRESET names the new variable", () => {
    const r = applyProfile({ ATF_PRESET: "regulateed" }); // typo
    expect(r.error).toContain("Unknown ATF_PRESET");
    expect(r.error).toContain("Valid presets");
    expect(r.error).toContain("regulated-multitenant");
    expect(r.deprecatedAlias).toBe(false);
  });

  it("every shipped profile only contains keys that are strings", () => {
    for (const name of listProfiles()) {
      const profile = PROFILES[name];
      if (profile === undefined) throw new Error(`expected a profile for "${name}"`);
      for (const [k, v] of Object.entries(profile)) {
        expect(typeof k).toBe("string");
        expect(typeof v).toBe("string");
      }
    }
  });
});
