// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Bench file contract: `<FLOWS_DIR>/bench/<flowId>.bench.yaml` pins a
 * flow to recorded conversations plus release thresholds. The loader throws on
 * anything malformed — a release gate that silently does nothing is worse than
 * no gate — and `llmJudge` assertions are rejected because the gate must stay
 * deterministic.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BenchFileSchema, loadBenchFile } from "../bench-contract.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function writeBench(name: string, content: string): string {
  tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bench-contract-"));
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content);
  return file;
}

const VALID_YAML = `version: 1
flow: demo
cases:
  - id: greeting
    messages:
      - role: user
        content: Hallo
    metadata:
      user: tester
    assert:
      - type: contains
        value: Hallo
  - id: farewell
    messages:
      - role: user
        content: Tschuess
thresholds:
  passRate: 0.9
  maxLatencyMsP50: 4000
  maxTokensP50: 800
`;

describe("loadBenchFile", () => {
  test("loads a valid bench file with cases, metadata and thresholds", () => {
    const file = writeBench("demo.bench.yaml", VALID_YAML);
    const bench = loadBenchFile(file);
    expect(bench.version).toBe(1);
    expect(bench.flow).toBe("demo");
    expect(bench.cases.map((c) => c.id)).toEqual(["greeting", "farewell"]);
    expect(bench.cases[0]?.metadata).toEqual({ user: "tester" });
    expect(bench.cases[0]?.assert).toEqual([{ type: "contains", value: "Hallo" }]);
    expect(bench.cases[1]?.assert).toBeUndefined();
    expect(bench.thresholds).toEqual({
      passRate: 0.9,
      maxLatencyMsP50: 4000,
      maxTokensP50: 800,
    });
  });

  test("accepts a file whose name does not follow the <flow>.bench.<ext> scheme", () => {
    const file = writeBench("adhoc.yaml", VALID_YAML);
    expect(loadBenchFile(file).flow).toBe("demo");
  });

  test("rejects a missing thresholds.passRate", () => {
    const file = writeBench(
      "demo.bench.yaml",
      VALID_YAML.replace("  passRate: 0.9\n", ""),
    );
    expect(() => loadBenchFile(file)).toThrow(/thresholds\.passRate/);
  });

  test("rejects a passRate outside 0-1", () => {
    const file = writeBench(
      "demo.bench.yaml",
      VALID_YAML.replace("passRate: 0.9", "passRate: 90"),
    );
    expect(() => loadBenchFile(file)).toThrow(/passRate/);
  });

  test("rejects duplicate case ids", () => {
    const file = writeBench(
      "demo.bench.yaml",
      VALID_YAML.replace("- id: farewell", "- id: greeting"),
    );
    expect(() => loadBenchFile(file)).toThrow(/case ids must be unique/);
  });

  test("rejects llmJudge assertions", () => {
    const file = writeBench(
      "demo.bench.yaml",
      VALID_YAML.replace(
        "      - type: contains\n        value: Hallo\n",
        "      - type: llmJudge\n        prompt: Ist die Antwort freundlich?\n",
      ),
    );
    expect(() => loadBenchFile(file)).toThrow(/Invalid discriminator value/);
  });

  test("rejects a version other than 1", () => {
    const file = writeBench("demo.bench.yaml", VALID_YAML.replace("version: 1", "version: 2"));
    expect(() => loadBenchFile(file)).toThrow(/version/);
  });

  test("rejects unknown keys (strict schema)", () => {
    const file = writeBench("demo.bench.yaml", `${VALID_YAML}owner: team-x\n`);
    expect(() => loadBenchFile(file)).toThrow(/owner/);
  });

  test("rejects a bench file whose name names a different flow", () => {
    const file = writeBench("other.bench.yaml", VALID_YAML);
    expect(() => loadBenchFile(file)).toThrow(
      /bench file name says flow "other" but `flow` is "demo"/,
    );
  });

  test("rejects a file with no cases", () => {
    const file = writeBench(
      "demo.bench.yaml",
      "version: 1\nflow: demo\ncases: []\nthresholds:\n  passRate: 1\n",
    );
    expect(() => loadBenchFile(file)).toThrow(/cases/);
  });

  test("reports the file name on unreadable or unparseable input", () => {
    const file = writeBench("demo.bench.yaml", "{ not yaml: [");
    expect(() => loadBenchFile(file)).toThrow(/failed to read\/parse bench file/);
    expect(() => loadBenchFile(path.join(tmpDir ?? ".", "missing.bench.yaml"))).toThrow(
      /failed to read\/parse bench file/,
    );
  });
});

describe("BenchFileSchema", () => {
  test("requires at least one message per case", () => {
    const result = BenchFileSchema.safeParse({
      version: 1,
      flow: "demo",
      cases: [{ id: "empty", messages: [] }],
      thresholds: { passRate: 1 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown roles", () => {
    const result = BenchFileSchema.safeParse({
      version: 1,
      flow: "demo",
      cases: [{ id: "c", messages: [{ role: "tool", content: "x" }] }],
      thresholds: { passRate: 1 },
    });
    expect(result.success).toBe(false);
  });
});
