// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { Database } from "../../db/database.js";
import { MirroredTranscriptStore, PostgresAssistantSessionStore, ToolJournalConflictError } from "../session-store.js";
import type { TranscriptEntry, TranscriptStore } from "../transcript-store.js";
import type { AssistantScope } from "../types.js";

const scope: AssistantScope = { tenantId: "tenant", userId: "user", assistantId: "assistant" };
const now = "2026-03-01T00:00:00.000Z";

function database(query: (sql: string, params: unknown[]) => Promise<unknown[]>): Database {
  return { query } as unknown as Database;
}

function session(conversationId: string, parent: string | null, fork: number | null) {
  return {
    conversation_id: conversationId,
    parent_conversation_id: parent,
    forked_from_sequence: fork,
    title: null,
    last_sequence: 10,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

function event(conversationId: string, sequence: number): Record<string, unknown> {
  return {
    id: `${conversationId}-${sequence}`,
    execution_id: `run-${sequence}`,
    conversation_id: conversationId,
    sequence,
    role: sequence % 2 === 0 ? "assistant" : "user",
    name: null,
    content: `${conversationId}:${sequence}`,
    created_at: now,
  };
}

describe("PostgresAssistantSessionStore lineage", () => {
  test("reconstructs all ancestors at their fork boundaries and applies one global limit", async () => {
    const sessions = new Map([
      ["root", session("root", null, null)],
      ["branch", session("branch", "root", 3)],
      ["leaf", session("leaf", "branch", 2)],
    ]);
    const events = new Map([
      ["root", [1, 2, 3, 4].map((sequence) => event("root", sequence))],
      ["branch", [1, 2, 3].map((sequence) => event("branch", sequence))],
      ["leaf", [1, 2].map((sequence) => event("leaf", sequence))],
    ]);
    const store = new PostgresAssistantSessionStore(
      database(async (sql, params) => {
        const conversationId = String(params[3]);
        if (sql.includes("FROM assistant_sessions"))
          return sessions.get(conversationId) === undefined ? [] : [sessions.get(conversationId)];
        if (sql.includes("FROM assistant_session_events")) {
          const maximum = params[4] === null ? Number.POSITIVE_INFINITY : Number(params[4]);
          const limit = Number(params[5]);
          return (events.get(conversationId) ?? [])
            .filter((row) => Number(row.sequence) <= maximum)
            .sort((a, b) => Number(b.sequence) - Number(a.sequence))
            .slice(0, limit);
        }
        return [];
      }),
    );

    const entries = await store.read(scope, "leaf", 5);
    expect(entries.map((entry) => entry.content)).toEqual([
      "root:3",
      "branch:1",
      "branch:2",
      "leaf:1",
      "leaf:2",
    ]);
  });

  test("rejects cyclic lineage instead of looping", async () => {
    const store = new PostgresAssistantSessionStore(
      database(async (sql, params) => {
        if (sql.includes("FROM assistant_sessions")) {
          const id = String(params[3]);
          return [session(id, id === "a" ? "b" : "a", 1)];
        }
        return [];
      }),
    );
    await expect(store.read(scope, "a", 5)).rejects.toThrow("cycle");
  });
});

describe("authoritative transcript projection", () => {
  test("returns the persisted id/sequence and places the same record in the outbox", async () => {
    let outboxPayload: TranscriptEntry | undefined;
    const store = new PostgresAssistantSessionStore(
      database(async (sql, params) => {
        if (sql.includes("RETURNING last_sequence")) return [{ last_sequence: 7 }];
        if (sql.includes("INSERT INTO assistant_mirror_outbox"))
          outboxPayload = JSON.parse(String(params[6])) as TranscriptEntry;
        return [];
      }),
    );
    const persisted = await store.append(scope, {
      executionId: "550e8400-e29b-41d4-a716-446655440000",
      conversationId: "chat",
      role: "assistant",
      content: "answer",
    });
    expect(persisted.sequence).toBe(7);
    expect(outboxPayload).toBeDefined();
    expect(persisted.id).toBe(outboxPayload?.id ?? "");
    expect(outboxPayload?.sequence).toBe(7);
  });

  test("does not synchronously append a second JSONL record when outbox projection is authoritative", async () => {
    const persisted: TranscriptEntry = {
      version: 1,
      id: "db-event",
      executionId: "run",
      conversationId: "chat",
      role: "assistant",
      content: "answer",
      sequence: 4,
      createdAt: now,
    };
    let replicaAppends = 0;
    const primary = {
      append: async () => persisted,
      read: async () => [],
      search: async () => [],
    } satisfies TranscriptStore;
    const replica = {
      append: async () => {
        replicaAppends += 1;
        return { ...persisted, id: "duplicate" };
      },
      read: async () => [],
      search: async () => [],
    } satisfies TranscriptStore;
    const mirror = new MirroredTranscriptStore(primary, replica);
    expect(
      await mirror.append(scope, {
        executionId: "run",
        conversationId: "chat",
        role: "assistant",
        content: "answer",
      }),
    ).toBe(persisted);
    expect(replicaAppends).toBe(0);
  });
});

describe("tool recovery transitions", () => {
  test("unknown actions can only be manually reconciled once and can never be claimed", async () => {
    let status = "unknown";
    const row = {
      conversation_id: "chat",
      tool_call_id: "call",
      operation_id: "operation",
      sequence: 1,
      execution_id: "550e8400-e29b-41d4-a716-446655440000",
      tool_name: "remote/write",
      args: {},
      status,
      attempts: 1,
      lease_expires_at: null,
      result: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    const store = new PostgresAssistantSessionStore(
      database(async (sql, params) => {
        if (sql.includes("status = 'running'") && sql.includes("status = 'pending'")) return [];
        if (sql.includes("AND status = 'unknown'")) {
          if (status !== "unknown") return [];
          status = String(params[5]);
          return [{ ...row, status }];
        }
        return [];
      }),
    );
    expect(
      await store.claimTool?.({
        scope,
        conversationId: "chat",
        toolCallId: "call",
        workerId: "worker",
      }),
    ).toBe(false);
    expect(
      (
        await store.reconcileUnknown?.({
          scope,
          conversationId: "chat",
          toolCallId: "call",
          status: "completed",
          result: { ok: true },
        })
      )?.status,
    ).toBe("completed");
    expect(
      await store.reconcileUnknown?.({
        scope,
        conversationId: "chat",
        toolCallId: "call",
        status: "failed",
        reason: "late",
      }),
    ).toBeUndefined();
  });
});

describe("tool journal call id reuse", () => {
  function journalStore(existingStatus: string | undefined) {
    const statements: string[] = [];
    const store = new PostgresAssistantSessionStore(
      database(async (sql) => {
        statements.push(sql);
        if (sql.includes("SELECT operation_id, status FROM assistant_tool_journal"))
          return existingStatus === undefined ? [] : [{ operation_id: "operation", status: existingStatus }];
        if (sql.includes("RETURNING last_sequence")) return [{ last_sequence: 3 }];
        return [];
      }),
    );
    return { store, statements };
  }

  const intent = {
    scope,
    conversationId: "chat",
    executionId: "550e8400-e29b-41d4-a716-446655440000",
    toolCallId: "550e8400-e29b-41d4-a716-446655440000:530690697",
    tool: "parking/status",
    args: {},
  };

  test("inserts a fresh pending intent when the call id is unused", async () => {
    const { store, statements } = journalStore(undefined);
    await store.beforeTool(intent);
    expect(statements.some((sql) => sql.includes("INSERT INTO assistant_tool_journal"))).toBe(true);
  });

  test("re-arms a settled row so a reused call id cannot wedge the conversation", async () => {
    const { store, statements } = journalStore("completed");
    await store.beforeTool(intent);
    const rearm = statements.find((sql) => sql.includes("UPDATE assistant_tool_journal"));
    expect(rearm).toContain("status = 'pending'");
    expect(rearm).toContain("attempts = attempts + 1");
    expect(rearm).toContain("status IN ('completed', 'failed', 'cancelled')");
    expect(statements.some((sql) => sql.includes("INSERT INTO assistant_tool_journal"))).toBe(false);
  });

  test("leaves an in-flight or unresolved row untouched so the lease stays fail-closed", async () => {
    for (const status of ["running", "pending", "awaiting_approval", "unknown"]) {
      const { store, statements } = journalStore(status);
      await store.beforeTool(intent);
      expect(statements.some((sql) => sql.includes("assistant_tool_journal") && !sql.includes("SELECT"))).toBe(false);
    }
  });
});

describe("tool journal outcome transitions", () => {
  function statusStore(updated: boolean) {
    let allowed: string[] = [];
    const store = new PostgresAssistantSessionStore(
      database(async (sql, params) => {
        if (!sql.includes("UPDATE assistant_tool_journal")) return [];
        allowed = JSON.parse(String(params[9])) as string[];
        return updated ? [{ tool_call_id: "call" }] : [];
      }),
    );
    return { store, allowedFrom: () => allowed };
  }

  test("settles a pending row, because leases are an optional part of the contract", async () => {
    const { store, allowedFrom } = statusStore(true);
    await store.completeTool({ scope, conversationId: "chat", toolCallId: "call", succeeded: true, result: { ok: true } });
    expect(allowedFrom()).toEqual(["running", "pending"]);
  });

  test("fails an awaiting-approval row instead of masking the original error", async () => {
    const { store, allowedFrom } = statusStore(true);
    await store.completeTool({ scope, conversationId: "chat", toolCallId: "call", succeeded: false, error: "boom" });
    expect(allowedFrom()).toEqual(["running", "pending", "awaiting_approval"]);
  });

  test("raises a typed conflict when the row moved on", async () => {
    const { store } = statusStore(false);
    await expect(
      store.completeTool({ scope, conversationId: "chat", toolCallId: "call", succeeded: true }),
    ).rejects.toBeInstanceOf(ToolJournalConflictError);
  });
});
