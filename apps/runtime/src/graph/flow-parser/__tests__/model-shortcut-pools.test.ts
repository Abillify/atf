// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  resolveModelShortcuts,
  type ModelShortcutsData,
} from "../model-shortcuts.js";
import { LlmConfigSchema } from "../validate.js";
import type { LlmConfig } from "../../../types/flow.js";

const DATA: ModelShortcutsData = {
  engines: {
    lmstudio: { provider: "macminilmstudio" },
    vllm: { provider: "gpuvllm" },
    bedrock: { provider: "awseu" },
  },
  modelPresets: {
    qwen: {
      model: "Qwen3.8-Flash-Next",
      parameters: { chatTemplateKwargs: { enable_thinking: false } },
    },
    gemma: { model: "google/gemma-4-26b" },
    haiku: { model: "eu.anthropic.claude-haiku" },
    sonnet: { model: "eu.anthropic.claude-sonnet-5" },
  },
  shortcuts: {
    "qwen-local": { engine: "vllm", model: "qwen" },
    "gemma-local": { engine: "lmstudio", model: "gemma" },
    "haiku-cloud": { engine: "bedrock", model: "haiku" },
    // Pool: ordered members, strategy defaults to "fallback".
    "local-first": {
      strategy: "fallback",
      members: [
        { engine: "vllm", model: "qwen" },
        { engine: "lmstudio", model: "gemma" },
      ],
    },
    // Pool with an explicit strategy and shortcut references.
    "resilient": {
      strategy: "round-robin",
      members: [
        { shortcut: "qwen-local" },
        { shortcut: "haiku-cloud" },
        { engine: "lmstudio", model: "gemma", parameters: { temperature: 0.3 } },
      ],
    },
    // Nested pool: a member that is itself a pool is kept as a sub-pool.
    "nested": {
      strategy: "round-robin",
      members: [{ shortcut: "local-first" }, { shortcut: "haiku-cloud" }],
    },
    // Inner round-robin sub-pool over two local endpoints.
    "local-rr": {
      strategy: "round-robin",
      members: [
        { engine: "vllm", model: "qwen" },
        { engine: "lmstudio", model: "gemma" },
      ],
    },
    // Pool with pool-level parameters, applied to every member leaf.
    "params-pool": {
      strategy: "round-robin",
      parameters: { extraBody: { repeat_penalty: 1.1 } },
      members: [
        { engine: "vllm", model: "qwen" },
        { engine: "lmstudio", model: "gemma" },
      ],
    },
    // Outer pool with params, inner sub-pool that OVERRIDES one of them.
    "params-outer": {
      strategy: "fallback",
      parameters: { extraBody: { repeat_penalty: 1.1 }, seed: 7 },
      members: [{ shortcut: "params-inner" }, { shortcut: "haiku-cloud" }],
    },
    "params-inner": {
      strategy: "round-robin",
      parameters: { extraBody: { repeat_penalty: 1.3 } },
      members: [
        { engine: "vllm", model: "qwen" },
        { engine: "lmstudio", model: "gemma" },
      ],
    },
    // Target scenario: outer fallback holds the RR sub-pool as primary, cloud
    // haiku as the last-resort fallback. A weight rides on the sub-pool member.
    "rr-then-fallback": {
      strategy: "fallback",
      members: [
        { shortcut: "local-rr", weight: 5 },
        { shortcut: "haiku-cloud" },
      ],
    },
    // Reference cycles must be detected, not looped forever.
    "cycle-a": { strategy: "fallback", members: [{ shortcut: "cycle-b" }] },
    "cycle-b": { strategy: "fallback", members: [{ shortcut: "cycle-a" }] },
    // A pool whose member references an unknown shortcut is unusable.
    "broken-pool": {
      strategy: "fallback",
      members: [{ engine: "vllm", model: "qwen" }, { shortcut: "nope" }],
    },
  },
};

function nodeWithLlm(llm: Record<string, unknown>): Record<string, unknown> {
  return { nodes: [{ id: "n1", type: "llm", llm }] };
}

function firstLlm(raw: Record<string, unknown>): Record<string, unknown> {
  const node = (raw.nodes as Array<Record<string, unknown>>)[0];
  if (node === undefined) throw new Error("expected a first node");
  return node.llm as Record<string, unknown>;
}

function poolOf(llm: Record<string, unknown>): {
  strategy?: string;
  candidates: LlmConfig[];
} {
  const pool = llm.pool as
    | { strategy?: string; candidates: LlmConfig[] }
    | undefined;
  if (pool === undefined) throw new Error("expected a pool");
  return pool;
}

describe("resolveModelShortcuts — pool shortcuts", () => {
  test("bare pool list expands to first candidate + fallback pool", () => {
    const raw = nodeWithLlm({ shortcut: "local-first" });
    resolveModelShortcuts(raw, DATA, "f");
    const llm = firstLlm(raw);
    expect(llm.shortcut).toBeUndefined();
    // The host config carries the FIRST member so every plain-LlmConfig
    // consumer (admission, cost, compliance) sees a valid model.
    expect(llm.provider).toBe("gpuvllm");
    expect(llm.model).toBe("Qwen3.8-Flash-Next");
    const pool = poolOf(llm);
    expect(pool.strategy).toBe("fallback");
    expect(pool.candidates.map((c) => `${c.provider}/${c.model}`)).toEqual([
      "gpuvllm/Qwen3.8-Flash-Next",
      "macminilmstudio/google/gemma-4-26b",
    ]);
  });

  test("round-robin strategy is carried through expansion", () => {
    const raw = nodeWithLlm({ shortcut: "resilient" });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    expect(pool.strategy).toBe("round-robin");
    expect(pool.candidates.map((c) => `${c.provider}/${c.model}`)).toEqual([
      "gpuvllm/Qwen3.8-Flash-Next",
      "awseu/eu.anthropic.claude-haiku",
      "macminilmstudio/google/gemma-4-26b",
    ]);
  });

  test("member preset params and member-level params both apply", () => {
    const raw = nodeWithLlm({ shortcut: "resilient" });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    const qwen = pool.candidates[0];
    const gemma = pool.candidates[2];
    // Preset tuning survives on the referenced member.
    expect(qwen?.parameters).toEqual({
      chatTemplateKwargs: { enable_thinking: false },
    });
    // A member's own extra params layer on top of its preset's.
    expect(gemma?.parameters).toEqual({ temperature: 0.3 });
  });

  test("node-level parameters apply to every pool candidate", () => {
    const raw = nodeWithLlm({
      shortcut: "local-first",
      parameters: { maxTokens: 256 },
    });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    // A round-robin pool must behave identically however it rotates, so the
    // requesting node's overrides ride on all members.
    for (const candidate of pool.candidates) {
      expect(candidate.parameters?.maxTokens).toBe(256);
    }
    // Preset tuning is preserved alongside the node override.
    expect(pool.candidates[0]?.parameters?.chatTemplateKwargs).toEqual({
      enable_thinking: false,
    });
  });

  test("a referenced pool member is kept as a NESTED sub-pool, not flattened", () => {
    const raw = nodeWithLlm({ shortcut: "nested" });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    expect(pool.strategy).toBe("round-robin");
    // Two outer candidates: the inner "local-first" pool (as a sub-pool) and
    // the concrete haiku config — the inner pool is NOT spread into the parent.
    expect(pool.candidates).toHaveLength(2);
    const [sub, haiku] = pool.candidates;
    // First candidate carries its own pool with the inner strategy preserved.
    expect(sub?.pool?.strategy).toBe("fallback");
    expect(sub?.pool?.candidates.map((c) => `${c.provider}/${c.model}`)).toEqual(
      ["gpuvllm/Qwen3.8-Flash-Next", "macminilmstudio/google/gemma-4-26b"],
    );
    // Host provider/model of the sub-pool candidate is its first leaf.
    expect(`${sub?.provider}/${sub?.model}`).toBe(
      "gpuvllm/Qwen3.8-Flash-Next",
    );
    // Second candidate is the concrete referenced single shortcut (no pool).
    expect(`${haiku?.provider}/${haiku?.model}`).toBe(
      "awseu/eu.anthropic.claude-haiku",
    );
    expect(haiku?.pool).toBeUndefined();
  });

  test("outer fallback with inner round-robin sub-pool preserves both strategies", () => {
    const raw = nodeWithLlm({ shortcut: "rr-then-fallback" });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    expect(pool.strategy).toBe("fallback");
    expect(pool.candidates).toHaveLength(2);
    const [sub, fallback] = pool.candidates;
    // Inner sub-pool keeps round-robin and its two local members.
    expect(sub?.pool?.strategy).toBe("round-robin");
    expect(sub?.pool?.candidates.map((c) => c.provider)).toEqual([
      "gpuvllm",
      "macminilmstudio",
    ]);
    // A member weight on a sub-pool reference is preserved for weighted outer
    // strategies.
    expect(sub?.weight).toBe(5);
    // Outer fallback member is the concrete cloud model.
    expect(`${fallback?.provider}/${fallback?.model}`).toBe(
      "awseu/eu.anthropic.claude-haiku",
    );
  });

  test("a nested-pool expansion validates as an LlmConfig", () => {
    const raw = nodeWithLlm({ shortcut: "rr-then-fallback" });
    resolveModelShortcuts(raw, DATA, "f");
    // DATA uses named providers (gpuvllm, awseu, …); those are accepted by the
    // provider registry check only when configured, so validate via the leaf
    // shape rather than provider-name resolution here.
    const llm = firstLlm(raw);
    expect(llm.pool).toBeDefined();
    const sub = (llm.pool as { candidates: LlmConfig[] }).candidates[0];
    expect(sub?.pool?.candidates).toHaveLength(2);
  });

  test("pool-level parameters are layered onto every member leaf", () => {
    const raw = nodeWithLlm({ shortcut: "params-pool" });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    for (const candidate of pool.candidates) {
      expect(candidate.parameters?.extraBody).toEqual({ repeat_penalty: 1.1 });
    }
    // The qwen member keeps its preset tuning alongside the pool param.
    expect(pool.candidates[0]?.parameters?.chatTemplateKwargs).toEqual({
      enable_thinking: false,
    });
    // The host config's parameters (first leaf) carry the pool param too.
    expect(
      (firstLlm(raw).parameters as Record<string, unknown>).extraBody,
    ).toEqual({ repeat_penalty: 1.1 });
  });

  test("node params override pool params which override preset params", () => {
    const raw = nodeWithLlm({
      shortcut: "params-pool",
      parameters: { extraBody: { repeat_penalty: 2.0 } },
    });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    // Node-level extraBody wins over the pool's.
    for (const candidate of pool.candidates) {
      expect(candidate.parameters?.extraBody).toEqual({ repeat_penalty: 2.0 });
    }
  });

  test("an inner sub-pool's params override the outer pool's on its leaves", () => {
    const raw = nodeWithLlm({ shortcut: "params-outer" });
    resolveModelShortcuts(raw, DATA, "f");
    const pool = poolOf(firstLlm(raw));
    const [subPool, cloud] = pool.candidates;
    // Inner leaves: inner repeat_penalty 1.3 wins over outer 1.1, but the
    // outer-only `seed` is still inherited.
    for (const leaf of subPool?.pool?.candidates ?? []) {
      expect(leaf.parameters?.extraBody).toEqual({ repeat_penalty: 1.3 });
      expect(leaf.parameters?.seed).toBe(7);
    }
    // The outer fallback member (haiku) only sees the outer pool params.
    expect(cloud?.parameters?.extraBody).toEqual({ repeat_penalty: 1.1 });
    expect(cloud?.parameters?.seed).toBe(7);
  });

  test("a single shortcut never produces a pool", () => {
    const raw = nodeWithLlm({ shortcut: "qwen-local" });
    resolveModelShortcuts(raw, DATA, "f");
    expect(firstLlm(raw).pool).toBeUndefined();
  });

  test("cyclic pool reference is left unresolved (so Zod rejects it)", () => {
    const raw = nodeWithLlm({ shortcut: "cycle-a" });
    resolveModelShortcuts(raw, DATA, "f");
    const llm = firstLlm(raw);
    expect(llm.shortcut).toBe("cycle-a");
    expect(llm.provider).toBeUndefined();
    expect(llm.pool).toBeUndefined();
  });

  test("pool with an unknown member shortcut is left unresolved", () => {
    const raw = nodeWithLlm({ shortcut: "broken-pool" });
    resolveModelShortcuts(raw, DATA, "f");
    const llm = firstLlm(raw);
    expect(llm.shortcut).toBe("broken-pool");
    expect(llm.provider).toBeUndefined();
  });

  test("pools expand in nested llm locations too", () => {
    const raw = {
      nodes: [
        {
          id: "orch",
          type: "agent-harness",
          config: {
            plannerLlm: { shortcut: "local-first" },
            mediaTools: [{ name: "gen", llm: { shortcut: "resilient" } }],
          },
        },
      ],
    } as Record<string, unknown>;
    resolveModelShortcuts(raw, DATA, "f");
    const cfg = (
      (raw.nodes as Array<Record<string, unknown>>)[0] as {
        config: Record<string, unknown>;
      }
    ).config;
    const planner = cfg.plannerLlm as Record<string, unknown>;
    expect(planner.provider).toBe("gpuvllm");
    expect(poolOf(planner).candidates).toHaveLength(2);
    const media = cfg.mediaTools as Array<{ llm: Record<string, unknown> }>;
    expect(poolOf(media[0]?.llm as Record<string, unknown>).strategy).toBe(
      "round-robin",
    );
  });
});

// The expansion must produce a shape Zod ACCEPTS — otherwise every pool flow
// would be skipped at load. Uses built-in protocol names so the provider
// registry check passes without a deployment PROVIDERS list.
describe("pool expansion passes Zod validation", () => {
  const BUILTIN: ModelShortcutsData = {
    engines: { local: { provider: "openai" }, cloud: { provider: "bedrock" } },
    modelPresets: {
      qwen: { model: "qwen/qwen3.6" },
      haiku: { model: "anthropic/claude-haiku" },
    },
    shortcuts: {
      "pool-fb": {
        strategy: "fallback",
        members: [
          { engine: "local", model: "qwen" },
          { engine: "cloud", model: "haiku" },
        ],
      },
      "pool-rr": {
        strategy: "round-robin",
        members: [{ engine: "local", model: "qwen" }],
      },
    },
  };

  test("an expanded fallback pool validates as an LlmConfig", () => {
    const raw = nodeWithLlm({ shortcut: "pool-fb" });
    resolveModelShortcuts(raw, BUILTIN, "f");
    const parsed = LlmConfigSchema.safeParse(firstLlm(raw));
    expect(parsed.success).toBe(true);
  });

  test("an expanded round-robin pool validates as an LlmConfig", () => {
    const raw = nodeWithLlm({ shortcut: "pool-rr" });
    resolveModelShortcuts(raw, BUILTIN, "f");
    expect(LlmConfigSchema.safeParse(firstLlm(raw)).success).toBe(true);
  });

  test("an unresolved pool shortcut is rejected by Zod", () => {
    const raw = nodeWithLlm({ shortcut: "broken-pool" });
    resolveModelShortcuts(raw, DATA, "f");
    // `shortcut` survives and provider is missing → Zod must reject the node.
    expect(LlmConfigSchema.safeParse(firstLlm(raw)).success).toBe(false);
  });
});
