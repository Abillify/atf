// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test: files under `<FLOWS_DIR>/bench/` are release-gate bench
 * definitions (`<flowId>.bench.yaml`, see `src/eval/bench-contract.ts`), not
 * flows. The startup scan must not register them and the hot-reload watcher
 * must not load them when they appear or disappear — mirroring how
 * `subflows/` fragments are skipped.
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFlowParserService } from "../flow-parser.js";
import { getFlowLoadFailures } from "../flow-parser/validate.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

// chokidar scans the directory asynchronously after start(); a change made
// before that scan finished is invisible to it (no "ready" hook is exposed).
const settle = () => new Promise((r) => setTimeout(r, 1000));

const BENCH_YAML = `version: 1
flow: demo
cases:
  - id: greeting
    messages:
      - role: user
        content: Hallo
thresholds:
  passRate: 0.9
`;

describe("flow-parser bench files", () => {
  test("bench files are never loaded as flows, at startup or via the watcher", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-bench-"));
    fs.mkdirSync(path.join(tmpDir, "bench"));

    fs.writeFileSync(
      path.join(tmpDir, "demo.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        nodes: [{ id: "n", type: "llm" }],
        edges: [],
      }),
    );
    fs.writeFileSync(path.join(tmpDir, "bench", "demo.bench.yaml"), BENCH_YAML);

    const service = createFlowParserService(tmpDir);
    await service.start();
    try {
      const registry = service.getRegistry();
      await settle();

      // The real flow is registered; the bench file is NOT a flow and does
      // not show up as a load failure either.
      expect(registry.get("demo")).toBeDefined();
      expect(registry.list().map((f) => f.id)).toEqual(["demo"]);
      expect(getFlowLoadFailures()).toEqual([]);

      // A bench file created after startup must not be picked up either.
      fs.writeFileSync(path.join(tmpDir, "bench", "late.bench.yaml"), BENCH_YAML);
      await settle();
      expect(registry.list().map((f) => f.id)).toEqual(["demo"]);
      expect(getFlowLoadFailures()).toEqual([]);

      // Removing it must not disturb the registry.
      fs.rmSync(path.join(tmpDir, "bench", "demo.bench.yaml"));
      await settle();
      expect(registry.get("demo")).toBeDefined();
      expect(registry.list().map((f) => f.id)).toEqual(["demo"]);
    } finally {
      await service.stop();
    }
  }, 15_000);
});
