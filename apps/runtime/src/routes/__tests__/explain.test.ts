// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the Decision-Provenance Explainability Card route
 * (`src/routes/explain.ts`).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createExplainRouter } from "../explain.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type { ExplainHistorySource } from "../../observability/explain.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import type { SignedEvidenceBundle } from "../../observability/evidence-bundle.js";

const viewerAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [{ token: "viewer-tok", role: "viewer" }],
});

function historyWith(events: NodeExecutionEvent[]): ExplainHistorySource {
  return {
    async listRecent() {
      return [];
    },
    async listEvents(executionId) {
      return executionId === "exec-1" ? events : [];
    },
  };
}

describe("GET /monitoring/explain/:executionId", () => {
  it("returns the assembled card as JSON", async () => {
    const events: NodeExecutionEvent[] = [
      {
        execution_id: "exec-1",
        node_id: "responder",
        status: "completed",
        start_time: "2026-01-01T00:00:00.000Z",
        end_time: "2026-01-01T00:00:01.000Z",
        latency_ms: 1000,
        model: "openai/gpt-4o-mini",
      },
    ];
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(events),
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/monitoring/explain/exec-1", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      card: { executionId: string; modelsUsed: unknown[] };
    };
    expect(body.card.executionId).toBe("exec-1");
    expect(body.card.modelsUsed).toHaveLength(1);
  });

  it("returns markdown when ?format=markdown is set", async () => {
    const events: NodeExecutionEvent[] = [
      {
        execution_id: "exec-1",
        node_id: "responder",
        status: "completed",
        start_time: "2026-01-01T00:00:00.000Z",
        end_time: "2026-01-01T00:00:01.000Z",
        latency_ms: 1000,
      },
    ];
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(events),
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request(
      "/monitoring/explain/exec-1?format=markdown",
      { headers: { Authorization: "Bearer viewer-tok" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(res.headers.get("Content-Disposition")).toContain(
      "explain-exec-1.md",
    );
    const text = await res.text();
    expect(text).toContain("# Decision-Provenance Card");
  });

  it("returns 404 when the execution has no history", async () => {
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith([]),
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/monitoring/explain/does-not-exist", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith([]),
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/monitoring/explain/exec-1");
    expect(res.status).toBe(401);
  });

  it("resolves a chatcmpl-prefixed response id to the same execution", async () => {
    // The chat endpoints report `chatcmpl-<executionId>` as the response id;
    // operators paste that into the monitoring lookups, so the route must
    // strip the prefix rather than 404.
    const events: NodeExecutionEvent[] = [
      {
        execution_id: "exec-1",
        node_id: "responder",
        status: "completed",
        start_time: "2026-01-01T00:00:00.000Z",
        end_time: "2026-01-01T00:00:01.000Z",
        latency_ms: 1000,
      },
    ];
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(events),
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/monitoring/explain/chatcmpl-exec-1", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { card: { executionId: string } };
    expect(body.card.executionId).toBe("exec-1");
  });
});

// ---------------------------------------------------------------------------
// GET /monitoring/explain/:executionId/bundle — Verifiable Evidence Bundle
// ---------------------------------------------------------------------------

describe("GET /monitoring/explain/:executionId/bundle", () => {
  const SECRET = "a-shared-signing-secret-at-least-16-chars";
  const sampleEvents: NodeExecutionEvent[] = [
    {
      execution_id: "exec-1",
      node_id: "responder",
      status: "completed",
      start_time: "2026-01-01T00:00:00.000Z",
      end_time: "2026-01-01T00:00:01.000Z",
      latency_ms: 1000,
      model: "openai/gpt-4o-mini",
    },
  ];

  it("returns a signed bundle as JSON that verifies with the configured secret", async () => {
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(sampleEvents),
        operatorAuth: viewerAuth,
        evidenceBundleSecret: SECRET,
      }),
    );
    const res = await app.request("/monitoring/explain/exec-1/bundle", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      "evidence-bundle-exec-1.json",
    );
    const signed = (await res.json()) as SignedEvidenceBundle;
    expect(signed.bundle.executionId).toBe("exec-1");
    expect(signed.algorithm).toBe("hmac-sha256");

    const { verifyEvidenceBundle } = await import(
      "../../observability/evidence-bundle.js"
    );
    expect(verifyEvidenceBundle(signed, SECRET).valid).toBe(true);
    // A different secret must not verify — proves the signature is real, not
    // just present.
    expect(verifyEvidenceBundle(signed, "wrong-secret-value-here!!!").valid).toBe(
      false,
    );
  });

  it("returns markdown with the verify-bundle instructions when ?format=markdown is set", async () => {
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(sampleEvents),
        operatorAuth: viewerAuth,
        evidenceBundleSecret: SECRET,
      }),
    );
    const res = await app.request(
      "/monitoring/explain/exec-1/bundle?format=markdown",
      { headers: { Authorization: "Bearer viewer-tok" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("# Verifiable Evidence Bundle — exec-1");
    expect(text).toContain("verify-bundle");
  });

  it("returns 404 when no signing secret is configured (feature disabled)", async () => {
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(sampleEvents),
        operatorAuth: viewerAuth,
        // No evidenceBundleSecret supplied.
      }),
    );
    const res = await app.request("/monitoring/explain/exec-1/bundle", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the execution has no history", async () => {
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith([]),
        operatorAuth: viewerAuth,
        evidenceBundleSecret: SECRET,
      }),
    );
    const res = await app.request(
      "/monitoring/explain/does-not-exist/bundle",
      { headers: { Authorization: "Bearer viewer-tok" } },
    );
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const app = new Hono();
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(sampleEvents),
        operatorAuth: viewerAuth,
        evidenceBundleSecret: SECRET,
      }),
    );
    const res = await app.request("/monitoring/explain/exec-1/bundle");
    expect(res.status).toBe(401);
  });

  it("embeds the audit-anchor status when an anchor service is provided", async () => {
    const app = new Hono();
    const fakeAnchor = {
      status: () => ({ active: true, verified: true }),
      anchorNow: async () => undefined,
      verifyLatest: async () => ({ active: true, verified: true }),
      start: () => {},
      stop: () => {},
    };
    app.route(
      "/",
      createExplainRouter({
        history: historyWith(sampleEvents),
        operatorAuth: viewerAuth,
        evidenceBundleSecret: SECRET,
        auditAnchor: fakeAnchor,
      }),
    );
    const res = await app.request("/monitoring/explain/exec-1/bundle", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const signed = (await res.json()) as SignedEvidenceBundle;
    expect(signed.bundle.auditAnchor).toEqual({ active: true, verified: true });
  });
});
