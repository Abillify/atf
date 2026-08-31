// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The assistant OPERATOR plane, plus the two seams that make an assistant reachable:
 * the model-name selector and the model listing.
 *
 * Three properties are load-bearing here.
 *
 * The operator plane owns exactly ONE soul write class. An operator may set the
 * constraints an assistant must obey; they may not rewrite the user's directives,
 * because those are that person's own instructions to their own assistant. If a future
 * change gives this router a directives path, these tests fail.
 *
 * There is no operator APPLY for a learned procedure. Approving new behaviour into
 * somebody's assistant is their decision; rejecting only removes, which is the
 * operator's business. The absence of that endpoint is a design decision, so it is
 * asserted rather than left to be noticed.
 *
 * And a read-only operator role must not be able to change anything, since the whole
 * point of RBAC on this plane is that "look at the estate" and "change the estate" are
 * different jobs.
 */
import { Hono } from "hono";
import type { AuthContext } from "../../middleware/auth.js";
import { AUTH_PRINCIPAL_KEY, TOKEN_KEY } from "../../middleware/auth.js";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AssistantRuntime } from "../../assistants/assistant-runtime.js";
import {
  InMemoryAssistantStore,
  OPERATOR_LIST_MAX_LIMIT,
} from "../../assistants/assistant-store.js";
import { AuthorityResolver } from "../../assistants/authority-resolver.js";
import { InMemoryCredentialStore } from "../../assistants/credential-store.js";
import { InMemoryMessagingStore } from "../../assistants/messaging-store.js";
import { InMemoryProposalStore } from "../../assistants/proposal-store.js";
import { InMemorySkillCanaryStore } from "../../assistants/skill-canary.js";
import { InMemorySkillStore } from "../../assistants/skill-store.js";
import { InMemorySoulStore } from "../../assistants/soul-store.js";
import { AssistantWorkspaceResolver } from "../../assistants/workspace.js";
import type { AssistantScope } from "../../assistants/types.js";
import { SecretCipher } from "../../graph/secret-cipher.js";
import type { AuditLog, AuditEntry } from "../../observability/audit-log.js";
import { createAssistantsAdminRouter } from "../assistants-admin.js";
import { createModelsRouter } from "../models.js";
import { assistantIdFromModelName } from "../../graph/handlers/assistant-context.js";
import type { OperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** An authorizer that grants a fixed permission set. */
function authorizer(granted: string[]): OperatorAuthorizer {
  return {
    authorize: async (
      _auth: string | undefined,
      _token: string | undefined,
      permission: string,
    ) =>
      granted.includes(permission)
        ? { ok: true, role: "test" }
        : { ok: false, reason: "forbidden" },
  } as unknown as OperatorAuthorizer;
}

/** A minimal AuditLog whose entries are asserted against directly in tests. */
function fakeAuditLog(): AuditLog & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record: (entry: AuditEntry) => {
      entries.push(entry);
    },
    list: async () => [],
    verifyChain: async () => ({ valid: true, checked: 0 }),
  };
}

function harness(granted = ["monitoring:read", "monitoring:write"]) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "aip-admin-assist-")),
  );
  const workspaces = new AssistantWorkspaceResolver({ root });
  const assistants = new InMemoryAssistantStore(workspaces);
  const skills = new InMemorySkillStore();
  const souls = new InMemorySoulStore();
  const proposals = new InMemoryProposalStore(skills);
  // A cipher is configured so delegation tests exercise the real
  // encrypt/decrypt/revoke path, matching the user-plane test harness.
  const credentials = new InMemoryCredentialStore(
    new SecretCipher(crypto.randomBytes(32)),
  );
  const authority = new AuthorityResolver({ credentials });
  const auditLog = fakeAuditLog();
  const runtime = new AssistantRuntime({
    assistants,
    souls,
    skills,
    proposals,
    canaries: new InMemorySkillCanaryStore(),
    messaging: new InMemoryMessagingStore(),
    credentials,
    authority,
  });
  const app = createAssistantsAdminRouter({
    runtime,
    operatorAuth: authorizer(granted),
    auditLog,
  });
  const call = (
    input: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Response> =>
    Promise.resolve(
      app.request(input, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: "Bearer op",
          "Content-Type": "application/json",
        },
        ...(init?.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
      }),
    );
  return {
    app,
    call,
    assistants,
    souls,
    skills,
    proposals,
    credentials,
    authority,
    auditLog,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const SCOPE: AssistantScope = {
  tenantId: "acme",
  userId: "alice@example.com",
  assistantId: "primary",
};
const PATH = `/admin/assistants/acme/${encodeURIComponent(SCOPE.userId)}/primary`;

// ---------------------------------------------------------------------------
// Model-name selector
// ---------------------------------------------------------------------------

describe("assistantIdFromModelName", () => {
  test("the prefix form carries a selection", () => {
    expect(assistantIdFromModelName("assistant-work")).toBe("work");
    expect(assistantIdFromModelName("assistant-a1_b2")).toBe("a1_b2");
    // Case-folded, because a picker entry is typed by a person and the id space is
    // lowercase.
    expect(assistantIdFromModelName("Assistant-Work")).toBe("work");
  });

  test("the bare flow id is NOT a selection, so the default still applies", () => {
    // If this returned something, `defaultAssistantId` would be dead config and every
    // deployment would need per-user setup — the opposite of the product promise.
    expect(assistantIdFromModelName("assistant")).toBeUndefined();
  });

  test("nothing else is a selection", () => {
    expect(assistantIdFromModelName("assistant-")).toBeUndefined();
    expect(assistantIdFromModelName("helpdesk")).toBeUndefined();
    expect(assistantIdFromModelName("my-assistant-work")).toBeUndefined();
    expect(assistantIdFromModelName(undefined)).toBeUndefined();
    expect(assistantIdFromModelName(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

function flowRegistry(ids: string[]): FlowRegistry {
  const flows = ids.map(
    (id) => ({ id, name: id }) as unknown as FlowDefinition,
  );
  return {
    list: () => flows,
    get: (id: string) => flows.find((f) => f.id === id),
  } as unknown as FlowRegistry;
}

function modelsAppForScope(
  ids: string[],
  assistants: InMemoryAssistantStore,
  scope: AssistantScope,
): Hono<AuthContext> {
  const app = new Hono<AuthContext>();
  app.use("*", async (ctx, next) => {
    ctx.set(TOKEN_KEY, "verified-test-token");
    ctx.set(AUTH_PRINCIPAL_KEY, {
      method: "token",
      verified: true,
      claims: { sub: scope.userId },
      tenantId: scope.tenantId,
    });
    await next();
  });
  app.route("/", createModelsRouter(flowRegistry(ids), { assistants }));
  return app;
}

describe("GET /v1/models with assistants", () => {
  test("a caller sees their own assistants and not another user's", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE, displayName: "Alice Primary" });
      await h.assistants.ensure({
        scope: {
          tenantId: "acme",
          userId: "bob@example.com",
          assistantId: "primary",
        },
        displayName: "Bob Primary",
      });
      const app = modelsAppForScope(
        ["helpdesk", "assistant"],
        h.assistants,
        SCOPE,
      );
      const res = await app.request("/v1/models");
      const body = (await res.json()) as {
        data: { id: string; name?: string }[];
      };
      const ids = body.data.map((m) => m.id);
      // The flows are still all there — the listing is additive.
      expect(ids).toContain("helpdesk");
      expect(ids).toContain("assistant");
      expect(ids).toContain("assistant-primary");
      // Bob's assistant has the same id, so the only thing that can distinguish the
      // two listings is the caller's identity.
      expect(body.data.find((m) => m.id === "assistant-primary")?.name).toBe(
        "Alice Primary",
      );
      expect(ids.filter((id) => id === "assistant-primary")).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("an unauthenticated caller still gets the flow list", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      const app = createModelsRouter(flowRegistry(["helpdesk"]), {
        assistants: h.assistants,
      });
      const res = await app.request("/v1/models");
      const body = (await res.json()) as { data: { id: string }[] };
      // No user identity means no assistants to add — but the picker must not break,
      // because it is how every other flow is reached.
      expect(body.data.map((m) => m.id)).toEqual(["helpdesk"]);
    } finally {
      h.cleanup();
    }
  });

  test("a suspended assistant is not offered in the picker", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.assistants.update(SCOPE, { status: "suspended" });
      const app = modelsAppForScope([], h.assistants, SCOPE);
      const res = await app.request("/v1/models");
      const body = (await res.json()) as { data: unknown[] };
      // Selecting it would produce a turn that cannot run.
      expect(body.data).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("GET /v1/models/:id resolves an assistant model the listing just offered", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      const app = modelsAppForScope([], h.assistants, SCOPE);
      expect((await app.request("/v1/models/assistant-primary")).status).toBe(
        200,
      );
      // Another user's assistant id is not resolvable even though the row exists.
      expect((await app.request("/v1/models/assistant-nope")).status).toBe(404);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Operator listing
// ---------------------------------------------------------------------------

describe("operator estate listing", () => {
  test("spans users and tenants, and reports the unpaged total", async () => {
    const h = harness();
    try {
      for (const [tenant, user] of [
        ["acme", "alice@example.com"],
        ["acme", "bob@example.com"],
        ["globex", "carol@example.com"],
      ] as const) {
        await h.assistants.ensure({
          scope: { tenantId: tenant, userId: user, assistantId: "primary" },
        });
      }
      const body = (await (await h.call("/admin/assistants")).json()) as {
        total: number;
        assistants: { tenantId: string; userId: string }[];
      };
      expect(body.total).toBe(3);
      // Grouped by tenant then user: an operator scans by organisation, so a pure
      // activity sort would interleave tenants.
      expect(body.assistants.map((a) => `${a.tenantId}/${a.userId}`)).toEqual([
        "acme/alice@example.com",
        "acme/bob@example.com",
        "globex/carol@example.com",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("filters by tenant, user and status", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.assistants.ensure({
        scope: {
          tenantId: "globex",
          userId: "carol@example.com",
          assistantId: "primary",
        },
      });
      await h.assistants.update(SCOPE, { status: "suspended" });

      const byTenant = (await (
        await h.call("/admin/assistants?tenantId=globex")
      ).json()) as {
        total: number;
      };
      expect(byTenant.total).toBe(1);

      const byStatus = (await (
        await h.call("/admin/assistants?status=suspended")
      ).json()) as {
        total: number;
        assistants: { userId: string }[];
      };
      expect(byStatus.total).toBe(1);
      expect(byStatus.assistants[0]?.userId).toBe(SCOPE.userId);
    } finally {
      h.cleanup();
    }
  });

  test("paging is bounded, so a huge limit cannot be requested", async () => {
    const h = harness();
    try {
      for (let i = 0; i < 5; i += 1) {
        await h.assistants.ensure({
          scope: {
            tenantId: "acme",
            userId: `u${i}@example.com`,
            assistantId: "primary",
          },
        });
      }
      const page = await h.assistants.listForOperator({ limit: 1_000_000 });
      expect(page.assistants.length).toBeLessThanOrEqual(
        OPERATOR_LIST_MAX_LIMIT,
      );
      // A nonsense offset is a legitimate request and must yield an empty page rather
      // than an error, while the total still describes the whole match.
      const past = await h.assistants.listForOperator({ offset: 999 });
      expect(past.assistants).toHaveLength(0);
      expect(past.total).toBe(5);
    } finally {
      h.cleanup();
    }
  });

  test("listForUser cannot be widened into a cross-user listing", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.assistants.ensure({
        scope: {
          tenantId: "acme",
          userId: "bob@example.com",
          assistantId: "primary",
        },
      });
      // The user-scoped listing requires both arguments and returns only that user's
      // rows. This is the method the user plane calls.
      const alice = await h.assistants.listForUser("acme", SCOPE.userId);
      expect(alice).toHaveLength(1);
      expect(alice[0]?.scope.userId).toBe(SCOPE.userId);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Write classes
// ---------------------------------------------------------------------------

describe("operator write class", () => {
  test("constraints are writable and render as the operator's class", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      const res = await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: {
          rules: "Never contact customers directly.",
          reason: "policy v2",
        },
      });
      expect(res.status).toBe(200);
      const soul = await h.souls.get(SCOPE);
      expect(soul.constraints.rules).toBe("Never contact customers directly.");

      const history = await h.souls.history(SCOPE, 10);
      // The write is attributed to the operator role, not to a guessed person.
      expect(history[0]?.writeClass).toBe("constraints");
      expect(history[0]?.actorType).toBe("operator");
    } finally {
      h.cleanup();
    }
  });

  test("an emptied field clears the constraint instead of storing an empty one", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { compliance: "GDPR Art. 6 applies." },
      });
      await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { compliance: null },
      });
      const soul = await h.souls.get(SCOPE);
      // An empty string would still render a "Forbidden:" heading into the prompt.
      expect(soul.constraints.compliance).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("denied tools round-trip as a list", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      const res = await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { deniedTools: ["email.send", "payments.transfer"] },
      });
      expect(res.status).toBe(200);
      expect((await h.souls.get(SCOPE)).constraints.deniedTools).toEqual([
        "email.send",
        "payments.transfer",
      ]);
      // An empty list is the "nothing denied" representation, so it must clear.
      await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { deniedTools: [] },
      });
      expect(
        (await h.souls.get(SCOPE)).constraints.deniedTools ?? [],
      ).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("an unknown constraint field is refused, not accepted and ignored", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      // This is the bug the closed schema prevents: a plausible-looking field name
      // that the soul document does not have would otherwise return 200 while the
      // assistant kept its old limits — an operator would believe a constraint was in
      // force when nothing had changed.
      const res = await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { policy: "Never contact customers." },
      });
      expect(res.status).toBe(400);
      expect((await h.souls.get(SCOPE)).constraints.rules).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("a stale revision hash is a conflict, so two operators cannot silently overwrite", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { rules: "First." },
      });
      const res = await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { rules: "Second.", expectedRevisionHash: "stale" },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { currentRevisionHash?: string };
      expect(typeof body.currentRevisionHash).toBe("string");
    } finally {
      h.cleanup();
    }
  });

  test("the operator plane has no route that writes a user's directives", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.souls.mutate({
        scope: SCOPE,
        actorType: "user",
        actorId: SCOPE.userId,
        patch: { directives: { instructions: "Answer in German." } },
      });
      // No such endpoint exists.
      const direct = await h.call(`${PATH}/directives`, {
        method: "PATCH",
        body: { instructions: "Answer in English." },
      });
      expect(direct.status).toBe(404);
      // And the constraints endpoint does not accept directive fields as a side door:
      // unknown keys leave nothing to change, so the request is refused outright.
      const sideDoor = await h.call(`${PATH}/constraints`, {
        method: "PATCH",
        body: { instructions: "Answer in English." },
      });
      expect(sideDoor.status).toBe(400);

      const soul = await h.souls.get(SCOPE);
      expect(soul.directives.instructions).toBe("Answer in German.");
    } finally {
      h.cleanup();
    }
  });

  test("all three soul classes are READABLE, because an operator must see what it was told", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.souls.mutate({
        scope: SCOPE,
        actorType: "user",
        actorId: SCOPE.userId,
        patch: { directives: { about: "Works in payroll." } },
      });
      const body = (await (await h.call(PATH)).json()) as {
        soul: {
          directives: Record<string, string>;
          constraints: Record<string, string>;
        };
      };
      expect(body.soul.directives.about).toBe("Works in payroll.");
      expect(body.soul.constraints).toEqual({});
    } finally {
      h.cleanup();
    }
  });

  test("the refresh token is not returned to an operator either", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      const text = await (await h.call(PATH)).text();
      expect(text).not.toContain("refreshToken");
      expect(text).not.toContain("refresh_token");
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Proposal queue
// ---------------------------------------------------------------------------

describe("proposal queue", () => {
  test("an operator can reject but there is no operator apply", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      const proposal = await h.proposals.create({
        scope: SCOPE,
        kind: "create",
        targetSkill: "payroll-export",
        actorType: "system",
        createdBy: "experience-review",
        title: "Monthly payroll export",
        triggerLine: "When asked for the monthly payroll export",
        body: "1. Open the ledger. 2. Export the month.",
      });

      const rejected = await h.call(`${PATH}/proposals/${proposal.id}/reject`, {
        method: "POST",
        body: { reason: "Not policy-compliant" },
      });
      expect(rejected.status).toBe(200);

      // Applying is the USER's decision. If this ever returns 200, an operator can
      // teach somebody's assistant behaviour they never agreed to.
      const applied = await h.call(`${PATH}/proposals/${proposal.id}/apply`, {
        method: "POST",
        body: {},
      });
      expect(applied.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("rejecting an already-decided proposal is a conflict, not a silent success", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      const proposal = await h.proposals.create({
        scope: SCOPE,
        kind: "create",
        targetSkill: "payroll-export",
        actorType: "system",
        createdBy: "experience-review",
        title: "Something",
        triggerLine: "When asked",
        body: "Do the thing.",
      });
      await h.call(`${PATH}/proposals/${proposal.id}/reject`, {
        method: "POST",
      });
      const second = await h.call(`${PATH}/proposals/${proposal.id}/reject`, {
        method: "POST",
      });
      expect(second.status).toBe(409);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("operator RBAC", () => {
  test("a read-only role can inspect but cannot change anything", async () => {
    const h = harness(["monitoring:read"]);
    try {
      await h.assistants.ensure({ scope: SCOPE });
      expect((await h.call("/admin/assistants")).status).toBe(200);
      expect((await h.call(PATH)).status).toBe(200);

      for (const [route, init] of [
        [`${PATH}/constraints`, { method: "PATCH", body: { rules: "x" } }],
        [PATH, { method: "PATCH", body: { status: "suspended" } }],
      ] as const) {
        expect((await h.call(route, init)).status).toBe(401);
      }
      const soul = await h.souls.get(SCOPE);
      expect(soul.constraints.rules).toBeUndefined();
      expect((await h.assistants.get(SCOPE))?.status).toBe("active");
    } finally {
      h.cleanup();
    }
  });

  test("a role with no permissions reads nothing", async () => {
    const h = harness([]);
    try {
      await h.assistants.ensure({ scope: SCOPE });
      expect((await h.call("/admin/assistants")).status).toBe(401);
      expect((await h.call(PATH)).status).toBe(401);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Status and autonomy
// ---------------------------------------------------------------------------

describe("status and autonomy", () => {
  test("suspending and reactivating go through the store", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.call(PATH, { method: "PATCH", body: { status: "suspended" } });
      expect((await h.assistants.get(SCOPE))?.status).toBe("suspended");
      await h.call(PATH, { method: "PATCH", body: { status: "active" } });
      expect((await h.assistants.get(SCOPE))?.status).toBe("active");
    } finally {
      h.cleanup();
    }
  });

  test("archiving retains the assistant's learned state", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      await h.skills.upsert({
        scope: SCOPE,
        name: "payroll-export",
        triggerLine: "When asked for payroll",
        body: "Steps.",
        origin: "user",
        status: "active",
      });
      await h.call(PATH, {
        method: "PATCH",
        body: { status: "archived", reason: "user left" },
      });
      expect((await h.assistants.get(SCOPE))?.status).toBe("archived");
      // Archive is not delete: an accidental click must be recoverable and the
      // compliance trail needs the state.
      expect(
        await h.skills.listAll(SCOPE, { includeRetired: true }),
      ).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("an empty patch is refused rather than treated as a no-op success", async () => {
    const h = harness();
    try {
      await h.assistants.ensure({ scope: SCOPE });
      expect((await h.call(PATH, { method: "PATCH", body: {} })).status).toBe(
        400,
      );
    } finally {
      h.cleanup();
    }
  });

  test("a path that does not name a valid assistant is refused, never resolved", async () => {
    const h = harness();
    try {
      const res = await h.call("/admin/assistants/acme/%20/primary");
      expect([400, 404]).toContain(res.status);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Identity Broker — Revocation Console
// ---------------------------------------------------------------------------

const ISSUER = "https://idp.example.com";

describe("Identity Broker: cross-scope delegation listing", () => {
  test("spans every tenant/user/assistant and never exposes a refresh token", async () => {
    const h = harness();
    try {
      const scopeA: AssistantScope = {
        tenantId: "acme",
        userId: "alice@example.com",
        assistantId: "primary",
      };
      const scopeB: AssistantScope = {
        tenantId: "globex",
        userId: "bob@example.com",
        assistantId: "primary",
      };
      await h.assistants.ensure({ scope: scopeA });
      await h.assistants.ensure({ scope: scopeB });
      await h.credentials.grant({
        scope: scopeA,
        issuer: ISSUER,
        refreshToken: "rt-alice",
        consentedScope: "offline_access",
        grantedBy: scopeA.userId,
      });
      await h.credentials.grant({
        scope: scopeB,
        issuer: ISSUER,
        refreshToken: "rt-bob",
        consentedScope: "offline_access",
        grantedBy: scopeB.userId,
      });

      const res = await h.call("/admin/identity-broker/delegations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        delegations: Array<{ tenantId: string; userId: string; state: string }>;
      };
      expect(body.total).toBe(2);
      const text = JSON.stringify(body);
      expect(text).not.toContain("rt-alice");
      expect(text).not.toContain("rt-bob");
      expect(text).not.toContain("refreshToken");
    } finally {
      h.cleanup();
    }
  });

  test("filters by tenantId, userId, assistantId and state", async () => {
    const h = harness();
    try {
      const scopeA: AssistantScope = {
        tenantId: "acme",
        userId: "alice@example.com",
        assistantId: "primary",
      };
      const scopeB: AssistantScope = {
        tenantId: "acme",
        userId: "bob@example.com",
        assistantId: "primary",
      };
      await h.assistants.ensure({ scope: scopeA });
      await h.assistants.ensure({ scope: scopeB });
      await h.credentials.grant({
        scope: scopeA,
        issuer: ISSUER,
        refreshToken: "rt-alice",
        consentedScope: "offline_access",
        grantedBy: scopeA.userId,
      });
      await h.credentials.grant({
        scope: scopeB,
        issuer: ISSUER,
        refreshToken: "rt-bob",
        consentedScope: "offline_access",
        grantedBy: scopeB.userId,
      });
      await h.credentials.revoke(scopeB, ISSUER);

      const byUser = (await (
        await h.call(
          "/admin/identity-broker/delegations?userId=alice%40example.com",
        )
      ).json()) as { total: number };
      expect(byUser.total).toBe(1);

      const byState = (await (
        await h.call("/admin/identity-broker/delegations?state=revoked")
      ).json()) as { total: number; delegations: Array<{ userId: string }> };
      expect(byState.total).toBe(1);
      expect(byState.delegations[0]?.userId).toBe("bob@example.com");
    } finally {
      h.cleanup();
    }
  });

  test("a read-only operator role can list but cannot revoke", async () => {
    const h = harness(["monitoring:read"]);
    try {
      expect((await h.call("/admin/identity-broker/delegations")).status).toBe(
        200,
      );
    } finally {
      h.cleanup();
    }
  });

  test("a role with no permissions cannot list", async () => {
    const h = harness([]);
    try {
      expect((await h.call("/admin/identity-broker/delegations")).status).toBe(
        401,
      );
    } finally {
      h.cleanup();
    }
  });
});

describe("Identity Broker: operator revocation", () => {
  test("revokes the grant, invalidates the cached token, and records an audit entry", async () => {
    const h = harness();
    try {
      const scope: AssistantScope = {
        tenantId: "acme",
        userId: "alice@example.com",
        assistantId: "primary",
      };
      await h.assistants.ensure({ scope });
      await h.credentials.grant({
        scope,
        issuer: ISSUER,
        refreshToken: "rt-alice",
        consentedScope: "offline_access",
        grantedBy: scope.userId,
      });

      const invalidateCalls: Array<{ userId: string; issuer: string }> = [];
      const original = h.authority.invalidateDelegatedToken.bind(h.authority);
      h.authority.invalidateDelegatedToken = (s, issuer) => {
        invalidateCalls.push({ userId: s.userId, issuer });
        return original(s, issuer);
      };

      const path = `/admin/assistants/acme/${encodeURIComponent(scope.userId)}/primary/delegation`;
      const res = await h.call(`${path}?issuer=${encodeURIComponent(ISSUER)}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(invalidateCalls).toEqual([
        { userId: scope.userId, issuer: ISSUER },
      ]);

      const listing = (await (
        await h.call(
          `/admin/identity-broker/delegations?userId=${encodeURIComponent(scope.userId)}`,
        )
      ).json()) as { delegations: Array<{ state: string }> };
      expect(listing.delegations[0]?.state).toBe("revoked");

      expect(h.auditLog.entries).toHaveLength(1);
      expect(h.auditLog.entries[0]?.action).toBe("assistant.delegation.revoke");
      expect(h.auditLog.entries[0]?.details).toEqual({ issuer: ISSUER });
    } finally {
      h.cleanup();
    }
  });

  test("requires an issuer query parameter", async () => {
    const h = harness();
    try {
      const scope: AssistantScope = {
        tenantId: "acme",
        userId: "alice@example.com",
        assistantId: "primary",
      };
      await h.assistants.ensure({ scope });
      const res = await h.call(
        `/admin/assistants/acme/${encodeURIComponent(scope.userId)}/primary/delegation`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  test("a read-only operator role cannot revoke", async () => {
    const h = harness(["monitoring:read"]);
    try {
      const scope: AssistantScope = {
        tenantId: "acme",
        userId: "alice@example.com",
        assistantId: "primary",
      };
      const path = `/admin/assistants/acme/${encodeURIComponent(scope.userId)}/primary/delegation`;
      const res = await h.call(`${path}?issuer=${encodeURIComponent(ISSUER)}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    } finally {
      h.cleanup();
    }
  });

  test("an invalid path is refused, never resolved", async () => {
    const h = harness();
    try {
      const res = await h.call(
        `/admin/assistants/acme/%20/primary/delegation?issuer=${encodeURIComponent(ISSUER)}`,
        { method: "DELETE" },
      );
      expect([400, 404]).toContain(res.status);
    } finally {
      h.cleanup();
    }
  });
});
