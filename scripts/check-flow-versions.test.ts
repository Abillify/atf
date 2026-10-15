// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bumpWarnings,
  checkFlowChange,
  compareSemver,
  graphShape,
  isCi,
  parseFlow,
  resolveFlowDependencies,
} from "./check-flow-versions.ts";

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
    parseFlow("flows/helpdesk.yaml", flow(version, prompt)) as NonNullable<ReturnType<typeof parseFlow>>;

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
    expect(v[0]).toContain("dependent file(s) changed");
  });

  test("new flows need a semantic version", () => {
    expect(checkFlowChange({ path: "p", base: undefined, head: doc(undefined), changedIncludes: [] })).toHaveLength(1);
    expect(checkFlowChange({ path: "p", base: undefined, head: doc("1.0.0"), changedIncludes: [] })).toEqual([]);
  });
});

describe("resolveFlowDependencies", () => {
  const files: Record<string, string> = {
    "subflows/guard.yaml":
      "metadata:\n  $include:\n    subflows: [subflows/inner.yaml]\nnodes:\n  - id: g\n    type: llm\n    llm: { shortcut: fast }\n    systemPrompt: \"#[[file:prompts/guard.md]]\"\n",
    "subflows/inner.yaml": "nodes:\n  - id: i\n    type: tool\n",
    "prompts/guard.md": "Guard. #[[file:prompts/shared.md]]\n",
    "prompts/shared.md": "Shared.\n",
  };
  const read = (rel: string) => files[rel];
  const entry = (extra: string) =>
    `id: main\nname: Main\nmetadata:\n  version: 1.0.0\n  $include:\n    subflows: [subflows/guard.yaml]\nnodes:\n  - id: a\n    type: llm\n${extra}edges: []\n`;
  const flowFiles = ["main.yaml", "model-shortcuts.yaml", "guardrails.yaml", "dispatch.yaml", "tool-authz.yaml", "access.yaml"];

  test("follows sub-flows, nested sub-flows and nested prompts transitively", () => {
    const deps = resolveFlowDependencies("main.yaml", entry(""), read, flowFiles);
    expect([...deps]).toEqual(
      expect.arrayContaining([
        "subflows/guard.yaml",
        "subflows/inner.yaml",
        "prompts/guard.md",
        "prompts/shared.md",
      ]),
    );
  });

  test("a shortcut anywhere (also in a sub-flow) adds model-shortcuts; shared config is always a dependency", () => {
    const deps = resolveFlowDependencies("main.yaml", entry(""), read, flowFiles);
    expect(deps.has("model-shortcuts.yaml")).toBe(true);
    for (const shared of ["guardrails.yaml", "dispatch.yaml", "tool-authz.yaml"]) expect(deps.has(shared)).toBe(true);
    expect(deps.has("access.yaml")).toBe(false);
  });

  test("a flow without shortcuts does not depend on model-shortcuts", () => {
    const plain = "id: p\nname: P\nnodes:\n  - id: a\n    type: llm\n    llm: { provider: openai, model: m }\nedges: []\n";
    const deps = resolveFlowDependencies("p.yaml", plain, read, flowFiles);
    expect(deps.has("model-shortcuts.yaml")).toBe(false);
    expect(deps.has("guardrails.yaml")).toBe(true);
  });

  test("prompt includes inside overrides are found; tolerates missing files and cycles", () => {
    const text =
      "id: o\nname: O\nnodes:\n  - id: a\n    type: llm\n    overrides:\n      - whenClass: X\n        systemPrompt: \"#[[file:prompts/loop.md]]\"\nedges: []\n";
    const loop = (rel: string) => (rel === "prompts/loop.md" ? "#[[file:prompts/loop.md]] #[[file:prompts/gone.md]]" : undefined);
    const deps = resolveFlowDependencies("o.yaml", text, loop, []);
    expect([...deps].sort()).toEqual(["prompts/gone.md", "prompts/loop.md"]);
  });
});

describe("graphShape and bumpWarnings", () => {
  test("graph shape ignores prompt text but sees node and edge changes", () => {
    expect(graphShape(flow("1.0.0", "A"), "f.yaml")).toBe(graphShape(flow("1.0.0", "B"), "f.yaml"));
    expect(graphShape(flow("1.0.0"), "f.yaml")).not.toBe(graphShape(flow("1.0.0").replace("id: answer", "id: other"), "f.yaml"));
  });

  test("a graph change with only a patch bump warns; a minor bump does not", () => {
    const doc = (v: string) => parseFlow("flows/helpdesk.yaml", flow(v)) as NonNullable<ReturnType<typeof parseFlow>>;
    const change = (head: string) => ({ path: "p", base: doc("1.0.0"), head: doc(head), changedIncludes: [], graphChanged: true });
    expect(bumpWarnings(change("1.0.1"))).toHaveLength(1);
    expect(bumpWarnings(change("1.1.0"))).toEqual([]);
    expect(bumpWarnings(change("2.0.0"))).toEqual([]);
    expect(bumpWarnings({ ...change("1.0.1"), graphChanged: false })).toEqual([]);
  });
});

describe("isCi", () => {
  test("recognises CI runners", () => {
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCi({})).toBe(false);
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
    expect(failed.stderr).toContain("dependent file(s) changed");

    git("reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(repo, "flows", "prompts", "answer.md"), "Answer in German.\n");
    writeFileSync(join(repo, "flows", "helpdesk.yaml"), flow("1.1.0", "\"#[[file:prompts/answer.md]]\""));
    git("commit", "-qam", "prompt + bump");
    const passed = run();
    expect(passed.status).toBe(0);
  });

  const runWith = (env: Record<string, string>, ...args: string[]) =>
    spawnSync("bun", ["run", script, ...args, "flows"], {
      cwd: repo,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });

  test("fails closed in CI without a base, passes locally, and honours --allow-missing-base", () => {
    const ci = runWith({ CI: "true" });
    expect(ci.status).toBe(1);
    expect(ci.stderr).toContain("Failing because this is CI");
    const zero = runWith({ CI: "true", FLOW_VERSION_BASE: "0000000000000000000000000000000000000000" });
    expect(zero.status).toBe(1);
    const unknown = runWith({ CI: "true" }, "--base", "does-not-exist");
    expect(unknown.status).toBe(1);
    expect(runWith({}).status).toBe(0);
    expect(runWith({ CI: "true" }, "--allow-missing-base").status).toBe(0);
  });

  test("a prompt reached through a sub-flow (transitive) requires a bump of the entry flow", () => {
    mkdirSync(join(repo, "flows", "subflows"), { recursive: true });
    writeFileSync(join(repo, "flows", "prompts", "deep.md"), "Deep.\n");
    writeFileSync(
      join(repo, "flows", "subflows", "guard.yaml"),
      "nodes:\n  - id: guard\n    type: llm\n    systemPrompt: \"#[[file:prompts/deep.md]]\"\nedges: []\n",
    );
    // Entry flow that includes the sub-flow via metadata.$include.
    writeFileSync(
      join(repo, "flows", "helpdesk.yaml"),
      "id: helpdesk\nname: Helpdesk\nmetadata:\n  version: 1.0.0\n  $include:\n    subflows: [subflows/guard.yaml]\nnodes:\n  - id: answer\n    type: llm\n    systemPrompt: \"#[[file:prompts/answer.md]]\"\nedges: []\n",
    );
    git("add", ".");
    git("commit", "-qm", "base with subflow");
    writeFileSync(join(repo, "flows", "prompts", "deep.md"), "Deeper.\n");
    git("commit", "-qam", "deep prompt only");
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("prompts/deep.md");
  });

  test("a model-shortcuts change requires a bump of flows that use a shortcut", () => {
    writeFileSync(join(repo, "flows", "model-shortcuts.yaml"), "shortcuts:\n  fast: { engine: e, model: m }\n");
    writeFileSync(
      join(repo, "flows", "helpdesk.yaml"),
      "id: helpdesk\nname: Helpdesk\nmetadata:\n  version: 1.0.0\nnodes:\n  - id: answer\n    type: llm\n    llm: { shortcut: fast }\nedges: []\n",
    );
    git("add", ".");
    git("commit", "-qm", "base with shortcut");
    writeFileSync(join(repo, "flows", "model-shortcuts.yaml"), "shortcuts:\n  fast: { engine: e, model: other }\n");
    git("commit", "-qam", "shortcut change");
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("model-shortcuts.yaml");
  });
});
