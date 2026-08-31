// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import {
  RocketChatBindingConflictError,
  type RocketChatChannel,
} from "../assistants/rocketchat-channel.js";

const eventSchema = z
  .object({
    token: z.string().min(1).max(1_024),
    user_id: z.string().min(1).max(256),
    user_name: z.string().min(1).max(256).optional(),
    channel_id: z.string().min(1).max(256),
    channel_name: z.string().max(256).optional(),
    message_id: z.string().min(1).max(512),
    text: z.string().min(1).max(100_000),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .strip();

function tokenMatches(actual: string, expected: string): boolean {
  const actualDigest = crypto.createHash("sha256").update(actual).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

export function createRocketChatRouter(params: {
  channel: RocketChatChannel;
  /** Enables self-service linking for unknown DMs only when a public URL is configured. */
  connect?: { db: Database; publicUrl: string; requestTtlSeconds?: number };
  logger?: Logger;
}): Hono {
  const app = new Hono();

  app.post("/integrations/rocketchat/events", async (ctx) => {
    const parsed = eventSchema.safeParse(await ctx.req.json().catch(() => undefined));
    if (!parsed.success) {
      return ctx.json({ error: { message: "Invalid Rocket.Chat event." } }, 400);
    }
    if (!tokenMatches(parsed.data.token, params.channel.webhookToken)) {
      return ctx.json({ error: { message: "Invalid integration token." } }, 401);
    }
    // Outgoing integrations can observe the bot's own posts. Dropping them here
    // prevents an assistant-response loop before any binding or run is touched.
    if (parsed.data.user_id === params.channel.botUserId) {
      return ctx.json({ accepted: true, ignored: true }, 202);
    }
    if (parsed.data.text.trim().toUpperCase() === "AIPERATOR-DISCONNECT") {
      await params.channel.bindings.revokeInbound(parsed.data.user_id, parsed.data.channel_id);
      await params.channel.client.sendMessage({
        messageId: `aiperator-disconnect-${crypto.createHash("sha256").update(parsed.data.message_id).digest("hex").slice(0, 24)}`,
        roomId: parsed.data.channel_id,
        text:
          params.connect === undefined
            ? "The connection has been revoked. Reconnecting is currently unavailable. Please contact an administrator."
            : "The connection has been revoked. Send another message to receive a new pairing link.",
      });
      return ctx.json({ accepted: true, disconnected: true }, 202);
    }
    if (parsed.data.text.trim().startsWith("AIPERATOR-")) {
      try {
        const paired = await params.channel.bindings.confirmPairing(
          parsed.data.user_id,
          parsed.data.channel_id,
          parsed.data.text,
        );
        if (paired !== undefined) {
          return ctx.json({ accepted: true, paired: true }, 202);
        }
      } catch (error) {
        if (error instanceof RocketChatBindingConflictError) {
          return ctx.json({ accepted: true }, 202);
        }
        throw error;
      }
    }
    const binding = await params.channel.bindings.resolveInbound(
      parsed.data.user_id,
      parsed.data.channel_id,
    );
    // Deliberately indistinguishable from an accepted event: external callers
    // cannot enumerate which Rocket.Chat identities are bound to assistants.
    if (binding === undefined) {
      const eventHash = crypto
        .createHash("sha256")
        .update(parsed.data.message_id)
        .digest("hex")
        .slice(0, 24);
      const sendConnectUnavailable = async (text: string): Promise<void> => {
        try {
          await params.channel.client.sendMessage({
            messageId: `aiperator-connect-unavailable-${eventHash}`,
            roomId: parsed.data.channel_id,
            text,
          });
        } catch (error) {
          params.logger?.warn("Rocket.Chat connect fallback delivery failed", {
            messageId: parsed.data.message_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      if (params.connect === undefined) {
        params.logger?.warn("Rocket.Chat self-service connect is unavailable", {
          messageId: parsed.data.message_id,
        });
        await sendConnectUnavailable(
          "Your assistant is not connected and reconnecting is currently unavailable. Please contact an administrator.",
        );
        return ctx.json({ accepted: true }, 202);
      }

      // Unknown DMs receive a short-lived opaque link. The e-mail is retrieved
      // server-to-server with the bot's PAT; neither a user-supplied address nor
      // Open WebUI identity participates in this proof.
      try {
        const verifiedEmail = await params.channel.client.verifiedPrimaryEmail(parsed.data.user_id);
        if (verifiedEmail === undefined) {
          params.logger?.warn(
            "Rocket.Chat user lookup returned no verified email; connect link not created",
            { messageId: parsed.data.message_id },
          );
          await sendConnectUnavailable(
            "No verified email address was found for your Rocket.Chat account. Please verify your email address or contact an administrator.",
          );
          return ctx.json({ accepted: true }, 202);
        }

        const id = crypto.randomUUID();
        const ttl = Math.min(3600, Math.max(60, params.connect.requestTtlSeconds ?? 900));
        await params.connect.db.withOperator((db) =>
          db.query(
            `INSERT INTO rocketchat_connect_requests (id,server_url,rocket_user_id,room_id,verified_email,expires_at)
               VALUES ($1::uuid,$2,$3,$4,$5,now()+($6::bigint*interval '1 second'))`,
            [
              id,
              params.channel.bindings.serverUrl,
              parsed.data.user_id,
              parsed.data.channel_id,
              verifiedEmail.trim().toLowerCase(),
              ttl,
            ],
          ),
        );
        const link = `${params.connect.publicUrl.replace(/\/$/, "")}/connect/rocketchat/${id}`;
        await params.channel.client.sendMessage({
          messageId: `aiperator-connect-${id.replace(/-/g, "").slice(0, 24)}`,
          roomId: parsed.data.channel_id,
          text: `To connect your assistant, securely sign in here: ${link}`,
        });
        return ctx.json({ accepted: true, connectRequested: true }, 202);
      } catch (error) {
        params.logger?.warn("Rocket.Chat connect-link creation failed", {
          messageId: parsed.data.message_id,
          error: error instanceof Error ? error.message : String(error),
        });
        await sendConnectUnavailable(
          "The connect link could not be created right now. Please try again later.",
        );
      }
      return ctx.json({ accepted: true }, 202);
    }
    const run = await params.channel.runs.start(binding.scope, {
      idempotencyKey: `rocketchat:${parsed.data.message_id}`,
      maxAttempts: 3,
      origin: "rocket-chat",
      resumePayload: {
        kind: "rocketchat-inbound",
        flowId: binding.flowId,
        message: parsed.data.text,
        conversationId: `rocketchat:${params.channel.bindings.serverUrl}:${binding.roomId}`,
        delivery: "rocket-chat",
        bindingId: binding.id,
        userName:
          parsed.data.user_name ?? binding.rocketUsername ?? binding.scope.userId,
      },
    });
    const placeholder = await params.channel.outbox.enqueueRunProgress(run, "Thinking …");
    if (placeholder !== undefined) {
      try {
        await params.channel.flushOutbox();
      } catch (error) {
        params.logger?.warn(
          "Immediate Rocket.Chat placeholder delivery failed; outbox will retry",
          {
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    return ctx.json({ accepted: true, runId: run.id }, 202);
  });

  return app;
}
