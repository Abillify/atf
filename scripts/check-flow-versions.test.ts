// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFlowChange, compareSemver, parseFlow } from "./check-flow-versions.ts";

const flow = (version: string | undefined, prompt = "Answer briefly.") =>
  `id: helpdesk\nname: Helpdesk\n${version !== undefined ? `metadata:\n  version: ${version}\n` : ""}nodes:\n  - id: answer\n    type: llm\n    systemPrompt: ${prompt}\nedges: []\n`;

describe("compareSemver", () => {
  test("orders releases and pre-releases", () => {
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("2.0.0", "10.0.0")).toBe(-1);
    expect(compareSemver("v1", "1.0.0")).toBeUndefined();
  });
});

describe("parseFlow", () => {
  test("recognises flows and skips reserved configs and templates", () => {
    expect(parseFlow("flows/helpdesk.yaml", flow("1.0.0"))?.version).toBe("1.0.0");
    expect(parseFlow("flows/compliance-policy.yaml", 'version: "1"\n')).toBeUndefined();
    expect(parseFlow("flows/shadow.yaml", flow("1.0.0"))).toBeUndefined();
    expect(parseFlow("flows/x.example.yaml", flow("1.0.0"))).toBeUndefined();
  });
});

describe("checkFlowChange", () => {
  const doc = (version: string | undefined, prompt?: string) =>
    parseFlow("flows/helpdesk.yaml", flow(version, prompt))!;

  test("a changed definition needs a higher version", () => {
    expect(checkFlowChange({ path: "p", base: doc("1.0.0"), head: doc("1.0.0", "New prompt."), changedIncludes: [] })).toHaveLength(1);
    expect(checkFlowChange({ path: "p", base: doc("1.0.0"), head: doc("0.9.0", "New prompt."), changedIncludes: [] })).toHaveLength(1);
    expect(checkFlowChange({ path: "p", base: doc("1.0.0"), head: doc("1.0.1", "New prompt."), changedIncludes: [] })).toEqual([]);
  });

  test("a pure version bump or no change passes", () => {
    expect(checkFlowChange({ path: "p", base: doc("1.0.0"), head: doc("1.0.0"), changedIncludes: [] })).toEqual([]);
    expect(checkFlowChange({ path: "p", base: doc("1.0.0"), head: doc("1.1.0"), changedIncludes: [] })).toEqual([]);
  });

  test("a changed include needs a higher version", () => {
    const v = checkFlowChange({ path: "p", base: doc("1.0.0"), head: doc("1.0.0"), changedIncludes: ["flows/prompts/answer.md"] });
    expect(v[0]).toContain("included file(s) changed");
  });

  test("new flows need a semantic version", () => {
    expect(checkFlowChange({ path: "p", base: undefined, head: doc(undefined), changedIncludes: [] })).toHaveLength(1);
    expect(checkFlowChange({ path: "p", base: undefined, head: doc("1.0.0"), changedIncludes: [] })).toEqual([]);
  });
});

describe("check-flow-versions CLI", () => {
  let repo: string;
  const script = join(import.meta.dir, "check-flow-versions.ts");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
  const run = () =>
    spawnSync("bun", ["run", script, "--base", "HEAD~1", "flows"], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "flow-versions-"));
    mkdirSync(join(repo, "flows", "prompts"), { recursive: true });
    writeFileSync(join(repo, "flows", "helpdesk.yaml"), flow("1.0.0", "\"#[[file:prompts/answer.md]]\""));
    writeFileSync(join(repo, "flows", "prompts", "answer.md"), "Answer briefly.\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("fails when a prompt include changes without a version bump, passes after the bump", () => {
    writeFileSync(join(repo, "flows", "prompts", "answer.md"), "Answer in German.\n");
    git("commit", "-qam", "prompt only");
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("included file(s) changed");

    git("reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(repo, "flows", "prompts", "answer.md"), "Answer in German.\n");
    writeFileSync(join(repo, "flows", "helpdesk.yaml"), flow("1.1.0", "\"#[[file:prompts/answer.md]]\""));
    git("commit", "-qam", "prompt + bump");
    const passed = run();
    expect(passed.status).toBe(0);
  });
});
