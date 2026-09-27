// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2/codec.ts
 *
 * The NDJSON codec for the v2 record stream.
 *
 * NDJSON (one JSON object per line) is the transport because it streams in both
 * directions without holding the whole document in memory: Extract emits a
 * `document.begin`, then a `page` per line as each page finishes, then a
 * `document.end`; Search validates and stages line by line. A 10,000-page
 * document is therefore never materialised as a single value on either side.
 *
 * Encoding is trivial (`JSON.stringify` + `\n`). The interesting half is
 * decoding a byte stream whose chunk boundaries fall anywhere — mid-line,
 * mid-multibyte-character — which is why the streaming decoder buffers a
 * partial trailing line and uses an incremental `TextDecoder`.
 *
 * Every decoded object is validated through the record schema, so a consumer
 * that pulls from {@link decodeRecordStream} only ever sees well-formed records
 * (or a thrown {@link RecordDecodeError} it can turn into the machine-readable
 * rejection Search owes the producer).
 */

import type { ExtractRecord } from "./records.js";
import { validateRecord, type RecordValidation } from "./validate.js";

/** A line that parsed as JSON but failed record validation, or was not JSON. */
export class RecordDecodeError extends Error {
  /** 0-based line number within the stream, when known. */
  readonly line: number | undefined;
  /** The offending raw line. */
  readonly raw: string;
  /** Structured validation issues, when the failure was a schema violation. */
  readonly validation: RecordValidation | undefined;

  constructor(
    message: string,
    options: { line?: number; raw: string; validation?: RecordValidation },
  ) {
    super(message);
    this.name = "RecordDecodeError";
    this.line = options.line;
    this.raw = options.raw;
    this.validation = options.validation;
  }
}

/** Serialize one record to a single NDJSON line (without the trailing newline). */
export function encodeRecordLine(record: ExtractRecord): string {
  return JSON.stringify(record);
}

/** Serialize records to an NDJSON string, one record per line, trailing newline. */
export function encodeRecords(records: Iterable<ExtractRecord>): string {
  let out = "";
  for (const record of records) {
    out += `${encodeRecordLine(record)}\n`;
  }
  return out;
}

/**
 * Streaming encoder: yields one NDJSON line (newline-terminated) per record.
 *
 * Accepts a sync or async iterable so a producer can pipe pages straight from a
 * database cursor without buffering them.
 */
export async function* encodeRecordStream(
  records: Iterable<ExtractRecord> | AsyncIterable<ExtractRecord>,
): AsyncGenerator<string> {
  for await (const record of records as AsyncIterable<ExtractRecord>) {
    yield `${encodeRecordLine(record)}\n`;
  }
}

/**
 * Decode one NDJSON line into a validated record.
 *
 * Throws {@link RecordDecodeError} for non-JSON or a schema violation, carrying
 * the machine-readable issue list Search rejects a batch with.
 */
export function decodeRecordLine(line: string, lineNumber?: number): ExtractRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new RecordDecodeError(
      `line is not valid JSON: ${(error as Error).message}`,
      { line: lineNumber, raw: line },
    );
  }
  const result = validateRecord(value);
  if (!result.ok) {
    throw new RecordDecodeError(
      `record failed validation: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      { line: lineNumber, raw: line, validation: result },
    );
  }
  return result.record;
}

/**
 * Decode a whole NDJSON string into records.
 *
 * Blank lines are skipped (a trailing newline is normal). Every non-blank line
 * must validate, so this throws on the first bad record.
 */
export function decodeRecords(ndjson: string): ExtractRecord[] {
  const records: ExtractRecord[] = [];
  const lines = ndjson.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    records.push(decodeRecordLine(line, i));
  }
  return records;
}

/** A chunk source: raw bytes or already-decoded string fragments. */
type StreamChunk = Uint8Array | string;

/**
 * Streaming decoder: consume an async iterable of byte/string chunks whose
 * boundaries fall anywhere, and yield one validated record per complete line.
 *
 * The partial trailing line is buffered across chunks. Bytes are decoded with a
 * streaming {@link TextDecoder} so a multibyte character split across a chunk
 * boundary is reassembled rather than mangled.
 */
export async function* decodeRecordStream(
  chunks: AsyncIterable<StreamChunk> | Iterable<StreamChunk>,
): AsyncGenerator<ExtractRecord> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lineNumber = 0;

  const emitLine = function* (line: string): Generator<ExtractRecord> {
    if (line.trim() !== "") {
      yield decodeRecordLine(line, lineNumber);
    }
    lineNumber++;
  };

  for await (const chunk of chunks as AsyncIterable<StreamChunk>) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newlineAt = buffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      yield* emitLine(line);
      newlineAt = buffer.indexOf("\n");
    }
  }

  // Flush any bytes the streaming decoder was still holding, then the last line.
  buffer += decoder.decode();
  if (buffer !== "") {
    yield* emitLine(buffer);
  }
}
