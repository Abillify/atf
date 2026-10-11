// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 1 (round trip through the file format) and Property 2 (environment
 * precedence, `_FILE` secrets) for the configuration loader.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import YAML from "yaml";
import { loadConfig, serializeConfig } from "../../src/config/load.js";
import { validateConfig } from "../../src/config/validate.js";
import { ENV_MAP } from "../../src/config/merge.js";
import { resolveSecretEnv } from "../../src/config/secrets-file.js";
import { configInputArb, envValueArb } from "../fakes/config-arb.js";

// Feature: extract-outpost, Property 1: Konfigurations-Round-Trip
// **Validates: Requirements 1.1**
describe("Property 1: configuration round trip", () => {
  it("validate → serialize → parse → validate is the identity", async () => {
    await fc.assert(
      fc.asyncProperty(configInputArb, async (input) => {
        const first = validateConfig(input);
        if (!first.ok) {
          // Generated inputs are schema-shaped, not guaranteed valid; a
          // rejected input says nothing about the round trip.
          return;
        }
        const text = serializeConfig(first.value);
        const reparsed = YAML.parse(text);
        const second = validateConfig(reparsed);
        expect(second.ok).toBe(true);
        if (second.ok) {
          expect(second.value).toEqual(first.value);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: extract-outpost, Property 2: precedence of environment variables and _FILE secrets
// **Validates: Requirements 1.2, 12.7**
describe("Property 2: environment precedence and _FILE secrets", () => {
  function getPath(obj: unknown, path: readonly string[]): unknown {
    let current: unknown = obj;
    for (const key of path) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  it("a set OUTPOST_* key wins over the file value, per key", async () => {
    // The file always carries an oidc block: an env override of a single oidc
    // sub-key must not turn the merged config invalid (missing clientId),
    // which would test validation rather than precedence.
    const fileCfgArb = configInputArb.map((input) => ({
      ...input,
      oidc: input.oidc ?? {
        issuer: "https://idp.example.com",
        clientId: "outpost",
        scopes: [],
      },
    }));
    // Assignments are generated as (entry, value) pairs so shrinking works
    // and a failure reproduces from the seed alone.
    const envAssignmentArb = fc.oneof(
      ...ENV_MAP.map((entry, index) => envValueArb(entry).map((value) => ({ index, value }))),
    );

    await fc.assert(
      fc.asyncProperty(
        fileCfgArb,
        fc.array(envAssignmentArb, { maxLength: ENV_MAP.length }),
        async (input, assignments) => {
          const fileResult = validateConfig(input);
          if (!fileResult.ok) return;
          const fileCfg = fileResult.value;

          const env: Record<string, string> = {};
          const expected = new Map<string, { path: readonly string[]; value: unknown }>();
          for (const { index, value } of assignments) {
            const entry = ENV_MAP[index];
            if (entry === undefined) continue;
            env[entry.name] = value;
            expected.set(entry.name, { path: entry.path, value: entry.parse(value) });
          }

          const text = serializeConfig(fileCfg);
          const loaded = await loadConfig("config.yaml", env, {
            readFile: async () => text,
          });
          expect(loaded.ok).toBe(true);
          if (!loaded.ok) return;

          for (const { path, value } of expected.values()) {
            expect(getPath(loaded.value, path)).toEqual(value);
          }
          // Keys the environment left unset keep the file value.
          for (const entry of ENV_MAP) {
            if (env[entry.name] !== undefined) continue;
            expect(getPath(loaded.value, entry.path)).toEqual(getPath(fileCfg, entry.path));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("X_FILE resolves to the file content without its trailing newline", async () => {
    const secretNameArb = fc.constantFrom(
      "OUTPOST_API_TOKEN",
      "OUTPOST_CLIENT_SECRET",
      "OUTPOST_SOURCE_A_S3_SECRET_KEY",
    );
    await fc.assert(
      fc.asyncProperty(
        secretNameArb,
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.constantFrom("", "\n", "\r\n"),
        fc.boolean(),
        async (name, content, trailing, alsoPlain) => {
          const env: Record<string, string> = {
            [`${name}_FILE`]: `/run/secrets/${name.toLowerCase()}`,
          };
          if (alsoPlain) env[name] = "plain-value-that-must-lose";
          const warnings: string[] = [];
          const resolved = await resolveSecretEnv(env, async () => content + trailing, (m) => {
            warnings.push(m);
          });
          // Exactly one trailing line break is stripped.ace(/\r?\n$/, ""));
          if (alsoPlain) {
            expect(warnings.length).toBeGreaterThan(0);
          }
          // The resolved secret is offered to the redactor.
          expect(resolved.secretValues).toContain(resolved.env[name]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
