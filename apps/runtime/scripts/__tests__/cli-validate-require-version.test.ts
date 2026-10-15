// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `validate --require-version`: an entry flow must declare a semantic
 * `metadata.version`, because that value is reported as `flow_version` in the
 * debug trace and is how a rollout is verified.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowVersionProblem } from "../cli.js";

describe("flowVersionProblem", () => {
  test("accepts semantic versions and pre-releases", () => {
    expect(flowVersionProblem({ metadata: { version: "1.0.0" } })).toBeUndefined();
    expect(flowVersionProblem({ metadata: { version: "2.3.4-rc.1" } })).toBeUndefined();
  });

  test("rejects a missing, non-semver or non-string version", () => {
    expect(flowVersionProblem({ id: "x" })).toContain("required");
    expect(flowVersionProblem({ metadata: {} })).toContain("required");
    expect(flowVersionProblem({ metadata: { version: "1.0" } })).toContain("x.y.z");
    expect(flowVersionProblem({ metadata: { version: 1.5 } })).toContain("x.y.z");
    expect(flowVersionProblem(null)).toContain("required");
  });
});

describe("validate --require-version (CLI)", () => {
  let dir: string;
  const cli = join(import.meta.dir, "..", "cli.ts");
  const flow = (metadata: string) =>
    `id: demo\nname: Demo\n${metadata}nodes:\n  - id: a\n    type: llm\n    llm: { provider: openai, model: gpt-4o }\nedges: []\n`;
  const run = (file: string, ...flags: string[]) =>
    Bun.spawnSync(["bun", "run", cli, "validate", file, ...flags], { stdout: "pipe", stderr: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-require-version-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("fails without a version only when the flag is set", () => {
    const file = join(dir, "demo.yaml");
    writeFileSync(file, flow(""));
    expect(run(file).exitCode).toBe(0);
    const strict = run(file, "--require-version");
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout.toString()).toContain("metadata.version");
  });

  test("passes with a semantic version", () => {
    const file = join(dir, "demo.yaml");
    writeFileSync(file, flow("metadata:\n  version: 1.2.3\n"));
    expect(run(file, "--require-version").exitCode).toBe(0);
  });
});
