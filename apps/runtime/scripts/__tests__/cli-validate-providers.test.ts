// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `registerProvidersFromEnv` — offline provider registration for the CLI
 * `validate` command.
 *
 * The validator runs without `loadConfig()`, so `llm.provider` references only
 * resolve if the command publishes the deployment's `PROVIDERS` into the same
 * module-level registry the schema consults. These tests pin the three states
 * that matter: a valid array registers the names, malformed input is ignored
 * without throwing (so validation still runs, just without name resolution),
 * and an unset variable preserves the legacy protocol-only behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredProviderNames,
  isKnownProviderName,
  setProviderRegistry,
} from "../../src/config/providers.js";
import { registerProvidersFromEnv } from "../cli.js";

const ORIGINAL_PROVIDERS = process.env.PROVIDERS;

afterEach(() => {
  // Reset both the shared registry and the env var so tests do not leak state.
  setProviderRegistry(undefined);
  if (ORIGINAL_PROVIDERS === undefined) {
    delete process.env.PROVIDERS;
  } else {
    process.env.PROVIDERS = ORIGINAL_PROVIDERS;
  }
});

describe("registerProvidersFromEnv", () => {
  test("registers a named instance from a valid PROVIDERS array", () => {
    process.env.PROVIDERS = JSON.stringify([
      { name: "gpuvllm", protocol: "openai", url: "http://vllm:8000/v1", local: true },
    ]);

    registerProvidersFromEnv();

    expect(isKnownProviderName("gpuvllm")).toBe(true);
    expect(configuredProviderNames()).toContain("gpuvllm");
  });

  test("registers several instances sharing one protocol", () => {
    process.env.PROVIDERS = JSON.stringify([
      { name: "vllm-a", protocol: "openai", url: "http://vllm-a:8000/v1" },
      { name: "vllm-b", protocol: "openai", url: "http://vllm-b:8000/v1" },
    ]);

    registerProvidersFromEnv();

    expect(isKnownProviderName("vllm-a")).toBe(true);
    expect(isKnownProviderName("vllm-b")).toBe(true);
  });

  test("leaves the registry empty when PROVIDERS is unset", () => {
    delete process.env.PROVIDERS;

    registerProvidersFromEnv();

    expect(configuredProviderNames()).toEqual([]);
    // Built-in wire protocols still resolve without any configured instances.
    expect(isKnownProviderName("openai")).toBe(true);
    // An unregistered named instance stays unknown.
    expect(isKnownProviderName("gpuvllm")).toBe(false);
  });

  test("ignores malformed JSON without throwing", () => {
    process.env.PROVIDERS = "{not valid json";

    expect(() => registerProvidersFromEnv()).not.toThrow();
    expect(configuredProviderNames()).toEqual([]);
  });

  test("ignores a schema-invalid PROVIDERS value without throwing", () => {
    // Missing the required `protocol` field.
    process.env.PROVIDERS = JSON.stringify([{ name: "gpuvllm" }]);

    expect(() => registerProvidersFromEnv()).not.toThrow();
    expect(configuredProviderNames()).toEqual([]);
    expect(isKnownProviderName("gpuvllm")).toBe(false);
  });
});

const PROVIDERS_JSON = JSON.stringify([
  { name: "llm1", protocol: "openai", url: "http://192.0.2.10/v1", local: true },
]);

const llmFlow = (id: string) =>
  `id: ${id}\nname: ${id}\nnodes:\n  - id: answer\n    type: llm\n    llm:\n      provider: llm1\n      model: gpt-4o-mini\nedges: []\n`;

describe("validate (CLI) and the PROVIDERS environment", () => {
  const cli = join(import.meta.dir, "..", "cli.ts");
  const run = (target: string, providers?: string) =>
    Bun.spawnSync(["bun", "run", cli, "validate", target], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PROVIDERS: providers ?? "" },
    });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-validate-providers-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("names the node and field of an unknown provider", () => {
    const file = join(dir, "one.yaml");
    writeFileSync(file, llmFlow("one"));

    const result = run(file);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("[nodes[0](answer).llm.provider]");
  });

  test("hints at the missing PROVIDERS exactly once for several files", () => {
    writeFileSync(join(dir, "one.yaml"), llmFlow("one"));
    writeFileSync(join(dir, "two.yaml"), llmFlow("two"));

    const result = run(dir);

    const out = result.stdout.toString();
    expect(out.match(/PROVIDERS is not set, so only built-in protocols resolve\./g)).toHaveLength(1);
    expect(out).toContain("2 invalid");
  });

  test("a configured provider validates and produces no hint", () => {
    const file = join(dir, "one.yaml");
    writeFileSync(file, llmFlow("one"));

    const result = run(file, PROVIDERS_JSON);

    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain("1 valid");
    expect(out).not.toContain("PROVIDERS is not set");
  });
});
