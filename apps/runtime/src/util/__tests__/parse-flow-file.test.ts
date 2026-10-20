// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow-file parser (src/util/parse-flow-file.ts): YAML merge
 * keys are expanded, and a merge key that cannot be expanded is a load error.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFlowFile, parseFlowFileAsync } from "../parse-flow-file.js";

function writeTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-parse-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

type FlowLike = {
  nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>;
};

describe("parseFlowFile merge keys", () => {
  test("(a) expands a simple mapping merge key", () => {
    const file = writeTempFile(
      "flow.yaml",
      [
        "defaults: &d",
        "  toolArgs:",
        "    \"vectorsearch/search\":",
        "      collection: cases",
        "nodes:",
        "  - id: a",
        "    type: llm",
        "    config:",
        "      <<: *d",
        "      maxToolSteps: 3",
      ].join("\n"),
    );
    const flow = parseFlowFile(file) as FlowLike & Record<string, unknown>;
    const config = flow.nodes[0]?.config ?? {};
    expect(config["maxToolSteps"]).toBe(3);
    const toolArgs = config["toolArgs"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(toolArgs["vectorsearch/search"]?.["collection"]).toBe("cases");
    expect(Object.keys(config)).not.toContain("<<");
  });

  test("(b) list merge: first entry wins on conflict, explicit keys win over both", () => {
    const file = writeTempFile(
      "flow.yaml",
      [
        "a: &a",
        "  alpha: from-a",
        "  shared: from-a",
        "b: &b",
        "  beta: from-b",
        "  shared: from-b",
        "nodes:",
        "  - id: n",
        "    type: llm",
        "    config:",
        "      <<: [*a, *b]",
        "      explicit: kept",
      ].join("\n"),
    );
    const config = (parseFlowFile(file) as FlowLike).nodes[0]?.config ?? {};
    expect(config["alpha"]).toBe("from-a");
    expect(config["beta"]).toBe("from-b");
    // YAML 1.1: the first mapping in the merge list wins on conflicts.
    expect(config["shared"]).toBe("from-a");
    expect(config["explicit"]).toBe("kept");
    expect(Object.keys(config)).not.toContain("<<");
  });

  test("(c) a literal merge key in JSON is a load error naming file and path", () => {
    const file = writeTempFile(
      "flow.json",
      JSON.stringify({
        nodes: [{ id: "a", type: "llm", config: { "<<": { x: 1 } } }],
      }),
    );
    expect(() => parseFlowFile(file)).toThrow(/<</);
    expect(() => parseFlowFile(file)).toThrow(/\/nodes\/0\/config/);
  });

  test("(d) parseFlowFileAsync behaves like the sync parser", async () => {
    const file = writeTempFile(
      "flow.yaml",
      [
        "defaults: &d",
        "  toolArgs:",
        "    \"vectorsearch/search\":",
        "      collection: cases",
        "nodes:",
        "  - id: a",
        "    type: llm",
        "    config:",
        "      <<: *d",
        "      maxToolSteps: 3",
      ].join("\n"),
    );
    const flow = (await parseFlowFileAsync(file)) as FlowLike;
    const config = flow.nodes[0]?.config ?? {};
    expect(config["maxToolSteps"]).toBe(3);
    const toolArgs = config["toolArgs"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(toolArgs["vectorsearch/search"]?.["collection"]).toBe("cases");
    expect(Object.keys(config)).not.toContain("<<");
  });
});
