// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the compliance / data-retention admin routes.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createComplianceRouter } from "../compliance.js";
import {
  RetentionService,
  type RetentionTarget,
  type ErasureSubject,
} from "../../observability/retention.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import { createErasureOrchestrator } from "../../compliance/erasure-orchestrator.js";
import {
  hmacReceiptKey,
  verifyReceipt,
  type ErasureReceiptEnvelope,
} from "../../compliance/erasure-receipt.js";
import { TOKEN_KEY, type AuthContext } from "../../middleware/auth.js";
import type { JwtVerifier } from "../../middleware/jwt-verifier.js";
import { auditPseudonym } from "../../compliance/audit-pseudonym.js";
import { erasureSubjectHash } from "@atf/erasure-contract";

const adminAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "admin-tok", role: "admin", name: "alice" },
    { token: "viewer-tok", role: "viewer" },
  ],
});

class FakeTarget implements RetentionTarget {
  cutoffs: string[] = [];
  subjects: ErasureSubject[] = [];
  constructor(
    public readonly name: string,
    private readonly counts = { age: 2, erase: 3 },
  ) {}
  purgeOlderThan = async (c: string): Promise<number> => {
    this.cutoffs.push(c);
    return this.counts.age;
  };
  eraseSubject = async (s: ErasureSubject): Promise<number> => {
    this.subjects.push(s);
    return this.counts.erase;
  };
}

function buildApp() {
  const target = new FakeTarget("snapshots");
  const auditLog = new InMemoryAuditLog();
  const retention = new RetentionService([target], {
    maxAgeDaysByTarget: { snapshots: 30 },
  });
  const app = new Hono();
  app.route(
    "/",
    createComplianceRouter({ retention, operatorAuth: adminAuth, auditLog }),
  );
  return { app, target, auditLog };
}

const authed = (body?: unknown, token = "admin-tok") => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

/** Minimal verifier: decodes a fake "header.<b64payload>.sig" token. */
function fakeVerifier(claims: Record<string, unknown>): JwtVerifier {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return {
    enabled: true,
    verify: async () => true,
    decodePayload: (token: string) =>
      token === "dsar-token"
        ? claims
        : token.endsWith(`.${payload}.sig`)
          ? claims
          : null,
  };
}

const ISSUER = "https://idp.example.test/";
/** The default DSAR caller: verified email, tenant claim. */
const CALLER = {
  iss: ISSUER,
  sub: "u-1",
  email: "u@x.de",
  email_verified: true,
  tenant_id: "acme",
};

/** Mount the compliance router with a DSAR caller identity in context. */
function buildDsarApp(opts: {
  targets?: RetentionTarget[];
  orchestrator?: ReturnType<typeof createErasureOrchestrator>;
  claims?: Record<string, unknown>;
}) {
  const retention = new RetentionService(opts.targets ?? []);
  const auditLog = new InMemoryAuditLog();
  const app = new Hono<AuthContext>();
  app.use("*", async (ctx, next) => {
    ctx.set(TOKEN_KEY, "dsar-token");
    await next();
  });
  app.route(
    "/",
    createComplianceRouter({
      retention,
      operatorAuth: adminAuth,
      auditLog,
      jwtVerifier: fakeVerifier(opts.claims ?? CALLER),
      ...(opts.orchestrator !== undefined ? { erasureOrchestrator: opts.orchestrator } : {}),
    }),
  );
  return { app, auditLog };
}

describe("DELETE /v1/me/data — honest per-store DSAR response (Req 2.10)", () => {
  const deleteReq = { method: "DELETE", headers: { Authorization: "Bearer dsar-token" } };

  it("local-only: 200 with per-store results when nothing fails", async () => {
    const { app } = buildDsarApp({
      targets: [new FakeTarget("snapshots"), new FakeTarget("replays")],
    });
    const res = await app.request("/v1/me/data", deleteReq);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      message: string;
      results: { store: string; status: string; erased: number }[];
      erased: number;
    };
    expect(body.status).toBe("complete");
    expect(body.message).toContain("erased across all applicable stores");
    expect(body.results).toEqual([
      { store: "snapshots", status: "ok", erased: 3 },
      { store: "replays", status: "ok", erased: 3 },
    ]);
    expect(body.erased).toBe(6);
  });

  it("local-only: 207 ERASURE_PARTIAL when one store fails", async () => {
    const failing: RetentionTarget = {
      name: "broken",
      eraseSubject: async () => {
        throw new Error("db down");
      },
    };
    const { app, auditLog } = buildDsarApp({
      targets: [new FakeTarget("snapshots"), failing],
    });
    const res = await app.request("/v1/me/data", deleteReq);
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      status: string;
      message: string;
      error?: { code: string };
      results: { store: string; status: string; error?: string }[];
    };
    expect(body.status).toBe("partial");
    expect(body.error?.code).toBe("ERASURE_PARTIAL");
    expect(body.message).not.toContain("erased across all applicable stores");
    const broken = body.results.find((r) => r.store === "broken");
    expect(broken?.status).toBe("failed");
    expect(broken?.error).toBe("db down");
    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({ action: "dsar.self_erasure", outcome: "error" });
  });

  it("local-only: 502 when every store fails", async () => {
    const failing = (name: string): RetentionTarget => ({
      name,
      eraseSubject: async () => {
        throw new Error("boom");
      },
    });
    const { app } = buildDsarApp({ targets: [failing("a"), failing("b")] });
    const res = await app.request("/v1/me/data", deleteReq);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("failed");
  });

  it("orchestrated: remote stores appear namespaced and drive the status", async () => {
    const retention = new RetentionService([new FakeTarget("snapshots")]);
    const orch = createErasureOrchestrator({
      retention,
      targets: [{ service: "search", url: "http://search.test/v1/erasure", tokenEnv: "T" }],
      envLookup: () => "tok",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            requestId: "x",
            service: "search",
            results: [{ store: "chunks", status: "ok", erased: 7 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    const { app } = buildDsarApp({ targets: [], orchestrator: orch });
    const res = await app.request("/v1/me/data", deleteReq);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      requestId: string;
      results: { store: string; status: string; erased: number }[];
      erased: number;
    };
    expect(body.status).toBe("complete");
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.results).toEqual([
      { store: "snapshots", status: "ok", erased: 3 },
      { store: "search.chunks", status: "ok", erased: 7 },
    ]);
    expect(body.erased).toBe(10);
  });

  it("orchestrated: remote failure yields 207 with the failure cause", async () => {
    const retention = new RetentionService([new FakeTarget("snapshots")]);
    const orch = createErasureOrchestrator({
      retention,
      targets: [{ service: "search", url: "http://search.test/v1/erasure", tokenEnv: "T" }],
      envLookup: () => "tok",
      attempts: 1,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    const { app } = buildDsarApp({ targets: [], orchestrator: orch });
    const res = await app.request("/v1/me/data", deleteReq);
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      status: string;
      error?: { code: string };
      results: { store: string; status: string; error?: string }[];
    };
    expect(body.status).toBe("partial");
    expect(body.error?.code).toBe("ERASURE_PARTIAL");
    const remote = body.results.find((r) => r.store === "search.endpoint");
    expect(remote?.status).toBe("failed");
    expect(remote?.error).toContain("503");
  });

  it("401 when the token carries no identity claim", async () => {
    const { app } = buildDsarApp({ targets: [], claims: {} });
    const res = await app.request("/v1/me/data", deleteReq);
    expect(res.status).toBe(401);
  });

  it("401 without iss or sub — an email alone never identifies the caller", async () => {
    for (const claims of [
      { sub: "u-1", email: "u@x.de", email_verified: true, tenant_id: "acme" },
      { iss: ISSUER, email: "u@x.de", email_verified: true, tenant_id: "acme" },
    ]) {
      const target = new FakeTarget("snapshots");
      const { app } = buildDsarApp({ targets: [target], claims });
      const res = await app.request("/v1/me/data", deleteReq);
      expect(res.status).toBe(401);
      expect(target.subjects).toEqual([]);
    }
  });

  it("ignores an unverified email: only sub identifies the caller", async () => {
    for (const email_verified of [undefined, false, "true"]) {
      const target = new FakeTarget("snapshots");
      const { app } = buildDsarApp({
        targets: [target],
        claims: { ...CALLER, email: "victim@x.de", email_verified },
      });
      const res = await app.request("/v1/me/data", deleteReq);
      expect(res.status).toBe(200);
      expect(target.subjects).toEqual([
        { userId: "u-1", tenantId: "acme", issuer: ISSUER },
      ]);
    }
  });

  it("uses a verified email as an additional identifier", async () => {
    const target = new FakeTarget("snapshots");
    const { app } = buildDsarApp({ targets: [target] });
    await app.request("/v1/me/data", deleteReq);
    expect(target.subjects).toEqual([
      {
        userId: "u-1",
        userAliases: ["u@x.de"],
        tenantId: "acme",
        issuer: ISSUER,
      },
    ]);
  });

  it("hands the caller's issuer to the stores so a colliding sub of another issuer is not erased", async () => {
    const OTHER = "https://other-idp.example/";
    const mine = new FakeTarget("snapshots");
    const theirs = new FakeTarget("snapshots");
    await buildDsarApp({ targets: [mine] }).app.request("/v1/me/data", deleteReq);
    await buildDsarApp({
      targets: [theirs],
      claims: { ...CALLER, iss: OTHER },
    }).app.request("/v1/me/data", deleteReq);
    expect(mine.subjects[0]?.issuer).toBe(ISSUER);
    expect(theirs.subjects[0]).toMatchObject({ userId: "u-1", issuer: OTHER });
  });

  it("passes the issuer through the orchestrator to the local stores", async () => {
    const target = new FakeTarget("snapshots");
    const orch = createErasureOrchestrator({
      retention: new RetentionService([target]),
    });
    const { app } = buildDsarApp({ targets: [], orchestrator: orch });
    await app.request("/v1/me/data", deleteReq);
    expect(target.subjects[0]).toMatchObject({ userId: "u-1", issuer: ISSUER });
  });

  it("403 TENANT_REQUIRED without a tenant claim — never erases across tenants", async () => {
    const target = new FakeTarget("snapshots");
    const { tenant_id: _omit, ...noTenant } = CALLER;
    void _omit;
    const { app, auditLog } = buildDsarApp({ targets: [target], claims: noTenant });
    const res = await app.request("/v1/me/data", deleteReq);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TENANT_REQUIRED");
    expect(target.subjects).toEqual([]);
    expect(await auditLog.list()).toEqual([]);
  });

  it("pseudonymises the caller instead of recording the issuer", async () => {
    const { app, auditLog } = buildDsarApp({ targets: [new FakeTarget("snapshots")] });
    await app.request("/v1/me/data", deleteReq);
    const [entry] = await auditLog.list();
    const pseudonym = auditPseudonym(`${ISSUER}|u-1`);
    expect(entry?.actor).toBe(pseudonym);
    expect(entry?.target).toBe(pseudonym);
    expect(entry?.details).not.toHaveProperty("issuer");
    expect(entry?.details).not.toHaveProperty("subject");
  });
});

describe("GET /v1/me/data/erasures/{id} — signed Erasure_Receipt (Req 2.11)", () => {
  const deleteReq = { method: "DELETE", headers: { Authorization: "Bearer dsar-token" } };
  const derivedKey = hmacReceiptKey("anchor-secret-0123456789");
  if (!derivedKey) throw new Error("receipt key must be derivable from the anchor secret");
  const receiptKey = derivedKey;

  /** Run a DSAR through the orchestrator and return the app plus receipt id. */
  async function dsarWithReceipt(claims?: Record<string, unknown>) {
    const orch = createErasureOrchestrator({
      retention: new RetentionService([new FakeTarget("snapshots")]),
      targets: [],
      receiptKey,
    });
    const built = buildDsarApp({ targets: [], orchestrator: orch, claims });
    const del = await built.app.request("/v1/me/data", deleteReq);
    expect(del.status).toBe(200);
    const { requestId } = (await del.json()) as { requestId: string };
    const operation = await orch.get(requestId);
    if (!operation) throw new Error("operation must exist after deletion");
    const receiptId = (operation.receipt as ErasureReceiptEnvelope).payload
      .receiptId;
    return { ...built, orch, receiptId };
  }

  it("returns the signed receipt to the data subject who requested it", async () => {
    const { app, receiptId } = await dsarWithReceipt();
    const res = await app.request(`/v1/me/data/erasures/${receiptId}`, {
      headers: { Authorization: "Bearer dsar-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipt: ErasureReceiptEnvelope };
    expect(body.receipt.payload.receiptId).toBe(receiptId);
    expect(body.receipt.payload.tenantId).toBe("acme");
    // Email and JWT `sub` both identify the caller, so both are hashed.
    expect(body.receipt.payload.subjectHashes).toHaveLength(2);
    expect(JSON.stringify(body.receipt.payload)).not.toContain("u@x.de");
    expect(JSON.stringify(body.receipt.payload)).not.toContain("u-1");
    expect(verifyReceipt(body.receipt, receiptKey)).toBe(true);
  });

  it("unknown receipt id → 404", async () => {
    const { app } = await dsarWithReceipt();
    const res = await app.request(
      "/v1/me/data/erasures/00000000-0000-4000-8000-000000000000",
      { headers: { Authorization: "Bearer dsar-token" } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERASURE_RECEIPT_NOT_FOUND");
  });

  it("another tenant's caller → 404, never the receipt", async () => {
    const { orch, receiptId } = await dsarWithReceipt();
    const other = buildDsarApp({
      targets: [],
      orchestrator: orch,
      claims: { ...CALLER, tenant_id: "evil" },
    });
    const res = await other.app.request(`/v1/me/data/erasures/${receiptId}`, {
      headers: { Authorization: "Bearer dsar-token" },
    });
    expect(res.status).toBe(404);
  });

  it("another subject in the same tenant → 404", async () => {
    const { orch, receiptId } = await dsarWithReceipt();
    const other = buildDsarApp({
      targets: [],
      orchestrator: orch,
      claims: { ...CALLER, sub: "u-2", email: "other@x.de" },
    });
    const res = await other.app.request(`/v1/me/data/erasures/${receiptId}`, {
      headers: { Authorization: "Bearer dsar-token" },
    });
    expect(res.status).toBe(404);
  });

  it("no orchestrator configured → 400 ERASURE_NOT_CONFIGURED", async () => {
    const { app } = buildDsarApp({ targets: [new FakeTarget("snapshots")] });
    const res = await app.request(
      "/v1/me/data/erasures/00000000-0000-4000-8000-000000000000",
      { headers: { Authorization: "Bearer dsar-token" } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERASURE_NOT_CONFIGURED");
  });

  it("without a signing key no receipt is stored → 404", async () => {
    const orch = createErasureOrchestrator({
      retention: new RetentionService([new FakeTarget("snapshots")]),
      targets: [],
    });
    const { app } = buildDsarApp({ targets: [], orchestrator: orch });
    const del = await app.request("/v1/me/data", deleteReq);
    const { requestId } = (await del.json()) as { requestId: string };
    const operation = await orch.get(requestId);
    expect(operation?.receipt).toBeUndefined();
    const res = await app.request(
      `/v1/me/data/erasures/${"00000000-0000-4000-8000-000000000000"}`,
      { headers: { Authorization: "Bearer dsar-token" } },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/compliance/forget — honest status codes (Req 2.10)", () => {
  it("207 with per-store results when a local store fails", async () => {
    const failing: RetentionTarget = {
      name: "broken",
      eraseSubject: async () => {
        throw new Error("disk full");
      },
    };
    const retention = new RetentionService([new FakeTarget("snapshots"), failing]);
    const auditLog = new InMemoryAuditLog();
    const app = new Hono();
    app.route(
      "/",
      createComplianceRouter({ retention, operatorAuth: adminAuth, auditLog }),
    );
    const res = await app.request(
      "/admin/compliance/forget",
      authed({ tenantId: "acme", userId: "u@x.de" }),
    );
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      status: string;
      error?: { code: string };
      results: { store: string; status: string; erased: number; error?: string }[];
    };
    expect(body.status).toBe("partial");
    expect(body.error?.code).toBe("ERASURE_PARTIAL");
    expect(body.results).toEqual([
      { store: "snapshots", status: "ok", erased: 3 },
      { store: "broken", status: "failed", erased: 0, error: "disk full" },
    ]);
    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({ action: "compliance.forget", outcome: "error" });
  });

  it("orchestrated: tenant-only subject uses scope=tenant and reports remote stores", async () => {
    const retention = new RetentionService([]);
    let seenScope = "";
    const orch = createErasureOrchestrator({
      retention,
      targets: [{ service: "gate", url: "http://gate.test/v1/erasure", tokenEnv: "T" }],
      envLookup: () => "tok",
      fetchImpl: (async (_url: unknown, init: unknown) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { scope: string };
        seenScope = body.scope;
        return new Response(
          JSON.stringify({
            requestId: "x",
            service: "gate",
            results: [{ store: "audit", status: "ok", erased: 2 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const app = new Hono();
    app.route(
      "/",
      createComplianceRouter({ retention, operatorAuth: adminAuth, erasureOrchestrator: orch }),
    );
    const res = await app.request("/admin/compliance/forget", authed({ tenantId: "acme" }));
    expect(res.status).toBe(200);
    expect(seenScope).toBe("tenant");
    const body = (await res.json()) as {
      status: string;
      requestId: string;
      results: { store: string }[];
    };
    expect(body.status).toBe("complete");
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.results[0]?.store).toBe("gate.audit");
  });
});

describe("GET /admin/compliance/status", () => {
  it("returns target capabilities for an admin", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/status", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: Array<{ name: string; maxAgeDays: number | null }>;
    };
    expect(body.targets[0]).toMatchObject({
      name: "snapshots",
      agePurge: true,
      maxAgeDays: 30,
    });
  });

  it("rejects a non-admin (viewer) with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/status", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/compliance/sweep", () => {
  it("runs a sweep and records an audit entry", async () => {
    const { app, target, auditLog } = buildApp();
    const res = await app.request("/admin/compliance/sweep", authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);
    expect(target.cutoffs).toHaveLength(1);
    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({
      action: "compliance.sweep",
      actor: "alice",
    });
  });
});

describe("POST /admin/compliance/forget", () => {
  it("erases a subject and records an audit entry", async () => {
    const { app, target, auditLog } = buildApp();
    const res = await app.request(
      "/admin/compliance/forget",
      authed({ tenantId: "acme", userId: "u@x.de" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      erased: number;
      subject: ErasureSubject;
    };
    expect(body.erased).toBe(3);
    expect(body.subject).toEqual({ tenantId: "acme", userId: "u@x.de" });
    expect(target.subjects[0]).toEqual({ tenantId: "acme", userId: "u@x.de" });
    const audit = await auditLog.list();
    const entry = audit[0];
    if (!entry) throw new Error("expected an audit entry");
    expect(entry).toMatchObject({
      action: "compliance.forget",
      // The subject is erased, so the append-only log carries only a
      // pseudonym and the subject hashes — never the identifiers.
      target: auditPseudonym("acme|u@x.de"),
    });
    expect(entry.details).not.toHaveProperty("subject");
    const details = entry.details as { subjectHashes: string[] };
    expect(details.subjectHashes.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects an empty subject with 400", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/forget", authed({}));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/forget", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-tok",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "acme" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/compliance/dossier", () => {
  it("returns a JSON dossier for an admin and records an audit entry", async () => {
    const { app, auditLog } = buildApp();
    const res = await app.request("/admin/compliance/dossier", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auditIntegrity: { chainVerification: { valid: boolean } };
      retentionPosture: { targets: unknown[] };
      architecturalGuarantees: unknown[];
    };
    expect(body.auditIntegrity.chainVerification.valid).toBe(true);
    expect(body.retentionPosture.targets).toHaveLength(1);
    expect(body.architecturalGuarantees.length).toBeGreaterThan(0);

    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({ action: "compliance.dossier.generate" });
  });

  it("returns a markdown dossier when format=markdown", async () => {
    const { app } = buildApp();
    const res = await app.request(
      "/admin/compliance/dossier?format=markdown",
      { headers: { Authorization: "Bearer admin-tok" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("# Compliance Dossier");
  });

  it("rejects a non-admin (viewer) with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/dossier", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(401);
  });
});

describe("erasure audit entries carry no clear-text subject (regression)", () => {
  const EMAIL = "jane.doe@example.com";
  const USER_ID = "jane-doe-42";
  const DSAR_ISSUER = "https://idp.example.test/";

  it("POST /admin/compliance/forget logs only subject hashes and a pseudonym", async () => {
    const { app, auditLog } = buildApp();
    const res = await app.request(
      "/admin/compliance/forget",
      authed({ tenantId: "acme", userId: USER_ID }),
    );
    expect(res.status).toBe(200);
    const rows = await auditLog.list();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      const json = JSON.stringify(row);
      expect(json).not.toContain(EMAIL);
      expect(json).not.toContain(USER_ID);
    }
    const forget = rows.find((r) => r.action === "compliance.forget");
    const details = forget?.details as { subjectHashes: string[] };
    expect(details.subjectHashes.length).toBeGreaterThanOrEqual(1);
    expect(details.subjectHashes).toContain(erasureSubjectHash("acme", USER_ID));
    expect(forget?.target).toBe(auditPseudonym(`acme|${USER_ID}`));
  });

  it("DELETE /v1/me/data logs only subject hashes and a pseudonym", async () => {
    const { app, auditLog } = buildDsarApp({
      targets: [new FakeTarget("snapshots")],
      claims: {
        iss: DSAR_ISSUER,
        sub: USER_ID,
        email: EMAIL,
        email_verified: true,
        tenant_id: "acme",
      },
    });
    const res = await app.request("/v1/me/data", {
      method: "DELETE",
      headers: { Authorization: "Bearer dsar-token" },
    });
    expect(res.status).toBe(200);
    const rows = await auditLog.list();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      const json = JSON.stringify(row);
      expect(json).not.toContain(EMAIL);
      expect(json).not.toContain(USER_ID);
      expect(json).not.toContain(DSAR_ISSUER);
    }
    const dsar = rows.find((r) => r.action === "dsar.self_erasure");
    const details = dsar?.details as { subjectHashes: string[] };
    expect(details.subjectHashes.length).toBeGreaterThanOrEqual(1);
    expect(details.subjectHashes).toContain(erasureSubjectHash("acme", USER_ID));
  });
});
