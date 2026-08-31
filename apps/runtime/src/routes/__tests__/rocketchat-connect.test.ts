// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { createRocketChatRouter } from "../rocketchat.js";
import type { RocketChatChannel } from "../../assistants/rocketchat-channel.js";
import type { Database } from "../../db/database.js";

describe("Rocket.Chat self-service connect links", () => {
  test("an unknown DM stores only the server-verified email and replies in the same room", async () => {
    const inserts: unknown[][] = [];
    const sent: Array<{ roomId: string; text: string }> = [];
    const db = {
      withOperator: async <T>(
        fn: (database: {
          query: (sql: string, values: unknown[]) => Promise<unknown[]>;
        }) => Promise<T>,
      ) =>
        fn({
          query: async (_sql, values) => {
            inserts.push(values);
            return [];
          },
        }),
    } as unknown as Database;
    const channel = {
      botUserId: "abby",
      webhookToken: "secret",
      runs: {
        start: async () => {
          throw new Error("must not start a run");
        },
      },
      outbox: {},
      bindings: {
        serverUrl: "https://chat.example",
        confirmPairing: async () => undefined,
        resolveInbound: async () => undefined,
      },
      client: {
        verifiedPrimaryEmail: async () => "Person@Example.COM",
        sendMessage: async (message: { roomId: string; text: string }) => {
          sent.push(message);
        },
      },
    } as unknown as RocketChatChannel;
    const app = createRocketChatRouter({
      channel,
      connect: { db, publicUrl: "https://aiperator.example", requestTtlSeconds: 120 },
    });
    const response = await app.request("http://localhost/integrations/rocketchat/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        user_id: "u1",
        channel_id: "dm1",
        message_id: "m1",
        text: "hello",
      }),
    });
    expect(response.status).toBe(202);
    expect((await response.json()) as { accepted: boolean; connectRequested: boolean }).toEqual({
      accepted: true,
      connectRequested: true,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[4]).toBe("person@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.roomId).toBe("dm1");
    expect(sent[0]?.text).toContain("https://aiperator.example/connect/rocketchat/");
  });

  test("replies with guidance when Rocket.Chat has no verified primary email", async () => {
    const sent: Array<{ roomId: string; text: string }> = [];
    const channel = {
      botUserId: "abby",
      webhookToken: "secret",
      runs: {},
      outbox: {},
      bindings: { serverUrl: "https://chat.example", resolveInbound: async () => undefined },
      client: {
        verifiedPrimaryEmail: async () => undefined,
        sendMessage: async (message: { roomId: string; text: string }) => {
          sent.push(message);
        },
      },
    } as unknown as RocketChatChannel;
    const db = {
      withOperator: async () => {
        throw new Error("must not persist");
      },
    } as unknown as Database;
    const app = createRocketChatRouter({
      channel,
      connect: { db, publicUrl: "https://aiperator.example" },
    });
    const response = await app.request("http://localhost/integrations/rocketchat/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        user_id: "u1",
        channel_id: "dm1",
        message_id: "m1",
        text: "hello",
      }),
    });
    expect(response.status).toBe(202);
    expect((await response.json()) as { accepted: boolean }).toEqual({ accepted: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.roomId).toBe("dm1");
    expect(sent[0]?.text).toContain("No verified email address was found");
  });
});
