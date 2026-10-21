// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `validate` must name WHY a flow is rejected. It used to print only
 * "Schema validation failed" and drop the per-field causes the loader logs, so
 * a CI failure could not be fixed without starting the runtime.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowIssues } from "../cli.js";

describe("flowIssues", () => {
  test("lists every offending field of a schema failure", () => {
    const issues = flowIssues("Schema validation failed", {
      formErrors: [],
      fieldErrors: { name: ["Invalid input: expected string"], edges: ["Required"] },
    });
    expect(issues[0]).toEqual({ path: "$", message: "Schema validation failed" });
    expect(issues).toContainEqual({ path: "name", message: "Invalid input: expected string" });
    expect(issues).toContainEqual({ path: "edges", message: "Required" });
  });

  test("keeps non-schema details instead of dropping them", () => {
    const issues = flowIssues('Duplicate node ID found: "a"', { duplicateNodeId: "a" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("duplicateNodeId");
  });

  test("a reason without details stays a single line", () => {
    expect(flowIssues("Something", undefined)).toEqual([{ path: "$", message: "Something" }]);
  });
});

describe("validate (CLI) reports the cause", () => {
  let dir: string;
  const cli = join(import.meta.dir, "..", "cli.ts");
  const run = (file: string) =>
    Bun.spawnSync(["bun", "run", cli, "validate", file], { stdout: "pipe", stderr: "pipe" });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-validate-cause-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a schema failure names the field", () => {
    const file = join(dir, "bad.yaml");
    writeFileSync(file, "id: bad\nnodes:\n  - id: a\n    type: llm\n");
    const result = run(file);
    expect(result.exitCode).toBe(1);
    const out = result.stdout.toString();
    expect(out).toContain("Schema validation failed");
    expect(out).toContain("[edges]");
    expect(out).toContain("[name]");
  });

  test("an unresolvable variable is reported for the file, not as a crash", () => {
    const file = join(dir, "vars.yaml");
    writeFileSync(
      file,
      "id: vars\nname: Vars\nnodes:\n  - id: a\n    type: llm\n    systemPrompt: \"{{const.missing}}\"\nedges: []\nvariables:\n  limit: \"{{const.missing}}\"\n",
    );
    const result = run(file);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("missing");
  });

  test("an unknown config key is a warning, not an error", () => {
    const file = join(dir, "typo.yaml");
    writeFileSync(
      file,
      "id: typo\nname: Typo\nnodes:\n  - id: a\n    type: llm\n    config:\n      toolArgz: {}\nedges: []\n",
    );
    const result = run(file);
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain("WARN");
    expect(out).toContain("nodes[0](a).config.toolArgz");
    expect(out).toContain('Did you mean "toolArgs"');
  });
});
