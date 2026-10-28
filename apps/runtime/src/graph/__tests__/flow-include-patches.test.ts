// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `metadata.$include.patches`: the parent deep-merges a partial node into an
 * included sub-flow node instead of replacing the whole node by redefining its
 * id. Objects merge recursively, arrays replace, `null` deletes the key; a
 * patch for a node the includes do not provide stops the flow from loading.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFlowParserService, materializeFlowSource } from "../flow-parser.js";
import { applyIncludePatches, deepMergePatch, FlowIncludeError } from "../flow-parser/normalize.js";
import { getFlowLoadFailures, resetFlowLoadFailures } from "../flow-parser/validate.js";

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
  resetFlowLoadFailures();
});

function workspace(patches: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-patches-"));
  fs.mkdirSync(path.join(dir, "subflows"));
  fs.writeFileSync(
    path.join(dir, "subflows", "research.json"),
    JSON.stringify({
      nodes: [
        {
          id: "researcher",
          type: "llm",
          tools: ["vectorsearch/search"],
          config: { toolArgs: { "vectorsearch/search": { collection: "cases", limit: 5 } }, maxToolSteps: 4 },
        },
        { id: "writer", type: "llm", config: { maxToolSteps: 2 } },
      ],
      edges: [{ source: "researcher", target: "writer" }],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "parent.json"),
    JSON.stringify({
      id: "parent",
      name: "Parent",
      metadata: { $include: { subflows: ["subflows/research.json"], ...(patches !== undefined ? { patches } : {}) } },
      nodes: [{ id: "router", type: "router" }],
      edges: [{ source: "router", target: "researcher" }],
    }),
  );
  return dir;
}

/** `config` of the node `id` in a loaded flow (empty when the node has none). */
function configOf(
  nodes: ReadonlyArray<{ id: string; config?: unknown }> | undefined,
  id: string,
): Record<string, unknown> {
  const config = nodes?.find((n) => n.id === id)?.config;
  return typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
}

async function load(dir: string, id = "parent") {
  const service = createFlowParserService(dir);
  await service.start();
  const flow = service.getRegistry().get(id);
  const source = service.getRegistry().getSource?.(id);
  await service.stop();
  return { flow, source };
}

describe("deepMergePatch", () => {
  test("objects merge recursively, arrays and scalars replace, null deletes", () => {
    const target: Record<string, unknown> = {
      a: { b: 1, c: { d: 2, e: 3 } },
      list: [1, 2, 3],
      gone: "x",
      keep: true,
    };
    deepMergePatch(target, { a: { c: { d: 9 } }, list: [7], gone: null, added: { n: 1 } });
    expect(target).toEqual({ a: { b: 1, c: { d: 9, e: 3 } }, list: [7], keep: true, added: { n: 1 } });
  });

  test("a patch value does not alias the patch object", () => {
    const patch = { cfg: { x: 1 } };
    const target: Record<string, unknown> = {};
    deepMergePatch(target, patch);
    (target.cfg as Record<string, unknown>).x = 2;
    expect(patch.cfg.x).toBe(1);
  });
});

describe("applyIncludePatches", () => {
  test("rejects unknown ids, non-object patches and id changes", () => {
    const nodes = () => ({ nodes: [{ id: "a", type: "llm" }] });
    expect(() => applyIncludePatches(nodes(), { zz: {} })).toThrow("patch targets unknown node zz");
    expect(() => applyIncludePatches(nodes(), { a: "x" })).toThrow(FlowIncludeError);
    expect(() => applyIncludePatches(nodes(), [])).toThrow(FlowIncludeError);
    expect(() => applyIncludePatches(nodes(), { a: { id: "b" } })).toThrow("must not change its id");
    expect(() => applyIncludePatches(nodes(), { a: { id: "a", type: "tool" } })).not.toThrow();
  });
});

describe("flow loading with $include.patches", () => {
  test("a patch sets config.toolArgs of a sub-flow node and leaves its other keys", async () => {
    tmpDir = workspace({
      researcher: { config: { toolArgs: { "vectorsearch/search": { collection: "contracts" } } } },
    });
    const { flow } = await load(tmpDir);
    const config = configOf(flow?.nodes, "researcher");
    expect(config.toolArgs).toEqual({ "vectorsearch/search": { collection: "contracts", limit: 5 } });
    expect(config.maxToolSteps).toBe(4);
    expect(flow?.nodes.find((n) => n.id === "researcher")?.tools).toEqual(["vectorsearch/search"]);
    // Another included node is untouched.
    expect(configOf(flow?.nodes, "writer")).toEqual({ maxToolSteps: 2 });
  });

  test("null deletes a key of the included node", async () => {
    tmpDir = workspace({ researcher: { config: { maxToolSteps: null } } });
    const { flow } = await load(tmpDir);
    const config = configOf(flow?.nodes, "researcher");
    expect(config).not.toHaveProperty("maxToolSteps");
    expect(config).toHaveProperty("toolArgs");
  });

  test("an unknown node id is a load error and the flow is not registered", async () => {
    tmpDir = workspace({ nope: { config: {} } });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { flow } = await load(tmpDir);
      expect(flow).toBeUndefined();
    } finally {
      stderr.mockRestore();
    }
    expect(getFlowLoadFailures().some((f) => f.reason === "patch targets unknown node nope")).toBe(true);
  });

  test("the editable source form keeps sub-flow nodes unpatched, so saving cannot write patches into the sub-flow file", async () => {
    tmpDir = workspace({ researcher: { config: { maxToolSteps: 99 } } });
    const { flow, source } = await load(tmpDir);
    expect(configOf(flow?.nodes, "researcher").maxToolSteps).toBe(99);
    const sourceNodes = source?.definition.nodes as Array<{ id: string; config?: unknown }> | undefined;
    expect(configOf(sourceNodes, "researcher").maxToolSteps).toBe(4);
    // The patches wait in bookkeeping until the runtime form is built from the source.
    const sourceMetadata = (source?.definition.metadata ?? {}) as Record<string, unknown>;
    expect(sourceMetadata.$includePatches).toEqual({
      researcher: { config: { maxToolSteps: 99 } },
    });
  });

  test("materializing the source form applies the patches again", async () => {
    tmpDir = workspace({ researcher: { config: { maxToolSteps: 99 } } });
    const { source } = await load(tmpDir);
    if (source === undefined) throw new Error("expected a source record");
    const result = materializeFlowSource(source.definition, tmpDir, "parent.json");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(configOf(result.data.nodes, "researcher").maxToolSteps).toBe(99);
    expect(result.data.metadata).not.toHaveProperty("$includePatches");
  });

  test("a bad patch in a source form is reported by materialization, not thrown", async () => {
    tmpDir = workspace({ researcher: { config: { maxToolSteps: 99 } } });
    const { source } = await load(tmpDir);
    if (source === undefined) throw new Error("expected a source record");
    const edited = structuredClone(source.definition) as { metadata: Record<string, unknown> };
    edited.metadata.$includePatches = { removed: { config: {} } };
    const result = materializeFlowSource(edited, tmpDir, "parent.json");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.reason).toBe("patch targets unknown node removed");
  });

  test("a flow without patches behaves exactly as before", async () => {
    tmpDir = workspace(undefined);
    const { flow } = await load(tmpDir);
    expect(flow?.nodes.map((n) => n.id).sort()).toEqual(["researcher", "router", "writer"]);
  });
});

describe("deepMergePatch · prototype keys", () => {
  test("ignores __proto__, constructor and prototype from a parsed patch", () => {
    const target: Record<string, unknown> = { a: { b: 1 } };
    const patch = JSON.parse('{"__proto__":{"polluted":true},"a":{"constructor":{"prototype":{"x":1}},"c":2}}');
    deepMergePatch(target, patch);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target).toEqual({ a: { b: 1, c: 2 } });
  });
});
