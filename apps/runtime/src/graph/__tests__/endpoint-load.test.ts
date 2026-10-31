// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CLAIM_TTL_MS,
  PROBE_CACHE_MS,
  PROBE_LAG_MS,
  acquireEndpointSlot,
  claimEndpoint,
  endpointLoad,
  isEndpointBusy,
  poolLoadOptions,
  refreshEndpointLoad,
  resetEndpointLoad,
  slotsProbeUrl,
  trackEndpointLoad,
} from "../endpoint-load.js";
import {
  buildPoolCandidateChain,
  poolStickiness,
  resetPoolCursors,
} from "../model-pool.js";
import {
  ProviderInstancesSchema,
  setProviderRegistry,
} from "../../config/providers.js";
import type { LlmConfig } from "../../types/flow.js";

const LLM1: LlmConfig = { provider: "slot1", model: "m" };
const LLM2: LlmConfig = { provider: "slot2", model: "m" };
const LLM3: LlmConfig = { provider: "wide", model: "m" };

function slotsFetch(state: Record<string, boolean | "fail">): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const entry = Object.entries(state).find(([prefix]) => url.startsWith(prefix));
    if (entry === undefined || entry[1] === "fail") throw new Error("unreachable");
    return new Response(JSON.stringify([{ id: 0, is_processing: entry[1] }]), {
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

beforeEach(() => {
  resetEndpointLoad();
  resetPoolCursors();
  setProviderRegistry(
    ProviderInstancesSchema.parse([
      {
        name: "slot1",
        protocol: "openai",
        url: "http://192.0.2.1:8000/v1",
        maxConcurrent: 1,
        loadProbe: "llama-slots",
      },
      {
        name: "slot2",
        protocol: "openai",
        url: "http://192.0.2.1:8002/v1/",
        max_concurrent: 1,
        load_probe: "llama-slots",
      },
      { name: "wide", protocol: "openai", url: "http://192.0.2.3:8000/v1" },
      { name: "local1", protocol: "openai", url: "http://192.0.2.4/v1", maxConcurrent: 1 },
    ]),
  );
});

afterEach(() => {
  setProviderRegistry([]);
  resetEndpointLoad();
});

describe("provider config", () => {
  test("parses camelCase and snake_case limits", () => {
    const [a, b] = ProviderInstancesSchema.parse([
      { name: "a", protocol: "openai", maxConcurrent: 2, loadProbe: "llama-slots" },
      { name: "b", protocol: "openai", max_concurrent: 3 },
    ]);
    expect(a?.maxConcurrent).toBe(2);
    expect(a?.loadProbe).toBe("llama-slots");
    expect(b?.maxConcurrent).toBe(3);
    expect(b?.loadProbe).toBeUndefined();
  });

  test("rejects invalid limits and probes", () => {
    expect(() =>
      ProviderInstancesSchema.parse([{ name: "a", protocol: "openai", maxConcurrent: 0 }]),
    ).toThrow();
    expect(() =>
      ProviderInstancesSchema.parse([{ name: "a", protocol: "openai", loadProbe: "vllm" }]),
    ).toThrow();
  });

  test("derives the llama.cpp /slots URL without /v1", () => {
    expect(slotsProbeUrl("slot1")).toBe("http://192.0.2.1:8000/slots");
    expect(slotsProbeUrl("slot2")).toBe("http://192.0.2.1:8002/slots");
    expect(slotsProbeUrl("local1")).toBeUndefined();
    expect(slotsProbeUrl("wide")).toBeUndefined();
  });
});

describe("local accounting", () => {
  test("providers without a limit are never busy", () => {
    acquireEndpointSlot("wide");
    acquireEndpointSlot("wide");
    expect(isEndpointBusy("wide")).toBe(false);
  });

  test("in-flight requests make a limited endpoint busy until released", () => {
    const release = acquireEndpointSlot("local1");
    expect(isEndpointBusy("local1")).toBe(true);
    release();
    release(); // idempotent
    expect(isEndpointBusy("local1")).toBe(false);
    expect(endpointLoad("local1").inFlight).toBe(0);
  });

  test("a claim counts until the request starts or it expires", () => {
    const now = 1_000_000;
    claimEndpoint("local1", now);
    expect(isEndpointBusy("local1", now + 10)).toBe(true);
    expect(isEndpointBusy("local1", now + CLAIM_TTL_MS + 1)).toBe(false);

    claimEndpoint("local1", now);
    const release = acquireEndpointSlot("local1", now + 5);
    // The claim was consumed: one request in flight, no extra claim.
    expect(endpointLoad("local1", now + 6)).toMatchObject({ inFlight: 1, claims: 0 });
    release();
  });

  test("trackEndpointLoad counts a streamed response until it is consumed", async () => {
    const base = (async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: x\n"));
          controller.close();
        },
      }))) as unknown as typeof fetch;
    const tracked = trackEndpointLoad("local1", base);
    const response = await tracked("http://192.0.2.4/v1/chat/completions");
    expect(isEndpointBusy("local1")).toBe(true);
    expect(await response.text()).toBe("data: x\n");
    expect(isEndpointBusy("local1")).toBe(false);
  });

  test("trackEndpointLoad releases on a failed request and on cancel", async () => {
    const failing = (async () => {
      throw new Error("connect failed");
    }) as unknown as typeof fetch;
    await expect(trackEndpointLoad("local1", failing)("http://x")).rejects.toThrow();
    expect(isEndpointBusy("local1")).toBe(false);

    const endless = (async () =>
      new Response(new ReadableStream({ pull() {} }))) as unknown as typeof fetch;
    const response = await trackEndpointLoad("local1", endless)("http://x");
    expect(isEndpointBusy("local1")).toBe(true);
    await response.body?.cancel();
    expect(isEndpointBusy("local1")).toBe(false);
  });

  test("trackEndpointLoad leaves unlimited providers untouched", () => {
    const base = (async () => new Response("ok")) as unknown as typeof fetch;
    expect(trackEndpointLoad("wide", base)).toBe(base);
  });
});

describe("slots probe", () => {
  test("a processing slot of another client makes the endpoint busy", async () => {
    const { fetch } = slotsFetch({ "http://192.0.2.1:8000": true, "http://192.0.2.1:8002": false });
    await refreshEndpointLoad(["slot1", "slot2", "wide"], fetch);
    expect(isEndpointBusy("slot1")).toBe(true);
    expect(isEndpointBusy("slot2")).toBe(false);
  });

  test("the probe is cached and shared", async () => {
    const { fetch, calls } = slotsFetch({ "http://192.0.2.1:8000": false });
    await Promise.all([
      refreshEndpointLoad(["slot1"], fetch),
      refreshEndpointLoad(["slot1"], fetch),
    ]);
    await refreshEndpointLoad(["slot1"], fetch);
    expect(calls).toEqual(["http://192.0.2.1:8000/slots"]);
  });

  test("own requests started after the probe count on top of it", async () => {
    const { fetch } = slotsFetch({ "http://192.0.2.1:8000": false });
    await refreshEndpointLoad(["slot1"], fetch);
    expect(isEndpointBusy("slot1")).toBe(false);
    claimEndpoint("slot1");
    expect(isEndpointBusy("slot1")).toBe(true);
  });

  test("older own requests are taken from the probe, not double counted", async () => {
    const started = Date.now() - PROBE_LAG_MS - PROBE_CACHE_MS - 50;
    // An in-flight entry whose completion event is late: the server already
    // reports the slot as idle, so the endpoint is free.
    acquireEndpointSlot("slot1", started);
    const { fetch } = slotsFetch({ "http://192.0.2.1:8000": false });
    await refreshEndpointLoad(["slot1"], fetch);
    expect(isEndpointBusy("slot1")).toBe(false);
  });

  test("a failed probe falls back to the local count", async () => {
    const { fetch } = slotsFetch({ "http://192.0.2.1:8000": "fail" });
    await refreshEndpointLoad(["slot1"], fetch);
    expect(isEndpointBusy("slot1")).toBe(false);
    const release = acquireEndpointSlot("slot1");
    expect(isEndpointBusy("slot1")).toBe(true);
    release();
  });

  test("poolLoadOptions is undefined for pools without limits", async () => {
    const { fetch, calls } = slotsFetch({});
    expect(await poolLoadOptions(["wide"], fetch)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("busy-aware pool selection", () => {
  const pool = (sticky?: "conversation"): LlmConfig => ({
    ...LLM1,
    pool: {
      strategy: "fallback",
      ...(sticky !== undefined ? { sticky } : {}),
      candidates: [LLM1, LLM2, LLM3],
    },
  });
  const order = (chain: LlmConfig[]): string[] => chain.map((c) => c.provider);

  test("a busy single-slot member moves behind the free ones", async () => {
    const { fetch } = slotsFetch({ "http://192.0.2.1:8000": true, "http://192.0.2.1:8002": false });
    const load = await poolLoadOptions(["slot1", "slot2", "wide"], fetch);
    expect(order(buildPoolCandidateChain(pool(), "k", { ...load }))).toEqual([
      "slot2",
      "wide",
      "slot1",
    ]);
  });

  test("all limited members busy: the unlimited member serves", async () => {
    const { fetch } = slotsFetch({ "http://192.0.2.1:8000": true, "http://192.0.2.1:8002": true });
    const load = await poolLoadOptions(["slot1", "slot2", "wide"], fetch);
    expect(order(buildPoolCandidateChain(pool(), "k", { ...load }))[0]).toBe("wide");
  });

  test("a sticky pin on a busy member moves to the free primary", async () => {
    const idle = slotsFetch({ "http://192.0.2.1:8000": false, "http://192.0.2.1:8002": false });
    let load = await poolLoadOptions(["slot1", "slot2", "wide"], idle.fetch);
    // First call pins the conversation to slot1.
    expect(
      buildPoolCandidateChain(pool("conversation"), "k", { ...load, stickyKey: "c1" })[0]
        ?.provider,
    ).toBe("slot1");

    // slot1 gets busy (another client): the call goes to slot2 and the pin moves.
    resetEndpointLoad();
    const busy = slotsFetch({ "http://192.0.2.1:8000": true, "http://192.0.2.1:8002": false });
    load = await poolLoadOptions(["slot1", "slot2", "wide"], busy.fetch);
    expect(
      buildPoolCandidateChain(pool("conversation"), "k", { ...load, stickyKey: "c1" })[0]
        ?.provider,
    ).toBe("slot2");

    // slot1 idle again: the conversation stays on slot2 (its cache is there).
    resetEndpointLoad();
    load = await poolLoadOptions(["slot1", "slot2", "wide"], idle.fetch);
    expect(
      buildPoolCandidateChain(pool("conversation"), "k", { ...load, stickyKey: "c1" })[0]
        ?.provider,
    ).toBe("slot2");
  });

  test("a fallback pool around a sticky sub-pool pins and moves the pin on load", async () => {
    // Deployment shape: fast-pool = fallback[ sticky weighted-rr(llm1, llm2, llm3), qwen3.6 ].
    const FALLBACK: LlmConfig = { provider: "wide", model: "fallback-model" };
    const inner: LlmConfig = {
      ...LLM1,
      pool: {
        strategy: "weighted-round-robin",
        sticky: "conversation",
        candidates: [LLM1, LLM2, { ...LLM3, weight: 2 }],
      },
    };
    const outer: LlmConfig = {
      ...LLM1,
      pool: { strategy: "fallback", candidates: [inner, FALLBACK] },
    };
    expect(poolStickiness(outer)).toBe("conversation");
    const idle = slotsFetch({ "http://192.0.2.1:8000": false, "http://192.0.2.1:8002": false });
    let load = await poolLoadOptions(["slot1", "slot2", "wide"], idle.fetch);
    const first = buildPoolCandidateChain(outer, "outer", { ...load, stickyKey: "c9" })[0]
      ?.provider;
    // Idle: the conversation stays on its first member although the inner
    // weighted round-robin rotates on every call.
    for (let i = 0; i < 5; i++) {
      expect(
        buildPoolCandidateChain(outer, "outer", { ...load, stickyKey: "c9" })[0]?.provider,
      ).toBe(first);
    }
    // Its member becomes busy: the call goes elsewhere and stays there.
    if (first === "slot1" || first === "slot2") {
      resetEndpointLoad();
      const busyState =
        first === "slot1"
          ? { "http://192.0.2.1:8000": true, "http://192.0.2.1:8002": false }
          : { "http://192.0.2.1:8000": false, "http://192.0.2.1:8002": true };
      load = await poolLoadOptions(["slot1", "slot2", "wide"], slotsFetch(busyState).fetch);
      const moved = buildPoolCandidateChain(outer, "outer", { ...load, stickyKey: "c9" })[0]
        ?.provider;
      expect(moved).not.toBe(first);
      resetEndpointLoad();
      load = await poolLoadOptions(["slot1", "slot2", "wide"], idle.fetch);
      expect(
        buildPoolCandidateChain(outer, "outer", { ...load, stickyKey: "c9" })[0]?.provider,
      ).toBe(moved);
    }
  });

  test("an explicit sticky: none on the outer pool disables nested stickiness", () => {
    const inner: LlmConfig = {
      ...LLM1,
      pool: { strategy: "round-robin", sticky: "conversation", candidates: [LLM1, LLM2] },
    };
    const outer: LlmConfig = {
      ...LLM1,
      pool: { strategy: "fallback", sticky: "none", candidates: [inner, LLM3] },
    };
    expect(poolStickiness(outer)).toBe("none");
    const a = buildPoolCandidateChain(outer, "o2", { stickyKey: "c1" })[0]?.provider;
    const b = buildPoolCandidateChain(outer, "o2", { stickyKey: "c1" })[0]?.provider;
    expect(a).not.toBe(b);
  });

  test("without load options the order is unchanged", () => {
    acquireEndpointSlot("slot1");
    expect(order(buildPoolCandidateChain(pool(), "k"))).toEqual(["slot1", "slot2", "wide"]);
  });
});
