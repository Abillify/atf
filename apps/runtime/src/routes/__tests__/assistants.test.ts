// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant management API — scope isolation and write-class boundaries.
 *
 * The property under test is not "the handler returns 200". It is that the assistant
 * segment in a path is resolved against the AUTHENTICATED caller, so no header
 * combination lets user A read, configure, or grant anything for user B's assistant
 * even when both named their assistant the same thing. That is the whole isolation
 * claim of the subsystem, and it is a one-line regression away at any time.
 *
 * The second property is that the route surface only exposes the USER's soul write
 * class. Identity belongs to the assistant and constraints to the operator, so a
 * request that tries to set them through the directive route must not succeed —
 * neither by being accepted nor by silently landing in the wrong section.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AssistantRuntime } from "../../assistants/assistant-runtime.js";
import { InMemoryAssistantStore } from "../../assistants/assistant-store.js";
import { AuthorityResolver } from "../../assistants/authority-resolver.js";
import { InMemoryCredentialStore } from "../../assistants/credential-store.js";
import { SecretCipher } from "../../graph/secret-cipher.js";
import { InMemoryMessagingStore } from "../../assistants/messaging-store.js";
import { InMemoryProposalStore } from "../../assistants/proposal-store.js";
import { InMemorySkillCanaryStore } from "../../assistants/skill-canary.js";
import { InMemorySkillStore } from "../../assistants/skill-store.js";
import { InMemorySoulStore } from "../../assistants/soul-store.js";
import { AssistantWorkspaceResolver } from "../../assistants/workspace.js";
import { createAssistantsRouter } from "../assistants.js";
import type { AssistantSessionStore } from "../../assistants/session-store.js";
import type { AssistantSessionIndex } from "../../assistants/session-index.js";
import type { AssistantScope } from "../../assistants/types.js";

function harness() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "aip-routes-assist-")),
  );
  const workspaces = new AssistantWorkspaceResolver({ root });
  const skills = new InMemorySkillStore();
  // A cipher is configured so delegation grant/revoke tests exercise the real
  // encrypt/decrypt path rather than only the "no encryption key" 503 branch.
  const credentials = new InMemoryCredentialStore(
    new SecretCipher(crypto.randomBytes(32)),
  );
  const messaging = new InMemoryMessagingStore();
  const runtime = new AssistantRuntime({
    assistants: new InMemoryAssistantStore(workspaces),
    souls: new InMemorySoulStore(),
    skills,
    proposals: new InMemoryProposalStore(skills),
    canaries: new InMemorySkillCanaryStore(),
    messaging,
    credentials,
    authority: new AuthorityResolver({ credentials }),
  });
  const app = createAssistantsRouter({ runtime });
  /** Issues a request as a given user. Mirrors what the chat path forwards. */
  const as = (
    userId: string,
    input: string,
    init?: { method?: string; body?: unknown; tenantId?: string },
  ): Promise<Response> =>
    // `app.request` is typed as sync-or-async; normalising here keeps every call site
    // a plain `await` instead of repeating the union at each one.
    Promise.resolve(
      app.request(input, {
        method: init?.method ?? "GET",
        headers: {
          "X-OpenWebUI-User-Id": userId,
          "X-Tenant-Id": init?.tenantId ?? "acme",
          "Content-Type": "application/json",
        },
        ...(init?.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
      }),
    );
  return {
    app,
    runtime,
    as,
    messaging,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

describe("caller identity", () => {
  test("no user header is an authentication error, not an empty list", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/v1/assistants");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { type: string } };
      // 401 rather than 200-with-nothing: an unauthenticated caller must not be able
      // to conclude "this user has no assistants".
      expect(body.error.type).toBe("authentication_error");
    } finally {
      h.cleanup();
    }
  });

  test("a user id in the body cannot override the header identity", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        // `userId` is not part of the schema; if it were ever honoured, this request
        // would provision under Bob.
        body: { assistantId: "molty", userId: BOB },
      });
      const mine = (await (await h.as(ALICE, "/v1/assistants")).json()) as {
        assistants: unknown[];
      };
      const theirs = (await (await h.as(BOB, "/v1/assistants")).json()) as {
        assistants: unknown[];
      };
      expect(mine.assistants).toHaveLength(1);
      expect(theirs.assistants).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("scope isolation between users", () => {
  test("same assistant id under two users are two different assistants", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty", displayName: "Alice's" },
      });
      await h.as(BOB, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty", displayName: "Bob's" },
      });

      const alice = (await (
        await h.as(ALICE, "/v1/assistants/molty")
      ).json()) as {
        displayName: string;
      };
      const bob = (await (await h.as(BOB, "/v1/assistants/molty")).json()) as {
        displayName: string;
      };
      // The path segment is identical in both requests. Only the token differs, and
      // that is what must decide which row is reached.
      expect(alice.displayName).toBe("Alice's");
      expect(bob.displayName).toBe("Bob's");
    } finally {
      h.cleanup();
    }
  });

  test("a directive written by one user is invisible to the other", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(BOB, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      const patched = await h.as(ALICE, "/v1/assistants/molty/directives", {
        method: "PATCH",
        body: { instructions: "Always answer in German." },
      });
      expect(patched.status).toBe(200);

      const bob = (await (await h.as(BOB, "/v1/assistants/molty")).json()) as {
        soul: { directives: { instructions?: string } };
      };
      expect(bob.soul.directives.instructions).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("a skill written by one user is not listed for the other", async () => {
    const h = harness();
    try {
      for (const user of [ALICE, BOB]) {
        await h.as(user, "/v1/assistants", {
          method: "POST",
          body: { assistantId: "molty" },
        });
      }
      const put = await h.as(ALICE, "/v1/assistants/molty/skills", {
        method: "PUT",
        body: {
          name: "invoice-export",
          triggerLine: "When asked to export invoices",
          body: "1. Open the ledger. 2. Export the month.",
        },
      });
      expect(put.status).toBe(200);

      const mine = (await (
        await h.as(ALICE, "/v1/assistants/molty/skills")
      ).json()) as {
        skills: unknown[];
      };
      const theirs = (await (
        await h.as(BOB, "/v1/assistants/molty/skills")
      ).json()) as {
        skills: unknown[];
      };
      expect(mine.skills).toHaveLength(1);
      expect(theirs.skills).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a delegation grant is not visible to another user with the same assistant id", async () => {
    const h = harness();
    try {
      for (const user of [ALICE, BOB]) {
        await h.as(user, "/v1/assistants", {
          method: "POST",
          body: { assistantId: "molty" },
        });
      }
      const granted = await h.as(ALICE, "/v1/assistants/molty/delegation", {
        method: "POST",
        body: {
          issuer: "https://idp.example.com",
          refreshToken: "refresh-token-value",
          scope: "openid offline_access",
        },
      });
      // Either the deployment holds the grant (200) or it is not configured to
      // encrypt it (503). Both are acceptable here; leaking it is not.
      expect([200, 503]).toContain(granted.status);

      const theirs = (await (
        await h.as(BOB, "/v1/assistants/molty/delegation")
      ).json()) as {
        delegations: unknown[];
      };
      expect(theirs.delegations).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("revoking a delegation invalidates any cached delegated access token", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      const granted = await h.as(ALICE, "/v1/assistants/molty/delegation", {
        method: "POST",
        body: {
          issuer: "https://idp.example.com",
          refreshToken: "refresh-token-value",
        },
      });
      expect(granted.status).toBe(200);

      // Spy on the authority resolver to confirm the route calls
      // invalidateDelegatedToken, not merely credentials.revoke — a revoked
      // grant must not go on working off an already-cached access token.
      const invalidateCalls: Array<{ userId: string; issuer: string }> = [];
      const originalInvalidate =
        h.runtime.stores.authority.invalidateDelegatedToken.bind(
          h.runtime.stores.authority,
        );
      h.runtime.stores.authority.invalidateDelegatedToken = (scope, issuer) => {
        invalidateCalls.push({ userId: scope.userId, issuer });
        return originalInvalidate(scope, issuer);
      };

      const revoked = await h.as(
        ALICE,
        "/v1/assistants/molty/delegation?issuer=https%3A%2F%2Fidp.example.com",
        { method: "DELETE" },
      );
      expect(revoked.status).toBe(200);
      expect(invalidateCalls).toEqual([
        { userId: ALICE, issuer: "https://idp.example.com" },
      ]);

      const listing = (await (
        await h.as(ALICE, "/v1/assistants/molty/delegation")
      ).json()) as { delegations: Array<{ state: string }> };
      expect(listing.delegations[0]?.state).toBe("revoked");
    } finally {
      h.cleanup();
    }
  });

  test("the refresh token is never echoed by the delegation listing", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(ALICE, "/v1/assistants/molty/delegation", {
        method: "POST",
        body: {
          issuer: "https://idp.example.com",
          refreshToken: "super-secret-refresh",
        },
      });
      const listing = await (
        await h.as(ALICE, "/v1/assistants/molty/delegation")
      ).text();
      expect(listing).not.toContain("super-secret-refresh");
    } finally {
      h.cleanup();
    }
  });

  test("tenant is part of the scope, so the same user id in another tenant is separate", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty", displayName: "Acme" },
        tenantId: "acme",
      });
      const other = (await (
        await h.as(ALICE, "/v1/assistants", { tenantId: "globex" })
      ).json()) as { assistants: unknown[] };
      expect(other.assistants).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("soul write classes", () => {
  test("identity and constraints cannot be set through the directive route", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      const res = await h.as(ALICE, "/v1/assistants/molty/directives", {
        method: "PATCH",
        body: {
          identity: { name: "root" },
          constraints: { forbidden: "nothing" },
        },
      });
      // No recognised directive field was supplied, so the request is rejected rather
      // than partially applied. The unknown keys must not reach the store at all.
      expect(res.status).toBe(400);

      const view = (await (
        await h.as(ALICE, "/v1/assistants/molty")
      ).json()) as {
        soul: {
          identity: Record<string, unknown>;
          constraints: Record<string, unknown>;
        };
      };
      expect(view.soul.constraints).toEqual({});
      expect(view.soul.identity.name).not.toBe("root");
    } finally {
      h.cleanup();
    }
  });

  test("a stale revision hash is a conflict that reports the current one", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(ALICE, "/v1/assistants/molty/directives", {
        method: "PATCH",
        body: { instructions: "First." },
      });
      const conflict = await h.as(ALICE, "/v1/assistants/molty/directives", {
        method: "PATCH",
        body: { instructions: "Second.", expectedRevisionHash: "stale-hash" },
      });
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as { currentRevisionHash?: string };
      // The current hash is returned so a client can re-read and retry without a
      // second round trip just to discover what it should have sent.
      expect(typeof body.currentRevisionHash).toBe("string");
    } finally {
      h.cleanup();
    }
  });

  test("null clears a directive field", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(ALICE, "/v1/assistants/molty/directives", {
        method: "PATCH",
        body: { style: "Terse." },
      });
      const cleared = (await (
        await h.as(ALICE, "/v1/assistants/molty/directives", {
          method: "PATCH",
          body: { style: null },
        })
      ).json()) as { directives: { style?: string } };
      expect(cleared.directives.style).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("peer channels", () => {
  test("a channel is granted by the receiving user and is not a directory of others", async () => {
    const h = harness();
    try {
      for (const user of [ALICE, BOB]) {
        await h.as(user, "/v1/assistants", {
          method: "POST",
          body: { assistantId: user === ALICE ? "alice-bot" : "bob-bot" },
        });
      }
      // Bob opens a channel INTO his own assistant for Alice's. He is the receiver, so
      // he is the party allowed to consent.
      const created = await h.as(BOB, "/v1/assistants/bob-bot/channels", {
        method: "POST",
        body: { fromAssistantId: "alice-bot", fromUserId: ALICE },
      });
      expect(created.status).toBe(201);
      const grant = (await created.json()) as {
        id: string;
        fromAssistantId: string;
      };
      expect(grant.fromAssistantId).toBe("alice-bot");
      // The response names the peer ASSISTANT, never the peer user.
      expect(JSON.stringify(grant)).not.toContain(ALICE);

      // Alice sees it as outgoing on her side, still without Bob's user id.
      const aliceView = await (
        await h.as(ALICE, "/v1/assistants/alice-bot/channels")
      ).text();
      expect(aliceView).toContain("bob-bot");
      expect(aliceView).not.toContain(BOB);
    } finally {
      h.cleanup();
    }
  });

  test("only the receiver can revoke the channel they granted", async () => {
    const h = harness();
    try {
      for (const [user, id] of [
        [ALICE, "alice-bot"],
        [BOB, "bob-bot"],
      ] as const) {
        await h.as(user, "/v1/assistants", {
          method: "POST",
          body: { assistantId: id },
        });
      }
      const grant = (await (
        await h.as(BOB, "/v1/assistants/bob-bot/channels", {
          method: "POST",
          body: { fromAssistantId: "alice-bot", fromUserId: ALICE },
        })
      ).json()) as { id: string };

      // Alice is the SENDER on this channel. Revocation is the other half of consent,
      // and consent belonged to Bob, so her attempt must not reach the grant.
      const bySender = await h.as(
        ALICE,
        `/v1/assistants/alice-bot/channels/${grant.id}`,
        {
          method: "DELETE",
        },
      );
      expect(bySender.status).toBe(404);

      const byReceiver = await h.as(
        BOB,
        `/v1/assistants/bob-bot/channels/${grant.id}`,
        {
          method: "DELETE",
        },
      );
      expect(byReceiver.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("a cross-tenant channel is not openable through this API", async () => {
    const h = harness();
    try {
      await h.as(BOB, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "bob-bot" },
        tenantId: "acme",
      });
      const created = await h.as(BOB, "/v1/assistants/bob-bot/channels", {
        method: "POST",
        body: { fromAssistantId: "alice-bot", fromUserId: ALICE },
        tenantId: "acme",
      });
      expect(created.status).toBe(201);
      // The sender scope was built from the RECEIVER's tenant, so a grant can never
      // name a foreign tenant even if the caller wanted one.
      const grants = await h.messaging.listIncomingGrants({
        tenantId: "acme",
        userId: BOB,
        assistantId: "bob-bot",
      });
      expect(grants).toHaveLength(1);
      expect(grants[0]?.from.tenantId).toBe("acme");
    } finally {
      h.cleanup();
    }
  });
});

describe("identifier handling", () => {
  test("a traversal attempt is normalised to a plain identifier, never to a path", async () => {
    const h = harness();
    try {
      const created = await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "../../etc" },
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { assistantId: string };
      // Separators are collapsed away before the id is ever used, so the id that
      // reaches the store and the workspace resolver contains no path syntax at all.
      expect(body.assistantId).toBe("etc");
      expect(body.assistantId).not.toContain("/");
      expect(body.assistantId).not.toContain(".");

      const record = await h.runtime.stores.assistants.get({
        tenantId: "acme",
        userId: ALICE,
        assistantId: "etc",
      });
      // And the workspace it provisioned stays inside the configured root — the id
      // could not climb out of it.
      expect(record?.workspacePath.includes("/..")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("an unknown assistant is a 404, not an implicit provisioning", async () => {
    const h = harness();
    try {
      const res = await h.as(ALICE, "/v1/assistants/never-created");
      expect(res.status).toBe(404);
      // Provisioning on first TURN is the product promise; provisioning on a GET
      // would make the listing unusable as an inventory.
      const listing = (await (await h.as(ALICE, "/v1/assistants")).json()) as {
        assistants: unknown[];
      };
      expect(listing.assistants).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("durable session recovery and snapshot projection", () => {
  const requestAs = (
    app: ReturnType<typeof createAssistantsRouter>,
    userId: string,
    input: string,
    method = "GET",
    body?: unknown,
  ) =>
    Promise.resolve(
      app.request(input, {
        method,
        headers: {
          "X-OpenWebUI-User-Id": userId,
          "X-Tenant-Id": "acme",
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );

  test("projects an API snapshot with its stored identity, sequence, and caller scope", async () => {
    const h = harness();
    try {
      const snapshot = {
        id: "snapshot-db-id",
        conversationId: "chat",
        sequence: 19,
        kind: "summary" as const,
        content: "durable summary",
        createdAt: "2026-03-01T00:00:00.000Z",
      };
      h.runtime.stores.sessionStore = {
        createSnapshot: async () => snapshot,
      } as unknown as AssistantSessionStore;
      const projections: Array<
        Parameters<AssistantSessionIndex["ingestEvent"]>[0]
      > = [];
      const sessionIndex: AssistantSessionIndex = {
        ingestEvent: async (input) => {
          projections.push(input);
        },
        search: async () => [],
      };
      const app = createAssistantsRouter({ runtime: h.runtime, sessionIndex });
      const response = await requestAs(
        app,
        ALICE,
        "/v1/assistants/molty/sessions/chat/snapshots",
        "POST",
        {
          sequence: 19,
          kind: "summary",
          content: "durable summary",
        },
      );
      expect(response.status).toBe(201);
      expect(projections).toHaveLength(1);
      expect(projections[0]).toMatchObject({
        documentId: "snapshot-db-id",
        sequence: 19,
        content: "durable summary",
        kind: "snapshot",
        scope: { tenantId: "acme", userId: ALICE, assistantId: "molty" },
      });
    } finally {
      h.cleanup();
    }
  });

  test("lists and manually reconciles recovery entries only in the authenticated caller scope", async () => {
    const h = harness();
    try {
      const scopes: Array<{
        tenantId: string;
        userId: string;
        assistantId: string;
      }> = [];
      h.runtime.stores.sessionStore = {
        recoverExpired: async (scope: AssistantScope) => {
          scopes.push(scope);
          return [];
        },
        listRecoverable: async (scope: AssistantScope) => {
          scopes.push(scope);
          return [];
        },
        reconcileUnknown: async (
          params: Parameters<
            NonNullable<AssistantSessionStore["reconcileUnknown"]>
          >[0],
        ) => {
          scopes.push(params.scope);
          return {
            conversationId: params.conversationId,
            toolCallId: params.toolCallId,
            operationId: "operation",
            sequence: 2,
            executionId: "550e8400-e29b-41d4-a716-446655440000",
            toolName: "remote/write",
            args: {},
            status: params.status,
            attempts: 1,
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          };
        },
      } as unknown as AssistantSessionStore;
      const app = createAssistantsRouter({ runtime: h.runtime });
      expect(
        (await requestAs(app, BOB, "/v1/assistants/molty/tool-recovery"))
          .status,
      ).toBe(200);
      expect(
        (
          await requestAs(
            app,
            BOB,
            "/v1/assistants/molty/tool-recovery/chat/call/reconcile",
            "POST",
            {
              status: "cancelled",
              reason: "Operator verified no effect",
            },
          )
        ).status,
      ).toBe(200);
      expect(scopes).toEqual([
        { tenantId: "acme", userId: BOB, assistantId: "molty" },
        { tenantId: "acme", userId: BOB, assistantId: "molty" },
        { tenantId: "acme", userId: BOB, assistantId: "molty" },
      ]);
    } finally {
      h.cleanup();
    }
  });
});
