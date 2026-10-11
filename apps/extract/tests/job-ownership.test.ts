// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-ownership.test.ts
 *
 * E3 — job status for the originator (extract-outpost, requirements 8.7,
 * 8.13, 8.14). `GET /v2/jobs/{id}` used to require `extract.admin`, which
 * also hands out the list of *every* caller's jobs — far too much for an
 * Outpost that only wants to poll the jobs it created. The owner columns
 * (`created_by_subject`/`created_by_tenant`) plus the pure `canReadJob` rule
 * replace that: the originator reads their own job with `extract.ingest`, a
 * foreign job answers with the byte-identical 404 of an unknown id, and the
 * list stays operator-only.
 */

import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import request from "supertest";
import { createApp, type AppOverrides } from "../src/index.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { canReadJob } from "../src/authorize.js";
import {
  loadTestConfig,
  stubExtractor,
  stubSearchClient,
  stubVisionClient,
  testLogger,
} from "./helpers.js";

const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

const cleanups: Array<() => void | Promise<void>> = [];

/**
 * Mount `app` on one stable loopback URL for the duration of a test — supertest
 * per-request ephemeral servers churn ports and let foreign local processes
 * answer (see documents.test.ts for the full explanation).
 */
async function serve(
  app: ReturnType<typeof createApp>["app"],
): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function buildApp(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
): Promise<string> {
  const config = loadTestConfig(configOverrides);
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    ...overrides,
  });
  cleanups.push(created.cleanup);
  return serve(created.app);
}

// ── Property 39: read access to jobs (E3), the pure rule ──────────────────

// Feature: extract-outpost, Property 39: read access to jobs (E3)
// **Validates: Requirements 8.7, 8.13, 8.14**
describe("Property 39: canReadJob", () => {
  const subjectArb = fc.constantFrom(undefined, "anna", "bob");
  const tenantArb = fc.constantFrom(undefined, "tenant-a", "tenant-b");
  const scopesArb = fc
    .subarray(["extract.convert", "extract.ingest", "extract.delete", "extract.admin"])
    .map((list) => new Set(list));

  it("matches the decision table exactly", () => {
    fc.assert(
      fc.property(
        subjectArb,
        tenantArb,
        subjectArb,
        tenantArb,
        scopesArb,
        (ownerSubject, ownerTenant, callerSubject, callerTenant, scopes) => {
          const job = {
            createdBySubject: ownerSubject ?? null,
            createdByTenant: ownerTenant ?? null,
          };
          const caller = {
            ...(callerSubject !== undefined ? { subject: callerSubject } : {}),
            ...(callerTenant !== undefined ? { tenantId: callerTenant } : {}),
            scopes,
          };
          const decision = canReadJob(job, caller);

          if (scopes.has("extract.admin")) {
            expect(decision).toBe("allow");
            return;
          }
          if (!scopes.has("extract.ingest")) {
            expect(decision).toBe("forbidden");
            return;
          }
          const sameSubject =
            ownerSubject !== undefined &&
            callerSubject !== undefined &&
            ownerSubject === callerSubject;
          const sameTenant = (ownerTenant ?? undefined) === (callerTenant ?? undefined);
          expect(decision).toBe(sameSubject && sameTenant ? "allow" : "not-found");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never reveals a foreign job as anything but not-found", () => {
    const strangerSubject = fc.constantFrom(undefined, "anna", "bob", "owner");
    const strangerTenant = fc.constantFrom(undefined, "tenant-a", "tenant-x");
    fc.assert(
      fc.property(scopesArb, strangerSubject, strangerTenant, (scopes, callerSubject, callerTenant) => {
        fc.pre(!scopes.has("extract.admin"));
        const foreign = { createdBySubject: "owner", createdByTenant: "tenant-x" };
        const caller = {
          ...(callerSubject !== undefined ? { subject: callerSubject } : {}),
          ...(callerTenant !== undefined ? { tenantId: callerTenant } : {}),
          scopes,
        };
        const decision = canReadJob(foreign, caller);
        // The owner is a fixed stranger; unless the caller happens to be them
        // (same subject *and* tenant), an ingest caller must get not-found —
        // never allow, never forbidden.
        if (scopes.has("extract.ingest") && !(callerSubject === "owner" && callerTenant === "tenant-x")) {
          expect(decision).toBe("not-found");
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ── Router: status mapping and owner plumbing (tasks 4.3–4.5) ──────────────

describe("GET /v2/jobs/{id} · owner-scoped read", () => {
  const token = "f".repeat(40);
  // A service token that asserts an end user via X-User — the way the Outpost
  // and the runtime call Extract. Scopes come from API_SERVICE_SCOPES.
  const envFor = (scopes: string) => ({
    AUTHN_MODE: "token",
    AUTHZ_ENABLED: "true",
    TENANT_ISOLATION_ENABLED: "false",
    API_TOKEN: token,
    API_SERVICE_SCOPES: scopes,
  });

  /** Seed a job directly in the fake store with an explicit owner. */
  async function seedJob(
    store: FakeJobStore,
    n: number,
    owner: { subject: string | null; tenant: string | null },
  ): Promise<string> {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await store.createJob({
      id,
      reference: `docs/job-${n}.pdf`,
      source_sha256: "0".repeat(64),
      created_by_subject: owner.subject,
      created_by_tenant: owner.tenant,
    });
    return id;
  }

  it("lets the originator read their own job with extract.ingest", async () => {
    const store = createFakeJobStore();
    const id = await seedJob(store, 1, { subject: "anna", tenant: "default" });
    const baseUrl = await buildApp(envFor("extract.ingest"), { store });
    const res = await request(baseUrl)
      .get(`/v2/jobs/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "anna");
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(id);
  });

  it("answers a foreign job with the 404 of an unknown id", async () => {
    const store = createFakeJobStore();
    const id = await seedJob(store, 2, { subject: "bob", tenant: "default" });
    const baseUrl = await buildApp(envFor("extract.ingest"), { store });

    const foreign = await request(baseUrl)
      .get(`/v2/jobs/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "mallory");
    expect(foreign.status).toBe(404);

    // Indistinguishable from a job id that was never created: same status,
    // same code, same message template. (The message echoes the *requested*
    // id, which the caller already has; nothing in the response reveals that
    // the row exists — requirement 8.14.)
    const missing = await request(baseUrl)
      .get("/v2/jobs/00000000-0000-4000-8000-999999999999")
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "mallory");
    expect(missing.status).toBe(404);
    expect(foreign.body.code).toBe(missing.body.code);
    expect(foreign.body.retryable).toBe(missing.body.retryable);
    expect(foreign.body.error).toMatch(/^Job [0-9a-f-]{36} does not exist$/);
    expect(missing.body.error).toMatch(/^Job [0-9a-f-]{36} does not exist$/);
    // No header distinguishes the two (both are plain JSON error responses).
    expect(foreign.headers["content-type"]).toBe(missing.headers["content-type"]);
  });

  it("treats a different tenant as foreign even with the same subject", async () => {
    const store = createFakeJobStore();
    const id = await seedJob(store, 3, { subject: "anna", tenant: "tenant-a" });
    const baseUrl = await buildApp(envFor("extract.ingest"), { store });
    // Same asserted user, but the job row carries another tenant.
    const res = await request(baseUrl)
      .get(`/v2/jobs/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "anna");
    // The caller's tenant is the service principal's (unset → "default"),
    // which differs from "tenant-a" → not-found.
    expect(res.status).toBe(404);
  });

  it("keeps owner-less legacy jobs operator-only", async () => {
    const store = createFakeJobStore();
    const id = await seedJob(store, 4, { subject: null, tenant: null });
    const ingestApp = await buildApp(envFor("extract.ingest"), { store });
    const asIngest = await request(ingestApp)
      .get(`/v2/jobs/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "anna");
    expect(asIngest.status).toBe(404);

    const adminApp = await buildApp(envFor("extract.admin"), { store });
    const asAdmin = await request(adminApp)
      .get(`/v2/jobs/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(asAdmin.status).toBe(200);
  });

  it("answers 403 for a caller with neither admin nor ingest", async () => {
    const store = createFakeJobStore();
    const id = await seedJob(store, 5, { subject: "anna", tenant: "default" });
    const baseUrl = await buildApp(envFor("extract.convert"), { store });
    const res = await request(baseUrl)
      .get(`/v2/jobs/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "anna");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("keeps the job list behind extract.admin", async () => {
    const store = createFakeJobStore();
    await seedJob(store, 6, { subject: "anna", tenant: "default" });
    const baseUrl = await buildApp(envFor("extract.ingest"), { store });
    const res = await request(baseUrl)
      .get("/v2/jobs")
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "anna");
    expect(res.status).toBe(403);
  });

  it("records the owner on POST /v2/jobs from the asserted principal", async () => {
    // The create path needs a stored source; reuse the fake store's leniency
    // by seeding through the HTTP route with a real source store is heavier
    // than needed here — instead assert via the fake store that the handler
    // passes the principal through, using a minimal app with a temp source.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Readable } = await import("node:stream");
    const { createFilesystemSourceStore } = await import("../src/source-store.js");
    const dir = await mkdtemp(join(tmpdir(), "atf-owner-store-"));
    const src = createFilesystemSourceStore(dir);
    const stored = await src.putStream(Readable.from([Buffer.from("%PDF-1.7\nbytes\n")]));
    try {
      const store = createFakeJobStore();
      const baseUrl = await buildApp(envFor("extract.ingest"), {
        store,
        sourceStore: src,
        searchClient: stubSearchClient(),
      });
      const res = await request(baseUrl)
        .post("/v2/jobs")
        .set("Authorization", `Bearer ${token}`)
        .set("X-User", "carla")
        .send({ reference: "docs/carla.pdf", sourceSha256: stored.sha256 });
      expect(res.status).toBe(201);
      expect(store.peek(res.body.jobId)?.created_by_subject).toBe("carla");
      expect(store.peek(res.body.jobId)?.created_by_tenant).toBe("default");

      // And carla can immediately read her own job back with ingest only.
      const read = await request(baseUrl)
        .get(`/v2/jobs/${res.body.jobId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-User", "carla");
      expect(read.status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes an unscoped service credential (documented default)", async () => {
    // API_SERVICE_SCOPES unset → scopes [] → the documented pass-through of
    // createRequireScope; E3 must not turn that default into a 403.
    const store = createFakeJobStore();
    const id = await seedJob(store, 7, { subject: null, tenant: null });
    const baseUrl = await buildApp(
      { AUTHN_MODE: "token", AUTHZ_ENABLED: "true", API_TOKEN: token },
      { store },
    );
    const res = await request(baseUrl)
      .get(`/v2/jobs/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("skips the owner check entirely when authz is disabled", async () => {
    const store = createFakeJobStore();
    const id = await seedJob(store, 8, { subject: "bob", tenant: "default" });
    const baseUrl = await buildApp(
      { AUTHN_MODE: "disabled", AUTHZ_ENABLED: "false" },
      { store },
    );
    const res = await request(baseUrl).get(`/v2/jobs/${id}`);
    expect(res.status).toBe(200);
  });
});
