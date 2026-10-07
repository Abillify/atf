// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const ERASURE_TOKEN = "erasure-service-token";
const PLAIN_TOKEN = "plain-service-token";

const READ_TOOL = {
  name: "list_orders",
  type: "database",
  access: "read",
  database: "main",
  query: "SELECT id FROM orders",
  inputSchema: { type: "object", properties: {}, required: [] },
};

interface StartOptions {
  auditFile: string;
  appendOnly?: boolean;
  tenantIsolation?: boolean;
}

async function start(options: StartOptions): Promise<number> {
  const tenantIsolation = options.tenantIsolation ?? false;
  const config = AppConfigSchema.parse({
    server: { port: 3000, rateLimit: { enabled: false } },
    auth: {
      mode: "static",
      static: {
        tokens: [
          {
            token: ERASURE_TOKEN,
            subject: "erasure-svc",
            scopes: ["gate.erasure"],
            ...(tenantIsolation ? { claims: { tenant_id: "acme" } } : {}),
          },
          {
            token: PLAIN_TOKEN,
            subject: "plain-svc",
            scopes: ["tools.read"],
            ...(tenantIsolation ? { claims: { tenant_id: "acme" } } : {}),
          },
        ],
      },
    },
    ...(tenantIsolation ? { tenantIsolation: { enabled: true } } : {}),
    monitoring: {
      enabled: true,
      audit: { enabled: true, file: options.auditFile, appendOnly: options.appendOnly ?? false },
    },
    tools: [READ_TOOL],
  });
  handle = await buildApp(config, { db: new FakeDb({ main: [{ id: 1 }] }) });
  const l = await listen(handle.app);
  server = l.server;
  return l.port;
}

let handle: AppHandle | undefined;
let server: Server | undefined;

afterEach(async () => {
  server?.close();
  if (handle) await handle.shutdown();
  handle = undefined;
  server = undefined;
});

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: randomUUID(),
    tenantId: "acme",
    subject: { userId: "user-42", email: "alice@example.com" },
    scope: "subject",
    ...overrides,
  };
}

/** `null` means "send no authorization header" — `undefined` would trigger the default parameter. */
async function post(
  port: number,
  payload: unknown,
  token: string | null = ERASURE_TOKEN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/erasure`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function seedAuditFile(file: string): void {
  const lines = [
    JSON.stringify({ id: 1, ts: "t", type: "tool_call", subject: "user-42", meta: { a: 1 } }),
    JSON.stringify({
      id: 2,
      ts: "t",
      type: "auth",
      meta: { claims: { email: "alice@example.com" } },
    }),
    JSON.stringify({ id: 3, ts: "t", type: "tool_call", subject: "user-7" }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function fileLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("POST /v1/erasure (Req 2.8)", () => {
  it("rejects an invalid request body with 400", async () => {
    const port = await start({ auditFile: join(mkdtempSync(join(tmpdir(), "atf-er-")), "a.jsonl") });
    const res = await post(port, { tenantId: "acme", scope: "subject" });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("ERASURE_REQUEST_INVALID");
    expect(Array.isArray(res.json.issues)).toBe(true);
  });

  it("requires a bearer token (401)", async () => {
    const port = await start({ auditFile: join(mkdtempSync(join(tmpdir(), "atf-er-")), "a.jsonl") });
    const res = await post(port, body(), null);
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("AUTHENTICATION_FAILED");
  });

  it("requires the gate.erasure scope (403)", async () => {
    const port = await start({ auditFile: join(mkdtempSync(join(tmpdir(), "atf-er-")), "a.jsonl") });
    const res = await post(port, body(), PLAIN_TOKEN);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("SCOPE_REQUIRED");
  });

  it("erases subject events and reports the store result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-er-"));
    const file = join(dir, "audit.jsonl");
    const port = await start({ auditFile: file });
    seedAuditFile(file);
    const res = await post(port, body());
    expect(res.status).toBe(200);
    expect(res.json.service).toBe("gate");
    const results = res.json.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]?.store).toBe("gate.audit");
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.erased).toBe(2);
    const lines = fileLines(file);
    expect(lines.filter((l) => l.erased === true)).toHaveLength(2);
    expect(lines.filter((l) => l.erased !== true).map((l) => l.id)).toEqual([3]);
  });

  it("dry run counts without rewriting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-er-"));
    const file = join(dir, "audit.jsonl");
    const port = await start({ auditFile: file });
    seedAuditFile(file);
    const before = readFileSync(file, "utf8");
    const res = await post(port, body({ dryRun: true }));
    expect(res.status).toBe(200);
    const results = res.json.results as Array<Record<string, unknown>>;
    expect(results[0]?.erased).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("replays an identical requestId+body from the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-er-"));
    const file = join(dir, "audit.jsonl");
    const port = await start({ auditFile: file });
    seedAuditFile(file);
    const payload = body();
    const first = await post(port, payload);
    expect(first.status).toBe(200);
    const replay = await post(port, payload);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    // The replay must not double-erase: file state equals the first run's.
    expect(fileLines(file).filter((l) => l.erased === true)).toHaveLength(2);
  });

  it("409s when a taken requestId is reused with a different payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-er-"));
    const file = join(dir, "audit.jsonl");
    const port = await start({ auditFile: file });
    seedAuditFile(file);
    const payload = body();
    expect((await post(port, payload)).status).toBe(200);
    const conflict = await post(port, { ...payload, subject: { userId: "someone-else" } });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
  });

  it("403 TENANT_MISMATCH under tenant isolation with a foreign tenantId", async () => {
    const port = await start({
      auditFile: join(mkdtempSync(join(tmpdir(), "atf-er-")), "a.jsonl"),
      tenantIsolation: true,
    });
    const res = await post(port, body({ tenantId: "other-corp" }));
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("TENANT_MISMATCH");
  });

  it("reports not_configured (HTTP 200) when the sink is append-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-er-"));
    const file = join(dir, "audit.jsonl");
    const port = await start({ auditFile: file, appendOnly: true });
    seedAuditFile(file);
    const before = readFileSync(file, "utf8");
    const res = await post(port, body());
    expect(res.status).toBe(200);
    const results = res.json.results as Array<Record<string, unknown>>;
    expect(results[0]?.status).toBe("not_configured");
    expect(results[0]?.erased).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
