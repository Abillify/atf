// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for POST/PUT /flows/write — file-based write-path security.
 *
 * Requirements: 22.1 (RBAC), 22.2 (path traversal), 22.3 (schema validation),
 * 22.4 (atomic write — no partial file on failure).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { createFlowsRouter } from "../flows.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import {
  createOperatorAuthorizer,
  type OperatorTokenEntry,
} from "../../middleware/operator-rbac.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const minimalFlow = (id = "test-flow"): FlowDefinition => ({
  id,
  name: id,
  nodes: [
    { id: "n", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } },
  ],
  edges: [],
});

function emptyRegistry(): FlowRegistry {
  return { get: () => undefined, list: () => [] };
}

function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Builds a Hono app with the flows router wired up, using a static token→role
 * RBAC map for predictable role resolution in tests.
 */
function buildApp(
  flowsDir: string | undefined,
  tokens: OperatorTokenEntry[] = [],
) {
  const operatorAuth = createOperatorAuthorizer({
    authRequired: tokens.length > 0,
    tokens,
  });
  const a = new Hono();
  a.route(
    "/",
    createFlowsRouter({
      fileRegistry: emptyRegistry(),
      operatorAuth,
      authRequired: tokens.length > 0,
      flowsDir,
    }),
  );
  return a;
}

function writeRequest(
  body: unknown,
  token?: string,
  method: "POST" | "PUT" = "POST",
): RequestInit & { headers: Record<string, string> } {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return { method, headers, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// RBAC tokens used throughout
// ---------------------------------------------------------------------------
const ADMIN_TOKEN = "admin-token-aaa";
const VIEWER_TOKEN = "viewer-token-bbb";

const TOKENS: OperatorTokenEntry[] = [
  { token: ADMIN_TOKEN, role: "admin", name: "admin-user" },
  { token: VIEWER_TOKEN, role: "viewer", name: "viewer-user" },
];

// ---------------------------------------------------------------------------
// Temporary directory for each test
// ---------------------------------------------------------------------------
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flows-write-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Req. 22.1 — RBAC
// ---------------------------------------------------------------------------

describe("Req. 22.1 — RBAC: only operator/admin may write", () => {
  test("admin token is accepted (200)", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "my-flow", format: "yaml", definition: minimalFlow("my-flow") },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(200);
  });

  test("no token → 401 Unauthorized when auth is required", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest({ id: "x", format: "yaml", definition: minimalFlow("x") }),
    );
    expect(res.status).toBe(401);
  });

  test("viewer token → 403 Forbidden (insufficient role)", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "x", format: "yaml", definition: minimalFlow("x") },
        VIEWER_TOKEN,
      ),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authorization_error");
  });

  test("PUT with admin token is also accepted (200)", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "put-flow", format: "yaml", definition: minimalFlow("put-flow") },
        ADMIN_TOKEN,
        "PUT",
      ),
    );
    expect(res.status).toBe(200);
  });

  test("501 when flowsDir is not configured (even for admin)", async () => {
    const app = buildApp(undefined, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "x", format: "yaml", definition: minimalFlow("x") },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// Req. 22.2 — Path-traversal protection
// ---------------------------------------------------------------------------

describe("Req. 22.2 — Path-traversal rejection", () => {
  const traverse = [
    "../evil",
    "../../etc/passwd",
    "sub/dir",
    "sub\\dir",
    "flow\0name",
    "..",
  ];

  for (const id of traverse) {
    test(`id="${id}" is rejected with 400`, async () => {
      const app = buildApp(tmpDir, TOKENS);
      const res = await app.request(
        "/flows/write",
        writeRequest(
          { id, format: "yaml", definition: minimalFlow("safe") },
          ADMIN_TOKEN,
        ),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(
        /[Pp]ath\s*[Tt]raversal|forbidden|escapes/i,
      );
    });
  }

  test("valid simple id stays within flowsDir and succeeds", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        {
          id: "safe-flow",
          format: "yaml",
          definition: minimalFlow("safe-flow"),
        },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, "safe-flow.yaml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Req. 22.3 — Schema validation before writing
// ---------------------------------------------------------------------------

describe("Req. 22.3 — Schema validation: invalid definition is rejected", () => {
  test("flow with no nodes → 400 with validation report", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const invalidFlow = { id: "bad", name: "Bad", nodes: [], edges: [] };
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "bad", format: "yaml", definition: invalidFlow },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { type: string };
      validation: { valid: boolean; errors: unknown[] };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.validation.valid).toBe(false);
    expect(body.validation.errors.length).toBeGreaterThan(0);
  });

  test("invalid flow → file is NOT written to disk", async () => {
    const app = buildApp(tmpDir, TOKENS);
    await app.request(
      "/flows/write",
      writeRequest(
        {
          id: "bad",
          format: "yaml",
          definition: { id: "bad", name: "Bad", nodes: [], edges: [] },
        },
        ADMIN_TOKEN,
      ),
    );
    expect(fs.existsSync(path.join(tmpDir, "bad.yaml"))).toBe(false);
  });

  test("non-object definition → 400", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "ok", format: "yaml", definition: "just a string" },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(400);
  });

  test("valid flow → written to disk and hash returned", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const flow = minimalFlow("valid-flow");
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "valid-flow", format: "yaml", definition: flow },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      hash: string;
      validation: { valid: boolean };
    };
    expect(body.id).toBe("valid-flow");
    expect(typeof body.hash).toBe("string");
    expect(body.hash.length).toBe(64); // SHA-256 hex
    expect(body.validation.valid).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "valid-flow.yaml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Req. 22.4 — Atomic write: no partial file on failure
// ---------------------------------------------------------------------------

describe("Req. 22.4 — Atomic write: no partial file left after rejected write", () => {
  test("schema failure leaves no file on disk", async () => {
    const app = buildApp(tmpDir, TOKENS);
    await app.request(
      "/flows/write",
      writeRequest(
        { id: "partial", format: "yaml", definition: { nodes: [], edges: [] } },
        ADMIN_TOKEN,
      ),
    );
    // Neither the target nor any temp file should be left.
    const entries = fs.readdirSync(tmpDir);
    expect(
      entries.filter((e) => e.startsWith("partial") || e.startsWith(".tmp-")),
    ).toHaveLength(0);
  });

  test("path-traversal failure leaves no file on disk", async () => {
    const app = buildApp(tmpDir, TOKENS);
    await app.request(
      "/flows/write",
      writeRequest(
        { id: "../escape", format: "yaml", definition: minimalFlow("escape") },
        ADMIN_TOKEN,
      ),
    );
    // Parent directory should not have gained any new files.
    const parentDir = path.dirname(tmpDir);
    const before = fs.readdirSync(parentDir);
    expect(before.some((e) => e === "escape.yaml")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conflict detection (Req. 14.6) — via baseHash
// ---------------------------------------------------------------------------

describe("Conflict detection via baseHash", () => {
  test("matching baseHash → write succeeds (200)", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const flow = minimalFlow("c-flow");

    // Write the initial file.
    await app.request(
      "/flows/write",
      writeRequest(
        { id: "c-flow", format: "yaml", definition: flow },
        ADMIN_TOKEN,
      ),
    );

    // Read the file to get its current hash.
    const currentContent = fs.readFileSync(
      path.join(tmpDir, "c-flow.yaml"),
      "utf-8",
    );
    const currentHash = sha256Hex(currentContent);

    // Write again with the correct baseHash.
    const flow2 = minimalFlow("c-flow");
    const res = await app.request(
      "/flows/write",
      writeRequest(
        {
          id: "c-flow",
          format: "yaml",
          definition: flow2,
          baseHash: currentHash,
        },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(200);
  });

  test("mismatched baseHash → 409 Conflict", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const flow = minimalFlow("conflict-flow");

    // Write the initial file.
    await app.request(
      "/flows/write",
      writeRequest(
        { id: "conflict-flow", format: "yaml", definition: flow },
        ADMIN_TOKEN,
      ),
    );

    // Attempt to overwrite with a stale baseHash.
    const res = await app.request(
      "/flows/write",
      writeRequest(
        {
          id: "conflict-flow",
          format: "yaml",
          definition: minimalFlow("conflict-flow"),
          baseHash:
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { type: string; currentHash: string };
    };
    expect(body.error.type).toBe("conflict_error");
    expect(typeof body.error.currentHash).toBe("string");
  });

  test("baseHash with non-existent file → no conflict, write succeeds", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        {
          id: "new-flow",
          format: "yaml",
          definition: minimalFlow("new-flow"),
          baseHash:
            "aabbccdd0000000000000000000000000000000000000000000000000000aabb",
        },
        ADMIN_TOKEN,
      ),
    );
    // File didn't exist before; baseHash mismatch is irrelevant when there's nothing to conflict with.
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// JSON format support
// ---------------------------------------------------------------------------

describe("JSON format", () => {
  test("valid flow written as .json file", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const flow = minimalFlow("json-flow");
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "json-flow", format: "json", definition: flow },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string };
    expect(body.format).toBe("json");
    expect(fs.existsSync(path.join(tmpDir, "json-flow.json"))).toBe(true);
    // Confirm the written content is valid JSON.
    const content = fs.readFileSync(
      path.join(tmpDir, "json-flow.json"),
      "utf-8",
    );
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

describe("Request validation", () => {
  test("missing id → 400", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest({ format: "yaml", definition: minimalFlow() }, ADMIN_TOKEN),
    );
    expect(res.status).toBe(400);
  });

  test("invalid format → 400", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest(
        { id: "x", format: "toml", definition: minimalFlow("x") },
        ADMIN_TOKEN,
      ),
    );
    expect(res.status).toBe(400);
  });

  test("missing definition → 400", async () => {
    const app = buildApp(tmpDir, TOKENS);
    const res = await app.request(
      "/flows/write",
      writeRequest({ id: "x", format: "yaml" }, ADMIN_TOKEN),
    );
    expect(res.status).toBe(400);
  });
});
