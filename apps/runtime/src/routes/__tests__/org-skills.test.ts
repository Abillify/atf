// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Route tests for the Org Skill Registry surface:
 *   - user plane: POST /v1/assistants/:id/skills/:name/publish,
 *     GET /v1/org-skills, POST /v1/org-skills/:id/install
 *   - operator plane: GET /admin/org-skills, POST /admin/org-skills/:id/deprecate
 *
 * The property under test is the same one every other assistants-route test
 * checks: publishing is the SOURCE user's own decision, browsing is
 * tenant-scoped, and installing writes into the CALLER's own assistant (never
 * a foreign one) as an ordinary pending proposal — never a live skill.
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
import { InMemoryOrgSkillStore } from "../../assistants/org-skill-registry.js";
import { InMemoryProposalStore } from "../../assistants/proposal-store.js";
import { InMemorySkillCanaryStore } from "../../assistants/skill-canary.js";
import { InMemorySkillStore } from "../../assistants/skill-store.js";
import { InMemorySoulStore } from "../../assistants/soul-store.js";
import { AssistantWorkspaceResolver } from "../../assistants/workspace.js";
import { createAssistantsRouter } from "../assistants.js";
import { createAssistantsAdminRouter } from "../assistants-admin.js";

function harness() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "aip-routes-orgskills-")),
  );
  const workspaces = new AssistantWorkspaceResolver({ root });
  const skills = new InMemorySkillStore();
  const credentials = new InMemoryCredentialStore(
    new SecretCipher(crypto.randomBytes(32)),
  );
  const messaging = new InMemoryMessagingStore();
  const orgSkills = new InMemoryOrgSkillStore();
  const runtime = new AssistantRuntime({
    assistants: new InMemoryAssistantStore(workspaces),
    souls: new InMemorySoulStore(),
    skills,
    proposals: new InMemoryProposalStore(skills),
    canaries: new InMemorySkillCanaryStore(),
    messaging,
    credentials,
    authority: new AuthorityResolver({ credentials }),
    orgSkills,
  });
  const app = createAssistantsRouter({ runtime });
  const adminApp = createAssistantsAdminRouter({
    runtime,
    authRequired: false,
  });

  const as = (
    userId: string,
    input: string,
    init?: { method?: string; body?: unknown; tenantId?: string },
  ): Promise<Response> =>
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

  const asAdmin = (
    input: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Response> =>
    Promise.resolve(
      adminApp.request(input, {
        method: init?.method ?? "GET",
        headers: { "Content-Type": "application/json" },
        ...(init?.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
      }),
    );

  return {
    app,
    adminApp,
    runtime,
    orgSkills,
    as,
    asAdmin,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

describe("POST /v1/assistants/:id/skills/:name/publish", () => {
  test("publishes an active skill the caller's own assistant has", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(ALICE, "/v1/assistants/molty/skills", {
        method: "PUT",
        body: {
          name: "invoice-export",
          triggerLine: "When asked to export invoices",
          body: "1. Open the ledger. 2. Export the month.",
        },
      });
      const res = await h.as(
        ALICE,
        "/v1/assistants/molty/skills/invoice-export/publish",
        {
          method: "POST",
          body: { summary: "Reliable export technique" },
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        name: string;
        status: string;
      };
      expect(body.status).toBe("published");
      expect(body.name.toLowerCase()).toBe("invoice-export");
    } finally {
      h.cleanup();
    }
  });

  test("refuses to publish a skill that does not exist", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      const res = await h.as(
        ALICE,
        "/v1/assistants/molty/skills/nope/publish",
        {
          method: "POST",
          body: {},
        },
      );
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("cannot publish another user's skill via the same assistant id", async () => {
    const h = harness();
    try {
      for (const user of [ALICE, BOB]) {
        await h.as(user, "/v1/assistants", {
          method: "POST",
          body: { assistantId: "molty" },
        });
      }
      await h.as(ALICE, "/v1/assistants/molty/skills", {
        method: "PUT",
        body: {
          name: "invoice-export",
          triggerLine: "trigger",
          body: "procedure",
        },
      });
      // Bob names the same assistant id + skill name, but his own scope has no
      // such skill — the isolation guarantee every other route enforces.
      const res = await h.as(
        BOB,
        "/v1/assistants/molty/skills/invoice-export/publish",
        {
          method: "POST",
          body: {},
        },
      );
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });
});

describe("GET /v1/org-skills and POST /v1/org-skills/:id/install", () => {
  test("browsing and installing round-trips through the destination's OWN proposal pipeline", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(ALICE, "/v1/assistants/molty/skills", {
        method: "PUT",
        body: {
          name: "invoice-export",
          triggerLine: "When asked to export invoices",
          body: "1. Open the ledger. 2. Export the month.",
        },
      });
      const publishRes = await h.as(
        ALICE,
        "/v1/assistants/molty/skills/invoice-export/publish",
        {
          method: "POST",
          body: { summary: "Reliable export technique" },
        },
      );
      const published = (await publishRes.json()) as { id: string };

      // Browse as Bob (same tenant, different user).
      await h.as(BOB, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      const listRes = await h.as(BOB, "/v1/org-skills");
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as {
        total: number;
        skills: Array<{ id: string }>;
      };
      expect(list.total).toBe(1);
      expect(list.skills[0]?.id).toBe(published.id);

      // Install into Bob's own assistant.
      const installRes = await h.as(
        BOB,
        `/v1/org-skills/${published.id}/install`,
        {
          method: "POST",
          body: { assistantId: "molty" },
        },
      );
      expect(installRes.status).toBe(201);
      const installed = (await installRes.json()) as { proposalId: string };
      expect(installed.proposalId).toBeDefined();

      // A pending proposal exists for Bob, not a live skill yet.
      const proposalsRes = await h.as(BOB, "/v1/assistants/molty/proposals");
      const proposals = (await proposalsRes.json()) as {
        proposals: Array<{ id: string; status: string }>;
      };
      expect(
        proposals.proposals.some(
          (p) => p.id === installed.proposalId && p.status === "pending",
        ),
      ).toBe(true);
      const skillsRes = await h.as(BOB, "/v1/assistants/molty/skills");
      const skillsBody = (await skillsRes.json()) as { skills: unknown[] };
      expect(skillsBody.skills).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("does not leak an entry from a different tenant", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(ALICE, "/v1/assistants/molty/skills", {
        method: "PUT",
        body: {
          name: "invoice-export",
          triggerLine: "trigger",
          body: "procedure content",
        },
      });
      await h.as(ALICE, "/v1/assistants/molty/skills/invoice-export/publish", {
        method: "POST",
        body: {},
      });
      const otherTenantList = await h.as(BOB, "/v1/org-skills", {
        tenantId: "other-tenant",
      });
      const body = (await otherTenantList.json()) as { total: number };
      expect(body.total).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("cannot install into a foreign assistant id owned by another user", async () => {
    const h = harness();
    try {
      await h.as(ALICE, "/v1/assistants", {
        method: "POST",
        body: { assistantId: "molty" },
      });
      await h.as(ALICE, "/v1/assistants/molty/skills", {
        method: "PUT",
        body: {
          name: "invoice-export",
          triggerLine: "trigger",
          body: "procedure content",
        },
      });
      const publishRes = await h.as(
        ALICE,
        "/v1/assistants/molty/skills/invoice-export/publish",
        {
          method: "POST",
          body: {},
        },
      );
      const published = (await publishRes.json()) as { id: string };

      // Bob attempts to install "into Alice's assistant" — but the scope is
      // always resolved from Bob's OWN identity, so this provisions/uses
      // Bob's own "molty", never Alice's.
      const installRes = await h.as(
        BOB,
        `/v1/org-skills/${published.id}/install`,
        {
          method: "POST",
          body: { assistantId: "molty" },
        },
      );
      expect(installRes.status).toBe(201);

      const aliceSkills = (await (
        await h.as(ALICE, "/v1/assistants/molty/proposals")
      ).json()) as {
        proposals: unknown[];
      };
      // Alice's own proposal queue is unaffected by Bob's install.
      expect(aliceSkills.proposals).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("Operator plane: GET /admin/org-skills, POST /admin/org-skills/:id/deprecate", () => {
  test("requires a tenantId query parameter", async () => {
    const h = harness();
    try {
      const res = await h.asAdmin("/admin/org-skills");
      expect(res.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  test("lists catalog entries for the named tenant, including non-published when asked", async () => {
    const h = harness();
    try {
      const entry = await h.orgSkills.publish({
        tenantId: "acme",
        sourceScope: { tenantId: "acme", userId: ALICE, assistantId: "molty" },
        publishedBy: ALICE,
        name: "Skill A",
        triggerLine: "always",
        body: "procedure content here",
      });
      const listRes = await h.asAdmin("/admin/org-skills?tenantId=acme");
      const list = (await listRes.json()) as { total: number };
      expect(list.total).toBe(1);

      const deprecateRes = await h.asAdmin(
        `/admin/org-skills/${entry.id}/deprecate?tenantId=acme`,
        {
          method: "POST",
        },
      );
      expect(deprecateRes.status).toBe(200);

      const afterPublished = await h.asAdmin("/admin/org-skills?tenantId=acme");
      const afterBody = (await afterPublished.json()) as { total: number };
      expect(afterBody.total).toBe(0);

      const afterDeprecated = await h.asAdmin(
        "/admin/org-skills?tenantId=acme&status=deprecated",
      );
      const deprecatedBody = (await afterDeprecated.json()) as {
        total: number;
      };
      expect(deprecatedBody.total).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("deprecating an unknown entry returns 404", async () => {
    const h = harness();
    try {
      const res = await h.asAdmin(
        "/admin/org-skills/unknown-id/deprecate?tenantId=acme",
        {
          method: "POST",
        },
      );
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });
});
