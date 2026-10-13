// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression/behavior test: `metadata.$include.subflows` merges a sub-flow
 * file's nodes/edges into the parent at load time, and records which
 * sub-flow file each merged node came from as `metadata.$includeOrigins`
 * (`nodeId -> relPath`). This is what lets `POST /flows/write` write an
 * edited flow's nodes back to the sub-flow file they came from instead of
 * flattening everything into the parent file — see `src/routes/flows-shared.ts`.
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFlowParserService } from "../flow-parser.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("$include.subflows origin tracking", () => {
  test("merges sub-flow nodes/edges and records their origin", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-subflow-"));
    fs.mkdirSync(path.join(tmpDir, "subflows"));

    fs.writeFileSync(
      path.join(tmpDir, "subflows", "guard.yaml"),
      JSON.stringify({
        nodes: [{ id: "guard-node", type: "tool" }],
        edges: [],
      }),
    );

    fs.writeFileSync(
      path.join(tmpDir, "parent.json"),
      JSON.stringify({
        id: "parent",
        name: "Parent",
        metadata: { $include: { subflows: ["subflows/guard.yaml"] } },
        nodes: [{ id: "router", type: "router" }],
        edges: [{ source: "router", target: "guard-node" }],
      }),
    );

    const service = createFlowParserService(tmpDir);
    await service.start();
    const flow = service.getRegistry().get("parent");
    await service.stop();

    expect(flow).toBeDefined();
    if (flow === undefined) throw new Error("expected the parent flow to load");
    expect(flow.nodes.map((n) => n.id).sort()).toEqual(["guard-node", "router"]);

    const origins = flow.metadata?.$includeOrigins as
      | Record<string, string>
      | undefined;
    expect(origins).toEqual({ "guard-node": "subflows/guard.yaml" });

    // The raw `$include` directive is consumed, not carried forward.
    expect(
      (flow.metadata as Record<string, unknown> | undefined)?.$include,
    ).toBeUndefined();
  });

  test("a flow without includes has no $includeOrigins at all", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-subflow-"));
    fs.writeFileSync(
      path.join(tmpDir, "plain.json"),
      JSON.stringify({
        id: "plain",
        name: "Plain",
        nodes: [{ id: "n", type: "llm" }],
        edges: [],
      }),
    );

    const service = createFlowParserService(tmpDir);
    await service.start();
    const flow = service.getRegistry().get("plain");
    await service.stop();

    if (flow === undefined) throw new Error("expected the plain flow to load");
    expect(flow.metadata?.$includeOrigins).toBeUndefined();
  });

  test("a duplicate node id in the sub-flow is skipped in favor of the parent's own node", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-subflow-"));
    fs.mkdirSync(path.join(tmpDir, "subflows"));
    fs.writeFileSync(
      path.join(tmpDir, "subflows", "dup.yaml"),
      JSON.stringify({ nodes: [{ id: "router", type: "tool" }], edges: [] }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "parent2.json"),
      JSON.stringify({
        id: "parent2",
        name: "Parent2",
        metadata: { $include: { subflows: ["subflows/dup.yaml"] } },
        nodes: [{ id: "router", type: "router" }],
        edges: [],
      }),
    );

    const service = createFlowParserService(tmpDir);
    await service.start();
    const flow = service.getRegistry().get("parent2");
    await service.stop();

    // Parent's own node wins; no origin recorded for the id it kept.
    if (flow === undefined) throw new Error("expected the parent2 flow to load");
    expect(flow.nodes).toHaveLength(1);
    const firstNode = flow.nodes[0];
    if (firstNode === undefined) throw new Error("expected a first node");
    expect(firstNode.type).toBe("router");
    const origins = flow.metadata?.$includeOrigins as
      | Record<string, string>
      | undefined;
    expect(origins?.router).toBeUndefined();
  });
});
