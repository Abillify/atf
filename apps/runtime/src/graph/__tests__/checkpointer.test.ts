// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the persistent checkpoint saver (src/graph/checkpointer.ts).
 *
 * Exercises the BaseCheckpointSaver implementation against the in-memory
 * repository so the (subtle) serde round-trip, tuple assembly and pending-write
 * handling are verified without a real Postgres. The Postgres repository is a
 * thin SQL adapter over the same interface.
 */

import { describe, test, expect } from "bun:test";
import {
  emptyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  PersistentCheckpointSaver,
  InMemoryCheckpointRepository,
  PostgresCheckpointRepository,
  type CheckpointRepository,
  type WriteRecord,
} from "../checkpointer.js";
import type { Database } from "../../db/database.js";

function cfg(threadId: string, checkpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
      ...(checkpointId !== undefined ? { checkpoint_id: checkpointId } : {}),
    },
  };
}

function makeCheckpoint(id: string, value: unknown): Checkpoint {
  const c = emptyCheckpoint();
  c.id = id;
  c.channel_values = { messages: value } as Record<string, unknown>;
  return c;
}

// `writes` was removed from `CheckpointMetadata` in LangGraph v1 (pending
// writes now live exclusively in `checkpoint_writes` / `CheckpointTuple.pendingWrites`).
const META: CheckpointMetadata = {
  source: "loop",
  step: 1,
  parents: {},
};

describe("PersistentCheckpointSaver", () => {
  test("round-trips a checkpoint through put → getTuple", async () => {
    const saver = new PersistentCheckpointSaver(
      new InMemoryCheckpointRepository(),
    );
    const checkpoint = makeCheckpoint("ckpt-1", ["hello", "world"]);

    const putConfig = await saver.put(cfg("thread-A"), checkpoint, META, {});
    expect(putConfig.configurable?.checkpoint_id).toBe("ckpt-1");

    const tuple = await saver.getTuple(cfg("thread-A"));
    expect(tuple).toBeDefined();
    expect(tuple?.checkpoint.id).toBe("ckpt-1");
    expect(tuple?.checkpoint.channel_values.messages).toEqual([
      "hello",
      "world",
    ]);
    expect(tuple?.metadata?.step).toBe(1);
  });

  test("getTuple returns undefined for an unknown thread", async () => {
    const saver = new PersistentCheckpointSaver(
      new InMemoryCheckpointRepository(),
    );
    expect(await saver.getTuple(cfg("nope"))).toBeUndefined();
  });

  test("latest checkpoint wins and parent is linked", async () => {
    const saver = new PersistentCheckpointSaver(
      new InMemoryCheckpointRepository(),
    );
    await saver.put(cfg("t"), makeCheckpoint("c1", 1), META, {});
    // Second put references the first as parent via checkpoint_id in config.
    await saver.put(cfg("t", "c1"), makeCheckpoint("c2", 2), META, {});

    const latest = await saver.getTuple(cfg("t"));
    expect(latest?.checkpoint.id).toBe("c2");
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe("c1");

    // Explicit fetch by id returns the requested checkpoint.
    const first = await saver.getTuple(cfg("t", "c1"));
    expect(first?.checkpoint.id).toBe("c1");
  });

  test("persists and replays pending writes", async () => {
    const saver = new PersistentCheckpointSaver(
      new InMemoryCheckpointRepository(),
    );
    await saver.put(cfg("tw"), makeCheckpoint("cw", 0), META, {});

    await saver.putWrites(
      cfg("tw", "cw"),
      [["messages", { role: "assistant", content: "hi" }]],
      "task-1",
    );

    const tuple = await saver.getTuple(cfg("tw", "cw"));
    expect(tuple?.pendingWrites).toBeDefined();
    expect(tuple?.pendingWrites?.length).toBe(1);
    if (tuple === undefined || tuple.pendingWrites === undefined) {
      throw new Error("expected pendingWrites");
    }
    const write0 = tuple.pendingWrites[0];
    if (write0 === undefined) throw new Error("expected a first write");
    const [taskId, channel, value] = write0;
    expect(taskId).toBe("task-1");
    expect(channel).toBe("messages");
    expect(value).toEqual({ role: "assistant", content: "hi" });
  });

  test("list yields checkpoints newest-first", async () => {
    const saver = new PersistentCheckpointSaver(
      new InMemoryCheckpointRepository(),
    );
    await saver.put(cfg("tl"), makeCheckpoint("a", 1), META, {});
    await saver.put(cfg("tl", "a"), makeCheckpoint("b", 2), META, {});

    const ids: string[] = [];
    for await (const t of saver.list(cfg("tl"))) ids.push(t.checkpoint.id);
    expect(ids).toEqual(["b", "a"]);
  });

  test("threads are isolated", async () => {
    const saver = new PersistentCheckpointSaver(
      new InMemoryCheckpointRepository(),
    );
    await saver.put(cfg("t1"), makeCheckpoint("x", 1), META, {});
    expect(await saver.getTuple(cfg("t2"))).toBeUndefined();
    expect((await saver.getTuple(cfg("t1")))?.checkpoint.id).toBe("x");
  });

  test("putWrites with multiple channel writes uses one batched call, not N sequential ones", async () => {
    // A repository whose putWriteBatch counts invocations, so we can assert
    // the saver takes the batched path (one call) instead of falling back to
    // per-record putWrite (N calls) when the repository supports batching.
    const inner = new InMemoryCheckpointRepository();
    let batchCalls = 0;
    let singleCalls = 0;
    const counting: CheckpointRepository = {
      putCheckpoint: (rec) => inner.putCheckpoint(rec),
      getCheckpoint: (t, ns, id) => inner.getCheckpoint(t, ns, id),
      getLatestCheckpoint: (t, ns) => inner.getLatestCheckpoint(t, ns),
      listCheckpoints: (t, ns, o) => inner.listCheckpoints(t, ns, o),
      putWrite: (rec) => {
        singleCalls++;
        return inner.putWrite(rec);
      },
      putWriteBatch: (recs: WriteRecord[]) => {
        batchCalls++;
        return Promise.all(recs.map((r) => inner.putWrite(r))).then(() => {});
      },
      getWrites: (t, ns, id) => inner.getWrites(t, ns, id),
      deleteThread: (t) => inner.deleteThread(t),
    };
    const saver = new PersistentCheckpointSaver(counting);
    await saver.put(cfg("tb"), makeCheckpoint("cb", 0), META, {});

    await saver.putWrites(
      cfg("tb", "cb"),
      [
        ["messages", { role: "assistant", content: "a" }],
        ["errors", []],
        ["toolResults", []],
      ],
      "task-batch",
    );

    expect(batchCalls).toBe(1);
    expect(singleCalls).toBe(0);

    const tuple = await saver.getTuple(cfg("tb", "cb"));
    expect(tuple?.pendingWrites?.length).toBe(3);
  });

  test("putWrites falls back to sequential putWrite when the repository lacks putWriteBatch", async () => {
    const inner = new InMemoryCheckpointRepository();
    let singleCalls = 0;
    const legacy: CheckpointRepository = {
      putCheckpoint: (rec) => inner.putCheckpoint(rec),
      getCheckpoint: (t, ns, id) => inner.getCheckpoint(t, ns, id),
      getLatestCheckpoint: (t, ns) => inner.getLatestCheckpoint(t, ns),
      listCheckpoints: (t, ns, o) => inner.listCheckpoints(t, ns, o),
      putWrite: (rec) => {
        singleCalls++;
        return inner.putWrite(rec);
      },
      // No putWriteBatch — models a repository implementation that predates it.
      getWrites: (t, ns, id) => inner.getWrites(t, ns, id),
      deleteThread: (t) => inner.deleteThread(t),
    };
    const saver = new PersistentCheckpointSaver(legacy);
    await saver.put(cfg("tl2"), makeCheckpoint("cl2", 0), META, {});

    await saver.putWrites(
      cfg("tl2", "cl2"),
      [
        ["messages", "x"],
        ["errors", []],
      ],
      "task-legacy",
    );

    expect(singleCalls).toBe(2);
  });
});

describe("PostgresCheckpointRepository.putWriteBatch", () => {
  test("issues one multi-row INSERT for all writes with correct ON CONFLICT semantics", async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    const store = new Map<string, WriteRecord>();
    const db: Database = {
      async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
        queries.push({ text, params });
        if (text.includes("INSERT INTO checkpoint_writes")) {
          // Simulate a single multi-row statement writing N rows keyed by
          // (thread, ns, checkpoint, task, idx).
          const p = params ?? [];
          for (let i = 0; i < p.length; i += 8) {
            const [
              threadId,
              checkpointNs,
              checkpointId,
              taskId,
              idx,
              channel,
              type,
              value,
            ] = p.slice(i, i + 8) as [
              string,
              string,
              string,
              string,
              number,
              string,
              string,
              Uint8Array,
            ];
            store.set(`${threadId}:${checkpointNs}:${checkpointId}:${taskId}:${idx}`, {
              threadId,
              checkpointNs,
              checkpointId,
              taskId,
              idx,
              channel,
              type,
              value,
            });
          }
        }
        return [] as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>) {
        return cb(this);
      },
    };
    const repo = new PostgresCheckpointRepository(db);
    const recs: WriteRecord[] = [
      {
        threadId: "t",
        checkpointNs: "",
        checkpointId: "c1",
        taskId: "task-1",
        idx: 0,
        channel: "messages",
        type: "json",
        value: new TextEncoder().encode('"a"'),
      },
      {
        threadId: "t",
        checkpointNs: "",
        checkpointId: "c1",
        taskId: "task-1",
        idx: 1,
        channel: "errors",
        type: "json",
        value: new TextEncoder().encode("[]"),
      },
    ];

    await repo.putWriteBatch(recs);

    // Exactly one INSERT statement for both records.
    const inserts = queries.filter((q) =>
      q.text.includes("INSERT INTO checkpoint_writes"),
    );
    expect(inserts.length).toBe(1);
    expect(inserts[0]?.text).toContain("ON CONFLICT");
    expect(store.size).toBe(2);
  });

  test("putWriteBatch with an empty array issues no query", async () => {
    let called = false;
    const db: Database = {
      async query<T>(): Promise<T[]> {
        called = true;
        return [] as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>) {
        return cb(this);
      },
    };
    const repo = new PostgresCheckpointRepository(db);
    await repo.putWriteBatch([]);
    expect(called).toBe(false);
  });
});
