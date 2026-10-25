// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `cli.ts citations impact` — the operator command that fetches
 * `GET /monitoring/citation-impact` and reports past answers whose cited
 * passages changed or disappeared.
 *
 * Pins: exit code 2 when executions are affected and 0 when none are, the
 * `--out` file, `--json` output, and the `--since` validation.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "cli.ts");

interface FakeReport {
  generated_at: string;
  since: string;
  tenant_id: string | null;
  summary: {
    executions_checked: number;
    executions_affected: number;
    chunks: Record<string, number>;
  };
  affected: unknown[];
}

function report(affected: number): FakeReport {
  return {
    generated_at: "2026-10-20T12:00:00.000Z",
    since: "2026-07-01T00:00:00.000Z",
    tenant_id: null,
    summary: {
      executions_checked: 10,
      executions_affected: affected,
      chunks: {
        current: 8,
        carried: 0,
        changed: affected,
        removed: 0,
        unknown: 0,
      },
    },
    affected:
      affected > 0
        ? [
            {
              execution_id: "exec-1",
              flow_id: "flows/test",
              flow_version: "1.0.0",
              created_at: "2026-10-01T10:00:00.000Z",
              chunks: [
                {
                  base_ref: "doc-a",
                  chunk_id: "c1",
                  status: "changed",
                  current_revision: "7",
                },
              ],
            },
          ]
        : [],
  };
}

const servers: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

function serve(payload: unknown, status = 200): string {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(payload, { status }) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("cli.ts citations impact", () => {
  it("exits 2 when executions are affected and prints them", async () => {
    const server = serve(report(1));
    const { exitCode, stdout } = await runCli([
      "citations",
      "impact",
      "--server",
      server,
    ]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("exec-1");
    expect(stdout).toContain("changed");
    expect(stdout).toContain("doc-a#c1");
  });

  it("exits 0 when nothing is affected", async () => {
    const server = serve(report(0));
    const { exitCode, stdout } = await runCli([
      "citations",
      "impact",
      "--server",
      server,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No answers cite a changed or removed passage");
  });

  it("writes the report to --out and prints it raw with --json", async () => {
    const server = serve(report(1));
    const dir = await mkdtemp(join(tmpdir(), "atf-citations-"));
    const out = join(dir, "impact.json");
    try {
      const { exitCode, stdout } = await runCli([
        "citations",
        "impact",
        "--server",
        server,
        "--out",
        out,
        "--json",
      ]);
      expect(exitCode).toBe(2);
      const written = JSON.parse(await readFile(out, "utf8")) as FakeReport;
      expect(written.summary.executions_affected).toBe(1);
      const printed = JSON.parse(stdout) as FakeReport;
      expect(printed.since).toBe("2026-07-01T00:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid --since with exit 1", async () => {
    const { exitCode, stderr } = await runCli([
      "citations",
      "impact",
      "--server",
      "http://127.0.0.1:1",
      "--since",
      "neunzig",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--since must be an RFC 3339 timestamp");
  });

  it("sends the bearer token and surfaces a server error", async () => {
    let authHeader: string | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        authHeader = req.headers.get("authorization") ?? undefined;
        return Response.json(
          { error: { message: "Unauthorized monitoring access." } },
          { status: 401 },
        );
      },
    });
    servers.push(server);
    const { exitCode, stderr } = await runCli([
      "citations",
      "impact",
      "--server",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "op-tok",
    ]);
    expect(exitCode).toBe(1);
    expect(authHeader).toBe("Bearer op-tok");
    expect(stderr).toContain("HTTP 401");
  });

  it("passes --base-ref through as a query parameter", async () => {
    let url = "";
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        url = req.url;
        return Response.json(report(0));
      },
    });
    servers.push(server);
    const { exitCode } = await runCli([
      "citations",
      "impact",
      "--server",
      `http://127.0.0.1:${server.port}`,
      "--base-ref",
      "doc-42",
      "--since",
      "30d",
    ]);
    expect(exitCode).toBe(0);
    expect(url).toContain("base_ref=doc-42");
    expect(url).toContain("since=");
  });
});
