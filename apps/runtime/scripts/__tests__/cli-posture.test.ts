// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `posture`: reports which governance controls are active. Local mode builds
 * the report from the environment (like `doctor`); `--server` fetches the live
 * report from `GET /monitoring/posture`. Exit code 1 when a check fails.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "cli.ts");

// A minimal valid compliance policy in a temp flows dir, so the `policy`
// check can be satisfied in the "everything configured" scenarios.
let flowsDir: string;
beforeAll(() => {
  flowsDir = mkdtempSync(join(tmpdir(), "atf-posture-flows-"));
  writeFileSync(
    join(flowsDir, "compliance-policy.yaml"),
    'version: "1"\ndataRules:\n  - dataClass: personal\n    allowedProviders: []\n',
  );
});
afterAll(() => {
  if (flowsDir) rmSync(flowsDir, { recursive: true, force: true });
});

// Async spawn (not spawnSync): the --server tests serve from this process,
// and a synchronous spawn would block the event loop the server needs.
async function run(env: Record<string, string>, ...argv: string[]) {
  const proc = Bun.spawn(["bun", "run", cli, "posture", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: (() => {
      const env2: Record<string, string> = { ...process.env };
      // Start from a known-empty posture: no signing material, no shared store.
      // Empty strings fail config validation, so the keys must be removed.
      for (const k of [
        "EVIDENCE_SIGNING_KEY",
        "AUDIT_ANCHOR_SECRET",
        "EVIDENCE_BUNDLE_SECRET",
        "RECEIPT_SIGNING_KEY",
        "REDIS_URL",
        "DATABASE_URL",
        "DATABASE_OPERATOR_URL",
        "AUDIT_PSEUDONYM_PEPPER",
        "PII_VAULT_ENABLED",
        "APPROVAL_GATE_ENABLED",
        "REPLICAS",
        "AUTHN_MODE",
      ]) {
        delete env2[k];
      }
      return { ...env2, ...env };
    })(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

const servers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

describe("posture (local mode)", () => {
  test("prints the STATUS ID MESSAGE table and exits 1 when a check fails", async () => {
    // No EVIDENCE_SIGNING_KEY and no HMAC secret → evidence_key fails.
    const res = await run({});
    const out = res.stdout;
    expect(res.exitCode).toBe(1);
    expect(out).toContain("FAIL  evidence_key");
    expect(out).toContain("taint");
    expect(out).toContain("overall: FAIL");
  });

  test("exits 0 when no check fails", async () => {
    const res = await run({
      EVIDENCE_SIGNING_KEY: "a-signing-key-at-least-16-chars",
      AUDIT_ANCHOR_FILE: "/tmp/atf-posture-anchor.log",
      EGRESS_ALLOWED_HOSTS: "api.openai.com",
      AI_DISCLOSURE: "header",
      DECISION_RECEIPTS_ENABLED: "true",
      RECEIPT_SIGNING_KEY: "a-receipt-key-at-least-16-chars",
      DATABASE_URL: "postgres://localhost/unused",
      AUDIT_PSEUDONYM_PEPPER: "synthetic-posture-pepper-0123456789abcdef",
      PII_VAULT_ENABLED: "true",
      PII_VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      APPROVAL_GATE_ENABLED: "true",
      FLOWS_DIR: flowsDir,
    });
    expect(res.stdout).toContain("overall: OK");
    expect(res.exitCode).toBe(0);
  });

  test("--json prints the raw report", async () => {
    const res = await run({
      EVIDENCE_SIGNING_KEY: "a-signing-key-at-least-16-chars",
      AUDIT_ANCHOR_FILE: "/tmp/atf-posture-anchor.log",
      EGRESS_ALLOWED_HOSTS: "api.openai.com",
      AI_DISCLOSURE: "header",
      DECISION_RECEIPTS_ENABLED: "true",
      RECEIPT_SIGNING_KEY: "a-receipt-key-at-least-16-chars",
      DATABASE_URL: "postgres://localhost/unused",
      AUDIT_PSEUDONYM_PEPPER: "synthetic-posture-pepper-0123456789abcdef",
      PII_VAULT_ENABLED: "true",
      PII_VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      APPROVAL_GATE_ENABLED: "true",
      FLOWS_DIR: flowsDir,
    }, "--json");
    expect(res.exitCode).toBe(0);
    const report = JSON.parse(res.stdout) as {
      status: string;
      summary: { ok: number; warn: number; fail: number };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.status).toBe("ok");
    expect(report.summary.fail).toBe(0);
    expect(report.checks.map((c) => c.id)).toContain("evidence_key");
  });
});

describe("posture (--server)", () => {
  test("fetches the live report and exits 0 when it is ok", async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      status: "ok",
      summary: { ok: 9, warn: 0, fail: 0 },
      checks: [{ id: "evidence_key", status: "ok", message: "signed" }],
    };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/monitoring/posture") {
          const auth = req.headers.get("authorization") ?? "";
          if (auth !== "Bearer tok-1") {
            return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
          }
          return Response.json(report);
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push({ stop: () => server.stop() });

    const res = await run({}, "--server", `http://127.0.0.1:${server.port}`, "--token", "tok-1");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("OK    evidence_key");
  });

  test("exits 1 when the live report has a failing check", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          generatedAt: new Date().toISOString(),
          status: "fail",
          summary: { ok: 8, warn: 0, fail: 1 },
          checks: [{ id: "flow_load", status: "fail", message: "2 flow file(s) failed" }],
        });
      },
    });
    servers.push({ stop: () => server.stop() });

    const res = await run({}, "--server", `http://127.0.0.1:${server.port}`);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("FAIL  flow_load");
  });

  test("exits 1 with a clear message when the server rejects the token", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ error: { message: "Unauthorized monitoring access." } }, { status: 401 });
      },
    });
    servers.push({ stop: () => server.stop() });

    const res = await run({}, "--server", `http://127.0.0.1:${server.port}`, "--token", "wrong");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("401");
  });
});
