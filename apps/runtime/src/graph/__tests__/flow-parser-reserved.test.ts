// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test: reserved control files in FLOWS_DIR (guardrails.json,
 * dispatch.json, access.json, canary.json, experiments.json) must NOT be parsed
 * as flow definitions at startup. Locks in the fix that adds guardrails.json to
 * the startup exclusion set, so shipping an active flows/guardrails.json does
 * not produce a spurious flow-validation error.
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

describe("flow-parser reserved files", () => {
  test("guardrails.json is not loaded as a flow at startup", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-reserved-"));

    // A real flow plus an active guardrails.json control file.
    fs.writeFileSync(
      path.join(tmpDir, "real-flow.json"),
      JSON.stringify({
        id: "real-flow",
        name: "Real",
        nodes: [{ id: "n", type: "llm" }],
        edges: [],
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "guardrails.json"),
      JSON.stringify({
        rules: [
          { flow: "real-flow", egress: { enabled: true, mode: "block" } },
        ],
      }),
    );

    const service = createFlowParserService(tmpDir);
    await service.start();
    const registry = service.getRegistry();
    await service.stop();

    // The real flow is registered; the control file is NOT a flow.
    expect(registry.get("real-flow")).toBeDefined();
    expect(registry.list().map((f) => f.id)).toEqual(["real-flow"]);
  });
});
