// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Source-form round trip for file flows: the editor gets (and saves back) the
 * AUTHORING form — `llm.shortcut`, `{{vars.*}}` and `#[[file:…]]` prompt
 * includes kept as references — while the runtime still runs the expanded
 * definition. Saving must never bake the expansion into the files.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import { createFlowsRouter } from "../flows.js";
import {
  createFlowParserService,
  materializeFlowSource,
  type FlowParserService,
} from "../../graph/flow-parser.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import { createStudioTestRegistry } from "../../graph/flow-registry-studio.js";
import type { FlowStore } from "../../graph/flow-store.js";
import type { FlowDefinition } from "../../types/flow.js";

const SHORTCUTS = `engines:
  local: { provider: openai }
modelPresets:
  small: { model: example/small, parameters: { maxTokens: 256 } }
shortcuts:
  local-small: { engine: local, model: small }
`;

const PARENT = `id: parent
name: Parent
# why this flow exists — must survive a save
variables:
  model_main: local-small
nodes:
  - id: router
    type: router
  - id: answer
    type: llm
    label: Answer
    # answer node comment
    llm:
      shortcut: "{{vars.model_main}}"
    systemPrompt: "#[[file:prompts/answer.md]]"
edges:
  - source: router
    target: answer
metadata:
  $include:
    subflows:
      - subflows/sub.yaml
`;

const SUB = `# sub-flow header comment
nodes:
  - id: helper
    type: llm
    llm:
      shortcut: local-small
edges:
  - source: answer
    target: helper
`;

/** Narrows away `undefined` with a readable failure instead of a `!`. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}`);
  return value;
}

let dir: string;
let parser: FlowParserService;

function buildApp() {
  const a = new Hono();
  a.route(
    "/",
    createFlowsRouter({
      fileRegistry: parser.getRegistry(),
      operatorAuth: createOperatorAuthorizer({ authRequired: false }),
      authRequired: false,
      flowsDir: dir,
    }),
  );
  return a;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flows-source-"));
  fs.mkdirSync(path.join(dir, "prompts"));
  fs.mkdirSync(path.join(dir, "subflows"));
  fs.writeFileSync(path.join(dir, "model-shortcuts.yaml"), SHORTCUTS);
  fs.writeFileSync(path.join(dir, "constants.yaml"), "constants:\n  budget: 300\n");
  fs.writeFileSync(path.join(dir, "prompts", "answer.md"), "You answer briefly.");
  fs.writeFileSync(path.join(dir, "subflows", "sub.yaml"), SUB);
  fs.writeFileSync(path.join(dir, "parent.yaml"), PARENT);
  parser = createFlowParserService(dir);
  await parser.start();
});

afterEach(async () => {
  await parser.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("file flow source form", () => {
  test("registry keeps the authoring form next to the expanded runtime form", () => {
    const reg = parser.getRegistry();
    const runtime = reg.get("parent");
    const source = reg.getSource?.("parent");
    expect(runtime?.nodes.find((n) => n.id === "answer")?.llm?.provider).toBe("openai");
    expect(runtime?.nodes.find((n) => n.id === "answer")?.systemPrompt).toBe(
      "You answer briefly.",
    );

    const srcNodes = source?.definition.nodes as Array<Record<string, unknown>>;
    const answer = must(srcNodes.find((n) => n.id === "answer"), "answer node");
    expect(answer.llm).toEqual({ shortcut: "{{vars.model_main}}" });
    expect(answer.systemPrompt).toBe("#[[file:prompts/answer.md]]");
    // sub-flow nodes are merged in (tagged) so the editor sees the whole graph
    expect(srcNodes.map((n) => n.id)).toEqual(["router", "answer", "helper"]);
    expect(source?.fileName).toBe("parent.yaml");

    const materialized = materializeFlowSource(must(source, "source").definition, dir);
    expect(materialized.success && materialized.data).toEqual(must(runtime, "runtime flow"));
  });

  test("GET /flows/:id serves the source form, its file and a hash", async () => {
    const res = await buildApp().request("/flows/parent");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.file).toEqual({ name: "parent.yaml", format: "yaml" });
    expect(typeof body.hash).toBe("string");
    const nodes = (body.sourceDefinition as { nodes: Array<Record<string, unknown>> }).nodes;
    expect(nodes.find((n) => n.id === "answer")?.llm).toEqual({
      shortcut: "{{vars.model_main}}",
    });
  });

  test("POST /flows/validate accepts the source form (shortcuts are expanded for checking)", async () => {
    const source = must(parser.getRegistry().getSource?.("parent"), "source").definition;
    const res = await buildApp().request("/flows/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(source),
    });
    const report = (await res.json()) as { valid: boolean; errors: unknown[] };
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  test("writing the source form keeps shortcuts, variables, prompt includes and comments", async () => {
    const source = structuredClone(
      must(parser.getRegistry().getSource?.("parent"), "source").definition,
    ) as { nodes: Array<Record<string, unknown>> };
    must(source.nodes.find((n) => n.id === "answer"), "answer node").label = "Answer (edited)";

    const res = await buildApp().request("/flows/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The editor asks for json, but the flow lives in parent.yaml: it must be
      // written back there, not into a second parent.json with the same id.
      body: JSON.stringify({ id: "parent", format: "json", definition: source }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(dir, "parent.json"))).toBe(false);

    const parentText = fs.readFileSync(path.join(dir, "parent.yaml"), "utf-8");
    expect(parentText).toContain("# why this flow exists — must survive a save");
    expect(parentText).toContain("# answer node comment");
    expect(parentText).toContain("Answer (edited)");
    const parent = parseYaml(parentText) as {
      nodes: Array<Record<string, unknown>>;
      metadata: Record<string, unknown>;
    };
    const answer = must(parent.nodes.find((n) => n.id === "answer"), "answer node");
    expect(answer.llm).toEqual({ shortcut: "{{vars.model_main}}" });
    expect(answer.systemPrompt).toBe("#[[file:prompts/answer.md]]");
    expect(parent.nodes.map((n) => n.id)).toEqual(["router", "answer"]);
    expect(parent.metadata.$include).toEqual({ subflows: ["subflows/sub.yaml"] });
    expect(parent.metadata.$includeOrigins).toBeUndefined();

    const subText = fs.readFileSync(path.join(dir, "subflows", "sub.yaml"), "utf-8");
    expect(subText).toContain("# sub-flow header comment");
    const sub = parseYaml(subText) as { nodes: Array<Record<string, unknown>> };
    expect(sub.nodes[0]?.llm).toEqual({ shortcut: "local-small" });
  });

  test("GET /flows advertises file writing only for a writable FLOWS_DIR", async () => {
    const res = await buildApp().request("/flows");
    expect(((await res.json()) as { fileWriting: boolean }).fileWriting).toBe(true);

    fs.chmodSync(dir, 0o555);
    try {
      const ro = await buildApp().request("/flows");
      expect(((await ro.json()) as { fileWriting: boolean }).fileWriting).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  test("POST /flows/:id/test-run registers the expanded canvas under a throwaway model", async () => {
    const studioTests = createStudioTestRegistry(parser.getRegistry());
    const app = new Hono();
    app.route(
      "/",
      createFlowsRouter({
        fileRegistry: parser.getRegistry(),
        operatorAuth: createOperatorAuthorizer({ authRequired: false }),
        authRequired: false,
        sourceDir: dir,
        studioTests,
      }),
    );
    const source = structuredClone(
      must(parser.getRegistry().getSource?.("parent"), "source").definition,
    ) as { nodes: Array<Record<string, unknown>> };
    must(source.nodes.find((n) => n.id === "answer"), "answer").label = "Unsaved edit";

    const res = await app.request("/flows/parent/test-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(source),
    });
    expect(res.status).toBe(200);
    const { model } = (await res.json()) as { model: string };
    const registered = must(studioTests.get(model), "registered flow");
    const answer = must(registered.nodes.find((n) => n.id === "answer"), "answer");
    expect(answer.label).toBe("Unsaved edit");
    expect(answer.llm?.provider).toBe("openai"); // shortcut expanded for the run
    expect(answer.systemPrompt).toBe("You answer briefly.");
    // the live flow is untouched
    expect(parser.getRegistry().get("parent")?.nodes.find((n) => n.id === "answer")?.label).toBe("Answer");

    const bad = await app.request("/flows/parent/test-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...source, nodes: [{ id: "x", type: "llm", llm: { shortcut: "nope" } }] }),
    });
    expect(bad.status).toBe(400);
  });

  test("GET /flows/subflows lists sub-flow files with their nodes and users", async () => {
    const body = (await (await buildApp().request("/flows/subflows")).json()) as {
      subflows: Array<{ path: string; nodeIds: string[]; edgeCount: number; usedBy: string[] }>;
    };
    expect(body.subflows).toEqual([
      { path: "subflows/sub.yaml", nodeIds: ["helper"], edgeCount: 1, usedBy: ["parent"] },
    ]);
  });

  test("GET /flows/subflows/content returns a sub-flow in source form", async () => {
    const res = await buildApp().request("/flows/subflows/content?path=subflows/sub.yaml");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ id: string; type: string; llm?: unknown }>;
      edges: Array<{ source: string; target: string }>;
      edgeOrigins: Record<string, string>;
    };
    expect(body.nodes).toEqual([{ id: "helper", type: "llm", llm: { shortcut: "local-small" } }]);
    expect(body.edges).toEqual([{ source: "answer", target: "helper" }]);
    expect(body.edgeOrigins).toEqual({ "answer->helper": "subflows/sub.yaml" });
    expect((await buildApp().request("/flows/subflows/content?path=../secrets.yaml")).status).toBe(400);
    expect((await buildApp().request("/flows/subflows/content?path=subflows/nope.yaml")).status).toBe(404);
  });

  test("POST /flows/expressions/copilot reaches the expression copilot, not /flows/:id/copilot", async () => {
    // Regression: registered after /flows/:id/copilot, the request was taken
    // by the flow copilot (id "expressions") and failed with "Field
    // 'definition' is not a valid flow".
    const res = await buildApp().request("/flows/expressions/copilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "template", current: "", instruction: "x", vocabulary: [] }),
    });
    const body = (await res.json()) as { message?: string };
    expect(res.status).toBe(501); // no DEFAULT_LLM in this test app
    expect(body.message).toContain("Copilot is not configured");
  });

  test("POST /flows/variables/evaluate evaluates like a flow load", async () => {
    const res = await buildApp().request("/flows/variables/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variables: { third: "{{= const.budget / 3 }}", label: "n={{vars.third}}", bad: "{{env.HOME}}" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      values: Record<string, unknown>;
      errors: Array<{ name: string; message: string }>;
    };
    expect(body.values["third"]).toBe(100);
    expect(body.values["label"]).toBe("n=100");
    expect(body.errors.map((e) => e.name)).toEqual(["bad"]);

    const invalid = await buildApp().request("/flows/variables/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables: [] }),
    });
    expect(invalid.status).toBe(400);
  });

  test("constants.yaml is not loaded as a flow and shows up in the catalog", async () => {
    expect(parser.getRegistry().list().map((f) => f.id)).not.toContain("constants");
    const body = (await (await buildApp().request("/flows/node-types")).json()) as {
      constants: Record<string, unknown>;
      publicEnv: Record<string, string>;
    };
    expect(body.constants).toEqual({ budget: 300 });
    expect(Object.keys(body.publicEnv).every((k) => k.startsWith("FLOW_PUBLIC_"))).toBe(true);
  });

  test("GET /flows/node-types serves the catalog with shortcuts", async () => {
    const res = await buildApp().request("/flows/node-types");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      types: Array<{ type: string; config: Array<{ key: string }> }>;
      common: Array<{ key: string }>;
      shortcuts: string[];
      shortcutInfo: Record<string, string>;
      models: string[];
    };
    expect(body.shortcuts).toEqual(["local-small"]);
    expect(body.shortcutInfo).toEqual({ "local-small": "openai · example/small" });
    expect(body.models).toEqual(["example/small"]);
    expect(body.common.map((f) => f.key)).toContain("errorStrategy");
    const llm = body.types.find((t) => t.type === "llm");
    expect(llm?.config.map((f) => f.key)).toContain("toolArgs");
  });

  test("a draft of a file flow is diffed against the live file (source form)", async () => {
    const drafts = new Map<string, FlowDefinition>();
    const store = {
      get: async (id: string) =>
        drafts.has(id)
          ? {
              id,
              version: 0,
              published: null,
              // drafts.has(id) was just checked; the store is cast anyway.
              draft: drafts.get(id),
              drafts: [
                {
                  draftId: "default",
                  label: "default",
                  definition: drafts.get(id),
                  updatedAt: "",
                  updatedBy: null,
                },
              ],
              updatedAt: "",
              updatedBy: null,
            }
          : undefined,
      listVersions: async () => [],
    } as unknown as FlowStore;
    const app = new Hono();
    app.route(
      "/",
      createFlowsRouter({
        fileRegistry: parser.getRegistry(),
        operatorAuth: createOperatorAuthorizer({ authRequired: false }),
        authRequired: false,
        store,
      }),
    );
    const source = structuredClone(
      must(parser.getRegistry().getSource?.("parent"), "source").definition,
    ) as unknown as FlowDefinition;
    source.nodes = source.nodes.map((n) => (n.id === "answer" ? { ...n, label: "Changed" } : n));
    drafts.set("parent", source);

    const res = await app.request("/flows/parent/diff?draft=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: { kind: string; file?: string }; diff: { nodes: { changed: Array<{ id: string; changedFields: string[]; details?: unknown[] }> } } };
    expect(body.from).toEqual({ kind: "file", file: "parent.yaml" });
    // only the label differs — shortcuts/prompt includes are not reported as changes
    expect(body.diff.nodes.changed).toEqual([
      { id: "answer", changedFields: ["label"], details: [expect.objectContaining({ path: "label", to: "Changed" })] },
    ]);

    const detail = (await (await app.request("/flows/parent")).json()) as { fileDefinition?: unknown; file?: unknown };
    expect(detail.file).toEqual({ name: "parent.yaml", format: "yaml" });
    expect(detail.fileDefinition).toBeDefined();
  });

  test("POST /flows/subflows/write updates one sub-flow file, keeping its comments", async () => {
    const res = await buildApp().request("/flows/subflows/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "subflows/sub.yaml",
        nodes: [
          { id: "helper", type: "llm", llm: { shortcut: "local-small" }, label: "Helper (edited)" },
          { id: "extra", type: "llm", llm: { shortcut: "local-small" } },
        ],
        edges: [
          { source: "answer", target: "helper" },
          { source: "helper", target: "extra" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { hash: string }).hash).toBe("string");

    const subText = fs.readFileSync(path.join(dir, "subflows", "sub.yaml"), "utf-8");
    // Comment preserved, the parent file is untouched.
    expect(subText).toContain("# sub-flow header comment");
    const parentText = fs.readFileSync(path.join(dir, "parent.yaml"), "utf-8");
    expect(parentText).toContain("# why this flow exists — must survive a save");

    const sub = parseYaml(subText) as { nodes: Array<Record<string, unknown>>; edges: unknown[] };
    expect(sub.nodes.map((n) => n.id)).toEqual(["helper", "extra"]);
    expect(must(sub.nodes.find((n) => n.id === "helper"), "helper").label).toBe("Helper (edited)");
    // The shortcut reference is kept as authored, not expanded.
    expect(sub.nodes[0]?.llm).toEqual({ shortcut: "local-small" });
    expect(sub.edges).toHaveLength(2);
  });

  test("POST /flows/subflows/write creates a new sub-flow file", async () => {
    const res = await buildApp().request("/flows/subflows/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "subflows/fresh.yaml",
        nodes: [{ id: "n1", type: "llm", llm: { shortcut: "local-small" } }],
        edges: [],
      }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(dir, "subflows", "fresh.yaml"))).toBe(true);
    const fresh = parseYaml(fs.readFileSync(path.join(dir, "subflows", "fresh.yaml"), "utf-8")) as {
      nodes: Array<Record<string, unknown>>;
      edges?: unknown;
    };
    expect(fresh.nodes.map((n) => n.id)).toEqual(["n1"]);
    // An empty-edges sub-flow doesn't get an invented `edges:` key.
    expect("edges" in fresh).toBe(false);
  });

  test("POST /flows/subflows/write rejects bad paths, empty fragments and invalid edges", async () => {
    const post = (body: unknown) =>
      buildApp().request("/flows/subflows/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    // path traversal / non-subflow path
    expect((await post({ path: "../secrets.yaml", nodes: [{ id: "n", type: "llm" }] })).status).toBe(400);
    expect((await post({ path: "parent.yaml", nodes: [{ id: "n", type: "llm" }] })).status).toBe(400);
    // empty fragment
    expect((await post({ path: "subflows/x.yaml", nodes: [] })).status).toBe(400);
    // duplicate node id → structural validation fails
    expect(
      (await post({
        path: "subflows/x.yaml",
        nodes: [{ id: "a", type: "llm" }, { id: "a", type: "llm" }],
      })).status,
    ).toBe(400);
    // A cross-boundary edge to a parent node NOT in the fragment is allowed —
    // it resolves once the sub-flow is merged back into its parent.
    expect(
      (await post({
        path: "subflows/x.yaml",
        nodes: [{ id: "a", type: "llm" }],
        edges: [{ source: "answer", target: "a" }],
      })).status,
    ).toBe(200);
  });

  test("POST /flows/subflows/write requires write permission", async () => {
    const app = new Hono();
    app.route(
      "/",
      createFlowsRouter({
        fileRegistry: parser.getRegistry(),
        // A guard that grants read but never write — mirrors an operator role.
        operatorAuth: {
          authorize: async (_auth: unknown, _token: unknown, perm: string) => ({
            ok: perm === "flows:read",
            actor: { name: "op", role: "operator", via: "token" },
          }),
        } as never,
        authRequired: true,
        flowsDir: dir,
      }),
    );
    const res = await app.request("/flows/subflows/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "subflows/x.yaml", nodes: [{ id: "n", type: "llm" }] }),
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(dir, "subflows", "x.yaml"))).toBe(false);
  });

  test("POST /flows/expressions/evaluate checks and evaluates with sample values", async () => {
    const post = (body: unknown) =>
      buildApp().request("/flows/expressions/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = (await (await post({
      expression: "classification.route == 'RETOURE' && messageCount > 1",
      sample: { classification: { route: "RETOURE" }, messageCount: 2 },
    })).json()) as { valid: boolean; result: boolean };
    expect(ok).toEqual({ valid: true, result: true });
    const regex = (await (await post({ expression: "lastMessageText =~ 'park'", sample: { lastMessageText: "Parkplatz frei?" } })).json()) as { result: boolean };
    expect(regex.result).toBe(true);
    const bad = (await (await post({ expression: "classification.route ==" })).json()) as { valid: boolean; error: string };
    expect(bad.valid).toBe(false);
    expect(bad.error.length).toBeGreaterThan(0);
  });
});
