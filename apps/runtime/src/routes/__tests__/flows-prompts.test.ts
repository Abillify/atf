// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for GET /flows/prompts/content and POST /flows/prompts/write — the
 * files behind `#[[file:prompts/x.md]]`.
 *
 * Covers the same guarantees the flow write path has: RBAC (401/403), path
 * traversal and the `prompts/` restriction, conflict detection via baseHash,
 * and an atomic write that leaves no temp file behind.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { createFlowsRouter } from "../flows.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import {
  createOperatorAuthorizer,
  type OperatorTokenEntry,
} from "../../middleware/operator-rbac.js";

const ADMIN_TOKEN = "admin-token-aaa";
const VIEWER_TOKEN = "viewer-token-bbb";

const TOKENS: OperatorTokenEntry[] = [
  { token: ADMIN_TOKEN, role: "admin", name: "admin-user" },
  { token: VIEWER_TOKEN, role: "viewer", name: "viewer-user" },
];

const sha256Hex = (content: string): string =>
  crypto.createHash("sha256").update(content, "utf8").digest("hex");

function emptyRegistry(): FlowRegistry {
  return { get: () => undefined, list: () => [] };
}

function buildApp(flowsDir: string | undefined, tokens: OperatorTokenEntry[] = TOKENS) {
  const a = new Hono();
  a.route(
    "/",
    createFlowsRouter({
      fileRegistry: emptyRegistry(),
      operatorAuth: createOperatorAuthorizer({
        authRequired: tokens.length > 0,
        tokens,
      }),
      authRequired: tokens.length > 0,
      ...(flowsDir !== undefined ? { flowsDir } : {}),
    }),
  );
  return a;
}

const get = (app: Hono, rel: string, token?: string) =>
  app.request(`/flows/prompts/content?path=${encodeURIComponent(rel)}`, {
    headers: token !== undefined ? { Authorization: `Bearer ${token}` } : {},
  });

const post = (app: Hono, body: unknown, token?: string) =>
  app.request("/flows/prompts/write", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flows-prompts-test-"));
  fs.mkdirSync(path.join(tmpDir, "prompts"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "prompts", "researcher.md"),
    "Du bist ein Rechercheur.\n",
    "utf-8",
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /flows/prompts/content", () => {
  test("returns the file content and its hash", async () => {
    const res = await get(buildApp(tmpDir), "prompts/researcher.md", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      content: string;
      hash: string;
      writable: boolean;
    };
    expect(body.path).toBe("prompts/researcher.md");
    expect(body.content).toBe("Du bist ein Rechercheur.\n");
    expect(body.hash).toBe(sha256Hex("Du bist ein Rechercheur.\n"));
    expect(body.writable).toBe(true);
  });

  test("a viewer may read (flows:read)", async () => {
    const res = await get(buildApp(tmpDir), "prompts/researcher.md", VIEWER_TOKEN);
    expect(res.status).toBe(200);
  });

  test("no token → 401", async () => {
    const res = await get(buildApp(tmpDir), "prompts/researcher.md");
    expect(res.status).toBe(401);
  });

  test("missing file → 404", async () => {
    const res = await get(buildApp(tmpDir), "prompts/nope.md", ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  test.each([
    ["prompts/../../etc/passwd.md", "traversal"],
    ["../prompts/x.md", "parent directory"],
    ["/etc/passwd.md", "absolute"],
    ["subflows/_retrieval.yaml", "outside prompts/"],
    ["prompts/x.yaml", "not a markdown file"],
    ["", "empty"],
  ])("rejects %s (%s) with 400", async (rel) => {
    const res = await get(buildApp(tmpDir), rel, ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });

  test("nested prompt directories are allowed", async () => {
    fs.mkdirSync(path.join(tmpDir, "prompts", "kanzlei"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "prompts", "kanzlei", "loop.md"), "x\n", "utf-8");
    const res = await get(buildApp(tmpDir), "prompts/kanzlei/loop.md", ADMIN_TOKEN);
    expect(res.status).toBe(200);
  });
});

describe("POST /flows/prompts/write", () => {
  test("admin writes the file and gets the new hash", async () => {
    const app = buildApp(tmpDir);
    const res = await post(
      app,
      { path: "prompts/researcher.md", content: "Neuer Prompt.\n" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hash: string; created: boolean };
    expect(body.hash).toBe(sha256Hex("Neuer Prompt.\n"));
    expect(body.created).toBe(false);
    expect(
      fs.readFileSync(path.join(tmpDir, "prompts", "researcher.md"), "utf-8"),
    ).toBe("Neuer Prompt.\n");
    // Req. 22.4: no leftover temp file.
    expect(
      fs.readdirSync(path.join(tmpDir, "prompts")).filter((f) => f.startsWith(".tmp-")),
    ).toEqual([]);
  });

  test("viewer → 403, no token → 401", async () => {
    const app = buildApp(tmpDir);
    const body = { path: "prompts/researcher.md", content: "x" };
    expect((await post(app, body, VIEWER_TOKEN)).status).toBe(403);
    expect((await post(app, body)).status).toBe(401);
    // Unchanged on disk.
    expect(
      fs.readFileSync(path.join(tmpDir, "prompts", "researcher.md"), "utf-8"),
    ).toBe("Du bist ein Rechercheur.\n");
  });

  test("stale baseHash → 409 conflict and the file is untouched", async () => {
    const app = buildApp(tmpDir);
    const res = await post(
      app,
      {
        path: "prompts/researcher.md",
        content: "Konkurrierende Fassung.\n",
        baseHash: sha256Hex("etwas anderes"),
      },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(409);
    expect(
      fs.readFileSync(path.join(tmpDir, "prompts", "researcher.md"), "utf-8"),
    ).toBe("Du bist ein Rechercheur.\n");
  });

  test("matching baseHash is accepted", async () => {
    const app = buildApp(tmpDir);
    const res = await post(
      app,
      {
        path: "prompts/researcher.md",
        content: "Fortschreibung.\n",
        baseHash: sha256Hex("Du bist ein Rechercheur.\n"),
      },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(200);
  });

  test("creates a new prompt file when no baseHash is sent", async () => {
    const app = buildApp(tmpDir);
    const res = await post(
      app,
      { path: "prompts/fresh.md", content: "Neu.\n" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { created: boolean }).toMatchObject({ created: true });
    expect(fs.readFileSync(path.join(tmpDir, "prompts", "fresh.md"), "utf-8")).toBe("Neu.\n");
  });

  test("a baseHash for a file that no longer exists → 409", async () => {
    const app = buildApp(tmpDir);
    const res = await post(
      app,
      { path: "prompts/fresh.md", content: "Neu.\n", baseHash: sha256Hex("Neu.\n") },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(409);
  });

  test("rejects traversal and non-prompt paths with 400", async () => {
    const app = buildApp(tmpDir);
    for (const rel of [
      "prompts/../escape.md",
      "../escape.md",
      "/etc/passwd.md",
      "subflows/x.yaml",
      "prompts/x.yaml",
    ]) {
      const res = await post(app, { path: rel, content: "x" }, ADMIN_TOKEN);
      expect(res.status).toBe(400);
    }
    expect(fs.existsSync(path.join(tmpDir, "..", "escape.md"))).toBe(false);
  });

  test("missing content → 400", async () => {
    const res = await post(buildApp(tmpDir), { path: "prompts/researcher.md" }, ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });

  test("oversized content → 400", async () => {
    const res = await post(
      buildApp(tmpDir),
      { path: "prompts/researcher.md", content: "x".repeat(1_000_001) },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(400);
  });

  test("without FLOWS_DIR the write endpoint is 501", async () => {
    const res = await post(
      buildApp(undefined),
      { path: "prompts/researcher.md", content: "x" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(501);
  });
});
