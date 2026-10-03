// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, test, vi } from "vitest";
import { streamChatCompletion } from "../lib/studio-run";

const encoder = new TextEncoder();

describe("streamChatCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("parses fragmented CRLF SSE JSON without losing content", async () => {
    const payload =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const bytes = encoder.encode(payload);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const boundary of [1, 7, 19, 31, 48, bytes.length]) {
              const previous = [0, 1, 7, 19, 31, 48][
                [1, 7, 19, 31, 48, bytes.length].indexOf(boundary)
              ] ?? 0;
              controller.enqueue(bytes.slice(previous, boundary));
            }
            controller.close();
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: string[] = [];
    for await (const chunk of streamChatCompletion("token", "flow", "prompt")) {
      expect(chunk.kind).toBe("content");
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(["Hel", "lo"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[0]?.content).toBe("prompt");
  });

  test("splits reasoning_content and content deltas by kind", async () => {
    const payload =
      'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(payload)),
    );

    const deltas: Array<[string, string]> = [];
    for await (const d of streamChatCompletion("token", "flow", "prompt")) {
      deltas.push([d.kind, d.text]);
    }

    expect(deltas).toEqual([
      ["reasoning", "think "],
      ["reasoning", "more"],
      ["content", "answer"],
    ]);
  });

  test("images are sent as OpenAI image_url content parts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("data: [DONE]\n\n")));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _d of streamChatCompletion("token", "flow", "what is this", undefined, [
      "data:image/png;base64,AAAA",
    ])) {
      // drain
    }

    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});
