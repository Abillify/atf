// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createJobsRouter, deriveJobOwner } from "../jobs.js";
import {
  AUTH_PRINCIPAL_KEY,
  TOKEN_KEY,
  resolveTenantClaim,
  type AuthContext,
  type AuthPrincipal,
} from "../../middleware/auth.js";
import { InMemoryJobStore } from "../../graph/job-store.js";

interface AuthFixture {
  claims?: Record<string, unknown>;
  tenantId?: string;
}

/** Mounts the jobs router behind a stand-in for the verified auth middleware. */
function appWith(store: InMemoryJobStore, fixture: AuthFixture = {}) {
  const app = new Hono<AuthContext>();
  app.use("*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const token = auth?.replace(/^Bearer\s+/, "") ?? "";
    const claims = fixture.claims ?? null;
    const tenantId = fixture.tenantId ?? resolveTenantClaim(claims);
    const principal: AuthPrincipal = {
      method: "token",
      verified: true,
      claims,
      ...(tenantId !== undefined ? { tenantId } : {}),
    };
    c.set(TOKEN_KEY, token);
    c.set(AUTH_PRINCIPAL_KEY, principal);
    await next();
  });
  app.route("/", createJobsRouter(store));
  return app;
}

function createJob(store: InMemoryJobStore, id: string, owner: string): void {
  store.create({ id, model: "flow-x", owner });
}

describe("deriveJobOwner", () => {
  it("uses the authenticated tenant before the raw token", () => {
    expect(
      deriveJobOwner(
        {
          method: "token",
          verified: true,
          claims: { tenant_id: "default" },
          tenantId: "default",
        },
        "tok-abc",
      ),
    ).toBe("default");
  });

  it("falls back to the token when the principal has no tenant", () => {
    expect(deriveJobOwner(undefined, "tok-abc")).toBe("tok-abc");
  });
});

describe("GET /v1/jobs/:id", () => {
  it("returns 404 for an unknown job", async () => {
    const res = await appWith(new InMemoryJobStore()).request("/v1/jobs/nope", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(404);
  });

  it("retrieves an owner=default job from a verified tenant_id-only token", async () => {
    const store = new InMemoryJobStore();
    createJob(store, "tenant-job", "default");

    const res = await appWith(store, {
      claims: { tenant_id: "default" },
    }).request("/v1/jobs/tenant-job", {
      headers: { Authorization: "Bearer tenant-token" },
    });

    expect(res.status).toBe(200);
  });

  it("gives tenant_id priority over client_id and tid", async () => {
    const store = new InMemoryJobStore();
    createJob(store, "priority-job", "tenant-owner");

    const res = await appWith(store, {
      claims: {
        tenant_id: "tenant-owner",
        client_id: "client-owner",
        tid: "tid-owner",
      },
    }).request("/v1/jobs/priority-job", {
      headers: { Authorization: "Bearer priority-token" },
    });

    expect(res.status).toBe(200);
  });

  it("falls back to client_id when tenant_id is absent", async () => {
    const store = new InMemoryJobStore();
    createJob(store, "client-job", "client-owner");

    const res = await appWith(store, {
      claims: { client_id: "client-owner", tid: "tid-owner" },
    }).request("/v1/jobs/client-job", {
      headers: { Authorization: "Bearer client-token" },
    });

    expect(res.status).toBe(200);
  });

  it("falls back to tid when tenant_id and client_id are absent", async () => {
    const store = new InMemoryJobStore();
    createJob(store, "tid-job", "tid-owner");

    const res = await appWith(store, {
      claims: { tid: "tid-owner" },
    }).request("/v1/jobs/tid-job", {
      headers: { Authorization: "Bearer tid-token" },
    });

    expect(res.status).toBe(200);
  });

  it("keeps the raw-token fallback when no tenant claim is available", async () => {
    const store = new InMemoryJobStore();
    createJob(store, "legacy-job", "legacy-token");

    const res = await appWith(store, { claims: { sub: "user-1" } }).request(
      "/v1/jobs/legacy-job",
      { headers: { Authorization: "Bearer legacy-token" } },
    );

    expect(res.status).toBe(200);
  });

  it("masks a different tenant exactly like an unknown job", async () => {
    const store = new InMemoryJobStore();
    createJob(store, "private-job", "tenant-a");
    const app = appWith(store, { claims: { tenant_id: "tenant-b" } });
    const emptyApp = appWith(new InMemoryJobStore(), {
      claims: { tenant_id: "tenant-b" },
    });

    const hidden = await app.request("/v1/jobs/private-job", {
      headers: { Authorization: "Bearer tenant-b-token" },
    });
    const unknown = await emptyApp.request("/v1/jobs/private-job", {
      headers: { Authorization: "Bearer tenant-b-token" },
    });

    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await hidden.json()).toEqual(await unknown.json());
  });
});
