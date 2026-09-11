// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it, vi } from "vitest";
import { createVisionClient, type VisionClientConfig } from "../src/vision/client.js";
import { ExtractError } from "../src/errors.js";
import { testLogger, TINY_PNG } from "./helpers.js";

const CONFIG: VisionClientConfig = {
  visionUrl: "http://model.test",
  visionModel: "test-vlm",
  visionApiKey: null,
  // Retries are exercised deliberately, so the timeout must not fire first.
  visionTimeoutMs: 5_000,
  visionTemperature: 0.1,
  visionTopP: 1,
  visionMaxTokenVariants: [100, 200, 400],
  visionMaxRetries: 2,
  visionReasoningEffort: null,
};

const PAGE = {
  page: 1,
  pageCount: 1,
  rawText: "Roher Text",
  image: { buffer: TINY_PNG, mimeType: "image/png" },
};

/** A chat-completions response with the given finish reason. */
function completion(content: string, finishReason = "stop", usage = { prompt: 10, completion: 5 }) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createVisionClient", () => {
  it("sends the page image and its text layer in one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("<markdown>ok</markdown>"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);

    expect(result.raw).toBe("<markdown>ok</markdown>");
    expect(result.requests).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://model.test/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.max_tokens).toBe(100);
    const userContent = body.messages[1]?.content as Array<Record<string, unknown>>;
    expect(userContent[0]?.["text"]).toContain("Roher Text");
    const imageUrl = userContent[1]?.["image_url"] as Record<string, unknown> | undefined;
    expect(imageUrl?.["url"]).toMatch(/^data:image\/png;base64,/);
    // "high" keeps the server from downscaling the page to a thumbnail.
    expect(imageUrl?.["detail"]).toBe("high");
  });

  it("omits the Authorization header when no key is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("<markdown>ok</markdown>"));
    vi.stubGlobal("fetch", fetchMock);
    await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("sends a bearer key when one is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("<markdown>ok</markdown>"));
    vi.stubGlobal("fetch", fetchMock);
    await createVisionClient({ ...CONFIG, visionApiKey: "k" }, testLogger).analyzePage(PAGE);
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
  });

  it("only sends chat_template_kwargs when a reasoning effort is set", async () => {
    // Strict servers reject unknown fields, so an unconditional field breaks every
    // request against them.
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => completion("<markdown>ok</markdown>"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).not.toHaveProperty(
      "chat_template_kwargs",
    );

    await createVisionClient({ ...CONFIG, visionReasoningEffort: "low" }, testLogger).analyzePage(PAGE);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body))).toMatchObject({
      chat_template_kwargs: { reasoning_effort: "low" },
    });
  });

  describe("truncation escalates the token budget", () => {
    it("moves to the next budget rather than repeating the identical request", async () => {
      // Retrying identically would produce the identical truncation.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(completion("abgeschnitten", "length"))
        .mockResolvedValueOnce(completion("<markdown>vollständig</markdown>"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);

      expect(result.raw).toBe("<markdown>vollständig</markdown>");
      expect(result.requests).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.maxTokens).toBe(200);
      const budgets = fetchMock.mock.calls.map(
        (call) => JSON.parse(String((call as [string, RequestInit])[1].body)).max_tokens as number,
      );
      expect(budgets).toEqual([100, 200]);
    });

    it("returns the partial response when every budget is exhausted", async () => {
      // A flagged 80% page beats a missing page.
      vi.stubGlobal("fetch", vi.fn(async () => completion("teilweise", "length")));

      const result = await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);

      expect(result.truncated).toBe(true);
      expect(result.raw).toBe("teilweise");
      expect(result.requests).toBe(3);
      expect(result.maxTokens).toBe(400);
    });

    it("accumulates usage across every attempt", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(completion("x", "length", { prompt: 10, completion: 100 }))
          .mockResolvedValueOnce(completion("<markdown>y</markdown>", "stop", { prompt: 10, completion: 50 })),
      );
      const result = await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);
      // The truncated attempt was paid for too.
      expect(result.usage.completionTokens).toBe(150);
      expect(result.usage.promptTokens).toBe(20);
    });
  });

  describe("transient failures retry in place", () => {
    it("retries a 503 and succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("loading", { status: 503 }))
        .mockResolvedValueOnce(completion("<markdown>ok</markdown>"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);
      expect(result.raw).toBe("<markdown>ok</markdown>");
      // Same budget, not escalated: the request was fine, the world was not.
      expect(result.maxTokens).toBe(100);
    });

    it("retries a network error", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(completion("<markdown>ok</markdown>"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(createVisionClient(CONFIG, testLogger).analyzePage(PAGE)).resolves.toMatchObject({
        raw: "<markdown>ok</markdown>",
      });
    });

    it("retries an empty completion", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(completion("   "))
        .mockResolvedValueOnce(completion("<markdown>ok</markdown>"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(createVisionClient(CONFIG, testLogger).analyzePage(PAGE)).resolves.toMatchObject({
        requests: 2,
      });
    });

    it("gives up after the retry budget and reports the endpoint as unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
      await expect(
        createVisionClient(CONFIG, testLogger).analyzePage(PAGE),
      ).rejects.toMatchObject({ code: "VISION_UNAVAILABLE", retryable: true });
    });

    it("does not escalate the budget for a transient failure", async () => {
      // Escalating on a 500 would burn the whole ladder on an unhealthy endpoint.
      const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      await createVisionClient(CONFIG, testLogger).analyzePage(PAGE).catch(() => undefined);
      expect(fetchMock).toHaveBeenCalledTimes(CONFIG.visionMaxRetries + 1);
    });
  });

  describe("permanent failures are not retried", () => {
    it("fails immediately on a 400", async () => {
      // A bad model name or an unsupported field will not fix itself, and retrying
      // hides the message.
      const fetchMock = vi.fn(async () => new Response('{"error":"unknown model"}', { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(createVisionClient(CONFIG, testLogger).analyzePage(PAGE)).rejects.toBeInstanceOf(
        ExtractError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a 429, which is transient by definition", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
        .mockResolvedValueOnce(completion("<markdown>ok</markdown>"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(createVisionClient(CONFIG, testLogger).analyzePage(PAGE)).resolves.toBeTruthy();
    });
  });

  it("stops when the client disconnects instead of finishing the page", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion("<markdown>ok</markdown>")));

    await expect(
      createVisionClient(CONFIG, testLogger).analyzePage({ ...PAGE, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "VISION_UNAVAILABLE" });
  });

  describe("probe", () => {
    it("uses the models listing so a health check spends no tokens", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(createVisionClient(CONFIG, testLogger).probe()).resolves.toEqual({
        available: true,
      });
      expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe("http://model.test/v1/models");
    });

    it("reports unavailability without throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
      await expect(createVisionClient(CONFIG, testLogger).probe()).resolves.toMatchObject({
        available: false,
      });
    });
  });
});
