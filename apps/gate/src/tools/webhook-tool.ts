// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import express from "express";
import type { AuthContext } from "../auth/context.ts";
import type { WebhookTool } from "../config/schema.ts";
import type { MonitorBus } from "../monitor/events.ts";
import { logger } from "../logger.ts";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolRuntime } from "./types.ts";

interface CachedPayload {
  value: unknown;
  receivedAt: number;
}

type InboundVerification = { ok: true } | { ok: false; reason: string; status: 401 | 409 | 503 };

/**
 * Webhook-backed tool. Inbound payloads are assigned only to the configured,
 * trusted tenant. Reads require the same tenant in a verified token claim;
 * request headers are deliberately never used as a tenant source.
 */
export class WebhookToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly payloads = new Map<string, CachedPayload>();

  constructor(
    private readonly cfg: WebhookTool,
    private readonly runtime: ToolRuntime,
  ) {
    this.definition = {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.inputSchema as Record<string, unknown>,
      ...(cfg.outputSchema !== undefined
        ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
        : {}),
    };
  }

  /** The Express path this webhook listens on (POST). */
  get path(): string {
    return this.cfg.path;
  }

  /** Mount the inbound receiver on the given router. */
  registerReceiver(router: Router, bus: MonitorBus): void {
    router.post(
      this.cfg.path,
      express.json({
        limit: "2mb",
        verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = Buffer.from(buf);
        },
      }),
      async (req: Request & { rawBody?: Buffer }, res: Response) => {
        const authResult = await this.verifyInbound(req);
        if (!authResult.ok) {
          bus.publish({
            type: "auth_failure",
            status: "error",
            message: `webhook '${this.cfg.name}': ${authResult.reason}`,
          });
          res.status(authResult.status).json({ error: authResult.reason });
          return;
        }

        // tenantId is operator-controlled configuration, never an inbound header.
        this.payloads.set(this.cfg.tenantId!, { value: req.body, receivedAt: Date.now() });
        logger.debug("webhook received", { tool: this.cfg.name, path: this.cfg.path });
        bus.publish({
          type: "tool_call",
          tool: this.cfg.name,
          status: "ok",
          message: "webhook payload received",
          meta: { source: "webhook" },
        });
        res.json({ ok: true });
      },
    );
  }

  private async verifyInbound(req: Request & { rawBody?: Buffer }): Promise<InboundVerification> {
    const auth = this.cfg.authentication;
    if (auth.type === "none") return { ok: true };

    if (auth.type === "bearer") {
      const presented = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
      if (!presented || !auth.token) return { ok: false, status: 401, reason: "missing bearer token" };
      if (!safeEqual(presented, auth.token)) return { ok: false, status: 401, reason: "invalid bearer token" };
      return { ok: true };
    }

    if (!auth.secret || !this.cfg.tenantId) {
      return { ok: false, status: 401, reason: "webhook HMAC secret or tenantId not configured" };
    }
    const sigHeader = req.headers[auth.header.toLowerCase()];
    const presented = (Array.isArray(sigHeader) ? sigHeader[0] : sigHeader)?.trim();
    if (!presented) return { ok: false, status: 401, reason: `missing ${auth.header} header` };

    const replay = this.cfg.replayProtection;
    const timestamp = requestHeader(req, replay.timestampHeader);
    const nonce = requestHeader(req, replay.nonceHeader);
    if (!timestamp) return { ok: false, status: 401, reason: `missing ${replay.timestampHeader} header` };
    if (!nonce) return { ok: false, status: 401, reason: `missing ${replay.nonceHeader} header` };
    if (nonce.length > 256) return { ok: false, status: 401, reason: "webhook nonce is too long" };
    if (!this.isFreshTimestamp(timestamp)) return { ok: false, status: 401, reason: "webhook timestamp is outside the accepted freshness window" };

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
    const expected = createHmac(auth.algorithm, auth.secret)
      .update(canonicalHmacInput(req.method, req.path, this.cfg.tenantId, timestamp, nonce, rawBody))
      .digest("hex");
    const normalized = presented.includes("=") ? presented.split("=").pop()! : presented;
    if (!safeEqual(normalized, expected)) return { ok: false, status: 401, reason: "invalid signature" };

    const replayKey = createHash("sha256")
      .update(JSON.stringify([this.cfg.name, this.cfg.tenantId, nonce]))
      .digest("hex");
    const store = this.runtime.webhookReplayStore;
    if (!store) return { ok: false, status: 503, reason: "webhook replay store unavailable" };
    try {
      const reserved = await store.reserve(replayKey, replay.cacheTtlSeconds * 1000);
      return reserved
        ? { ok: true }
        : { ok: false, status: 409, reason: "webhook nonce has already been used" };
    } catch (cause) {
      logger.error("webhook replay reservation failed", {
        tool: this.cfg.name,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return { ok: false, status: 503, reason: "webhook replay protection unavailable" };
    }
  }

  async execute(_args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> {
    // AUTHZ_ENABLED controls business permissions only. Tenant partitioning is
    // an independent boundary and must never be bypassed.
    const tenantId = ctx.tenantId;
    if (!tenantId || !this.cfg.tenantId || tenantId !== this.cfg.tenantId) {
      return {
        content: [{ type: "text", text: "Webhook data is unavailable for this tenant." }],
        isError: true,
        meta: { source: "webhook", state: "tenant_mismatch" },
      };
    }

    const cached = this.payloads.get(tenantId);
    const fresh = this.isFresh(cached);
    if (!fresh) {
      if (this.cfg.defaultValue !== undefined) {
        return {
          content: [{ type: "text", text: stringify(this.cfg.defaultValue) }],
          meta: { source: "webhook", state: cached ? "expired" : "empty", usedDefault: true },
        };
      }
      const reason = cached
        ? `last payload is older than ttl (${this.cfg.ttlSeconds}s)`
        : "no webhook payload received yet";
      return {
        content: [{ type: "text", text: `No fresh webhook data: ${reason}.` }],
        isError: true,
        meta: { source: "webhook", state: cached ? "expired" : "empty" },
      };
    }

    const value = cached.value;
    const structured = value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
    return {
      content: [{ type: "text", text: stringify(value) }],
      structuredContent: structured,
      meta: { source: "webhook", receivedAt: new Date(cached.receivedAt).toISOString(), ageMs: Date.now() - cached.receivedAt },
    };
  }

  private isFresh(cached: CachedPayload | undefined): cached is CachedPayload {
    return cached !== undefined && this.cfg.ttlSeconds !== undefined && Date.now() - cached.receivedAt <= this.cfg.ttlSeconds * 1000;
  }

  private isFreshTimestamp(timestamp: string): boolean {
    if (!/^\d{1,13}$/.test(timestamp)) return false;
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds)) return false;
    const ageMs = Date.now() - seconds * 1000;
    const { maxAgeSeconds, clockSkewSeconds } = this.cfg.replayProtection;
    return ageMs <= (maxAgeSeconds + clockSkewSeconds) * 1000 && ageMs >= -clockSkewSeconds * 1000;
  }
}

/** Canonical, versioned HMAC input; body is base64 to preserve exact bytes. */
export function canonicalHmacInput(method: string, path: string, tenantId: string, timestamp: string, nonce: string, rawBody: Buffer): string {
  return JSON.stringify({ v: 1, method, path, tenantId, timestamp, nonce, body: rawBody.toString("base64") });
}

function requestHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  const normalized = (Array.isArray(value) ? value[0] : value)?.trim();
  return normalized || undefined;
}

function stringify(v: unknown): string { return typeof v === "string" ? v : JSON.stringify(v); }

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) { timingSafeEqual(ab, ab); return false; }
  return timingSafeEqual(ab, bb);
}
