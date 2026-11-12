// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Classification of MCP transport errors (expired session, rejected auth, connection).
 * Split out of `client.ts` unchanged; that module re-exports them.
 */

import {
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { StreamableHTTPError };

/**
 * Returns true when the error signals that an MCP HTTP session has expired
 * (server responded with 404 — session not found / timed out).
 *
 * The MCP spec mandates that servers return 404 for requests that carry an
 * unknown or expired `mcp-session-id` header.
 */
export function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 404) {
    return true;
  }
  // Some SDK versions wrap the error as a plain Error whose message contains the status.
  if (err instanceof Error) {
    return /\b404\b/.test(err.message) && /session/i.test(err.message);
  }
  return false;
}

/**
 * Returns true when the server rejected the request's bearer (HTTP 401). For a
 * token-exchange server this means the exchanged token was revoked or lapsed
 * early (e.g. clock skew); the session is rebuilt with a freshly exchanged
 * token. For other servers a 401 is not recoverable by reconnecting.
 */
export function isAuthRejectedError(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 401) return true;
  // The native 2026 client reports failures as "... failed (HTTP 401): ...".
  return err instanceof Error && /\(HTTP 401\)/.test(err.message);
}

/**
 * Returns true when the error signals a transport-level connection failure —
 * i.e. the MCP server process restarted or its network endpoint became
 * temporarily unreachable.
 *
 * Unlike session expiry (HTTP 404), these errors are thrown at the OS /
 * transport layer and are not specific to a session ID. They appear on all
 * three transports:
 *  - http/sse: ECONNREFUSED / ECONNRESET / ETIMEDOUT / socket hang-up when the
 *              remote process restarts or the network path drops.
 *  - stdio:    EPIPE / "write after end" / "process exited" when the child
 *              process terminates.
 *
 * On detecting any of these we tear down the dead client and open a fresh
 * connection — exactly the same recovery path as for session expiry.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    // Node.js / OS-level network codes (case-insensitive match on the code name)
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH/i.test(msg) ||
    // Human-readable variants produced by the MCP SDK and the Node http stack
    /connection (closed|refused|reset|terminated|dropped|lost)/i.test(msg) ||
    /transport (closed|error|disconnected|ended)/i.test(msg) ||
    /socket (hang.?up|closed|error|end)/i.test(msg) ||
    /write after end/i.test(msg) ||
    // stdio transport: child process died
    /process (exited|terminated|died|crashed)/i.test(msg) ||
    /spawn.*ENOENT/i.test(msg)
  );
}
