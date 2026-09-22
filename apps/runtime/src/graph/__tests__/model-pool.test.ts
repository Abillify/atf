// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  buildPoolCandidateChain,
  poolLeafConfigs,
  poolSignature,
  resetPoolCursors,
} from "../model-pool.js";
import type { LlmConfig } from "../../types/flow.js";
import type { LlmPoolStrategy } from "../../types/flow.js";

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
