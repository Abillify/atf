// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit test for `splitChunkByFrameBytes` (src/graph/exec-runtime.ts).
 *
 * Final hard-cap guard at the SSE write choke point (streaming.ts else-branch):
 * any `chat.completion.chunk` whose wire frame (`data: <json>\n\n`) would exceed
 * the aiohttp 131072-byte (128 KiB) per-line cap of Open WebUI's client is split
 * into equivalent sub-frames so no single `data:` line aborts the read with
 * "Got more than 131072 bytes when reading". This is the byte-exact net beneath
 * the per-emitter CHARACTER splitters (`onReasoning`/`sendToken` at 60_000
 * chars), which do not guarantee a byte budget for multibyte / JSON-escape-heavy
 * content.
 */
import { describe, test, expect } from "bun:test";
import { splitChunkByFrameBytes } from "../exec-runtime.js";
import type { ChatCompletionChunk, CitationSource } from "../../types/openai.js";

const CAP = 131072;

function frameBytes(chunk: ChatCompletionChunk): number {
  return Buffer.byteLength(`data: ${JSON.stringify(chunk)}\n\n`, "utf8");
}

function reasoningChunk(text: string): ChatCompletionChunk {
  return {
    id: "2ce42413-05d8-436a-aecf-4f3748c12dd3",
    object: "chat.completion.chunk",
    created: 1784700000,
    model: "openai/qwen/qwen3.6-35b-a3b",
    choices: [
      { index: 0, delta: { reasoning_content: text }, finish_reason: null },
    ],
  };
}

function reasoningText(c: ChatCompletionChunk): string {
  return c.choices[0]?.delta.reasoning_content ?? "";
}

describe("splitChunkByFrameBytes", () => {
  test("passes an already-small frame through unchanged (fast path)", () => {
    const chunk = reasoningChunk("Task 3 → in-progress");
    const parts = splitChunkByFrameBytes(chunk);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(chunk);
  });

  test("splits an oversized reasoning_content frame so every frame is under the cap", () => {
    // A tool-result detail block (get_summaries over ~200 docs) that a
    // 60_000-char emitter would still emit as a >128 KiB byte frame. Build one
    // large enough that a single frame exceeds the cap.
    const big = "Beauskunftung geschwärzter Unterlagen. ".repeat(6000); // ~234k chars
    const chunk = reasoningChunk(big);
    expect(frameBytes(chunk)).toBeGreaterThan(CAP);

    const parts = splitChunkByFrameBytes(chunk);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(frameBytes(p)).toBeLessThanOrEqual(120_000);
    }
    // Client concatenates reasoning_content deltas → original reconstructed.
    expect(parts.map(reasoningText).join("")).toBe(big);
  });

  test("holds the byte budget for heavily multibyte content (all 2-byte umlauts)", () => {
    // 100_000 chars of pure umlauts ≈ 200 KB in one frame — the exact case a
    // CHARACTER-based 60_000 split does NOT catch.
    const umlauts = "ä".repeat(100_000);
    const chunk = reasoningChunk(umlauts);
    expect(frameBytes(chunk)).toBeGreaterThan(CAP);

    const parts = splitChunkByFrameBytes(chunk);
    for (const p of parts) {
      expect(frameBytes(p)).toBeLessThanOrEqual(120_000);
    }
    expect(parts.map(reasoningText).join("")).toBe(umlauts);
  });

  test("splits an oversized content (delta.content) frame too", () => {
    const big = "x".repeat(200_000);
    const chunk: ChatCompletionChunk = {
      id: "e42076b9-5788-411f-9906-0710dbc19632",
      object: "chat.completion.chunk",
      created: 1784700000,
      model: "m",
      choices: [{ index: 0, delta: { content: big }, finish_reason: null }],
    };
    expect(frameBytes(chunk)).toBeGreaterThan(CAP);

    const parts = splitChunkByFrameBytes(chunk);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(frameBytes(p)).toBeLessThanOrEqual(120_000);
    }
    expect(parts.map((p) => p.choices[0]?.delta.content ?? "").join("")).toBe(
      big,
    );
  });

  test("re-batches an oversized sources[] chunk by index (transparent merge)", () => {
    const sources: CitationSource[] = Array.from({ length: 260 }, (_, i) => ({
      index: i + 1,
      title: `Dok_${i}.pdf`,
      url: `/ExampleRecords/Beispielunterlagen/Dok_${i}_geprüft.pdf`,
      snippet: "Beauskunftung gemäß Art. 15 DSGVO. ".repeat(14).slice(0, 500),
      score: 0,
    }));
    const chunk: ChatCompletionChunk = {
      id: "2ce42413-05d8-436a-aecf-4f3748c12dd3",
      object: "chat.completion.chunk",
      created: 1784700000,
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      sources,
    };
    expect(frameBytes(chunk)).toBeGreaterThan(CAP);

    const parts = splitChunkByFrameBytes(chunk);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(frameBytes(p)).toBeLessThanOrEqual(120_000);
    }
    // Order + completeness preserved across the re-batched frames.
    const flat = parts.flatMap((p) => p.sources ?? []);
    expect(flat).toHaveLength(sources.length);
    expect(flat.map((s) => s.index)).toEqual(sources.map((s) => s.index));
  });

  test("emits an unsplittable oversized chunk as-is (best effort, bounded types)", () => {
    // A shape with no splittable string/array field (e.g. a huge groundedness
    // payload) is passed through rather than dropped — documented best effort.
    const chunk = {
      id: "abc",
      object: "chat.completion.chunk",
      created: 1784700000,
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      groundedness: { blob: "y".repeat(200_000) },
    } as unknown as ChatCompletionChunk;
    const parts = splitChunkByFrameBytes(chunk);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(chunk);
  });
});
