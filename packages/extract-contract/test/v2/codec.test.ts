// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  RecordDecodeError,
  decodeRecordStream,
  decodeRecords,
  encodeRecordStream,
  encodeRecords,
  type ExtractRecord,
} from "../../src/index.js";
import { stream } from "./fixtures.js";

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/** Split an NDJSON string into arbitrary byte chunks to stress the decoder. */
function chunkBytes(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.slice(i, i + size));
  }
  return chunks;
}

describe("NDJSON codec", () => {
  test("encode → decode round-trips a full stream", () => {
    const records = stream();
    const ndjson = encodeRecords(records);
    expect(ndjson.endsWith("\n")).toBe(true);
    expect(decodeRecords(ndjson)).toEqual(records);
  });

  test("one record per line", () => {
    const ndjson = encodeRecords(stream());
    const lines = ndjson.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("decode skips blank lines", () => {
    const records = decodeRecords(`\n${encodeRecords(stream())}\n\n`);
    expect(records).toHaveLength(4);
  });

  test("decode throws a structured error on non-JSON", () => {
    let caught: unknown;
    try {
      decodeRecords("not json\n");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RecordDecodeError);
    expect((caught as RecordDecodeError).raw).toBe("not json");
  });

  test("decode throws a structured error carrying validation issues", () => {
    let caught: unknown;
    try {
      decodeRecords('{"type":"page","page":0}\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RecordDecodeError);
    expect((caught as RecordDecodeError).validation?.ok).toBe(false);
    expect((caught as RecordDecodeError).validation?.issues.length).toBeGreaterThan(0);
  });
});

describe("streaming codec", () => {
  test("encodeRecordStream yields newline-terminated lines", async () => {
    const lines = await collect(encodeRecordStream(stream()));
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.endsWith("\n")).toBe(true);
  });

  test("decodeRecordStream reassembles records from tiny byte chunks", async () => {
    const records = stream();
    const ndjson = encodeRecords(records);
    // A chunk size of 1 splits lines and multibyte umlauts arbitrarily.
    const decoded = await collect(
      decodeRecordStream(chunkBytes(ndjson, 1) as unknown as Iterable<Uint8Array>),
    );
    expect(decoded).toEqual(records);
  });

  test("decodeRecordStream handles a missing trailing newline", async () => {
    const records = stream();
    const ndjson = encodeRecords(records).replace(/\n$/, "");
    async function* source(): AsyncGenerator<string> {
      yield ndjson;
    }
    const decoded: ExtractRecord[] = await collect(decodeRecordStream(source()));
    expect(decoded).toEqual(records);
  });

  test("decodeRecordStream accepts string fragments split mid-line", async () => {
    const records = stream();
    const ndjson = encodeRecords(records);
    const mid = Math.floor(ndjson.length / 2);
    async function* source(): AsyncGenerator<string> {
      yield ndjson.slice(0, mid);
      yield ndjson.slice(mid);
    }
    expect(await collect(decodeRecordStream(source()))).toEqual(records);
  });
});
