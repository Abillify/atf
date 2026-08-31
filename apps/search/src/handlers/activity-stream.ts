// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/activity-stream.ts
 *
 * GET /activity/stream — Server-Sent Events endpoint.
 *
 * Each connected browser tab receives real-time activity events from ALL
 * sessions (ingest, search, delete) as they happen on the server.
 *
 * SSE format
 * ──────────
 * Each message is a standard SSE event:
 *
 *   id: <uuid>
 *   data: <JSON>
 *
 * The client can reconnect with `Last-Event-ID` to receive a replay of
 * the last REPLAY_BUFFER_SIZE events that happened before the reconnect.
 *
 * Authentication
 * ──────────────
 * Protected by the web auth middleware (cookie/token), same as the UI itself.
 */

import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import {
  onActivity,
  offActivity,
  type ActivityEvent,
} from "../activity-emitter.js";

/** Number of recent events kept in memory for reconnection replay. */
const REPLAY_BUFFER_SIZE = 200;

const replayBuffer: ActivityEvent[] = [];

/** Called by the emitter to persist an event into the replay buffer. */
onActivity((event: ActivityEvent) => {
  replayBuffer.push(event);
  if (replayBuffer.length > REPLAY_BUFFER_SIZE) {
    replayBuffer.shift();
  }
});

export function createActivityStreamHandler(): RequestHandler {
  return (req, res) => {
    // ── SSE handshake ──────────────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
    res.flushHeaders();

    // ── Replay missed events (Last-Event-ID reconnection support) ──────────
    const lastId = req.headers["last-event-id"] as string | undefined;
    if (lastId) {
      const idx = replayBuffer.findIndex((e) => e.id === lastId);
      const missed = idx >= 0 ? replayBuffer.slice(idx + 1) : replayBuffer;
      for (const event of missed) {
        res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }

    // ── Subscribe to live events ───────────────────────────────────────────
    const onActivityEvent = (event: ActivityEvent) => {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    onActivity(onActivityEvent);

    // ── Heartbeat — keep the connection alive through proxies ──────────────
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 25_000);

    // ── Cleanup on client disconnect ───────────────────────────────────────
    req.on("close", () => {
      clearInterval(heartbeat);
      offActivity(onActivityEvent);
    });
  };
}

/** Generate a unique, sortable event ID. */
export function newActivityId(): string {
  return randomUUID();
}
