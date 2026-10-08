// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * converter-rpc.test.ts
 *
 * The isolated-converter transport (requirement 5.7): the framing, the request
 * validation, and a real round trip over a real Unix socket against the real
 * server, so the error taxonomy is proven to survive the container boundary —
 * a missing binary must arrive as CONVERTER_UNAVAILABLE, not as a generic
 * socket failure, or the whole point of the taxonomy is lost at the one hop
 * where it matters most.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtractError } from "../src/errors.js";
import {
  configureConverterTransport,
  getConverterTransport,
  probeConverterSocket,
  run,
} from "../src/pipeline/exec.js";
import {
  encodeFrame,
  FrameDecoder,
  parseConverterRequest,
  ProtocolError,
} from "../src/converter/protocol.js";
import { startConverterServer } from "../src/converter/server.js";

const silentLog = (): void => {};

describe("frame decoder", () => {
  it("splits frames on newline boundaries across chunk boundaries", () => {
    const decoder = new FrameDecoder(1024);
    const first = encodeFrame({ a: 1 });
    const second = encodeFrame({ b: 2 });
    const bytes = Buffer.from(`${first}${second}`);
    // Feed one byte at a time: the decoder must emit only on newlines.
    const frames: string[] = [];
    for (const byte of bytes) {
      frames.push(...decoder.push(Buffer.from([byte])));
    }
    expect(frames).toEqual([JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 })]);
  });

  it("escapes newlines inside payloads so the boundary stays unambiguous", () => {
    const decoder = new FrameDecoder(1024);
    const frame = encodeFrame({ text: "line1\nline2" });
    expect(frame.includes("\nline2")).toBe(false);
    const [decoded] = decoder.push(Buffer.from(frame));
    expect(decoded).toBeDefined();
    expect(JSON.parse(decoded ?? "")).toEqual({ text: "line1\nline2" });
  });

  it("rejects a frame larger than the limit instead of buffering it", () => {
    const decoder = new FrameDecoder(16);
    expect(() => decoder.push(Buffer.from("x".repeat(40)))).toThrow(ProtocolError);
  });

  it("rejects a completed frame larger than the limit", () => {
    const decoder = new FrameDecoder(16);
    expect(() => decoder.push(Buffer.from(`${"y".repeat(40)}\n`))).toThrow(
      ProtocolError,
    );
  });
});

describe("request validation", () => {
  const valid = {
    id: 7,
    command: "pdfinfo",
    args: ["/tmp/x.pdf"],
    home: "/tmp",
    timeoutMs: 1000,
    maxBuffer: 4096,
  };

  it("accepts a well-formed request", () => {
    expect(parseConverterRequest(JSON.stringify(valid))).toEqual(valid);
  });

  it("rejects non-JSON, non-objects, and a non-string argument", () => {
    expect(() => parseConverterRequest("{")).toThrow(ProtocolError);
    expect(() => parseConverterRequest("42")).toThrow(ProtocolError);
    expect(() =>
      parseConverterRequest(JSON.stringify({ ...valid, args: [1] })),
    ).toThrow(/args/);
    expect(() =>
      parseConverterRequest(JSON.stringify({ ...valid, command: "" })),
    ).toThrow(/command/);
    expect(() =>
      parseConverterRequest(JSON.stringify({ ...valid, timeoutMs: -1 })),
    ).toThrow(/timeoutMs/);
  });
});

describe("converter RPC over a real Unix socket", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    configureConverterTransport({ mode: "local", socketPath: "" });
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  async function startTestServer(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-rpc-"));
    const socketPath = join(dir, "converter.sock");
    const server = await startConverterServer({
      socketPath,
      log: silentLog,
    });
    cleanups.push(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });
    return socketPath;
  }

  it("runs a command remotely and returns stdout", async () => {
    const socketPath = await startTestServer();
    configureConverterTransport({ mode: "isolated", socketPath });
    expect(getConverterTransport().mode).toBe("isolated");
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-home-"));
    const { stdout } = await run("echo", ["hello from the sidecar"], dir, {
      timeoutMs: 10_000,
    });
    expect(stdout.trim()).toBe("hello from the sidecar");
  });

  it("maps a missing binary across the boundary to CONVERTER_UNAVAILABLE", async () => {
    const socketPath = await startTestServer();
    configureConverterTransport({ mode: "isolated", socketPath });
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-home-"));
    const error = await run("no-such-converter-binary-xyz", [], dir).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe("CONVERTER_UNAVAILABLE");
  });

  it("maps a failing exit across the boundary to CONVERSION_FAILED", async () => {
    const socketPath = await startTestServer();
    configureConverterTransport({ mode: "isolated", socketPath });
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-home-"));
    const error = await run("sh", ["-c", "echo boom >&2; exit 3"], dir).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe("CONVERSION_FAILED");
  });

  it("enforces the timeout inside the converter", async () => {
    const socketPath = await startTestServer();
    configureConverterTransport({ mode: "isolated", socketPath });
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-home-"));
    const started = Date.now();
    const error = await run("sleep", ["5"], dir, { timeoutMs: 250 }).catch(
      (err: unknown) => err,
    );
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe("CONVERSION_FAILED");
    // The server killed it at ~250 ms; the client grace must not have fired.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("reports CONVERTER_UNAVAILABLE when no converter is listening", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-gone-"));
    configureConverterTransport({
      mode: "isolated",
      socketPath: join(dir, "nothing-here.sock"),
    });
    const error = await run("echo", ["x"], dir).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe("CONVERTER_UNAVAILABLE");
    expect((error as ExtractError).message).toMatch(/not reachable/);
  });

  it("answers the abort of a caller without hanging", async () => {
    const socketPath = await startTestServer();
    configureConverterTransport({ mode: "isolated", socketPath });
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-home-"));
    const controller = new AbortController();
    const pending = run("sleep", ["5"], dir, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe("CONVERSION_FAILED");
  });

  it("probes the socket for readiness", async () => {
    const socketPath = await startTestServer();
    await expect(probeConverterSocket(socketPath)).resolves.toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "atf-converter-gone-"));
    await expect(probeConverterSocket(join(dir, "absent.sock"))).resolves.toBe(
      false,
    );
  });
});
