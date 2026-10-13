// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { chunkDocument, isMeaningfulChunk, type Chunk } from "./chunker.js";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;
interface TextSpan { content: string; start: number; end: number }

/** Split into trimmed semantic units while retaining exact monotone source spans. */
function splitSentences(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  const push = (end: number): void => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (s < e) spans.push({ content: text.slice(s, e), start: s, end: e });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if ((ch === "." || ch === "!" || ch === "?") && next !== undefined && /\s/.test(next)) {
      push(i + 1);
    } else if (ch === "\n" && next === "\n") {
      push(i + 2);
      i++;
    }
  }
  push(text.length);
  return spans;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function semanticChunks(text: string, spans: TextSpan[], embeddings: number[][], options: { maxChunkSize: number; maxChunkOverlap: number; breakpointPercentile: number }): Chunk[] {
  const distances = spans.slice(0, -1).map((_, i) => 1 - cosineSim(embeddings[i], embeddings[i + 1]));
  const sorted = [...distances].sort((a, b) => a - b);
  const threshold = sorted[Math.min(Math.floor((options.breakpointPercentile / 100) * sorted.length), sorted.length - 1)] ?? 0;
  const segments: Array<{ start: number; end: number }> = [];
  let first = 0;
  for (let i = 1; i < spans.length; i++) {
    if ((distances[i - 1] ?? 0) > threshold) {
      segments.push({ start: spans[first].start, end: spans[i - 1].end });
      first = i;
    }
  }
  segments.push({ start: spans[first].start, end: spans[spans.length - 1].end });

  const chunks: Chunk[] = [];
  for (const segment of segments) {
    const segmentText = text.slice(segment.start, segment.end);
    const local = segmentText.length <= options.maxChunkSize
      ? [{ content: segmentText, index: 0, total: 1, overlapStart: 0, overlapEnd: 0, charStart: 0, charEnd: segmentText.length }]
      : chunkDocument(segmentText, options.maxChunkSize, options.maxChunkOverlap);
    for (const chunk of local) {
      if (!isMeaningfulChunk(chunk.content)) continue;
      chunks.push({ ...chunk, charStart: segment.start + chunk.charStart, charEnd: segment.start + chunk.charEnd });
    }
  }
  return chunks.map((chunk, index) => ({ ...chunk, index, total: chunks.length }));
}

export async function semanticChunk(text: string, embedFn: EmbedFn, options: { maxChunkSize: number; maxChunkOverlap: number; breakpointPercentile: number }): Promise<Chunk[]> {
  const spans = splitSentences(text);
  if (spans.length <= 2) return chunkDocument(text, options.maxChunkSize, options.maxChunkOverlap);
  const embeddings = await embedFn(spans.map((span) => span.content));
  if (embeddings.length !== spans.length) return chunkDocument(text, options.maxChunkSize, options.maxChunkOverlap);
  return semanticChunks(text, spans, embeddings, options);
}

export async function semanticChunkBatch(texts: string[], embedFn: EmbedFn, options: { maxChunkSize: number; maxChunkOverlap: number; breakpointPercentile: number }): Promise<Chunk[][]> {
  const docSpans = texts.map(splitSentences);
  const all: string[] = [];
  const offsets: number[] = [];
  for (const spans of docSpans) {
    offsets.push(all.length);
    if (spans.length > 2) all.push(...spans.map((span) => span.content));
  }
  if (all.length === 0) return texts.map((text) => chunkDocument(text, options.maxChunkSize, options.maxChunkOverlap));
  const embeddings = await embedFn(all);
  if (embeddings.length !== all.length) return texts.map((text) => chunkDocument(text, options.maxChunkSize, options.maxChunkOverlap));
  return texts.map((text, index) => {
    const spans = docSpans[index];
    if (spans.length <= 2) return chunkDocument(text, options.maxChunkSize, options.maxChunkOverlap);
    return semanticChunks(text, spans, embeddings.slice(offsets[index], offsets[index] + spans.length), options);
  });
}
