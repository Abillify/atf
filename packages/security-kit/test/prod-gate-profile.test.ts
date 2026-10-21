// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the shared operational-profile resolution.
 *
 * The property that matters most: a profile can never be silently lost. An
 * env var that names a real profile resolves to it; an env var that names
 * nothing recognizable aborts startup loudly. The old failure mode — a typo
 * like APP_ENV=prod falling back to development and switching every
 * production gate off — is exactly what these tests pin closed.
 */

import { describe, expect, test } from "bun:test";
import {
  OPERATIONAL_PROFILES,
  OPERATIONAL_PROFILE_ENV_VAR,
  UnknownOperationalProfileError,
  normalizeOperationalProfile,
  profileShadowWarning,
  resolveOperationalProfile,
} from "../src/index.ts";

describe("normalizeOperationalProfile", () => {
  test("normalizes case and surrounding whitespace", () => {
    expect(normalizeOperationalProfile("NODE_ENV", "  Production ")).toBe(
      "production",
    );
    expect(normalizeOperationalProfile("NODE_ENV", "DEVELOPMENT")).toBe(
      "development",
    );
  });

  test("accepts every member of the closed value set", () => {
    for (const profile of OPERATIONAL_PROFILES) {
      expect(normalizeOperationalProfile("ATF_PROFILE", profile)).toBe(profile);
    }
  });

  test("rejects a value outside the closed set", () => {
    expect(() => normalizeOperationalProfile("APP_ENV", "prod")).toThrow(
      UnknownOperationalProfileError,
    );
    try {
      normalizeOperationalProfile("APP_ENV", "prod");
      expect.unreachable();
    } catch (err) {
      const e = err as UnknownOperationalProfileError;
      expect(e.variable).toBe("APP_ENV");
      expect(e.value).toBe("prod");
      expect(e.message).toContain("APP_ENV");
      expect(e.message).toContain("prod");
      // The message must name the legal values so the operator can fix it
      // without reading source.
      for (const profile of OPERATIONAL_PROFILES) {
        expect(e.message).toContain(profile);
      }
    }
  });
});

describe("resolveOperationalProfile", () => {
  test("defaults to development when nothing is set", () => {
    const r = resolveOperationalProfile({}, ["APP_ENV"]);
    expect(r.profile).toBe("development");
    expect(r.isProduction).toBe(false);
    expect(r.source).toBeUndefined();
  });

  test("treats blank values as unset", () => {
    const r = resolveOperationalProfile({ APP_ENV: "   " }, ["APP_ENV"]);
    expect(r.profile).toBe("development");
    expect(r.source).toBeUndefined();
  });

  test("resolves the first service variable that is set", () => {
    const r = resolveOperationalProfile(
      { MCPGATE_ENV: "staging", NODE_ENV: "production" },
      ["MCPGATE_ENV", "NODE_ENV"],
    );
    expect(r.profile).toBe("staging");
    expect(r.source).toBe("MCPGATE_ENV");
  });

  test("ATF_PROFILE overrides every service variable", () => {
    const r = resolveOperationalProfile(
      {
        ATF_PROFILE: "production",
        APP_ENV: "development",
        MCPGATE_ENV: "development",
        NODE_ENV: "development",
      },
      ["APP_ENV", "MCPGATE_ENV", "NODE_ENV"],
    );
    expect(r.profile).toBe("production");
    expect(r.isProduction).toBe(true);
    expect(r.source).toBe(OPERATIONAL_PROFILE_ENV_VAR);
  });

  test("isProduction is true only for production", () => {
    for (const profile of OPERATIONAL_PROFILES) {
      const r = resolveOperationalProfile({ ATF_PROFILE: profile });
      expect(r.profile).toBe(profile);
      expect(r.isProduction).toBe(profile === "production");
    }
  });

  test("a blank ATF_PROFILE falls through to the service variables", () => {
    const r = resolveOperationalProfile(
      { ATF_PROFILE: "", NODE_ENV: "production" },
      ["NODE_ENV"],
    );
    expect(r.profile).toBe("production");
    expect(r.source).toBe("NODE_ENV");
  });

  test("an unknown value fails fast instead of silently disabling gates", () => {
    expect(() => resolveOperationalProfile({ APP_ENV: "prod" }, ["APP_ENV"])).toThrow(
      UnknownOperationalProfileError,
    );
    expect(() =>
      resolveOperationalProfile({ ATF_PROFILE: "PRODUCTIVE" }, ["APP_ENV"]),
    ).toThrow(UnknownOperationalProfileError);
    // Even a typo in a lower-priority variable is fatal once a higher one is
    // unset — this is the bug class the profile closes.
    expect(() =>
      resolveOperationalProfile({ ATF_PROFILE: "", MCPGATE_ENV: "prodction" }, [
        "MCPGATE_ENV",
      ]),
    ).toThrow(UnknownOperationalProfileError);
  });

  test("normalizes service variable values", () => {
    const r = resolveOperationalProfile(
      { NODE_ENV: "  PRODUCTION " },
      ["NODE_ENV"],
    );
    expect(r.profile).toBe("production");
    expect(r.isProduction).toBe(true);
  });
});

describe("shadowed production", () => {
  test("ATF_PROFILE=staging over NODE_ENV=production is reported", () => {
    const r = resolveOperationalProfile(
      { ATF_PROFILE: "staging", NODE_ENV: "production" },
      ["NODE_ENV"],
    );
    expect(r.profile).toBe("staging");
    expect(r.shadowedProduction).toBe("NODE_ENV");
    expect(profileShadowWarning(r)).toBe(
      "NODE_ENV=production is overridden by ATF_PROFILE=staging; production checks are not enforced.",
    );
  });

  test("a service variable can shadow a lower one as well", () => {
    const r = resolveOperationalProfile(
      { MCPGATE_ENV: "development", NODE_ENV: " Production " },
      ["MCPGATE_ENV", "NODE_ENV"],
    );
    expect(r.shadowedProduction).toBe("NODE_ENV");
    expect(profileShadowWarning(r)).toContain("MCPGATE_ENV=development");
  });

  test("nothing is reported when production wins or nothing says production", () => {
    const production = resolveOperationalProfile(
      { ATF_PROFILE: "production", NODE_ENV: "development" },
      ["NODE_ENV"],
    );
    expect(production.shadowedProduction).toBeUndefined();
    expect(profileShadowWarning(production)).toBeUndefined();
    const staging = resolveOperationalProfile({ ATF_PROFILE: "staging" }, ["NODE_ENV"]);
    expect(profileShadowWarning(staging)).toBeUndefined();
  });

  test("a higher-precedence variable that says production is never shadowed", () => {
    const r = resolveOperationalProfile(
      { NODE_ENV: "development", ATF_PROFILE: "production" },
      ["NODE_ENV"],
    );
    expect(r.isProduction).toBe(true);
    expect(r.shadowedProduction).toBeUndefined();
  });
});
