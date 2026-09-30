// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import { runSourceLogin, randomLoopbackPort, type SourceLoginIo } from "./source-login.js";
import type { OutpostConfig } from "@atf/outpost-core";

const io = (isTTY: boolean): SourceLoginIo => ({
  isTTY,
  readLine: async () => "",
  out: () => undefined,
  err: () => undefined,
});

const cfg = {
  extractUrl: "https://extract.example.test",
  collection: "documents",
  cloudOAuth: { gdrive: { clientId: "client" } },
  sources: [
    { id: "local", type: "local", path: "/sources/local" },
    { id: "drive", type: "gdrive", folderId: "folder", auth: "service-account" },
  ],
} as unknown as OutpostConfig;

const deps = (input: Partial<Parameters<typeof runSourceLogin>[1]> = {}) => ({
  io: io(true),
  store: { get: async () => null, set: async () => undefined, delete: async () => undefined },
  cfg,
  env: {} as Parameters<typeof runSourceLogin>[1]["env"],
  fetchImpl: (async () => new Response("{}")) as Parameters<typeof runSourceLogin>[1]["fetchImpl"],
  ...input,
});

describe("source-login", () => {
  test("rejects non-interactive input with exit 64", async () => {
    const result = await runSourceLogin("local", { ...deps(), io: io(false) });
    expect(result).toBe(64);
  });

  test("rejects service-account sources with exit 64", async () => {
    const result = await runSourceLogin("drive", deps());
    expect(result).toBe(64);
  });

  test("generates a port only inside the registered loopback range", () => {
    expect(randomLoopbackPort(() => 0)).toBe(49152);
    expect(randomLoopbackPort(() => 0.999999)).toBeLessThanOrEqual(65535);
  });

  test("stops after three invalid pasted inputs", async () => {
    const messages: string[] = [];
    const result = await runSourceLogin("dropbox", {
      ...deps({
        cfg: {
          ...cfg,
          cloudOAuth: { dropbox: { appKey: "dropbox-app" } },
          sources: [{ id: "dropbox", type: "dropbox", path: "/inbox" }],
        } as OutpostConfig,
      }),
      io: {
        ...io(true),
        readLine: async () => "",
        err: (message) => messages.push(message),
      },
    });
    expect(result).toBe(1);
    expect(messages).toHaveLength(4);
    expect(messages.at(-1)).toContain("Zu viele");
  });

  test("stores the refresh token after a successful code exchange", async () => {
    let promptText = "";
    let stored: string | undefined;
    const result = await runSourceLogin("drive-oauth", {
      ...deps({
        cfg: {
          ...cfg,
          sources: [{ id: "drive-oauth", type: "gdrive", folderId: "folder", auth: "oauth" }],
        } as OutpostConfig,
        store: { get: async () => null, set: async (_key, value) => { stored = value; }, delete: async () => undefined },
        fetchImpl: (async () => new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), { status: 200, headers: { "content-type": "application/json" } })) as Parameters<typeof runSourceLogin>[1]["fetchImpl"],
      }),
      io: {
        ...io(true),
        out: (message) => { promptText += `${message}\n`; },
        readLine: async () => {
          const match = promptText.match(/https:\/\/[^\s]+/);
          if (match === null) return "";
          const authorization = new URL(match[0]);
          const redirect = authorization.searchParams.get("redirect_uri");
          const state = authorization.searchParams.get("state");
          return `${redirect}?code=approved&state=${state}`;
        },
      },
    });
    expect(result).toBe(0);
    expect(stored).toBe("refresh");
  });
});
