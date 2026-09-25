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
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hel", "lo"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");
  });
});
