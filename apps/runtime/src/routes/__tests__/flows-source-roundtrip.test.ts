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
          ? { id, version: 0, published: null, draft: drafts.get(id)!, updatedAt: "", updatedBy: null }
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
    const body = (await res.json()) as { from: { kind: string; file?: string }; diff: { nodes: { changed: Array<{ id: string; changedFields: string[] }> } } };
    expect(body.from).toEqual({ kind: "file", file: "parent.yaml" });
    // only the label differs — shortcuts/prompt includes are not reported as changes
    expect(body.diff.nodes.changed).toEqual([{ id: "answer", changedFields: ["label"] }]);

    const detail = (await (await app.request("/flows/parent")).json()) as { fileDefinition?: unknown; file?: unknown };
    expect(detail.file).toEqual({ name: "parent.yaml", format: "yaml" });
    expect(detail.fileDefinition).toBeDefined();
  });

  test("POST /flows/expressions/evaluate checks and evaluates with sample values", async () => {
    const post = (body: unknown) =>
      buildApp().request("/flows/expressions/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = (await (await post({
      expression: "classification.route == 'INKASSO' && messageCount > 1",
      sample: { classification: { route: "INKASSO" }, messageCount: 2 },
    })).json()) as { valid: boolean; result: boolean };
    expect(ok).toEqual({ valid: true, result: true });
    const regex = (await (await post({ expression: "lastMessageText =~ 'park'", sample: { lastMessageText: "Parkplatz frei?" } })).json()) as { result: boolean };
    expect(regex.result).toBe(true);
    const bad = (await (await post({ expression: "classification.route ==" })).json()) as { valid: boolean; error: string };
    expect(bad.valid).toBe(false);
    expect(bad.error.length).toBeGreaterThan(0);
  });
});
