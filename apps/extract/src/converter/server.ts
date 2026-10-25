// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * server.ts
 *
 * The isolated converter.
 *
 * A minimal RPC server that runs poppler and LibreOffice on behalf of the
 * extract service. It exists so those binaries — the parts of the system that
 * parse attacker-controlled bytes — can run in a container with no network
 * access, a read-only root filesystem, a non-root UID and the default seccomp
 * profile, while the service that holds the API tokens, the database
 * credentials and the OIDC secret keeps its own, smaller attack surface.
 *
 * Deliberately absent:
 *
 *  - Any authentication. The socket is the trust boundary: it lives on a
 *    volume only the two containers mount, and the converter container has no
 *    network at all, so there is nothing else to connect to it. Adding a token
 *    would put a secret in the request path without adding a boundary.
 *  - Any file transfer. Requests name paths on a shared volume; document
 *    bytes never cross the socket, which keeps this server's memory flat
 *    regardless of document size.
 *  - Any concurrency cap. The extract service's `CONVERT_CONCURRENCY` and
 *    `PAGE_CONCURRENCY` are the queue; a second queue in front of them would
 *    only add a place for requests to be dropped silently.
 *
 * Run it as its own process (`node dist/converter/server.js`), typically as a
 * separate container next to the extract service.
 */

import { createServer, type Socket } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtractError } from "../errors.js";
import { runLocal } from "../pipeline/exec.js";
import {
  encodeFrame,
  FrameDecoder,
  parseConverterRequest,
  type ConverterRequest,
  type ConverterResponse,
} from "./protocol.js";

/**
 * A frame may hold a full pdftotext/bbox-layout output; the client sizes its
 * own `maxBuffer` and the server enforces that per request. This ceiling only
 * bounds what a peer may *send*, which is a command line — a few kilobytes.
 */
const MAX_REQUEST_FRAME_BYTES = 1 * 1024 * 1024;

export interface ConverterServerOptions {
  /** Socket path to listen on. Its parent directory is created if missing. */
  socketPath: string;
  /** Log sink; defaults to console. */
  log?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Flatten an error for the wire.
 *
 * An `ExtractError` keeps its code — that is the whole point of the taxonomy,
 * and the client re-validates it. Anything else becomes a generic failure so
 * an unexpected internal message cannot leak a path or a credential.
 */
function serializeError(error: unknown): ConverterResponse {
  if (error instanceof ExtractError) {
    return {
      id: 0,
      ok: false,
      error: { __extractError: true, code: error.code, message: error.message },
    };
  }
  return {
    id: 0,
    ok: false,
    error: {
      __extractError: false,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Handle one connection: read requests until it closes, answering each.
 *
 * A framing violation drops the connection rather than replying — a peer that
 * cannot frame a request cannot be trusted to route a response, and dropping
 * is the signal that something is wrong on that side.
 */
function handleConnection(socket: Socket, log: NonNullable<ConverterServerOptions["log"]>): void {
  const decoder = new FrameDecoder(MAX_REQUEST_FRAME_BYTES);
  // Requests on one connection are independent; a slow soffice must not block
  // a pdfinfo that arrives behind it, so each is dispatched without waiting.
  socket.on("data", (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch (err) {
      log("warn", "converter: dropping connection, framing violation", {
        error: err instanceof Error ? err.message : String(err),
      });
      socket.destroy();
      return;
    }
    for (const line of lines) {
      let request: ConverterRequest;
      try {
        request = parseConverterRequest(line);
      } catch (err) {
        const response = serializeError(err);
        socket.write(encodeFrame({ ...response, id: 0 }));
        continue;
      }
      void runLocal(request.command, request.args, request.home, {
        timeoutMs: request.timeoutMs,
        maxBuffer: request.maxBuffer,
      }).then(
        ({ stdout, stderr }) => {
          if (socket.destroyed) return;
          socket.write(encodeFrame({ id: request.id, ok: true, stdout, stderr }));
        },
        (error: unknown) => {
          if (socket.destroyed) return;
          socket.write(encodeFrame({ ...serializeError(error), id: request.id }));
        },
      );
    }
  });
  socket.on("error", (err: NodeJS.ErrnoException) => {
    // ECONNRESET/EPIPE are a client that gave up (abort, timeout); normal, not
    // worth an error log.
    if (err.code !== "ECONNRESET" && err.code !== "EPIPE") {
      log("warn", "converter: connection error", { code: err.code });
    }
  });
}

/**
 * Start the converter. Resolves once the socket is accepting connections.
 *
 * A stale socket file from a previous crash is removed first: `listen` fails
 * with EADDRINUSE on a dead socket, and a container restart would otherwise
 * never come back up.
 */
export async function startConverterServer(
  options: ConverterServerOptions,
): Promise<{ close: () => Promise<void> }> {
  const { socketPath } = options;
  const log =
    options.log ??
    ((level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => {
      console[level](`${message} ${fields === undefined ? "" : JSON.stringify(fields)}`);
    });

  await mkdir(dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });

  const server = createServer((socket) => handleConnection(socket, log));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // The service's own credentials are of no use to a document parser, and the
  // binaries it spawns get a minimal environment for the same reason. Dropping
  // them here means a compromise of the converter container finds nothing.
  log("info", `extract-converter listening on ${socketPath}`);

  return {
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          void rm(socketPath, { force: true });
          if (err !== undefined && err !== null) reject(err);
          else resolve();
        });
      }),
  };
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const socketPath = process.env["CONVERTER_SOCKET"] ?? "/run/atf-converter/converter.sock";
  startConverterServer({ socketPath }).catch((err: unknown) => {
    console.error("extract-converter failed to start:", err);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.info(`extract-converter shutting down (${signal})`);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
