// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the control-plane routes (approvals, replay, canary) under
 * /monitoring/*, sharing the monitoring auth gate.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createControlRouter } from "../control.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import { createApprovalGate } from "../../graph/approval-gate.js";
import type {
  ApprovalGateConfig,
  ApprovalRegistry,
} from "../../graph/approval-gate.js";
import {
  signApprovalConfirmToken,
  signApprovalLinkToken,
} from "../../graph/approval-link.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import {
  createReplayService,
  InMemoryReplayStore,
} from "../../graph/replay.js";
import { createCanaryManager } from "../../graph/canary.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function app(deps: Parameters<typeof createControlRouter>[0]) {
  const a = new Hono();
  a.route("/", createControlRouter(deps));
  return a;
}

/** `createApprovalGate` for a config known to enable the gate (never undefined). */
function mustCreateApprovalGate(config: ApprovalGateConfig): ApprovalRegistry {
  const gate = createApprovalGate(config);
  if (gate === undefined)
    throw new Error("expected the approval gate to be enabled");
  return gate;
}

/** The id of the first pending approval, asserting one actually exists. */
async function firstPendingId(gate: ApprovalRegistry): Promise<string> {
  const pending = await gate.listPending();
  const first = pending[0];
  if (first === undefined) throw new Error("expected a first pending approval");
  return first.id;
}

describe("approvals routes", () => {
  test("GET /monitoring/approvals lists pending and POST resolves", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({ approvalGate: gate });

    const decision = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "demo-mcp/case_lookup",
      args: { reference: "A-123" },
    });

    const list = await a.request("/monitoring/approvals");
    const body = (await list.json()) as {
      pending: Array<{ id: string; tool: string }>;
    };
    expect(body.pending).toHaveLength(1);
    const firstPending = body.pending[0];
    if (firstPending === undefined)
      throw new Error("expected a first pending approval");
    expect(firstPending.tool).toBe("demo-mcp/case_lookup");

    const id = firstPending.id;
    const res = await a.request(`/monitoring/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, by: "alice" }),
    });
    expect(res.status).toBe(200);
    const decided = await decision;
    expect(decided.approved).toBe(true);
    expect(decided.by).toBe("alice");
  });

  test("POST with missing 'approved' is 400", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate });
    const res = await a.request("/monitoring/approvals/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST for an unknown id is 404", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate });
    const res = await a.request("/monitoring/approvals/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    expect(res.status).toBe(404);
  });

  test("401 when auth is required and no token is provided", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate, authRequired: true });
    const res = await a.request("/monitoring/approvals");
    expect(res.status).toBe(401);
  });

  test("a format-only token is rejected by default (fail-closed)", async () => {
    // `aaa.bbb.ccc` passes the SHAPE check but carries no verified identity.
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({ approvalGate: gate, authRequired: true });
    const res = await a.request("/monitoring/approvals?token=aaa.bbb.ccc");
    expect(res.status).toBe(401);
  });

  test("authorised with a format-only token only when explicitly opted into", async () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      operatorAuth: createOperatorAuthorizer({
        authRequired: true,
        allowUnverifiedJwt: true,
      }),
    });
    const res = await a.request("/monitoring/approvals?token=aaa.bbb.ccc");
    expect(res.status).toBe(200);
  });
});

describe("approval-link capability token (in-chat widget)", () => {
  const SECRET = "control-test-secret-at-least-32-chars-long";

  test("GET /:id/widget is authorised by a valid capability token (no operator bearer)", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
      approvalFrameAncestors: ["https://chat.example.com"],
    });

    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);
    const res = await a.request(
      `/monitoring/approvals/${id}/widget?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://chat.example.com;",
    );
    const html = await res.text();
    // The decide buttons must carry the same token forward (relative hrefs drop the query).
    expect(html).toContain(
      `decide?decision=approved&token=${encodeURIComponent(token)}`,
    );
  });

  test("GET /:id/widget shows the final state for an expired token instead of a 401", async () => {
    // The token expires with the approval's own auto-deny plus a grace. A chat
    // that stays open reloads the widget after that point constantly, and the
    // outcome of a denied approval leaks nothing the token holder was not
    // already shown — whereas 401 would leave the iframe dead.
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 20 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);
    // Minted short, so that by the reload below the token has expired too —
    // exactly the state a chat reaches when it is left open past the deadline.
    const token = signApprovalLinkToken(id, SECRET, Date.now() + 40);

    // Let the gate auto-deny and the token lapse, so the terminal state is the
    // timed-out one reached with an expired capability.
    await new Promise((r) => setTimeout(r, 80));

    const res = await a.request(
      `/monitoring/approvals/${id}/widget?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Automatically denied (timed out).");
    // Terminal: no working buttons, and no echo of the request arguments.
    expect(html).not.toContain("decide?decision=");
    expect(html).not.toContain("sven");
  });

  test("an expired token never shows live details or buttons, even if still pending", async () => {
    // Belt and braces for clock skew or a replica that never ran the timer:
    // the expired path must degrade to the neutral card, never to the live one.
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 60_000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);
    const expired = signApprovalLinkToken(id, SECRET, Date.now() - 1);

    const res = await a.request(
      `/monitoring/approvals/${id}/widget?token=${encodeURIComponent(expired)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("no longer available");
    expect(html).not.toContain("decide?decision=");
    expect(html).not.toContain("sven");
    // The approval itself is untouched — reading is not deciding.
    expect(await gate.listPending()).toHaveLength(1);
  });

  test("a forged token is still a 401 for the widget, and an expired one for decide", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 60_000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    // Forged (wrong secret): no read access either.
    const forged = signApprovalLinkToken(
      id,
      "a-completely-different-secret-value-that-is-long",
      Date.now() + 60_000,
    );
    const widgetRes = await a.request(
      `/monitoring/approvals/${id}/widget?token=${encodeURIComponent(forged)}`,
    );
    expect(widgetRes.status).toBe(401);

    // Expired but genuine: deciding stays forbidden, the approval stays pending.
    const expired = signApprovalLinkToken(id, SECRET, Date.now() - 1);
    const decideRes = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(expired)}`,
    );
    expect(decideRes.status).toBe(401);
    expect(await gate.listPending()).toHaveLength(1);
  });

  test("GET /:id/decide with a valid capability token resolves the approval as the requesting user", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
      approvalLinkConfirm: false,
    });

    const decision = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const decided = await decision;
    expect(decided.approved).toBe(true);
    expect(decided.by).toBe("Example Contributor");
  });

  test("APPROVAL_LINK_CONFIRM=false keeps the one-click decision flow", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const audit = new InMemoryAuditLog();
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
      approvalLinkConfirm: false,
      auditLog: audit,
    });
    const decisionPromise = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
      requestedBy: "user-1",
    });
    const id = await firstPendingId(gate);
    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);

    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=denied&token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const decided = await decisionPromise;
    expect(decided.approved).toBe(false);
    expect((await audit.list()).some((r) => r.action === "approvals.resolve")).toBe(
      true,
    );
  });

  test("two-step confirmation is on by default when a link secret exists", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
      requestedBy: "user-1",
    });
    const id = await firstPendingId(gate);
    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}`,
    );
    expect(await res.text()).toContain("Confirm your choice");
    expect(await gate.listPending()).toHaveLength(1);
  });

  test("a link click first asks for confirmation and only the second click resolves", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const audit = new InMemoryAuditLog();
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
      auditLog: audit,
    });

    const decisionPromise = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);
    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);

    // First click — what a link preview, prefetcher or security scanner would
    // trigger automatically. It must not resolve the approval.
    const first = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}`,
    );
    expect(first.status).toBe(200);
    const page = await first.text();
    expect(page).toContain("Confirm your choice");
    expect(await gate.listPending()).toHaveLength(1);
    expect((await audit.list()).length).toBe(0);
    expect(decisionPromise).toBeDefined();

    // Second click — the confirmation link from that page.
    const nonce = /confirm=([A-Za-z0-9._-]+)/.exec(page)?.[1];
    if (nonce === undefined) throw new Error("no confirmation link rendered");
    const second = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}&confirm=${nonce}`,
    );
    expect(second.status).toBe(200);
    const decided = await decisionPromise;
    expect(decided.approved).toBe(true);
    expect(decided.by).toBe("Example Contributor");
  });

  test("a confirmation nonce is bound to its approval and decision", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    const decisionPromise = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
      requestedBy: "user-1",
    });
    const id = await firstPendingId(gate);
    const linkExpiresAtMs = Date.now() + 60_000;
    const token = signApprovalLinkToken(id, SECRET, linkExpiresAtMs);

    // A nonce minted for a different approval id must not resolve this one.
    const foreignNonce = signApprovalConfirmToken(
      "another-approval",
      "approved",
      linkExpiresAtMs,
      SECRET,
    );
    const foreign = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}&confirm=${foreignNonce}`,
    );
    expect(foreign.status).toBe(400);

    // Neither may a nonce minted for the opposite decision.
    const denyNonce = signApprovalConfirmToken(
      id,
      "denied",
      linkExpiresAtMs,
      SECRET,
    );
    const mismatched = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}&confirm=${denyNonce}`,
    );
    expect(mismatched.status).toBe(400);

    expect(await gate.listPending()).toHaveLength(1);
    void decisionPromise;
  });

  test("an authenticated operator goes through the same confirmation", async () => {
    // No GET decides in one step, not even an authenticated one — the Control
    // dashboard resolves through POST /monitoring/approvals/:id instead.
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
      operatorAuth: createOperatorAuthorizer({
        authRequired: true,
        tokens: [{ token: "op-token-alice", role: "operator", name: "alice" }],
      }),
    });
    const decisionPromise = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    const first = await a.request(
      `/monitoring/approvals/${id}/decide?decision=denied`,
      { headers: { Authorization: "Bearer op-token-alice" } },
    );
    expect(first.status).toBe(200);
    const page = await first.text();
    expect(page).toContain("Confirm your choice");
    expect(await gate.listPending()).toHaveLength(1);

    const nonce = /confirm=([A-Za-z0-9._-]+)/.exec(page)?.[1];
    if (nonce === undefined) throw new Error("no confirmation link rendered");
    const second = await a.request(
      `/monitoring/approvals/${id}/decide?decision=denied&confirm=${nonce}`,
      { headers: { Authorization: "Bearer op-token-alice" } },
    );
    expect(second.status).toBe(200);
    const decided = await decisionPromise;
    expect(decided.approved).toBe(false);
    expect(decided.by).toBe("alice");
  });

  test("an expired or tampered confirmation is 400 and stays pending", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
      requestedBy: "user-1",
    });
    const id = await firstPendingId(gate);
    const expiresAtMs = Date.now() + 60_000;
    const token = signApprovalLinkToken(id, SECRET, expiresAtMs);

    // Expired (minted APPROVAL_CONFIRM_TTL_MS + 1s ago).
    const stale = signApprovalConfirmToken(
      id,
      "approved",
      expiresAtMs,
      SECRET,
      Date.now() - 121_000,
    );
    const staleRes = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}&confirm=${stale}`,
    );
    expect(staleRes.status).toBe(400);

    // Tampered signature.
    const forged = `${signApprovalConfirmToken(id, "approved", expiresAtMs, SECRET).split(".")[0]}.AAAA_forged`;
    const forgedRes = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}&confirm=${forged}`,
    );
    expect(forgedRes.status).toBe(400);

    expect(await gate.listPending()).toHaveLength(1);
  });

  test("the confirmation page is script-free and form-free", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
      requestedBy: "user-1",
    });
    const id = await firstPendingId(gate);
    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}`,
    );
    const page = await res.text();
    expect(page).not.toContain("<script");
    expect(page).not.toContain("<form");
    expect(page).not.toContain("onclick");
    // Works inside the script-less sandboxed iframe: plain links only.
    expect(page).toContain("rel=\"nofollow\"");
  });

  test("GET /:id/decide without a token is 401 when auth is required", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
    });
    const id = await firstPendingId(gate);
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved`,
    );
    expect(res.status).toBe(401);
  });

  test("a capability token for a different approval id is rejected", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: {},
    });
    const id = await firstPendingId(gate);
    const wrongToken = signApprovalLinkToken(
      "some-other-id",
      SECRET,
      Date.now() + 60_000,
    );
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(wrongToken)}`,
    );
    expect(res.status).toBe(401);
  });

  test("GET /:id/decide ignores ?by= when the caller is an authenticated operator", async () => {
    // RBAC-authenticated operator `alice`: the query parameter must never
    // overwrite the authenticated identity in the resolved decision or the
    // audit trail (mirrors the POST handler's rule).
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const audit = new InMemoryAuditLog();
    const a = app({
      approvalGate: gate,
      authRequired: true,
      approvalLinkSecret: SECRET,
      auditLog: audit,
      operatorAuth: createOperatorAuthorizer({
        authRequired: true,
        tokens: [{ token: "op-token-alice", role: "operator", name: "alice" }],
      }),
    });

    const decision = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    const first = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&by=bob`,
      { headers: { Authorization: "Bearer op-token-alice" } },
    );
    const page = await first.text();
    const nonce = /confirm=([A-Za-z0-9._-]+)/.exec(page)?.[1];
    if (nonce === undefined) throw new Error("no confirmation link rendered");
    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&by=bob&confirm=${nonce}`,
      { headers: { Authorization: "Bearer op-token-alice" } },
    );
    expect(res.status).toBe(200);
    const decided = await decision;
    expect(decided.by).toBe("alice");

    const records = await audit.list();
    const resolve = records.find((r) => r.action === "approvals.resolve");
    expect(resolve?.actor).toBe("alice");
    expect(resolve?.details?.via).toBe("link");
    expect(resolve?.details?.authenticatedAs).toBe("alice");
  });

  test("approvalMessageLocale=de renders the widget, confirmation and result in German", async () => {
    // The chat message and the pages it embeds must read the same language;
    // English widget labels under a German chat message was the reported defect.
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 60_000 });
    const a = app({
      approvalGate: gate,
      approvalLinkSecret: SECRET,
      approvalMessageLocale: "de",
    });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "bank/pay",
      args: {},
      requestedBy: "user-1",
    });
    const id = await firstPendingId(gate);
    const token = signApprovalLinkToken(id, SECRET, Date.now() + 60_000);

    const widget = await (
      await a.request(
        `/monitoring/approvals/${id}/widget?token=${encodeURIComponent(token)}`,
      )
    ).text();
    expect(widget).toContain('<html lang="de">');
    expect(widget).toContain("Freigabe erforderlich");
    expect(widget).toContain("keine Argumente");
    expect(widget).toContain("Freigeben");
    expect(widget).toContain("Ablehnen");
    expect(widget).not.toContain(">Approve<");

    const confirm = await (
      await a.request(
        `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}`,
      )
    ).text();
    expect(confirm).toContain("<code>pay</code> genehmigen?");
    expect(confirm).toContain("Bestätige deine Auswahl");
    expect(confirm).toContain(">Zurück<");

    const nonce = /confirm=([A-Za-z0-9._-]+)/.exec(confirm)?.[1];
    if (nonce === undefined) throw new Error("no confirmation link rendered");
    const decided = await (
      await a.request(
        `/monitoring/approvals/${id}/decide?decision=approved&token=${encodeURIComponent(token)}&confirm=${nonce}`,
      )
    ).text();
    expect(decided).toContain("Freigegeben");
    expect(decided).not.toContain(">Approved<");
  });

  test("an unsupported approvalMessageLocale still renders English", async () => {
    // A misconfigured label language must never leave a security-relevant
    // decision page without text.
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 60_000 });
    const a = app({ approvalGate: gate, approvalMessageLocale: "fr" });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "bank/pay",
      args: {},
    });
    const id = await firstPendingId(gate);
    const html = await (await a.request(`/monitoring/approvals/${id}/widget`)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Approval required");
  });

  test("GET /:id/decide on the open plane still honours ?by=", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const audit = new InMemoryAuditLog();
    const a = app({ approvalGate: gate, auditLog: audit });

    const decision = gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "worktime/vacation_create",
      args: { user: "sven" },
      requestedBy: "Example Contributor",
    });
    const id = await firstPendingId(gate);

    const res = await a.request(
      `/monitoring/approvals/${id}/decide?decision=approved&by=carol`,
    );
    expect(res.status).toBe(200);
    const decided = await decision;
    expect(decided.by).toBe("carol");

    const records = await audit.list();
    const resolve = records.find((r) => r.action === "approvals.resolve");
    expect(resolve?.details?.authenticatedAs).toBe("anonymous");
  });
});

describe("replay route", () => {
  test("POST /monitoring/replay re-runs a captured snapshot", async () => {
    const store = new InMemoryReplayStore();
    const svc = createReplayService(store, async (_flow, msgs) => {
      const first = msgs[0];
      return {
        text: `echo:${typeof first?.content === "string" ? first.content : ""}`,
      };
    });
    await svc.capture({
      executionId: "exec-9",
      flowId: "helpdesk",
      messages: [{ role: "user", content: "hallo" }],
      responseText: "echo:hallo",
      createdAt: new Date().toISOString(),
    });
    const a = app({ replayService: svc });

    const res = await a.request("/monitoring/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_id: "exec-9" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; similarity: number };
    expect(body.changed).toBe(false);
    expect(body.similarity).toBe(1);
  });

  test("missing execution_id → 400", async () => {
    const store = new InMemoryReplayStore();
    const svc = createReplayService(store, async () => ({ text: "" }));
    const a = app({ replayService: svc });
    const res = await a.request("/monitoring/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("unknown execution → 404", async () => {
    const store = new InMemoryReplayStore();
    const svc = createReplayService(store, async () => ({ text: "" }));
    const a = app({ replayService: svc });
    const res = await a.request("/monitoring/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_id: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("canary status route", () => {
  test("GET /monitoring/canary returns deployment status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-route-"));
    fs.writeFileSync(
      path.join(dir, "canary.json"),
      JSON.stringify({
        deployments: [
          { flow: "prod", candidate: "prod-v2", trafficPercent: 25 },
        ],
      }),
    );
    const mgr = createCanaryManager(dir);
    const a = app({ canaryManager: mgr });

    const res = await a.request("/monitoring/canary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{ flow: string; trafficPercent: number }>;
    };
    expect(body.deployments).toHaveLength(1);
    const firstDeployment = body.deployments[0];
    if (firstDeployment === undefined)
      throw new Error("expected a first deployment");
    expect(firstDeployment.flow).toBe("prod");
    expect(firstDeployment.trafficPercent).toBe(25);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("MCP server approval display", () => {
  test("renders escaped server title, message and fields instead of raw args", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const a = app({ approvalGate: gate });
    void gate.request({
      executionId: "e1",
      nodeId: "n1",
      tool: "bank/pay",
      args: { internal: "raw" },
      title: "Zahlung <freigeben>",
      message: "Kein <script>alert(1)</script> ausführen",
      fields: [
        { name: "amount", label: "Betrag", value: "10 & 20" },
        { name: "recipient", label: "Empfänger", value: "Ada" },
      ],
    });
    const id = await firstPendingId(gate);
    const response = await a.request(`/monitoring/approvals/${id}/widget`);
    const html = await response.text();
    expect(html).toContain("Zahlung &lt;freigeben&gt;");
    expect(html).toContain(
      "Kein &lt;script&gt;alert(1)&lt;/script&gt; ausführen",
    );
    expect(html).toContain("10 &amp; 20");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("internal");
  });
});
