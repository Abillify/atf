// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SessionStore — idle expiry and the hard concurrency cap.
 *
 * These are the two bounds that turn MCP session tracking from "a Map that only
 * shrinks when a well-behaved client says goodbye" into something an untrusted
 * caller cannot grow without limit, so each is pinned explicitly.
 */

import { describe, expect, test } from "bun:test";
import { SessionStore, type SessionLimits } from "../../src/mcp/session-store.ts";

/** Controllable clock so tests never sleep. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const limits = (over: Partial<SessionLimits> = {}): SessionLimits => ({
  idleTimeoutMs: 60_000,
  max: 3,
  sweepIntervalMs: 3_600_000, // long, so the interval never fires during a test
  ...over,
});

describe("SessionStore · idle expiry", () => {
  test("sweeps a session that has been idle beyond the timeout", () => {
    const clock = fakeClock();
    const evicted: { id: string; value: string; idleMs: number }[] = [];
    const store = new SessionStore<string>(
      limits(),
      (id, value, idleMs) => evicted.push({ id, value, idleMs }),
      clock.now,
    );

    store.set("a", "session-a");
    expect(store.size).toBe(1);

    clock.advance(59_000);
    expect(store.sweep()).toBe(0);
    expect(store.size).toBe(1);

    clock.advance(2_000); // now 61s idle
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(0);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.id).toBe("a");
    expect(evicted[0]?.value).toBe("session-a");
    expect(evicted[0]?.idleMs).toBeGreaterThanOrEqual(61_000);
  });

  test("get() refreshes the idle timer so an active session is never evicted", () => {
    const clock = fakeClock();
    const store = new SessionStore<string>(limits(), () => {}, clock.now);
    store.set("a", "v");

    // Keep touching it just under the timeout, well past the timeout in total.
    for (let i = 0; i < 10; i++) {
      clock.advance(50_000);
      expect(store.get("a")).toBe("v");
      expect(store.sweep()).toBe(0);
    }
    expect(store.size).toBe(1);
  });

  test("peek() does NOT refresh the idle timer", () => {
    const clock = fakeClock();
    const store = new SessionStore<string>(limits(), () => {}, clock.now);
    store.set("a", "v");

    clock.advance(30_000);
    expect(store.peek("a")).toBe("v");
    clock.advance(31_000);
    expect(store.sweep()).toBe(1);
  });

  test("idleTimeoutMs 0 disables the sweep entirely", () => {
    const clock = fakeClock();
    const store = new SessionStore<string>(
      limits({ idleTimeoutMs: 0 }),
      () => {},
      clock.now,
    );
    store.set("a", "v");
    clock.advance(10_000_000);
    expect(store.sweep()).toBe(0);
    expect(store.size).toBe(1);
  });

  test("a throwing evict handler does not abort the sweep", () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const store = new SessionStore<string>(
      limits(),
      (id) => {
        seen.push(id);
        if (id === "a") throw new Error("handler blew up");
      },
      clock.now,
    );
    store.set("a", "v");
    store.set("b", "v");
    clock.advance(61_000);

    expect(store.sweep()).toBe(2);
    expect(seen).toEqual(["a", "b"]);
    expect(store.size).toBe(0);
  });
});

describe("SessionStore · concurrency cap", () => {
  test("refuses a reservation once max is held", () => {
    const clock = fakeClock();
    const store = new SessionStore<string>(limits({ max: 2 }), () => {}, clock.now);

    expect(store.tryReserve().ok).toBe(true);
    store.set("a", "v");
    expect(store.tryReserve().ok).toBe(true);
    store.set("b", "v");

    const refused = store.tryReserve();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.held).toBe(2);
      expect(refused.max).toBe(2);
      expect(refused.reason).toContain("Session limit reached");
    }
  });

  test("does NOT evict a live session to admit a new one", () => {
    const clock = fakeClock();
    const evicted: string[] = [];
    const store = new SessionStore<string>(
      limits({ max: 1 }),
      (id) => evicted.push(id),
      clock.now,
    );
    store.set("incumbent", "v");

    expect(store.tryReserve().ok).toBe(false);
    // The incumbent is untouched — refusing the newcomer is the whole point.
    expect(store.peek("incumbent")).toBe("v");
    expect(evicted).toEqual([]);
  });

  test("sweeps before refusing, so a cap hit caused by stale sessions still admits", () => {
    const clock = fakeClock();
    const store = new SessionStore<string>(limits({ max: 2 }), () => {}, clock.now);
    store.set("stale-1", "v");
    store.set("stale-2", "v");

    clock.advance(61_000); // both are now idle past the timeout
    const result = store.tryReserve();
    expect(result.ok).toBe(true);
    expect(store.size).toBe(0);
  });

  test("max 0 disables the cap", () => {
    const clock = fakeClock();
    const store = new SessionStore<string>(limits({ max: 0 }), () => {}, clock.now);
    for (let i = 0; i < 50; i++) store.set(`s${i}`, "v");
    expect(store.tryReserve().ok).toBe(true);
    expect(store.size).toBe(50);
  });
});

describe("SessionStore · basics", () => {
  test("delete() reports whether the entry existed", () => {
    const store = new SessionStore<string>(limits(), () => {});
    store.set("a", "v");
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
  });

  test("get() on an unknown id is undefined", () => {
    const store = new SessionStore<string>(limits(), () => {});
    expect(store.get("nope")).toBeUndefined();
    expect(store.peek("nope")).toBeUndefined();
  });

  test("set() on an existing id replaces the value and resets idle", () => {
    const clock = fakeClock();
    const store = new SessionStore<string>(limits(), () => {}, clock.now);
    store.set("a", "first");
    clock.advance(59_000);
    store.set("a", "second");
    clock.advance(59_000);
    expect(store.sweep()).toBe(0);
    expect(store.peek("a")).toBe("second");
  });

  test("stop() is safe to call even when no timer was started", () => {
    const store = new SessionStore<string>(
      limits({ idleTimeoutMs: 0 }),
      () => {},
    );
    expect(() => store.stop()).not.toThrow();
  });

  test("the periodic sweep timer actually fires", async () => {
    const evicted: string[] = [];
    const store = new SessionStore<string>(
      { idleTimeoutMs: 1, max: 10, sweepIntervalMs: 5 },
      (id) => evicted.push(id),
    );
    store.set("a", "v");
    await new Promise((r) => setTimeout(r, 40));
    store.stop();
    expect(evicted).toContain("a");
  });
});
