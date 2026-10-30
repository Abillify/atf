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
  visionSupportsJsonSchema: false,
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

  it("sends enable_thinking from VISION_ENABLE_THINKING, alone or with reasoning_effort", async () => {
    // Qwen-style templates ignore reasoning_effort; only enable_thinking turns
    // their thinking block off.
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => completion("<markdown>ok</markdown>"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createVisionClient({ ...CONFIG, visionEnableThinking: false }, testLogger).analyzePage(PAGE);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body)).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });

    await createVisionClient(
      { ...CONFIG, visionReasoningEffort: "low", visionEnableThinking: true },
      testLogger,
    ).analyzePage(PAGE);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body)).chat_template_kwargs).toEqual({
      reasoning_effort: "low",
      enable_thinking: true,
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

  describe("structured output (response_format json_schema)", () => {
    const WITH_SCHEMA: VisionClientConfig = {
      ...CONFIG,
      visionSupportsJsonSchema: true,
    };

    /** The parsed request body of call number n. */
    function bodyOf(
      fetchMock: ReturnType<typeof vi.fn>,
      n = 0,
    ): Record<string, unknown> {
      return JSON.parse(
        String((fetchMock.mock.calls[n] as [string, RequestInit])[1].body),
      );
    }

    it("sends no response_format while the capability flag is off", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(completion("<markdown>ok</markdown>"));
      vi.stubGlobal("fetch", fetchMock);
      await createVisionClient(CONFIG, testLogger).analyzePage(PAGE);
      expect(bodyOf(fetchMock)).not.toHaveProperty("response_format");
    });

    it("sends the page schema when the flag is on", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(completion("<markdown>ok</markdown>"));
      vi.stubGlobal("fetch", fetchMock);
      await createVisionClient(WITH_SCHEMA, testLogger).analyzePage(PAGE);
      expect(bodyOf(fetchMock)).toMatchObject({
        response_format: {
          type: "json_schema",
          json_schema: { name: "page_extraction", strict: false },
        },
      });
    });

    it("sends the per-kind Pass-2 schema matching the figure kind", async () => {
      // A Response body is single-use, so each call needs a fresh one.
      const fetchMock = vi.fn(async () => completion('{"format":"process"}'));
      vi.stubGlobal("fetch", fetchMock);
      const client = createVisionClient(WITH_SCHEMA, testLogger);
      const figure = {
        page: 1,
        figureId: "p1-f1",
        kind: "bpmn",
        regionText: "",
        image: { buffer: TINY_PNG, mimeType: "image/png" },
      };
      await client.analyzeFigure(figure);
      expect(bodyOf(fetchMock, 0)).toMatchObject({
        response_format: { json_schema: { name: "process_transcription" } },
      });
      await client.analyzeFigure({ ...figure, kind: "chart" });
      expect(bodyOf(fetchMock, 1)).toMatchObject({
        response_format: { json_schema: { name: "data_transcription" } },
      });
    });

    it("re-renders a conforming JSON page into the tag format", async () => {
      const json = JSON.stringify({
        summary: "Eine Seite.",
        figures: [{ id: "1", kind: "chart", description: "Ein Diagramm." }],
        markdown: "Text mit ![figure_1](x)",
      });
      const fetchMock = vi.fn().mockResolvedValue(completion(json));
      vi.stubGlobal("fetch", fetchMock);

      const result = await createVisionClient(
        WITH_SCHEMA,
        testLogger,
      ).analyzePage(PAGE);

      expect(result.raw).toContain("<summary>Eine Seite.</summary>");
      expect(result.raw).toContain(
        '<figure id="1" kind="chart">Ein Diagramm.</figure>',
      );
      expect(result.raw).toContain(
        "<markdown>Text mit ![figure_1](x)</markdown>",
      );
    });

    it("passes a non-conforming response through to the tag parser untouched", async () => {
      // The provider accepted the field but the model answered in tags anyway
      // (or produced broken JSON): the existing parser must still get its raw.
      const raw =
        "<summary>s</summary><figures>None</figures><markdown>m</markdown>";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion(raw)));
      const result = await createVisionClient(
        WITH_SCHEMA,
        testLogger,
      ).analyzePage(PAGE);
      expect(result.raw).toBe(raw);
    });

    it("drops the field process-wide when the provider rejects it, and counts both requests", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            '{"error":"BadRequest: response_format json_schema unsupported"}',
            {
              status: 400,
            },
          ),
        )
        .mockResolvedValueOnce(completion("<markdown>ok</markdown>"));
      vi.stubGlobal("fetch", fetchMock);

      const client = createVisionClient(WITH_SCHEMA, testLogger);
      const result = await client.analyzePage(PAGE);

      expect(result.raw).toBe("<markdown>ok</markdown>");
      // The rejected attempt was paid for too.
      expect(result.requests).toBe(2);
      expect(bodyOf(fetchMock, 0)).toHaveProperty("response_format");
      expect(bodyOf(fetchMock, 1)).not.toHaveProperty("response_format");

      // And the next page does not probe the capability again.
      fetchMock.mockResolvedValue(completion("<markdown>noch eine</markdown>"));
      await client.analyzePage(PAGE);
      expect(bodyOf(fetchMock, 2)).not.toHaveProperty("response_format");
    });

    it("still fails permanently on a 400 that does not name the field", async () => {
      // A bad model name must not be mistaken for a capability rejection.
      const fetchMock = vi.fn(
        async () => new Response('{"error":"unknown model"}', { status: 400 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        createVisionClient(WITH_SCHEMA, testLogger).analyzePage(PAGE),
      ).rejects.toMatchObject({ code: "VISION_UNAVAILABLE" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
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

describe("analyzeFigure (Pass 2, task 2.5)", () => {
  const FIGURE = {
    page: 3,
    figureId: "p3-f1",
    kind: "ui_mask",
    regionText: "Lieferant Datum",
    caption: "Maske WE01",
    image: { buffer: TINY_PNG, mimeType: "image/png" },
  };

  it("sends the per-kind system prompt, the region text and the crop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completion('{"format":"fields","areas":[],"actions":[]}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createVisionClient(CONFIG, testLogger).analyzeFigure(FIGURE);
    expect(result.raw).toContain('"format":"fields"');
    expect(result.truncated).toBe(false);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://model.test/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // System prompt is the ui_mask Pass-2 prompt.
    expect(String(body.messages[0]?.content)).toContain('"format": "fields"');
    const userContent = body.messages[1]?.content as Array<Record<string, unknown>>;
    expect(userContent[0]?.["text"]).toContain("Lieferant Datum");
    expect(userContent[0]?.["text"]).toContain("Maske WE01");
    const imageUrl = userContent[1]?.["image_url"] as Record<string, unknown> | undefined;
    expect(imageUrl?.["url"]).toMatch(/^data:image\/png;base64,/);
    expect(imageUrl?.["detail"]).toBe("high");
  });

  it("escalates the token budget on truncation, like the page path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completion("partial", "length"))
      .mockResolvedValueOnce(completion('{"format":"fields","areas":[],"actions":[]}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createVisionClient(CONFIG, testLogger).analyzeFigure(FIGURE);
    expect(result.requests).toBe(2);
    // Second request used the next-larger budget.
    const first = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { max_tokens: number };
    const second = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { max_tokens: number };
    expect(first.max_tokens).toBe(100);
    expect(second.max_tokens).toBe(200);
  });

  it("rejects a kind that has no Pass-2 prompt", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createVisionClient(CONFIG, testLogger).analyzeFigure({ ...FIGURE, kind: "photo" }),
    ).rejects.toBeInstanceOf(ExtractError);
  });
});
