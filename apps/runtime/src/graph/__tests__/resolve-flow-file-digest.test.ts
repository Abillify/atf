// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `resolveFlowFile` resolves a flow file the way the loader does (includes,
 * prompt files, shortcuts, validation) without registering it. The release
 * gate relies on `computeFlowDigest(resolveFlowFile(file))` being the
 * `flow_digest` the engine reports for the flow the loader registered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFlowParserService } from "../flow-parser.js";
import { resolveFlowFile } from "../flow-parser/loader.js";
import { computeFlowDigest } from "../flow-revision.js";

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function writeFlows(subflowModel: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-flow-digest-"));
  fs.mkdirSync(path.join(dir, "subflows"));
  fs.writeFileSync(path.join(dir, "model-shortcuts.yaml"), "shortcuts: {}\n");
  fs.writeFileSync(
    path.join(dir, "subflows", "extra.yaml"),
    JSON.stringify({
      nodes: [{ id: "b", type: "llm", llm: { provider: "openai", model: subflowModel } }],
      edges: [],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "demo.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      metadata: { version: "1.0.0", $include: { subflows: ["subflows/extra.yaml"] } },
      nodes: [{ id: "a", type: "llm", llm: { provider: "openai", model: "gpt-4o" } }],
      edges: [{ source: "a", target: "b" }],
    }),
  );
  return dir;
}

describe("resolveFlowFile digest", () => {
  test("equals the digest of the flow the loader registers", async () => {
    tmpDir = writeFlows("gpt-4o");
    const service = createFlowParserService(tmpDir);
    await service.start();
    const loaded = service.getRegistry().get("demo");
    await service.stop();
    if (loaded === undefined) throw new Error("expected the demo flow to load");

    const resolved = resolveFlowFile(path.join(tmpDir, "demo.json"));
    expect(resolved.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(computeFlowDigest(resolved)).toBe(computeFlowDigest(loaded));
  });

  test("changes when only an included sub-flow changes", () => {
    tmpDir = writeFlows("gpt-4o");
    const before = computeFlowDigest(resolveFlowFile(path.join(tmpDir, "demo.json")));
    fs.writeFileSync(
      path.join(tmpDir, "subflows", "extra.yaml"),
      JSON.stringify({
        nodes: [{ id: "b", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } }],
        edges: [],
      }),
    );
    const after = computeFlowDigest(resolveFlowFile(path.join(tmpDir, "demo.json")));
    expect(after).not.toBe(before);
  });

  test("throws with the validation reason for a flow that does not resolve", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-flow-digest-"));
    fs.writeFileSync(path.join(tmpDir, "broken.json"), JSON.stringify({ id: "broken", nodes: "x" }));
    expect(() => resolveFlowFile(path.join(tmpDir as string, "broken.json"))).toThrow(/broken\.json/);
  });
});
