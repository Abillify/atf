// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceTranscriptStore } from "../transcript-store.js";
import { AssistantWorkspaceResolver } from "../workspace.js";
import type { AssistantScope } from "../types.js";

const scope: AssistantScope = {
  tenantId: "tenant",
  userId: "user@example.com",
  assistantId: "helpdesk",
};

describe("WorkspaceTranscriptStore", () => {
  test("writes private, append-only conversation data below the assistant data directory", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "aip-transcript-")),
    );
    try {
      const workspaces = new AssistantWorkspaceResolver({ root });
      const store = new WorkspaceTranscriptStore(workspaces);
      await store.append(scope, {
        executionId: "run-1",
        conversationId: "chat-1",
        role: "user",
        content: "Bitte merke dir den Projektstatus.",
      });
      await store.append(scope, {
        executionId: "run-1",
        conversationId: "chat-1",
        role: "assistant",
        content: "Der Projektstatus ist gespeichert.",
      });

      const entries = await store.read(scope, "chat-1");
      expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(entries[0]?.content).toContain("Projektstatus");

      const dataDirectory = path.join(
        workspaces.workspaceDir(scope),
        "data",
        "conversations",
      );
      const files = fs.readdirSync(dataDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[a-f0-9]{64}\.jsonl$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("searches all of one assistant's conversations without crossing workspaces", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "aip-transcript-")),
    );
    try {
      const store = new WorkspaceTranscriptStore(
        new AssistantWorkspaceResolver({ root }),
      );
      await store.append(scope, {
        executionId: "run-1",
        conversationId: "chat-a",
        role: "user",
        content: "Der Hermes-Abgleich ist wichtig.",
      });
      await store.append(scope, {
        executionId: "run-2",
        conversationId: "chat-b",
        role: "assistant",
        content: "Der Import wurde abgeschlossen.",
      });
      const matches = await store.search(scope, "hermes");
      expect(matches).toHaveLength(1);
      expect(matches[0]?.conversationId).toBe("chat-a");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
