// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `cli.ts flows release` (T-352): the release gate runs a flow's bench file
 * against a server. A fake OpenAI-compatible server (Bun.serve on port 0)
 * answers the completions; a temporary git repository provides the `--base`
 * revision for the SemVer version gate.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "cli.ts");

/** Answers POST /v1/chat/completions with the last user message echoed back. */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return req
        .json()
        .then((body: { messages?: { content?: string }[] }) => {
          const last = body.messages?.[body.messages.length - 1]?.content ?? "";
          return Response.json({
            id: "rel-test",
            choices: [{ message: { content: last } }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          });
        })
        .catch(() => Response.json({ error: "bad request" }, { status: 400 }));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
const serverUrl = `http://127.0.0.1:${server.port}`;

/**
 * Async spawn: the fake server runs in this process, so the event loop must
 * stay free while the CLI child makes its requests (spawnSync would
 * deadlock).
 */
async function release(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", cli, "flows", "release", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const FLOW_V1 = [
  "id: demo",
  "name: Demo",
  "metadata:",
  "  version: 1.2.3",
  "nodes:",
  "  - id: a",
  "    type: llm",
  "    llm: { provider: openai, model: gpt-4o }",
  "edges: []",
  "",
].join("\n");

const BENCH = [
  "version: 1",
  "flow: demo",
  "cases:",
  "  - id: greeting",
  "    messages:",
  "      - role: user",
  "        content: Hallo",
  "    assert:",
  "      - type: contains",
  "        value: Hallo",
  "thresholds:",
  "  passRate: 1.0",
  "",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-flows-release-"));
  writeFileSync(join(dir, "model-shortcuts.yaml"), "shortcuts: {}\n");
  mkdirSync(join(dir, "bench"));
  writeFileSync(join(dir, "demo.yaml"), FLOW_V1);
  writeFileSync(join(dir, "bench", "demo.bench.yaml"), BENCH);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function git(args: string[]): void {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

beforeAll(() => {
  // Sanity: the fake server answers like a completion endpoint.
  return fetch(`${serverUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
  }).then((res) => {
    if (!res.ok) throw new Error("fake server not answering");
  });
});

afterAll(() => server.stop());

describe("flows release", () => {
  test("passes the bench gate against the fake server", async () => {
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl);
    expect(result.stdout.toString() + result.stderr.toString()).toContain("Release gate passed");
    expect(result.exitCode).toBe(0);
  });

  test("reports stats in JSON mode", async () => {
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl, "--json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.toString().replace(/^[^{]*/, ""));
    expect(payload.flowId).toBe("demo");
    expect(payload.flowVersion).toBe("1.2.3");
    expect(payload.flowDigest).toStartWith("sha256:");
    expect(payload.cases).toBe(1);
    expect(payload.passed).toBe(1);
    expect(payload.passRate).toBe(1);
    expect(payload.tokensP50).toBe(10);
  });

  test("fails when a bench case fails the threshold", async () => {
    writeFileSync(
      join(dir, "bench", "demo.bench.yaml"),
      BENCH.replace("value: Hallo", "value: never-matches"),
    );
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Threshold");
    expect(result.stderr.toString()).toContain("passRate");
  });

  test("missing flow id or --flows-dir is rejected", async () => {
    expect((await release("--flows-dir", dir, "--server", serverUrl)).exitCode).toBe(1);
    expect((await release("demo", "--server", serverUrl)).exitCode).toBe(1);
  });

  test("a missing bench file is reported", async () => {
    rmSync(join(dir, "bench", "demo.bench.yaml"));
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Bench file not found");
  });

  test("version gate: changed flow with an unchanged version exits 1", async () => {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    // Behavioural change without a version bump.
    writeFileSync(join(dir, "demo.yaml"), FLOW_V1.replace("gpt-4o", "gpt-4o-mini"));
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl, "--base", "HEAD");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "flow changed but metadata.version was not raised (1.2.3 → 1.2.3)",
    );
  });

  test("version gate: changed flow with a raised version passes", async () => {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    writeFileSync(
      join(dir, "demo.yaml"),
      FLOW_V1.replace("gpt-4o", "gpt-4o-mini").replace("1.2.3", "1.2.4"),
    );
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl, "--base", "HEAD");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Version gate passed (1.2.3 → 1.2.4)");
  });

  test("version gate: unchanged flow with an unchanged version passes", async () => {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl, "--base", "HEAD");
    expect(result.exitCode).toBe(0);
  });

  test("baseline receipt: a regressed pass rate exits 1", async () => {
    const baselinePath = join(dir, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ results: { passRate: 1, latencyMsP50: 1, tokensP50: 1 } }));
    writeFileSync(
      join(dir, "bench", "demo.bench.yaml"),
      BENCH.replace("value: Hallo", "value: never-matches").replace("passRate: 1.0", "passRate: 0"),
    );
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--baseline",
      baselinePath,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("passRate regressed from baseline 100.0% to 0.0%");
  });
});
