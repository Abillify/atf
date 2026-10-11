// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErasureRequestSchema, type ErasureRequest } from "@atf/erasure-contract";
import { AuditSink, GATE_AUDIT_STORE } from "../../src/monitor/audit.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import type { AuditConfig } from "../../src/monitor/audit.ts";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "atf-audit-")), "audit.jsonl");
}

function auditConfig(overrides: Partial<AuditConfig> = {}): AuditConfig {
  return {
    enabled: true,
    file: tempFile(),
    redact: { enabled: true, paths: ["query.bindings"], extraKeys: [] },
    appendOnly: false,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): ErasureRequest {
  const parsed = ErasureRequestSchema.safeParse({
    requestId: "5f0f0b0a-1111-4aaa-8bbb-000000000001",
    tenantId: "acme",
    subject: { userId: "user-42", email: "alice@example.com" },
    scope: "subject",
    ...overrides,
  });
  if (!parsed.success) throw new Error(`invalid test request: ${parsed.error.message}`);
  return parsed.data;
}

function readRawLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

/** Parse every line, keeping unparseable lines verbatim as raw strings. */
function readLines(file: string): Array<Record<string, unknown> | string> {
  return readRawLines(file).map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return l;
    }
  });
}

function parsedLines(file: string): Array<Record<string, unknown>> {
  return readLines(file).filter(
    (l): l is Record<string, unknown> => typeof l !== "string",
  );
}

/**
 * Wait until the audit file contains at least `count` parsed lines. A fixed
 * sleep is flaky under parallel test load (the sink flush can exceed it), so
 * poll with a generous deadline instead.
 */
async function waitForParsedLines(
  file: string,
  count: number,
  timeoutMs = 2000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = existsSync(file) ? parsedLines(file) : [];
    if (lines.length >= count) return lines;
    if (Date.now() >= deadline) return lines;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let sink: AuditSink | undefined;

afterEach(async () => {
  await sink?.close();
  sink = undefined;
});

describe("AuditSink · sink-level redaction (Req 2.8)", () => {
  it("redacts configured meta paths before persisting", async () => {
    sink = new AuditSink(auditConfig());
    const bus = new MonitorBus(10);
    sink.attach(bus);
    bus.publish({
      type: "tool_call",
      tool: "database.query",
      meta: {
        query: { sql: "SELECT * FROM users WHERE email = ?", bindings: ["alice@example.com", 42] },
        rowCount: 1,
      },
    });
    const lines = await waitForParsedLines(sink["config"].file as string, 1);
    expect(lines).toHaveLength(1);
    const meta = lines[0]?.meta as Record<string, Record<string, unknown>>;
    expect(meta.query?.bindings).toBe("[redacted]");
    // Non-targeted parts of the same subtree stay intact.
    expect(meta.query?.sql).toBe("SELECT * FROM users WHERE email = ?");
    expect(meta.rowCount).toBe(1);
  });

  it("redacts extraKeys fragments on top-level meta", async () => {
    const config = auditConfig({
      redact: { enabled: true, paths: [], extraKeys: ["customer_note"] },
    });
    sink = new AuditSink(config);
    const bus = new MonitorBus(10);
    sink.attach(bus);
    bus.publish({
      type: "tool_call",
      meta: { customer_note: "lives at Main Street 1", other: "keep" },
    });
    const lines = await waitForParsedLines(config.file as string, 1);
    const meta = lines[0]?.meta as Record<string, unknown>;
    expect(meta.customer_note).toBe("[redacted]");
    expect(meta.other).toBe("keep");
  });

  it("keeps raw values when redaction is disabled", async () => {
    const config = auditConfig({
      redact: { enabled: false, paths: ["query.bindings"], extraKeys: [] },
    });
    sink = new AuditSink(config);
    const bus = new MonitorBus(10);
    sink.attach(bus);
    bus.publish({
      type: "tool_call",
      meta: { query: { bindings: ["alice@example.com"] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const meta = parsedLines(config.file as string)[0]?.meta as Record<
      string,
      Record<string, unknown>
    >;
    expect(meta.query?.bindings).toEqual(["alice@example.com"]);
  });

  it("is a no-op for paths that do not exist", async () => {
    const config = auditConfig({
      redact: { enabled: true, paths: ["deep.missing.path"], extraKeys: [] },
    });
    sink = new AuditSink(config);
    const bus = new MonitorBus(10);
    sink.attach(bus);
    bus.publish({ type: "tool_call", meta: { kept: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const meta = parsedLines(config.file as string)[0]?.meta as Record<string, unknown>;
    expect(meta).toEqual({ kept: 1 });
  });
});

describe("AuditSink · subject erasure (Req 2.8)", () => {
  function seed(file: string): void {
    const lines = [
      // Matches via event.subject.
      JSON.stringify({ id: 1, ts: "t", type: "tool_call", subject: "user-42", meta: { a: 1 } }),
      // Matches via meta.claims.email.
      JSON.stringify({
        id: 2,
        ts: "t",
        type: "auth",
        username: "svc",
        meta: { claims: { sub: "s-9", email: "Alice@Example.com" } },
      }),
      // Foreign subject — must survive.
      JSON.stringify({ id: 3, ts: "t", type: "tool_call", subject: "user-7", meta: { b: 2 } }),
      // Foreign tenant — must survive even with a matching subject.
      JSON.stringify({
        id: 4,
        ts: "t",
        type: "tool_call",
        subject: "user-42",
        meta: { claims: { tenant_id: "other-corp" } },
      }),
      // Corrupt line — kept verbatim.
      "{not-json",
    ];
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  }

  it("tombstones matching events and keeps foreign ones", async () => {
    sink = new AuditSink(auditConfig());
    seed(sink["config"].file as string);
    const result = await sink.erase(request(), false);
    expect(result).toEqual({ store: GATE_AUDIT_STORE, status: "ok", erased: 2 });
    const lines = readLines(sink["config"].file as string);
    // 2 tombstones + foreign subject + foreign tenant + corrupt line (verbatim).
    expect(lines).toHaveLength(5);
    expect(lines).toContain("{not-json");
    const parsed = lines.filter(
      (l): l is Record<string, unknown> => typeof l !== "string",
    );
    const tombstones = parsed.filter((l) => l.erased === true);
    expect(tombstones).toHaveLength(2);
    for (const t of tombstones) {
      expect(t.message).toBe("[erased]");
      expect(t.subject).toBeUndefined();
      expect(t.meta).toBeUndefined();
      expect(t.username).toBeUndefined();
    }
    const survivors = parsed.filter((l) => l.erased !== true);
    expect(survivors.map((l) => l.id)).toEqual([3, 4]);
  });

  it("dry run counts without rewriting the file", async () => {
    sink = new AuditSink(auditConfig());
    const file = sink["config"].file as string;
    seed(file);
    const before = readFileSync(file, "utf8");
    const result = await sink.erase(request(), true);
    expect(result.status).toBe("ok");
    expect(result.erased).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("reports ok/0 when the file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-audit-empty-"));
    sink = new AuditSink(auditConfig({ file: join(dir, "sub", "missing.jsonl") }));
    const result = await sink.erase(request(), false);
    expect(result).toEqual({ store: GATE_AUDIT_STORE, status: "ok", erased: 0 });
  });

  it("honestly reports not_configured when disabled", async () => {
    sink = new AuditSink(auditConfig({ enabled: false }));
    const result = await sink.erase(request(), false);
    expect(result.status).toBe("not_configured");
    expect(result.erased).toBe(0);
    expect(result.error).toContain("not configured");
  });

  it("honestly reports not_configured when append-only is committed", async () => {
    sink = new AuditSink(auditConfig({ appendOnly: true }));
    const file = sink["config"].file as string;
    seed(file);
    const before = readFileSync(file, "utf8");
    const result = await sink.erase(request(), false);
    expect(result.status).toBe("not_configured");
    expect(result.erased).toBe(0);
    expect(result.error).toContain("append-only");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("tenant scope erases all events of the requesting tenant only", async () => {
    sink = new AuditSink(auditConfig());
    const file = sink["config"].file as string;
    const lines = [
      JSON.stringify({
        id: 1,
        ts: "t",
        type: "tool_call",
        subject: "user-1",
        meta: { claims: { tenant_id: "acme" } },
      }),
      JSON.stringify({
        id: 2,
        ts: "t",
        type: "tool_call",
        subject: "user-2",
        meta: { claims: { tenant_id: "other-corp" } },
      }),
      // No tenant claim — cannot be attributed, kept.
      JSON.stringify({ id: 3, ts: "t", type: "tool_call", subject: "user-3" }),
    ];
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const result = await sink.erase(request({ scope: "tenant", subject: undefined }), false);
    expect(result.status).toBe("ok");
    expect(result.erased).toBe(1);
    const survivors = parsedLines(file);
    expect(survivors.filter((l) => l.erased !== true).map((l) => l.id)).toEqual([2, 3]);
  });

  it("reopens the append stream after a rewrite", async () => {
    sink = new AuditSink(auditConfig());
    const file = sink["config"].file as string;
    const bus = new MonitorBus(10);
    sink.attach(bus);
    bus.publish({ type: "tool_call", subject: "user-42" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sink.erase(request(), false);
    bus.publish({ type: "tool_call", subject: "user-99" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = parsedLines(file);
    expect(lines.some((l) => l.erased === true)).toBe(true);
    expect(lines.some((l) => l.subject === "user-99")).toBe(true);
  });

  it("failed state on unreadable file (directory in the way)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-audit-bad-"));
    mkdirSync(join(dir, "audit.jsonl")); // a directory where a file is expected
    sink = new AuditSink(auditConfig({ file: join(dir, "audit.jsonl") }));
    const result = await sink.erase(request(), false);
    expect(result.status).toBe("failed");
    expect(result.erased).toBe(0);
    expect(result.error).toBeDefined();
  });
});
