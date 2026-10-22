// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `validate` and bench files: `<FLOWS_DIR>/bench/<flowId>.bench.yaml`
 * files are release-gate definitions, not flows. Validating the flows
 * directory — or the bench directory itself — must skip them instead of
 * failing them as invalid flow definitions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "cli.ts");
const run = (...args: string[]) =>
  Bun.spawnSync(["bun", "run", cli, "validate", ...args], { stdout: "pipe", stderr: "pipe" });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-validate-bench-"));
  // findFlowsDir() anchors on model-shortcuts.* — without it the bench
  // directory is not recognised as living below the flows root.
  writeFileSync(join(dir, "model-shortcuts.yaml"), "shortcuts: {}\n");
  mkdirSync(join(dir, "bench"));
  writeFileSync(
    join(dir, "bench", "demo.bench.yaml"),
    "version: 1\nflow: demo\ncases:\n  - id: greeting\n    messages:\n      - role: user\n        content: Hallo\nthresholds:\n  passRate: 0.9\n",
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("validate with bench files", () => {
  test("a bench file validated directly is skipped, not failed", () => {
    const result = run(join(dir, "bench", "demo.bench.yaml"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("skipped");
    expect(result.stdout.toString()).toContain("bench file");
  });

  test("validating the flows directory skips the bench directory", () => {
    writeFileSync(
      join(dir, "demo.yaml"),
      "id: demo\nname: Demo\nnodes:\n  - id: a\n    type: llm\n    llm: { provider: openai, model: gpt-4o }\nedges: []\n",
    );
    const result = run(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("demo");
    expect(result.stdout.toString()).not.toContain("demo.bench");
  });

  test("validating the bench directory itself reports the bench hint", () => {
    const result = run(join(dir, "bench"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("bench");
    expect(result.stdout.toString()).not.toContain("No YAML/JSON flow files found");
  });
});
