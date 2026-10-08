// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * protocol.ts
 *
 * The converter RPC wire format (requirement 5.7).
 *
 * One JSON object per line, in both directions: the client sends a
 * {@link ConverterRequest}, the server answers with exactly one
 * {@link ConverterResponse} carrying the same `id`. Newline-delimited JSON
 * rather than a binary length prefix because `JSON.stringify` escapes every
 * newline inside a string, so `\n` is an unambiguous frame boundary — and the
 * format stays inspectable with `socat`/`nc` when a socket misbehaves, which
 * is worth more during an outage than the few bytes a length prefix saves.
 *
 * What crosses the boundary is a command line and the binary's output — never
 * document bytes. The input, output and HOME directories are paths on a
 * filesystem both containers mount at the same location, which keeps requests
 * small enough to validate cheaply and the converter's memory flat.
 */

/** A request to run one converter binary; mirrors `RunOptions` in exec.ts. */
export interface ConverterRequest {
  /** Echoed by the response; pairs replies with requests on a shared socket. */
  id: number;
  command: string;
  args: string[];
  /** Writable directory used as HOME/TMPDIR for the binary. */
  home: string;
  /** Wall-clock ceiling enforced by the converter's own execFile. 0 = none. */
  timeoutMs: number;
  /** Cap on captured stdout/stderr, enforced on the converter side. */
  maxBuffer: number;
}

/**
 * An error flattened across the socket — the same `__extractError` envelope
 * `pipeline/isolate.ts` uses across the worker-thread boundary. The `code` is
 * a plain string here: it comes from another container and must be validated
 * with `isExtractErrorCode` before it is trusted as an `ExtractErrorCode`.
 */
export interface SerializedConverterError {
  __extractError: boolean;
  code?: string;
  message: string;
}

export type ConverterResponse =
  | { id: number; ok: true; stdout: string; stderr: string }
  | { id: number; ok: false; error: SerializedConverterError };

/** Encode one frame: compact JSON terminated by a newline. */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Raised when a peer violates the framing; the connection is dropped. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * Incremental newline-delimited frame reader.
 *
 * A frame larger than `maxFrameBytes` is a protocol violation rather than an
 * allocation: the socket is shared between two containers, and a wedged or
 * compromised peer must not be able to make the reader grow without bound.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {}

  /** Append a chunk and return every complete frame it completed. */
  push(chunk: Buffer): string[] {
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: string[] = [];
    let newline = this.#buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > this.maxFrameBytes) {
        throw new ProtocolError(
          `frame of ${line.length} bytes exceeds the ${this.maxFrameBytes} byte limit`,
        );
      }
      // Blank lines between frames are tolerated; they carry no information.
      if (line.length > 0) frames.push(line.toString("utf8"));
      newline = this.#buffer.indexOf(0x0a);
    }
    if (this.#buffer.length > this.maxFrameBytes) {
      throw new ProtocolError(
        `inbound frame exceeds the ${this.maxFrameBytes} byte limit`,
      );
    }
    return frames;
  }
}

/**
 * Validate the untrusted request shape on the converter side.
 *
 * The converter runs binaries on files the request names, so the fields are
 * checked before anything touches `execFile`: a request whose `args` contain
 * a non-string would otherwise reach the process boundary as `undefined` and
 * surface as a confusing spawn failure.
 */
export function parseConverterRequest(line: string): ConverterRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError("request frame is not valid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new ProtocolError("request frame is not an object");
  }
  const o = value as Record<string, unknown>;
  const bad = (field: string, want: string): never => {
    throw new ProtocolError(`request field "${field}" must be ${want}`);
  };
  if (typeof o["id"] !== "number" || !Number.isInteger(o["id"])) {
    bad("id", "an integer");
  }
  if (typeof o["command"] !== "string" || o["command"].length === 0) {
    bad("command", "a non-empty string");
  }
  if (
    !Array.isArray(o["args"]) ||
    !o["args"].every((arg) => typeof arg === "string")
  ) {
    bad("args", "an array of strings");
  }
  if (typeof o["home"] !== "string" || o["home"].length === 0) {
    bad("home", "a non-empty string");
  }
  if (
    typeof o["timeoutMs"] !== "number" ||
    !Number.isFinite(o["timeoutMs"]) ||
    o["timeoutMs"] < 0
  ) {
    bad("timeoutMs", "a non-negative number");
  }
  if (
    typeof o["maxBuffer"] !== "number" ||
    !Number.isFinite(o["maxBuffer"]) ||
    o["maxBuffer"] <= 0
  ) {
    bad("maxBuffer", "a positive number");
  }
  return {
    id: o["id"] as number,
    command: o["command"] as string,
    args: o["args"] as string[],
    home: o["home"] as string,
    timeoutMs: o["timeoutMs"] as number,
    maxBuffer: o["maxBuffer"] as number,
  };
}
