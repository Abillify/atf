// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli.ts";

const dirs: string[] = [];
const base = `auth:\n  mode: static\n  static:\n    tokens:\n      - token: this-is-a-long-enough-static-token-for-tests\n        username: test\nmonitoring:\n  enabled: false\n`;

function configDir(extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpgate-cli-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.yaml"), base + extra);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("config CLI", () => {
  it("validates locally and rejects remote imports without --remote", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["validate", configDir()])).toBe(0);
    expect(
      await runCli([
        "validate",
        configDir("mcpServers:\n  - server:\n      url: https://example.invalid/mcp\n"),
      ]),
    ).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain("requires the async loader");
    log.mockRestore();
    error.mockRestore();
  });

  it("inspect emits a normalized summary without configured secrets", async () => {
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const dir = configDir(
      "databases:\n  main:\n    client: pg\n    connection: postgres://secret-user:secret-pass@db/app\n",
    );
    expect(await runCli(["inspect", dir])).toBe(0);
    const text = output.join("\n");
    expect(text).toContain('"client": "pg"');
    expect(text).not.toContain("secret-pass");
    expect(text).not.toContain("connection");
    log.mockRestore();
  });
});
