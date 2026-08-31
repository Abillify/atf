// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Store-Abstraktion backing implementations.
 *
 * Covers MemoryStoreFactory (unit — no external deps), and verifies structural
 * correctness of RedisStoreFactory / PostgresStoreFactory factories.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MemoryStoreFactory } from "../store/memory-store.js";
import type { Store, CounterStore, StoreFactory } from "../store/store.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// MemoryStoreFactory — full unit tests
// ---------------------------------------------------------------------------

describe("MemoryStoreFactory", () => {
  let factory: StoreFactory;

  beforeEach(() => {
    factory = new MemoryStoreFactory();
  });

  test("backing() returns 'memory'", () => {
    expect(factory.backing()).toBe("memory");
  });

  describe("keyValue store", () => {
    let store: Store<string, unknown>;

    beforeEach(() => {
      store = factory.keyValue<string, unknown>("test-ns");
    });

    test("get returns undefined for non-existent key", async () => {
      expect(await store.get("missing")).toBeUndefined();
    });

    test("set and get round-trip a value", async () => {
      await store.set("key1", { foo: "bar" });
      expect(await store.get("key1")).toEqual({ foo: "bar" });
    });

    test("set overwrites existing value", async () => {
      await store.set("key1", "first");
      await store.set("key1", "second");
      expect(await store.get("key1")).toBe("second");
    });

    test("delete removes a key", async () => {
      await store.set("key1", 42);
      await store.delete("key1");
      expect(await store.get("key1")).toBeUndefined();
    });

    test("delete on non-existent key is a no-op", async () => {
      // Should not throw
      await store.delete("ghost");
    });

    test("TTL evicts entry after expiry", async () => {
      await store.set("temp", "value", { ttlMs: 50 });
      expect(await store.get("temp")).toBe("value");
      await new Promise((r) => setTimeout(r, 70));
      expect(await store.get("temp")).toBeUndefined();
    });

    test("set without TTL persists indefinitely", async () => {
      await store.set("permanent", "stays");
      await new Promise((r) => setTimeout(r, 30));
      expect(await store.get("permanent")).toBe("stays");
    });

    test("namespaces are isolated", async () => {
      const storeA = factory.keyValue<string, string>("ns-a");
      const storeB = factory.keyValue<string, string>("ns-b");
      await storeA.set("shared-key", "from-a");
      await storeB.set("shared-key", "from-b");
      expect(await storeA.get("shared-key")).toBe("from-a");
      expect(await storeB.get("shared-key")).toBe("from-b");
    });

    test("handles complex key types via serialisation", async () => {
      const store = factory.keyValue<
        { tenant: string; endpoint: string },
        number
      >("complex");
      const key = { tenant: "abc", endpoint: "/v1/chat" };
      await store.set(key, 100);
      expect(await store.get(key)).toBe(100);
    });
  });

  describe("counter store", () => {
    let counter: CounterStore<string>;

    beforeEach(() => {
      counter = factory.counter<string>("rate-limit");
    });

    test("first increment returns the increment value", async () => {
      const result = await counter.incr("key1", 1, 60_000);
      expect(result).toBe(1);
    });

    test("multiple increments accumulate within the same window", async () => {
      await counter.incr("key1", 1, 60_000);
      await counter.incr("key1", 1, 60_000);
      const result = await counter.incr("key1", 1, 60_000);
      expect(result).toBe(3);
    });

    test("increment by larger values works", async () => {
      const result = await counter.incr("key1", 5, 60_000);
      expect(result).toBe(5);
    });

    test("counter resets after window expires", async () => {
      await counter.incr("key1", 3, 50);
      await new Promise((r) => setTimeout(r, 70));
      const result = await counter.incr("key1", 1, 50);
      expect(result).toBe(1);
    });

    test("different keys are independent", async () => {
      await counter.incr("a", 5, 60_000);
      const result = await counter.incr("b", 1, 60_000);
      expect(result).toBe(1);
    });

    test("namespaces are isolated", async () => {
      const counterA = factory.counter<string>("ns-a");
      const counterB = factory.counter<string>("ns-b");
      await counterA.incr("shared", 10, 60_000);
      const result = await counterB.incr("shared", 1, 60_000);
      expect(result).toBe(1);
    });

    test("concurrent increments yield consistent total (atomicity)", async () => {
      const concurrency = 20;
      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          counter.incr("atomic-key", 1, 60_000),
        ),
      );
      // Each increment should return a unique value between 1 and concurrency
      const sorted = [...results].sort((a, b) => a - b);
      expect(sorted).toEqual(
        Array.from({ length: concurrency }, (_, i) => i + 1),
      );
      // Final value should equal total number of increments
      const finalValue = await counter.incr("atomic-key", 1, 60_000);
      expect(finalValue).toBe(concurrency + 1);
    });
  });
});

// ---------------------------------------------------------------------------
// RedisStoreFactory — structural tests (no real Redis)
// ---------------------------------------------------------------------------

describe("RedisStoreFactory", () => {
  test("throws when RedisClient is unavailable", () => {
    // Ensure no global RedisClient
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    delete g.RedisClient;
    try {
      // Dynamic import to avoid module-level side effects
      const { RedisStoreFactory } = require("../store/redis-store.js");
      expect(
        () => new RedisStoreFactory({ url: "redis://localhost:6379" }),
      ).toThrow(/unavailable/);
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
    }
  });

  test("backing() returns 'redis' when constructed with a mock client", () => {
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    // Provide a minimal mock constructor
    g.RedisClient = class {
      send() {
        return Promise.resolve(null);
      }
    };
    try {
      const { RedisStoreFactory } = require("../store/redis-store.js");
      const factory = new RedisStoreFactory({ url: "redis://localhost:6379" });
      expect(factory.backing()).toBe("redis");
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
      else delete g.RedisClient;
    }
  });
});

// ---------------------------------------------------------------------------
// PostgresStoreFactory — structural tests (no real Postgres)
// ---------------------------------------------------------------------------

describe("PostgresStoreFactory", () => {
  test("backing() returns 'postgres'", () => {
    const { PostgresStoreFactory } = require("../store/postgres-store.js");
    // Provide a minimal fake Database that only needs to exist for construction
    const fakeDb = {
      query: async () => [],
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    const factory = new PostgresStoreFactory({ db: fakeDb });
    expect(factory.backing()).toBe("postgres");
  });

  test("keyValue and counter return Store/CounterStore instances", () => {
    const { PostgresStoreFactory } = require("../store/postgres-store.js");
    const fakeDb = {
      query: async () => [],
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    const factory = new PostgresStoreFactory({ db: fakeDb });
    const kv = factory.keyValue("test");
    const ctr = factory.counter("test");
    expect(typeof kv.get).toBe("function");
    expect(typeof kv.set).toBe("function");
    expect(typeof kv.delete).toBe("function");
    expect(typeof ctr.incr).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// RedisStore / RedisCounterStore — behavioural tests with a mock RedisClient
// ---------------------------------------------------------------------------

describe("RedisStoreFactory — keyValue store behaviour", () => {
  function withMockClient<T>(
    handlers: Record<string, (args: string[]) => unknown>,
    fn: (factory: StoreFactory) => Promise<T>,
  ): Promise<T> {
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    g.RedisClient = class {
      async send(command: string, args: string[]): Promise<unknown> {
        const handler = handlers[command];
        return handler ? handler(args) : null;
      }
    };
    try {
      const { RedisStoreFactory } = require("../store/redis-store.js");
      const factory = new RedisStoreFactory({ url: "redis://localhost:6379" });
      return fn(factory);
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
      else delete g.RedisClient;
    }
  }

  test("get returns undefined when the key is missing (null response)", async () => {
    await withMockClient({ GET: () => null }, async (factory) => {
      const store = factory.keyValue<string, unknown>("ns");
      expect(await store.get("missing")).toBeUndefined();
    });
  });

  test("set then get round-trips a JSON value", async () => {
    const backing = new Map<string, string>();
    await withMockClient(
      {
        SET: (args) => {
          backing.set(at(args, 0), at(args, 1));
          return "OK";
        },
        GET: (args) => backing.get(at(args, 0)) ?? null,
      },
      async (factory) => {
        const store = factory.keyValue<string, { a: number }>("ns");
        await store.set("key1", { a: 1 });
        expect(await store.get("key1")).toEqual({ a: 1 });
      },
    );
  });

  test("set with a ttlMs sends a PX-qualified SET", async () => {
    const seen: string[][] = [];
    await withMockClient(
      {
        SET: (args) => {
          seen.push(args);
          return "OK";
        },
      },
      async (factory) => {
        const store = factory.keyValue<string, string>("ns");
        await store.set("k", "v", { ttlMs: 5000 });
      },
    );
    expect(seen[0]).toEqual(["ns:k", '"v"', "PX", "5000"]);
  });

  test("get returns undefined when the stored value is not valid JSON", async () => {
    await withMockClient({ GET: () => "not-json{" }, async (factory) => {
      const store = factory.keyValue<string, unknown>("ns");
      expect(await store.get("bad")).toBeUndefined();
    });
  });

  test("delete issues a DEL for the namespaced key", async () => {
    const seen: string[][] = [];
    await withMockClient(
      {
        DEL: (args) => {
          seen.push(args);
          return 1;
        },
      },
      async (factory) => {
        const store = factory.keyValue<string, string>("ns");
        await store.delete("k");
      },
    );
    expect(seen[0]).toEqual(["ns:k"]);
  });

  test("handles complex (non-string) keys via JSON serialisation", async () => {
    const backing = new Map<string, string>();
    await withMockClient(
      {
        SET: (args) => {
          backing.set(at(args, 0), at(args, 1));
          return "OK";
        },
        GET: (args) => backing.get(at(args, 0)) ?? null,
      },
      async (factory) => {
        const store = factory.keyValue<{ a: string }, number>("ns");
        const key = { a: "x" };
        await store.set(key, 42);
        expect(await store.get(key)).toBe(42);
      },
    );
  });
});

describe("RedisStoreFactory — counter store behaviour", () => {
  function withMockEval(
    evalHandler: (args: string[]) => unknown,
  ): { factory: StoreFactory; restore: () => void } {
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    g.RedisClient = class {
      async send(command: string, args: string[]): Promise<unknown> {
        if (command === "EVAL") return evalHandler(args);
        return null;
      }
    };
    const { RedisStoreFactory } = require("../store/redis-store.js");
    const factory = new RedisStoreFactory({ url: "redis://localhost:6379" });
    return {
      factory,
      restore: () => {
        if (saved !== undefined) g.RedisClient = saved;
        else delete g.RedisClient;
      },
    };
  }

  test("incr returns the numeric result from the Lua EVAL", async () => {
    const { factory, restore } = withMockEval(() => 7);
    try {
      const counter = factory.counter<string>("rl");
      expect(await counter.incr("key", 1, 60_000)).toBe(7);
    } finally {
      restore();
    }
  });

  test("incr coerces a string numeric response", async () => {
    const { factory, restore } = withMockEval(() => "9");
    try {
      const counter = factory.counter<string>("rl");
      expect(await counter.incr("key", 1, 60_000)).toBe(9);
    } finally {
      restore();
    }
  });

  test("incr returns 0 for a non-numeric response", async () => {
    const { factory, restore } = withMockEval(() => "not-a-number");
    try {
      const counter = factory.counter<string>("rl");
      expect(await counter.incr("key", 1, 60_000)).toBe(0);
    } finally {
      restore();
    }
  });

  test("incr rounds and floors the increment amount to at least 1", async () => {
    let capturedBy: string | undefined;
    const { factory, restore } = withMockEval((args) => {
      capturedBy = args[3];
      return 1;
    });
    try {
      const counter = factory.counter<string>("rl");
      await counter.incr("key", 0.4, 60_000);
      expect(capturedBy).toBe("1");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// PostgresStore / PostgresCounterStore — behavioural tests with a fake db
// ---------------------------------------------------------------------------

describe("PostgresStoreFactory — keyValue store behaviour", () => {
  function makeFakeDb() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const rows = new Map<string, string>();
    const fakeDb = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT value FROM")) {
          const [namespace, key] = params as [string, string];
          const v = rows.get(`${namespace}:${key}`);
          return v === undefined ? [] : [{ value: v }];
        }
        if (sql.includes("INSERT INTO store_kv")) {
          const [namespace, key, value] = params as [string, string, string];
          rows.set(`${namespace}:${key}`, value);
          return [];
        }
        if (sql.includes("DELETE FROM store_kv")) {
          const [namespace, key] = params as [string, string];
          rows.delete(`${namespace}:${key}`);
          return [];
        }
        return [];
      },
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    return { fakeDb, calls, rows };
  }

  test("set then get round-trips through the fake db", async () => {
    const { PostgresStoreFactory } = require("../store/postgres-store.js");
    const { fakeDb } = makeFakeDb();
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const store = factory.keyValue<string, { n: number }>("ns");
    await store.set("k1", { n: 5 });
    expect(await store.get("k1")).toEqual({ n: 5 });
  });

  test("get returns undefined for a missing key", async () => {
    const { PostgresStoreFactory } = require("../store/postgres-store.js");
    const { fakeDb } = makeFakeDb();
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const store = factory.keyValue<string, unknown>("ns");
    expect(await store.get("missing")).toBeUndefined();
  });

  test("delete removes the key so a subsequent get returns undefined", async () => {
    const { PostgresStoreFactory } = require("../store/postgres-store.js");
    const { fakeDb } = makeFakeDb();
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const store = factory.keyValue<string, string>("ns");
    await store.set("k1", "v1");
    await store.delete("k1");
    expect(await store.get("k1")).toBeUndefined();
  });

  test("set with a ttlMs computes an expires_at timestamp", async () => {
    const { PostgresStoreFactory } = require("../store/postgres-store.js");
    const { fakeDb, calls } = makeFakeDb();
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const store = factory.keyValue<string, string>("ns");
    await store.set("k1", "v1", { ttlMs: 10_000 });
    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO store_kv"));
    expect(insertCall).toBeDefined();
    if (insertCall === undefined) throw new Error("expected an insert call");
    expect(insertCall.params[3]).not.toBeNull();
  });

  test("get returns undefined when the stored value is not valid JSON", async () => {
    const { PostgresStoreFactory, resetPostgresStoreInit } = require("../store/postgres-store.js");
    resetPostgresStoreInit();
    const rows = new Map<string, string>();
    rows.set("ns:k1", "not-json{");
    const fakeDb = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("SELECT value FROM")) {
          const [namespace, key] = params as [string, string];
          const v = rows.get(`${namespace}:${key}`);
          return v === undefined ? [] : [{ value: v }];
        }
        return [];
      },
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const store = factory.keyValue<string, unknown>("ns");
    expect(await store.get("k1")).toBeUndefined();
  });
});

describe("PostgresStoreFactory — counter store behaviour", () => {
  test("incr returns the count from the RETURNING clause", async () => {
    const { PostgresStoreFactory, resetPostgresStoreInit } = require("../store/postgres-store.js");
    resetPostgresStoreInit();
    const fakeDb = {
      query: async (_sql: string) => [{ count: 4 }],
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const counter = factory.counter<string>("rl");
    expect(await counter.incr("key", 1, 60_000)).toBe(4);
  });

  test("incr coerces a string count", async () => {
    const { PostgresStoreFactory, resetPostgresStoreInit } = require("../store/postgres-store.js");
    resetPostgresStoreInit();
    const fakeDb = {
      query: async (_sql: string) => [{ count: "6" }],
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const counter = factory.counter<string>("rl");
    expect(await counter.incr("key", 1, 60_000)).toBe(6);
  });

  test("incr returns 0 when no rows are returned", async () => {
    const { PostgresStoreFactory, resetPostgresStoreInit } = require("../store/postgres-store.js");
    resetPostgresStoreInit();
    const fakeDb = {
      query: async (_sql: string) => [],
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const counter = factory.counter<string>("rl");
    expect(await counter.incr("key", 1, 60_000)).toBe(0);
  });

  test("incr returns 0 for a non-numeric count", async () => {
    const { PostgresStoreFactory, resetPostgresStoreInit } = require("../store/postgres-store.js");
    resetPostgresStoreInit();
    const fakeDb = {
      query: async (_sql: string) => [{ count: "not-a-number" }],
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb(fakeDb),
    };
    const factory: StoreFactory = new PostgresStoreFactory({ db: fakeDb });
    const counter = factory.counter<string>("rl");
    expect(await counter.incr("key", 1, 60_000)).toBe(0);
  });
});
