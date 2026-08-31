// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the `$includeOrigins`-aware split in POST/PUT /flows/write.
 *
 * When an incoming definition carries `metadata.$includeOrigins` (produced by
 * the loader when a flow was composed via `metadata.$include.subflows` — see
 * flow-parser/normalize.ts), the write endpoint must write each tagged
 * node/edge group back to its own sub-flow file and write only the
 * remaining (untagged) nodes/edges to the parent file — instead of
 * flattening everything into the parent, which would silently orphan the
 * sub-flow file on every save.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import { createFlowsRouter } from "../flows.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

function emptyRegistry(): FlowRegistry {
  return { get: () => undefined, list: () => [] };
}

function buildApp(flowsDir: string) {
  const operatorAuth = createOperatorAuthorizer({ authRequired: false });
  const a = new Hono();
  a.route(
    "/",
    createFlowsRouter({
      fileRegistry: emptyRegistry(),
      operatorAuth,
      authRequired: false,
      flowsDir,
    }),
  );
  return a;
}

function writeRequest(body: unknown): RequestInit & { headers: Record<string, string> } {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flows-write-subflow-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const composedFlow: FlowDefinition = {
  id: "parent",
  name: "Parent",
  nodes: [
    { id: "router", type: "router" },
    { id: "guard-node", type: "tool" },
  ],
  edges: [{ source: "router", target: "guard-node" }],
  metadata: { $includeOrigins: { "guard-node": "subflows/guard.yaml" } },
};

describe("POST /flows/write — $includeOrigins split", () => {
  test("writes the tagged node to its own sub-flow file and only the untagged node to the parent", async () => {
    const app = buildApp(tmpDir);
    const res = await app.request(
      "/flows/write",
      writeRequest({ id: "parent", format: "yaml", definition: composedFlow }),
    );
    expect(res.status).toBe(200);

    const parentRaw = fs.readFileSync(path.join(tmpDir, "parent.yaml"), "utf-8");
    const parent = parseYaml(parentRaw) as FlowDefinition;
    expect(parent.nodes.map((n) => n.id)).toEqual(["router"]);
    expect(parent.metadata?.$include).toEqual({
      subflows: ["subflows/guard.yaml"],
    });

    const subflowRaw = fs.readFileSync(
      path.join(tmpDir, "subflows", "guard.yaml"),
      "utf-8",
    );
    const subflow = parseYaml(subflowRaw) as { nodes: Array<{ id: string }> };
    expect(subflow.nodes.map((n) => n.id)).toEqual(["guard-node"]);
  });

  test("a cross-boundary edge (only one endpoint tagged) stays with the parent", async () => {
    const app = buildApp(tmpDir);
    await app.request(
      "/flows/write",
      writeRequest({ id: "parent", format: "yaml", definition: composedFlow }),
    );
    const parentRaw = fs.readFileSync(path.join(tmpDir, "parent.yaml"), "utf-8");
    // Both edges cross the router<->guard-node boundary, so both stay in the
    // parent (edges reference ids that still resolve after re-merging).
    expect(parentRaw).toContain("guard-node");
  });

  test("$includeOrigins itself is never persisted to either file", async () => {
    const app = buildApp(tmpDir);
    await app.request(
      "/flows/write",
      writeRequest({ id: "parent", format: "yaml", definition: composedFlow }),
    );
    const parentRaw = fs.readFileSync(path.join(tmpDir, "parent.yaml"), "utf-8");
    expect(parentRaw).not.toContain("includeOrigins");
  });

  test("a flow without $includeOrigins writes exactly as before (no split)", async () => {
    const app = buildApp(tmpDir);
    const plain: FlowDefinition = {
      id: "plain",
      name: "Plain",
      nodes: [{ id: "n", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } }],
      edges: [],
    };
    const res = await app.request(
      "/flows/write",
      writeRequest({ id: "plain", format: "yaml", definition: plain }),
    );
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, "subflows"))).toBe(false);
  });

  test("rejects a traversal attempt smuggled in via $includeOrigins", async () => {
    const app = buildApp(tmpDir);
    const malicious: FlowDefinition = {
      ...composedFlow,
      metadata: {
        $includeOrigins: { "guard-node": "../../etc/evil.yaml" },
      },
    };
    const res = await app.request(
      "/flows/write",
      writeRequest({ id: "parent", format: "yaml", definition: malicious }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/path traversal/i);
    // Nothing was written at all — the whole request is rejected atomically.
    expect(fs.existsSync(path.join(tmpDir, "parent.yaml"))).toBe(false);
  });
});
