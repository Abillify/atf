// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for GET /monitoring/citation-impact (`src/routes/citation-impact.ts`).
 *
 * Pins the auth contract (monitoring:read, admin-only all-tenant reports),
 * the 503 without CITATION_CHECK_URL / without a citation index source, the
 * request forwarding to the Search citation check (Bearer token, blocks of
 * at most 500 pairs), upstream failures as 502, and the optional evidence
 * signature.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  createCitationImpactRouter,
  type CitationImpactSource,
} from "../citation-impact.js";
import type { CitationPairGroup } from "../../compliance/citation-impact.js";
import {
  citationImpactSigningBytes,
} from "../../compliance/citation-impact.js";
import {
  createOperatorAuthorizer,
  type AuthorizeResult,
  type OperatorAuthorizer,
} from "../../middleware/operator-rbac.js";
import {
  evidencePublicKeyFromRaw,
  parseEvidenceSigningKey,
  verifyEvidenceBytes,
} from "../../observability/evidence-key.js";
import type { AppConfig } from "../../config/schema.js";

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    flowsDir: "./flows",
    monitoringTransport: "sse",
    mcpServers: [],
    corsOrigins: [],
    appEnv: "production",
    ...over,
  } as AppConfig;
}

function group(
  baseRef: string,
  chunkId: string,
  executionIds: string[],
): CitationPairGroup {
  return {
    baseRef,
    chunkId,
    executions: executionIds.map((id) => ({
      executionId: id,
      flowId: "flows/test",
      flowVersion: "1.0.0",
      createdAt: "2026-10-01T10:00:00.000Z",
    })),
  };
}

function fakeSource(
  groups: CitationPairGroup[],
  calls: Array<Record<string, unknown>> = [],
): CitationImpactSource {
  return {
    async citedPairs(options) {
      calls.push({ ...options });
      return groups;
    },
  };
}

function checkFetch(
  results: Array<{
    base_ref: string;
    chunk_id: string;
    status: string;
    current_revision?: string;
  }>,
  requests: Array<{ url: string; auth?: string; items: unknown }> = [],
): { fetchFn: typeof fetch; requests: typeof requests } {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      items?: unknown;
    };
    const auth = (init?.headers as Record<string, string> | undefined)?.[
      "Authorization"
    ];
    requests.push({
      url: String(url),
      ...(typeof auth === "string" ? { auth } : {}),
      items: body.items,
    });
    return new Response(
      JSON.stringify({
        checked_at: "2026-10-20T12:00:00Z",
        results: results.map((r) => ({ ...r })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

function fixedAuthorizer(result: AuthorizeResult): OperatorAuthorizer {
  return {
    rbacEnabled: true,
    async authorize() {
      return result;
    },
  };
}

const viewerAuth = fixedAuthorizer({
  ok: true,
  actor: { name: "v", role: "viewer", via: "token" },
});

function buildApp(deps: Parameters<typeof createCitationImpactRouter>[0]): Hono {
  const app = new Hono();
  app.route("/", createCitationImpactRouter(deps));
  return app;
}

const OK_URL = config({
  citationCheckUrl: "http://search.test:8080",
  citationCheckToken: "search-tok",
});

describe("GET /monitoring/citation-impact", () => {
  it("returns 401 without credentials when monitoring auth is required", async () => {
    const app = buildApp({
      config: OK_URL,
      authRequired: true,
      operatorAuth: createOperatorAuthorizer({
        authRequired: true,
        tokens: [{ token: "op-tok", role: "admin" }],
      }),
      source: fakeSource([]),
      fetchFn: checkFetch([]).fetchFn,
    });
    const res = await app.request("/monitoring/citation-impact?since=2026-07-01T00:00:00Z");
    expect(res.status).toBe(401);
  });

  it("returns 503 when the citation check URL is not configured", async () => {
    const app = buildApp({
      config: config(),
      source: fakeSource([]),
      fetchFn: checkFetch([]).fetchFn,
    });
    const res = await app.request("/monitoring/citation-impact?since=2026-07-01T00:00:00Z");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      "citation check is not configured (CITATION_CHECK_URL)",
    );
  });

  it("returns 503 when no citation index source is available", async () => {
    const app = buildApp({
      config: OK_URL,
      fetchFn: checkFetch([]).fetchFn,
    });
    const res = await app.request("/monitoring/citation-impact?since=2026-07-01T00:00:00Z");
    expect(res.status).toBe(503);
  });

  it("rejects an invalid since with 400", async () => {
    const app = buildApp({
      config: OK_URL,
      source: fakeSource([]),
      fetchFn: checkFetch([]).fetchFn,
    });
    const res = await app.request("/monitoring/citation-impact?since=gestern");
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range limit with 400", async () => {
    const app = buildApp({
      config: OK_URL,
      source: fakeSource([]),
      fetchFn: checkFetch([]).fetchFn,
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z&limit=5000",
    );
    expect(res.status).toBe(400);
  });

  it("requires the admin role for an all-tenant report", async () => {
    const app = buildApp({
      config: OK_URL,
      operatorAuth: viewerAuth,
      source: fakeSource([]),
      fetchFn: checkFetch([]).fetchFn,
    });
    const res = await app.request("/monitoring/citation-impact?since=2026-07-01T00:00:00Z");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("admin");
  });

  it("lets a viewer scope the report to one tenant", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = buildApp({
      config: OK_URL,
      operatorAuth: viewerAuth,
      source: fakeSource([group("doc-a", "c1", ["e1"])], calls),
      fetchFn: checkFetch([
        { base_ref: "doc-a", chunk_id: "c1", status: "current" },
      ]).fetchFn,
      now: () => new Date("2026-10-20T12:00:00.000Z"),
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z&tenant_id=acme",
    );
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      tenant_id: string | null;
      generated_at: string;
      summary: { executions_checked: number; executions_affected: number };
      signature?: unknown;
    };
    expect(report.tenant_id).toBe("acme");
    expect(report.generated_at).toBe("2026-10-20T12:00:00.000Z");
    expect(report.summary.executions_checked).toBe(1);
    expect(report.summary.executions_affected).toBe(0);
    expect(report.signature).toBeUndefined();
    expect(calls[0]?.["tenantId"]).toBe("acme");
  });

  it("forwards tenant and base_ref filters to the source", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = buildApp({
      config: OK_URL,
      source: fakeSource([], calls),
      fetchFn: checkFetch([]).fetchFn,
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z&tenant_id=beta&base_ref=doc-42&limit=50",
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.["tenantId"]).toBe("beta");
    expect(calls[0]?.["baseRef"]).toBe("doc-42");
    expect(calls[0]?.["limit"]).toBe(50);
  });

  it("posts the cited pairs to the Search check with the configured token", async () => {
    const { fetchFn, requests } = checkFetch([
      { base_ref: "doc-a", chunk_id: "c1", status: "changed", current_revision: "7" },
    ]);
    const app = buildApp({
      config: OK_URL,
      source: fakeSource([group("doc-a", "c1", ["e1"])]),
      fetchFn,
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(requests.length).toBe(1);
    expect(requests[0]?.url).toBe(
      "http://search.test:8080/v2/citations/check",
    );
    expect(requests[0]?.auth).toBe("Bearer search-tok");
    expect(requests[0]?.items).toEqual([
      { base_ref: "doc-a", chunk_id: "c1" },
    ]);
    const report = (await res.json()) as {
      summary: { executions_affected: number };
      affected: Array<{ execution_id: string; chunks: Array<{ status: string; current_revision?: string }> }>;
    };
    expect(report.summary.executions_affected).toBe(1);
    expect(report.affected[0]?.chunks[0]?.status).toBe("changed");
    expect(report.affected[0]?.chunks[0]?.current_revision).toBe("7");
  });

  it("splits more than 500 pairs into multiple check requests", async () => {
    const groups = Array.from({ length: 700 }, (_, i) =>
      group(`doc-${i}`, "c1", [`e${i}`]),
    );
    const { fetchFn, requests } = checkFetch([]);
    const app = buildApp({
      config: OK_URL,
      source: fakeSource(groups),
      fetchFn,
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(requests.length).toBe(2);
    expect(((requests[0]?.items ?? []) as unknown[]).length).toBe(500);
    expect(((requests[1]?.items ?? []) as unknown[]).length).toBe(200);
  });

  it("answers 502 when the citation check fails", async () => {
    const failing = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const app = buildApp({
      config: OK_URL,
      source: fakeSource([group("doc-a", "c1", ["e1"])]),
      fetchFn: failing,
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z",
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("upstream_error");
  });

  it("answers 502 when the citation check is unreachable", async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const app = buildApp({
      config: OK_URL,
      source: fakeSource([group("doc-a", "c1", ["e1"])]),
      fetchFn: throwing,
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z",
    );
    expect(res.status).toBe(502);
  });

  it("signs the report with the evidence key when configured", async () => {
    const key = parseEvidenceSigningKey(
      Buffer.alloc(32, 13).toString("base64"),
    ) as NonNullable<ReturnType<typeof parseEvidenceSigningKey>>;
    const app = buildApp({
      config: OK_URL,
      source: fakeSource([group("doc-a", "c1", ["e1"])]),
      fetchFn: checkFetch([
        { base_ref: "doc-a", chunk_id: "c1", status: "removed" },
      ]).fetchFn,
      evidenceKey: key,
    });
    const res = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      signature?: { alg: string; kid: string; value: string };
    };
    expect(report.signature?.alg).toBe("EdDSA");
    expect(report.signature?.kid).toBe(key.kid);
    expect(
      verifyEvidenceBytes(
        evidencePublicKeyFromRaw(key.publicKeyRaw),
        citationImpactSigningBytes(report as never),
        report.signature?.value ?? "",
      ),
    ).toBe(true);
  });

  it("keeps tenants apart: a scoped report only sees the requested tenant", async () => {
    // The source is the tenant boundary; the route must forward tenant_id
    // unchanged and never widen it.
    const seen: Array<string | undefined> = [];
    const source: CitationImpactSource = {
      async citedPairs(options) {
        seen.push(options.tenantId);
        return options.tenantId === "acme"
          ? [group("doc-a", "c1", ["e-acme"])]
          : [group("doc-b", "c1", ["e-beta"])];
      },
    };
    const app = buildApp({
      config: OK_URL,
      source,
      fetchFn: checkFetch([
        { base_ref: "doc-a", chunk_id: "c1", status: "removed" },
        { base_ref: "doc-b", chunk_id: "c1", status: "removed" },
      ]).fetchFn,
    });
    const acmeRes = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z&tenant_id=acme",
    );
    const acmeReport = (await acmeRes.json()) as {
      affected: Array<{ execution_id: string }>;
    };
    const resBeta = await app.request(
      "/monitoring/citation-impact?since=2026-07-01T00:00:00Z&tenant_id=beta",
    );
    const reportBeta = (await resBeta.json()) as {
      affected: Array<{ execution_id: string }>;
    };
    expect(acmeReport.affected.map((a) => a.execution_id)).toEqual(["e-acme"]);
    expect(reportBeta.affected.map((a) => a.execution_id)).toEqual(["e-beta"]);
    expect(seen).toEqual(["acme", "beta"]);
  });
});
