// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  applyStickiness,
  buildPoolCandidateChain,
  poolLeafConfigs,
  poolSignature,
  resetPoolCursors,
  STICKY_MAX_ENTRIES,
  STICKY_TTL_MS,
} from "../model-pool.js";
import type { LlmConfig } from "../../types/flow.js";
import type { LlmPoolStickiness, LlmPoolStrategy } from "../../types/flow.js";

const A: LlmConfig = { provider: "gpuvllm", model: "qwen-a" };
const B: LlmConfig = { provider: "macminilmstudio", model: "gemma-b" };
const C: LlmConfig = { provider: "awseu", model: "haiku-c" };

function pooled(strategy: LlmPoolStrategy | undefined): LlmConfig {
  return {
    ...A,
    pool: {
      ...(strategy !== undefined ? { strategy } : {}),
      candidates: [A, B, C],
    },
  };
}

describe("buildPoolCandidateChain", () => {
  test("no pool yields a single-element chain", () => {
    resetPoolCursors();
    expect(buildPoolCandidateChain(A, "k")).toEqual([A]);
  });

  test("empty/malformed pool falls back to the host config", () => {
    const empty: LlmConfig = { ...A, pool: { candidates: [] } };
    const chain = buildPoolCandidateChain(empty, "k");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.model).toBe("qwen-a");
  });

  test("fallback strategy keeps the configured order every call", () => {
    resetPoolCursors();
    const config = pooled("fallback");
    for (let i = 0; i < 5; i++) {
      expect(buildPoolCandidateChain(config, "flow/node/fb").map((c) => c.model))
        .toEqual(["qwen-a", "gemma-b", "haiku-c"]);
    }
  });

  test("omitted strategy behaves as fallback", () => {
    resetPoolCursors();
    const config = pooled(undefined);
    expect(buildPoolCandidateChain(config, "flow/node/x").map((c) => c.model))
      .toEqual(["qwen-a", "gemma-b", "haiku-c"]);
  });

  test("round-robin rotates the primary across calls", () => {
    resetPoolCursors();
    const config = pooled("round-robin");
    const key = "flow/node/rr";
    const primaries: string[] = [];
    for (let i = 0; i < 6; i++) {
      const chain = buildPoolCandidateChain(config, key);
      primaries.push(chain[0]?.model as string);
    }
    expect(primaries).toEqual([
      "qwen-a",
      "gemma-b",
      "haiku-c",
      "qwen-a",
      "gemma-b",
      "haiku-c",
    ]);
  });

  test("round-robin keeps remaining members as wrapped failovers", () => {
    resetPoolCursors();
    const config = pooled("round-robin");
    // Advance once (primary A), then the next call rotates to B with the
    // remaining members following in wrapped configured order.
    buildPoolCandidateChain(config, "flow/node/wrap");
    const chain = buildPoolCandidateChain(config, "flow/node/wrap").map(
      (c) => c.model,
    );
    expect(chain).toEqual(["gemma-b", "haiku-c", "qwen-a"]);
  });

  test("round-robin skips unavailable members before selecting a primary", () => {
    resetPoolCursors();
    const config = pooled("round-robin");
    const chain = buildPoolCandidateChain(config, "flow/node/health", {
      isAvailable: (candidate) => candidate.model !== "gemma-b",
    });
    expect(chain.map((candidate) => candidate.model)).toEqual([
      "qwen-a",
      "haiku-c",
    ]);
  });

  test("unavailable members are skipped even when they would be round-robin primary", () => {
    resetPoolCursors();
    const config = pooled("round-robin");
    const key = "flow/node/health-rotate";
    buildPoolCandidateChain(config, key);
    const chain = buildPoolCandidateChain(config, key, {
      isAvailable: (candidate) => candidate.model !== "gemma-b",
    });
    expect(chain[0]?.model).toBe("haiku-c");
    expect(chain).toHaveLength(2);
  });

  test("weighted round-robin gives heavier members more primary slots", () => {
    resetPoolCursors();
    const config: LlmConfig = {
      ...A,
      pool: {
        strategy: "weighted-round-robin",
        candidates: [
          { ...A, weight: 2 },
          { ...B, weight: 1 },
        ],
      },
    };
    const primaries = Array.from({ length: 6 }, () =>
      buildPoolCandidateChain(config, "flow/node/weighted")[0]?.model,
    );
    expect(primaries).toEqual([
      "qwen-a",
      "qwen-a",
      "gemma-b",
      "qwen-a",
      "qwen-a",
      "gemma-b",
    ]);
  });

  test("weighted random honors the injected random source", () => {
    const config: LlmConfig = {
      ...A,
      pool: {
        strategy: "weighted-random",
        candidates: [
          { ...A, weight: 3 },
          { ...B, weight: 1 },
        ],
      },
    };
    expect(buildPoolCandidateChain(config, "flow/node/random", { random: () => 0.9 })[0]?.model).toBe("gemma-b");
    expect(buildPoolCandidateChain(config, "flow/node/random-2", { random: () => 0.1 })[0]?.model).toBe("qwen-a");
  });

  test("least-used rotates the least used member to the front", () => {
    resetPoolCursors();
    const config = pooled("least-used");
    const key = "flow/node/least-used";
    expect(buildPoolCandidateChain(config, key)[0]?.model).toBe("qwen-a");
    expect(buildPoolCandidateChain(config, key)[0]?.model).toBe("gemma-b");
    expect(buildPoolCandidateChain(config, key)[0]?.model).toBe("haiku-c");
  });

  test("distinct pools never share a cursor", () => {
    resetPoolCursors();
    const config = pooled("round-robin");
    buildPoolCandidateChain(config, "pool-one");
    // A fresh key starts at the first member.
    expect(buildPoolCandidateChain(config, "pool-two")[0]?.model).toBe("qwen-a");
  });

  test("single-member pool is stable under round-robin", () => {
    resetPoolCursors();
    const single: LlmConfig = { ...A, pool: { strategy: "round-robin", candidates: [A] } };
    expect(buildPoolCandidateChain(single, "k1")).toEqual([A]);
    expect(buildPoolCandidateChain(single, "k2")).toEqual([A]);
  });

  test("resetPoolCursors re-phases a pool", () => {
    resetPoolCursors();
    const config = pooled("round-robin");
    const key = "flow/node/reset";
    buildPoolCandidateChain(config, key);
    buildPoolCandidateChain(config, key);
    resetPoolCursors(key);
    expect(buildPoolCandidateChain(config, key)[0]?.model).toBe("qwen-a");
  });
});

describe("buildPoolCandidateChain — nested sub-pools", () => {
  // Outer fallback pool whose PRIMARY member is an inner round-robin sub-pool
  // over [A, B], with C as the outer fallback. This is the target scenario:
  // round-robin between A and B, C only when the whole sub-pool is unavailable.
  function nested(): LlmConfig {
    const subPool: LlmConfig = {
      ...A,
      pool: { strategy: "round-robin", candidates: [A, B] },
    };
    return {
      ...A,
      pool: { strategy: "fallback", candidates: [subPool, C] },
    };
  }

  test("inner round-robin rotates, outer fallback keeps C last", () => {
    resetPoolCursors();
    const config = nested();
    const key = "flow/node/nested";
    // Call 1: inner RR primary A, then inner other B, then outer fallback C.
    expect(buildPoolCandidateChain(config, key).map((c) => c.model)).toEqual([
      "qwen-a",
      "gemma-b",
      "haiku-c",
    ]);
    // Call 2: inner RR rotates to B first, then A, then C — C stays last.
    expect(buildPoolCandidateChain(config, key).map((c) => c.model)).toEqual([
      "gemma-b",
      "qwen-a",
      "haiku-c",
    ]);
  });

  test("C is reached as primary only when BOTH sub-pool members are down", () => {
    resetPoolCursors();
    const config = nested();
    const chain = buildPoolCandidateChain(config, "flow/node/nested-down", {
      isAvailable: (candidate) =>
        candidate.model !== "qwen-a" && candidate.model !== "gemma-b",
    });
    expect(chain.map((c) => c.model)).toEqual(["haiku-c"]);
  });

  test("one dead sub-pool member still keeps the other before C", () => {
    resetPoolCursors();
    const config = nested();
    const chain = buildPoolCandidateChain(config, "flow/node/nested-half", {
      isAvailable: (candidate) => candidate.model !== "qwen-a",
    });
    // Sub-pool still usable (B alive), so it precedes C.
    expect(chain.map((c) => c.model)).toEqual(["gemma-b", "haiku-c"]);
  });

  test("nested chain never leaks a pool onto a leaf", () => {
    resetPoolCursors();
    const chain = buildPoolCandidateChain(nested(), "flow/node/nested-leak");
    for (const leaf of chain) expect(leaf.pool).toBeUndefined();
  });
});

describe("poolLeafConfigs", () => {
  test("returns [] for a config without a pool", () => {
    expect(poolLeafConfigs(A)).toEqual([]);
  });

  test("returns the flat leaves of a single-level pool", () => {
    const config: LlmConfig = { ...A, pool: { candidates: [A, B, C] } };
    expect(poolLeafConfigs(config).map((c) => c.model)).toEqual([
      "qwen-a",
      "gemma-b",
      "haiku-c",
    ]);
  });

  test("walks nested sub-pools to collect every leaf", () => {
    const subPool: LlmConfig = {
      ...A,
      pool: { strategy: "round-robin", candidates: [A, B] },
    };
    const config: LlmConfig = {
      ...A,
      pool: { strategy: "fallback", candidates: [subPool, C] },
    };
    expect(poolLeafConfigs(config).map((c) => c.model)).toEqual([
      "qwen-a",
      "gemma-b",
      "haiku-c",
    ]);
  });
});

describe("poolSignature", () => {
  test("is order-sensitive and provider/model-qualified", () => {
    expect(poolSignature([A, B])).toBe("gpuvllm/qwen-a,macminilmstudio/gemma-b");
    expect(poolSignature([A, B])).not.toBe(poolSignature([B, A]));
  });
});

describe("pool stickiness", () => {
  function stickyPool(
    strategy: LlmPoolStrategy,
    sticky: LlmPoolStickiness,
  ): LlmConfig {
    return {
      ...A,
      pool: { strategy, candidates: [A, B, C], sticky },
    };
  }

  test("sticky execution keeps the first leaf within one execution", () => {
    resetPoolCursors();
    const config = stickyPool("round-robin", "execution");
    const key = "flow/node/rr-sticky";
    const primaries: string[] = [];
    for (let i = 0; i < 5; i++) {
      const chain = buildPoolCandidateChain(config, key, {
        stickyKey: "exec-1",
      });
      primaries.push(chain[0]?.model as string);
    }
    expect(primaries).toEqual(["qwen-a", "qwen-a", "qwen-a", "qwen-a", "qwen-a"]);
  });

  test("sticky execution rotates when the execution changes", () => {
    resetPoolCursors();
    const config = stickyPool("round-robin", "execution");
    const key = "flow/node/rr-rot";
    const first = buildPoolCandidateChain(config, key, {
      stickyKey: "exec-a",
    });
    const second = buildPoolCandidateChain(config, key, {
      stickyKey: "exec-b",
    });
    expect(first[0]?.model).toBe("qwen-a");
    expect(second[0]?.model).toBe("gemma-b");
  });

  test("sticky moves the pinned leaf back to the front of the rotated chain", () => {
    resetPoolCursors();
    const config = stickyPool("round-robin", "execution");
    const key = "flow/node/rr-order";
    // First call selects A (cursor 0) and pins it.
    buildPoolCandidateChain(config, key, { stickyKey: "exec-1" });
    // The second call would rotate to B (cursor 1 -> [B, C, A]); stickiness
    // moves A back to the front and keeps the rotated order behind it as the
    // failover chain.
    const chain = buildPoolCandidateChain(config, key, { stickyKey: "exec-1" });
    expect(chain.map((c) => c.model)).toEqual([
      "qwen-a",
      "gemma-b",
      "haiku-c",
    ]);
  });

  test("unavailable sticky leaf fails over and re-pins the new head", () => {
    resetPoolCursors();
    const config = stickyPool("round-robin", "execution");
    const key = "flow/node/rr-fail";
    buildPoolCandidateChain(config, key, { stickyKey: "exec-1" });
    // Sticky leaf A goes down: the chain fails over to the rotated head C...
    const down = buildPoolCandidateChain(config, key, {
      stickyKey: "exec-1",
      isAvailable: (c) => c.model !== "qwen-a",
    });
    expect(down.map((c) => c.model)).toEqual(["haiku-c", "gemma-b"]);
    // ...and the sticky entry followed C, so C stays primary once A is back.
    const restored = buildPoolCandidateChain(config, key, {
      stickyKey: "exec-1",
    });
    expect(restored[0]?.model).toBe("haiku-c");
  });

  test("sticky conversation shares the leaf across executions of one conversation", () => {
    resetPoolCursors();
    const config = stickyPool("round-robin", "conversation");
    const key = "flow/node/conv";
    const first = buildPoolCandidateChain(config, key, {
      stickyKey: "conv-1",
    });
    const second = buildPoolCandidateChain(config, key, {
      stickyKey: "conv-1",
    });
    const other = buildPoolCandidateChain(config, key, {
      stickyKey: "conv-2",
    });
    expect(first[0]?.model).toBe("qwen-a");
    expect(second[0]?.model).toBe("qwen-a");
    // The cursor still advances per call, so a fresh conversation gets the
    // rotated head (call 3 -> cursor 2 -> C).
    expect(other[0]?.model).toBe("haiku-c");
  });

  test("sticky none (default) keeps rotating even with a sticky key", () => {
    resetPoolCursors();
    const config = stickyPool("round-robin", "none");
    const key = "flow/node/none";
    const primaries: string[] = [];
    for (let i = 0; i < 3; i++) {
      const chain = buildPoolCandidateChain(config, key, {
        stickyKey: "exec-1",
      });
      primaries.push(chain[0]?.model as string);
    }
    expect(primaries).toEqual(["qwen-a", "gemma-b", "haiku-c"]);
  });

  test("applyStickiness pins a member of the ordered chain", () => {
    resetPoolCursors();
    const ordered = [A, B, C];
    expect(applyStickiness(ordered, "p", "s").map((c) => c.model)).toEqual([
      "qwen-a",
      "gemma-b",
      "haiku-c",
    ]);
    const rotated = [B, C, A];
    expect(applyStickiness(rotated, "p", "s").map((c) => c.model)).toEqual([
      "qwen-a",
      "gemma-b",
      "haiku-c",
    ]);
  });

  test("applyStickiness re-pins when the sticky leaf is gone", () => {
    resetPoolCursors();
    applyStickiness([A, B], "p", "s");
    expect(applyStickiness([B, C], "p", "s").map((c) => c.model)).toEqual([
      "gemma-b",
      "haiku-c",
    ]);
    // The entry now follows B, so B is pinned for later chains.
    expect(applyStickiness([C, B], "p", "s").map((c) => c.model)).toEqual([
      "gemma-b",
      "haiku-c",
    ]);
  });

  test("applyStickiness ignores entries older than the TTL", () => {
    resetPoolCursors();
    applyStickiness([A, B], "p", "ttl");
    const original = Date.now;
    try {
      Date.now = () => original() + STICKY_TTL_MS + 1;
      expect(
        applyStickiness([B, A], "p", "ttl").map((c) => c.model),
      ).toEqual(["gemma-b", "qwen-a"]);
    } finally {
      Date.now = original;
    }
  });

  test("sticky store is bounded to STICKY_MAX_ENTRIES", () => {
    resetPoolCursors();
    for (let i = 0; i < STICKY_MAX_ENTRIES + 10; i++) {
      applyStickiness([A, B], "p", `s${i}`);
    }
    // The oldest entries were evicted, so a fresh call for s0 pins the head.
    expect(applyStickiness([B, A], "p", "s0").map((c) => c.model)).toEqual([
      "gemma-b",
      "qwen-a",
    ]);
  });
});
