// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Tests for `cli.ts bench capture` — the operator command that turns recorded
 * executions (`GET /monitoring/debug/:executionId`) into a bench file for
 * `flows release`.
 *
 * Pins: the written YAML (tools, token/latency caps, provenance comment), the
 * personal-data refusal and its `--allow-raw` override, `--append` vs. the
 * existing-file refusal, and that a result failing `loadBenchFile` is never
 * written.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

const cli = join(import.meta.dir, "..", "cli.ts");

interface FakeTrace {
  execution_id: string;
  flow_id: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  context: Record<string, unknown>;
  input_messages: Array<{ role: string; content: string }>;
  nodes: Array<{
    node_id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    latency_ms: number | null;
    tool_calls: Array<{ id: string; name: string; arguments: unknown; result: unknown; is_error: boolean; called_at: string }>;
    diagnostics?: Array<{ at: string; level: string; code: string; message: string }>;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  errors: unknown[];
}

function fakeTrace(executionId: string, overrides: Partial<FakeTrace> = {}): FakeTrace {
  return {
    execution_id: executionId,
    flow_id: "my-flow",
    status: "completed",
    started_at: "2026-10-20T10:00:00.000Z",
    finished_at: "2026-10-20T10:00:04.000Z",
    context: {},
    input_messages: [{ role: "user", content: "Summarize the quarterly report" }],
    nodes: [
      {
        node_id: "answer",
        status: "completed",
        started_at: "2026-10-20T10:00:00.000Z",
        finished_at: "2026-10-20T10:00:04.000Z",
        latency_ms: 4000,
        tool_calls: [
          {
            id: "t1",
            name: "search/docs",
            arguments: { q: "quarterly" },
            result: { chunks: [] },
            is_error: false,
            called_at: "2026-10-20T10:00:01.000Z",
          },
        ],
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
    errors: [],
    ...overrides,
  };
}

const servers: Array<{ stop(): void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atf-bench-capture-test-"));
  dirs.push(dir);
  return dir;
}

/** Serve one trace per execution id; unknown ids answer 404 like the runtime. */
function serveTraces(traces: Map<string, FakeTrace>): string {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const match = /^\/monitoring\/debug\/(.+)$/.exec(new URL(req.url).pathname);
      const id = match?.[1] !== undefined ? decodeURIComponent(match[1]) : "";
      const trace = traces.get(id);
      if (trace === undefined) {
        return Response.json({ error: { message: "not found", type: "not_found_error" } }, { status: 404 });
      }
      return Response.json(trace);
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("cli.ts bench capture", () => {
  it("writes a bench file with derived assertions and a provenance comment", async () => {
    const server = serveTraces(new Map([["exec-1", fakeTrace("exec-1")]]));
    const dir = await tempDir();
    const out = join(dir, "my-flow.bench.yaml");
    const { exitCode, stdout } = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "exec-1",
      "--out",
      out,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Captured 1 bench case(s)");
    const yaml = await readFile(out, "utf8");
    expect(yaml).toContain("# captured from execution exec-1 at ");
    expect(yaml).toContain("review the expectations before release");
    const doc = parseYaml(yaml) as {
      version: number;
      flow: string;
      cases: Array<{ id: string; messages: unknown[]; assert: Array<{ type: string; value?: number; name?: string }> }>;
      thresholds: { passRate: number };
    };
    expect(doc.version).toBe(1);
    expect(doc.flow).toBe("my-flow");
    expect(doc.thresholds.passRate).toBe(1);
    const benchCase = doc.cases[0];
    expect(benchCase?.id).toBe("captured-exec-1");
    const assertions = benchCase?.assert ?? [];
    expect(assertions).toContainEqual({ type: "toolCalled", name: "search/docs" });
    expect(assertions).toContainEqual({ type: "finishReason", equals: "stop" });
    // ceil(1.5 * 300) = 450
    expect(assertions.some((a) => a.type === "maxTokens" && a.value === 450)).toBe(true);
    // ceil(2 * 4000ms) = 8000
    expect(assertions.some((a) => a.type === "maxLatencyMs" && a.value === 8000)).toBe(true);
    expect(assertions.some((a) => a.type === "noDiagnostic")).toBe(true);
  });

  it("refuses an execution whose input contains personal data, naming the kinds", async () => {
    const trace = fakeTrace("exec-pii", {
      input_messages: [{ role: "user", content: "Please mail john@example.com about it" }],
    });
    const server = serveTraces(new Map([["exec-pii", trace]]));
    const dir = await tempDir();
    const out = join(dir, "my-flow.bench.yaml");
    const { exitCode, stderr } = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "exec-pii",
      "--out",
      out,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("execution exec-pii contains personal data (email)");
    expect(stderr).toContain("pass --allow-raw");
    let written = true;
    try {
      await readFile(out, "utf8");
    } catch {
      written = false;
    }
    expect(written).toBe(false);
  });

  it("captures personal data with --allow-raw but warns about it", async () => {
    const trace = fakeTrace("exec-pii", {
      input_messages: [{ role: "user", content: "Please mail john@example.com about it" }],
    });
    const server = serveTraces(new Map([["exec-pii", trace]]));
    const dir = await tempDir();
    const out = join(dir, "my-flow.bench.yaml");
    const { exitCode, stderr } = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "exec-pii",
      "--allow-raw",
      "--out",
      out,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("personal data");
    const yaml = await readFile(out, "utf8");
    expect(yaml).toContain("john@example.com");
  });

  it("refuses an existing output file without --append and extends it with it", async () => {
    const traces = new Map<string, FakeTrace>([
      ["exec-1", fakeTrace("exec-1")],
      [
        "exec-2",
        fakeTrace("exec-2", {
          input_messages: [{ role: "user", content: "And now the risks" }],
        }),
      ],
    ]);
    const server = serveTraces(traces);
    const dir = await tempDir();
    const out = join(dir, "my-flow.bench.yaml");

    const first = await runCli(["bench", "capture", "--server", server, "--execution", "exec-1", "--out", out]);
    expect(first.exitCode).toBe(0);

    const refused = await runCli(["bench", "capture", "--server", server, "--execution", "exec-2", "--out", out]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(refused.stderr).toContain("--append");

    const appended = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "exec-2",
      "--append",
      "--out",
      out,
    ]);
    expect(appended.exitCode).toBe(0);
    const yaml = await readFile(out, "utf8");
    const doc = parseYaml(yaml) as { cases: Array<{ id: string }> };
    expect(doc.cases.map((c) => c.id)).toEqual(["captured-exec-1", "captured-exec-2"]);
    expect(yaml).toContain("# captured from execution exec-1");
    expect(yaml).toContain("# captured from execution exec-2");
  });

  it("fails validation and writes nothing when the captured result is invalid", async () => {
    // A trace without input messages yields a case with no messages — the
    // bench contract requires at least one, so the CLI must refuse to write.
    const trace = fakeTrace("exec-empty", { input_messages: [] });
    const server = serveTraces(new Map([["exec-empty", trace]]));
    const dir = await tempDir();
    const out = join(dir, "my-flow.bench.yaml");
    const { exitCode, stderr } = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "exec-empty",
      "--out",
      out,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not validate");
    let written = true;
    try {
      await readFile(out, "utf8");
    } catch {
      written = false;
    }
    expect(written).toBe(false);
  });

  it("fails when an execution id is unknown to the server", async () => {
    const server = serveTraces(new Map());
    const dir = await tempDir();
    const { exitCode, stderr } = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "missing-id",
      "--out",
      join(dir, "my-flow.bench.yaml"),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing-id");
    expect(stderr).toContain("404");
  });

  it("refuses executions from different flows in one bench file", async () => {
    const traces = new Map<string, FakeTrace>([
      ["exec-a", fakeTrace("exec-a", { flow_id: "flow-a" })],
      ["exec-b", fakeTrace("exec-b", { flow_id: "flow-b" })],
    ]);
    const server = serveTraces(traces);
    const dir = await tempDir();
    const { exitCode, stderr } = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "exec-a",
      "--execution",
      "exec-b",
      "--out",
      join(dir, "flow-a.bench.yaml"),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("multiple flows");
  });

  it("requires --execution and --out", async () => {
    const server = serveTraces(new Map());
    const noExecution = await runCli(["bench", "capture", "--server", server, "--out", "x.bench.yaml"]);
    expect(noExecution.exitCode).toBe(1);
    expect(noExecution.stderr).toContain("--execution");
    const noOut = await runCli(["bench", "capture", "--server", server, "--execution", "exec-1"]);
    expect(noOut.exitCode).toBe(1);
    expect(noOut.stderr).toContain("--out");
  });

  it("appends to a hand-written bench file and keeps its existing content", async () => {
    const server = serveTraces(new Map([["exec-2", fakeTrace("exec-2")]]));
    const dir = await tempDir();
    const out = join(dir, "my-flow.bench.yaml");
    await writeFile(
      out,
      `# hand-written bench file\nversion: 1\nflow: my-flow\ncases:\n  # manual case\n  - id: manual-1\n    messages:\n      - role: user\n        content: Hello there\nthresholds:\n  passRate: 1\n`,
    );
    const { exitCode } = await runCli([
      "bench",
      "capture",
      "--server",
      server,
      "--execution",
      "exec-2",
      "--append",
      "--out",
      out,
    ]);
    expect(exitCode).toBe(0);
    const yaml = await readFile(out, "utf8");
    expect(yaml).toContain("# hand-written bench file");
    expect(yaml).toContain("# manual case");
    const doc = parseYaml(yaml) as { cases: Array<{ id: string }> };
    expect(doc.cases.map((c) => c.id)).toEqual(["manual-1", "captured-exec-2"]);
  });
});
