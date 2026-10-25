// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `cli.ts flows release`: the release gate runs a flow's bench file
 * against a server. A fake OpenAI-compatible server (Bun.serve on port 0)
 * answers the completions and serves the debug trace of each execution; a
 * temporary git repository provides the `--base` revision for the SemVer
 * version gate.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyReleaseReceiptSignature,
  type FlowReleaseReceipt,
} from "../../src/eval/flow-release.js";
import { parseEvidenceSigningKey } from "../../src/observability/evidence-key.js";
import { resolveFlowFile } from "../../src/graph/flow-parser/loader.js";
import { computeFlowDigest } from "../../src/graph/flow-revision.js";

const cli = join(import.meta.dir, "..", "cli.ts");

/**
 * What the fake server reports as the executed revision in the debug trace:
 * `"head"` = the digest and version of the local flow file (set per test),
 * `"missing"` = no readable trace (404).
 */
let traceMode: "head" | "missing" = "head";
let traceRevision: { flow_digest?: string; flow_version?: string } = {};
let executionCounter = 0;

/**
 * Answers POST /v1/chat/completions with the last user message echoed back
 * and GET /monitoring/debug/<id> with the revision in {@link traceRevision}.
 */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.startsWith("/monitoring/debug/")) {
      if (traceMode === "missing") return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ nodes: [], ...traceRevision });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return req
        .json()
        .then((body: { messages?: { content?: string }[] }) => {
          const last = body.messages?.[body.messages.length - 1]?.content ?? "";
          executionCounter += 1;
          return Response.json({
            id: `chatcmpl-rel-test-${executionCounter}`,
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

/** Lets the fake server report the revision of the local flow file. */
function serveHeadRevision(): void {
  traceMode = "head";
  traceRevision = {
    flow_digest: computeFlowDigest(resolveFlowFile(join(dir, "demo.yaml"))),
    flow_version: "1.2.3",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-flows-release-"));
  writeFileSync(join(dir, "model-shortcuts.yaml"), "shortcuts: {}\n");
  mkdirSync(join(dir, "bench"));
  writeFileSync(join(dir, "demo.yaml"), FLOW_V1);
  writeFileSync(join(dir, "bench", "demo.bench.yaml"), BENCH);
  serveHeadRevision();
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

  test("the flow's slo supplies a token threshold the bench file omits", async () => {
    // The fake server reports 10 tokens per case; the slo caps the p50 at 5.
    writeFileSync(
      join(dir, "demo.yaml"),
      FLOW_V1.replace("nodes:", "slo:\n  maxTokensP50: 5\nnodes:"),
    );
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("p50 tokens 10 above max 5");
  });

  test("a bench file threshold wins over the flow's slo", async () => {
    writeFileSync(
      join(dir, "demo.yaml"),
      FLOW_V1.replace("nodes:", "slo:\n  maxTokensP50: 5\nnodes:"),
    );
    writeFileSync(
      join(dir, "bench", "demo.bench.yaml"),
      `${BENCH}  maxTokensP50: 20\n`,
    );
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl);
    expect(result.exitCode).toBe(0);
  });

  test("the receipt records which source supplied each threshold", async () => {
    writeFileSync(
      join(dir, "demo.yaml"),
      FLOW_V1.replace("nodes:", "slo:\n  p50LatencyMs: 60000\n  maxTokensP50: 100\nnodes:"),
    );
    writeFileSync(
      join(dir, "bench", "demo.bench.yaml"),
      `${BENCH}  maxLatencyMsP50: 30000\n`,
    );
    // The flow file changed after beforeEach: let the server report its digest.
    serveHeadRevision();
    const keyPath = join(dir, "signing.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("base64"));
    const receiptPath = join(dir, "demo.release-receipt.json");
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--signing-key-file",
      keyPath,
      "--out",
      receiptPath,
    );
    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(
      readFileSync(receiptPath, "utf8"),
    ) as FlowReleaseReceipt;
    expect(receipt.thresholds.maxLatencyMsP50).toBe(30000);
    expect(receipt.thresholds.maxTokensP50).toBe(100);
    expect(receipt.thresholds.sources).toEqual({
      maxLatencyMsP50: "bench",
      maxTokensP50: "slo",
    });
    const key = parseEvidenceSigningKey(Buffer.alloc(32, 7).toString("base64"));
    if (key === undefined) throw new Error("fixture signing key missing");
    expect(verifyReleaseReceiptSignature(receipt, key.publicKeyRaw)).toBe(true);
  });

  test("a release without slo and without those thresholds records no sources", async () => {
    const keyPath = join(dir, "signing.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("base64"));
    const receiptPath = join(dir, "demo.release-receipt.json");
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--signing-key-file",
      keyPath,
      "--out",
      receiptPath,
    );
    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(
      readFileSync(receiptPath, "utf8"),
    ) as FlowReleaseReceipt;
    expect(receipt.thresholds.sources).toBeUndefined();
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

  test("--signing-key-file writes a verifiable release receipt", async () => {
    const keyPath = join(dir, "signing.key");
    // Fixed synthetic seed.
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("base64"));
    const receiptPath = join(dir, "demo.release-receipt.json");
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--json",
      "--signing-key-file",
      keyPath,
      "--out",
      receiptPath,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.toString().replace(/^[^{]*/, ""));
    expect(payload.receiptPath).toBe(receiptPath);

    const receipt = JSON.parse(
      readFileSync(receiptPath, "utf8"),
    ) as FlowReleaseReceipt;
    expect(receipt.type).toBe("atf.flow-release-receipt");
    expect(receipt.flowId).toBe("demo");
    expect(receipt.flowVersion).toBe("1.2.3");
    expect(receipt.signature.alg).toBe("EdDSA");
    const key = parseEvidenceSigningKey(Buffer.alloc(32, 7).toString("base64"));
    if (key === undefined) throw new Error("fixture signing key missing");
    expect(receipt.signature.kid).toBe(key.kid);
    expect(verifyReleaseReceiptSignature(receipt, key.publicKeyRaw)).toBe(true);
  });

  test("--signing-key-file with an empty key file exits 1", async () => {
    const keyPath = join(dir, "empty.key");
    writeFileSync(keyPath, "");
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--signing-key-file",
      keyPath,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("is empty");
  });

  test("a failed gate does not write a receipt", async () => {
    const keyPath = join(dir, "signing.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("base64"));
    const receiptPath = join(dir, "demo.release-receipt.json");
    writeFileSync(
      join(dir, "bench", "demo.bench.yaml"),
      BENCH.replace("value: Hallo", "value: never-matches"),
    );
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--signing-key-file",
      keyPath,
      "--out",
      receiptPath,
    );
    expect(result.exitCode).toBe(1);
    expect(existsSync(receiptPath)).toBe(false);
  });

  test("signing: a server that ran another flow digest exits 1 without a receipt", async () => {
    const keyPath = join(dir, "signing.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("base64"));
    const receiptPath = join(dir, "demo.release-receipt.json");
    traceRevision = { ...traceRevision, flow_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--signing-key-file",
      keyPath,
      "--out",
      receiptPath,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Revision: greeting: the server ran flow digest sha256:0000");
    expect(existsSync(receiptPath)).toBe(false);
  });

  test("signing: a server that ran another flow version exits 1 without a receipt", async () => {
    const keyPath = join(dir, "signing.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("base64"));
    const receiptPath = join(dir, "demo.release-receipt.json");
    traceRevision = { ...traceRevision, flow_version: "1.2.2" };
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--signing-key-file",
      keyPath,
      "--out",
      receiptPath,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("the server ran flow version 1.2.2, not the local 1.2.3");
    expect(existsSync(receiptPath)).toBe(false);
  });

  test("signing: a missing debug trace exits 1 without a receipt", async () => {
    const keyPath = join(dir, "signing.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("base64"));
    const receiptPath = join(dir, "demo.release-receipt.json");
    traceMode = "missing";
    const result = await release(
      "demo",
      "--flows-dir",
      dir,
      "--server",
      serverUrl,
      "--signing-key-file",
      keyPath,
      "--out",
      receiptPath,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("no flow_digest in the debug trace");
    expect(existsSync(receiptPath)).toBe(false);
  });

  test("without signing, a missing debug trace does not fail the gate", async () => {
    traceMode = "missing";
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl);
    expect(result.exitCode).toBe(0);
  });

  test("version gate: a changed sub-flow with an unchanged version exits 1", async () => {
    mkdirSync(join(dir, "subflows"));
    writeFileSync(
      join(dir, "subflows", "extra.yaml"),
      ["nodes:", "  - id: b", "    type: llm", "    llm: { provider: openai, model: gpt-4o }", "edges: []", ""].join("\n"),
    );
    writeFileSync(
      join(dir, "demo.yaml"),
      FLOW_V1.replace("  version: 1.2.3", "  version: 1.2.3\n  $include:\n    subflows: [subflows/extra.yaml]"),
    );
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    // Only the included sub-flow changes; demo.yaml itself is untouched.
    writeFileSync(
      join(dir, "subflows", "extra.yaml"),
      ["nodes:", "  - id: b", "    type: llm", "    llm: { provider: openai, model: gpt-4o-mini }", "edges: []", ""].join("\n"),
    );
    const result = await release("demo", "--flows-dir", dir, "--server", serverUrl, "--base", "HEAD");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "flow changed but metadata.version was not raised (1.2.3 → 1.2.3)",
    );
  });
});
