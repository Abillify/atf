// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { buildAiTools } from "../../graph/agent-tools.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import {
  BudgetExceededError,
  createTransactionOrchestrator,
  getTransactionOrchestrator,
  TransactionTokenValidator,
} from "../index.js";

const SECRET = "01234567890123456789012345678901";
const originalSecret = process.env.AGENT_TRANSACTION_SECRET;
const originalAudiences = process.env.AGENT_TRANSACTION_AUDIENCES;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AGENT_TRANSACTION_SECRET;
  else process.env.AGENT_TRANSACTION_SECRET = originalSecret;
  if (originalAudiences === undefined) delete process.env.AGENT_TRANSACTION_AUDIENCES;
  else process.env.AGENT_TRANSACTION_AUDIENCES = originalAudiences;
});

const ctx: RequestContext = {
  ssoToken: "raw-sso-token",
  executionId: "exec-1",
  userId: "user-1",
  clientId: "tenant-1",
  sessionId: "chat-session-1",
  authenticatedSessionId: "session-1",
  role: "analyst",
  groups: ["case-team"],
  claims: {
    scope: "documents:read tools:call",
    scp: ["search:run"],
    tools: ["parking:user"],
    kb: ["knowledge:read"],
    role: "analyst",
    providerKeyOverrides: { openai: "secret-provider-key" },
    raw_claim: "must-not-leak",
  },
  traceContext: {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    sampled: true,
  },
};

const env = {
  AGENT_TRANSACTION_SECRET: SECRET,
  AGENT_TRANSACTION_ISSUER: "aiperator",
  AGENT_TRANSACTION_TTL_SECONDS: "30",
  AGENT_TRANSACTION_MAX_DURATION_MS: "5000",
  AGENT_TRANSACTION_AUDIENCES: JSON.stringify({ records: "records-service" }),
};

describe("transaction orchestrator", () => {
  test("issues audience-bound minimal claims and finalizes budget and ledger", async () => {
    let now = 1_700_000_000_000;
    const orchestrator = createTransactionOrchestrator({ env, now: () => now });
    if (orchestrator === undefined) throw new Error("expected orchestrator");

    const invocation = await orchestrator.begin(ctx, "records", "records/search", "inv-1");
    const token = invocation.transaction?.token;
    const validated = await new TransactionTokenValidator(
      {
        issuer: "aiperator",
        audience: "records-service",
        secret: SECRET,
        ttlSeconds: 30,
      },
      () => now,
    ).validate(token);

    expect(validated).toMatchObject({
      executionId: "exec-1",
      invocationId: "inv-1",
      userId: "user-1",
      tenantId: "tenant-1",
      agentId: "agent-runtime",
      sessionId: "session-1",
      purpose: "records/search",
      aud: "records-service",
      scopes: ["documents:read", "tools:call", "search:run", "role:analyst", "tool:search"],
      groups: ["case-team"],
      delegationChain: [],
    });
    expect(validated?.trace.deadlineAt).toBe(now + 5000);
    expect(validated).not.toHaveProperty("ssoToken");
    expect(validated).not.toHaveProperty("claims");
    expect(validated).not.toHaveProperty("providerKeyOverrides");
    expect(JSON.stringify(decodeJwt(token ?? ""))).not.toContain("secret-provider-key");
    expect(JSON.stringify(decodeJwt(token ?? ""))).not.toContain("raw-sso-token");

    await invocation.complete("committed", { ok: true });
    expect((await orchestrator.ledger.get("inv-1"))?.state).toBe("committed");
    expect(orchestrator.budgetCoordinator.current("exec-1").toolCalls).toBe(1);
    now += 1;
  });

  test("omits the session binding when the target receives an exchanged token", async () => {
    const orchestrator = createTransactionOrchestrator({ env });
    if (orchestrator === undefined) throw new Error("expected orchestrator");
    const invocation = await orchestrator.begin(ctx, "records", "records/search", "inv-exchanged", {
      bindSession: false,
    });
    const claims = decodeJwt(invocation.transaction?.token ?? "");
    expect(claims).not.toHaveProperty("sessionId");
    expect(claims).toMatchObject({ userId: "user-1", invocationId: "inv-exchanged" });
    await invocation.complete("committed");
  });

  test("canonicalizes action-contract hash aliases and excludes response evidence from transaction metadata", async () => {
    const orchestrator = createTransactionOrchestrator({ env });
    if (orchestrator === undefined) throw new Error("expected orchestrator");
    const uppercaseHash = "A".repeat(64);
    const invocation = await orchestrator.begin(ctx, "records", "records/write", "inv-contract", {
      actionContractHash: uppercaseHash,
      evidenceContractHash: uppercaseHash.toLowerCase(),
    });
    const claims = decodeJwt(invocation.transaction?.token ?? "");

    expect(claims.actionContractHash).toBe(uppercaseHash.toLowerCase());
    expect(claims.evidenceContractHash).toBe(uppercaseHash.toLowerCase());
    expect(claims).not.toHaveProperty("evidencePackHash");
    expect(invocation.transaction?.actionContractHash).toBe(uppercaseHash.toLowerCase());
    expect(invocation.transaction).not.toHaveProperty("evidencePackHash");
    await invocation.complete("committed");
  });

  test("copies scopes from only the configured JWT claims", async () => {
    const orchestrator = createTransactionOrchestrator({
      env: { ...env, AGENT_TRANSACTION_SCOPE_CLAIMS: "tools, kb, tools" },
    });
    if (orchestrator === undefined) throw new Error("expected orchestrator");

    const invocation = await orchestrator.begin(ctx, "records", "records/search", "inv-configured-scopes");
    expect(decodeJwt(invocation.transaction?.token ?? "").scopes).toEqual([
      "parking:user",
      "knowledge:read",
      "role:analyst",
      "tool:search",
    ]);
    await invocation.complete("committed");
  });

  test("omits the internal single-tenant sentinel from the external transaction envelope", async () => {
    const orchestrator = createTransactionOrchestrator({ env });
    if (orchestrator === undefined) throw new Error("expected orchestrator");

    const invocation = await orchestrator.begin(
      { ...ctx, clientId: "_" },
      "records",
      "records/search",
      "inv-no-tenant",
    );
    const claims = decodeJwt(invocation.transaction?.token ?? "");

    expect(claims).not.toHaveProperty("tenantId");
    expect(claims.userId).toBe("user-1");
    await invocation.complete("committed");
  });

  test("defaults audience to the exact server name and records failure outcomes", async () => {
    const orchestrator = createTransactionOrchestrator({
      env: { AGENT_TRANSACTION_SECRET: SECRET },
    });
    if (orchestrator === undefined) throw new Error("expected orchestrator");
    const invocation = await orchestrator.begin(ctx, "calendar", "calendar/create", "inv-2");
    expect(decodeJwt(invocation.transaction?.token ?? "").aud).toBe("calendar");
    await invocation.complete("outcome_unknown", new Error("connection dropped"));
    expect((await orchestrator.ledger.get("inv-2"))?.state).toBe("outcome_unknown");
    expect(orchestrator.budgetCoordinator.current("exec-1").toolCalls).toBe(1);
  });

  test("finalizes a claimed invocation when an open reservation exhausts the budget", async () => {
    const orchestrator = createTransactionOrchestrator({
      env: { ...env, AGENT_TRANSACTION_MAX_TOOL_CALLS: "1" },
    });
    if (orchestrator === undefined) throw new Error("expected orchestrator");

    const attempts = await Promise.allSettled([
      orchestrator.begin(ctx, "records", "records/search", "budget-1"),
      orchestrator.begin(ctx, "records", "records/search", "budget-2"),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(BudgetExceededError);

    const records = await Promise.all([orchestrator.ledger.get("budget-1"), orchestrator.ledger.get("budget-2")]);
    expect(records.map((record) => record?.state).sort()).toEqual(["failed", "running"]);
  });

  test("returns transparent legacy mode when no signing secret exists", () => {
    expect(createTransactionOrchestrator({ env: {} })).toBeUndefined();
    delete process.env.AGENT_TRANSACTION_SECRET;
    expect(getTransactionOrchestrator()).toBeUndefined();
  });
});

describe("agent MCP dispatch", () => {
  test("passes issued transaction metadata, stable toolCallId and signal", async () => {
    process.env.AGENT_TRANSACTION_SECRET = SECRET;
    process.env.AGENT_TRANSACTION_AUDIENCES = JSON.stringify({ records: "records-service" });
    const signal = new AbortController().signal;
    let seen: Parameters<McpWrapperService["callTool"]>[4];
    const mcp: McpWrapperService = {
      connect: async () => {},
      reconnect: async () => {},
      listTools: async () => ["search"],
      getTransactionCapabilities: async () => ({
        protocol: "v1",
        issuer: "records",
        audiences: ["records-service"],
        enforcement: "optional",
        signingAlgorithms: ["HS256"],
        features: {
          idempotency: true,
          budgets: true,
          compensation: true,
          evidenceLineage: true,
        },
        maxTokenTtlSeconds: 60,
      }),
      getFilteredToolSchema: async () => ({
        name: "search",
        inputSchema: { type: "object", properties: {} },
      }),
      refreshSchemaIfChanged: async () => false,
      getInstructions: () => undefined,
      callTool: async (_server, _tool, _args, _ctx, opts) => {
        seen = opts;
        return { content: "ok" };
      },
    };
    const node: FlowNode = { id: "agent", type: "llm", tools: ["records/search"] };
    const { tools } = await buildAiTools(
      node,
      mcp,
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { signal },
    );
    const bound = tools[Object.keys(tools)[0] ?? ""];
    if (bound?.execute === undefined) throw new Error("expected executable tool");
    await bound.execute({}, { toolCallId: "stable-call-id" } as never);

    expect(seen?.signal).toBe(signal);
    expect(seen?.invocationId).toBe("stable-call-id");
    expect(seen?.transaction?.invocationId).toBe("stable-call-id");
    expect(decodeJwt(seen?.transaction?.token ?? "").aud).toBe("records-service");
  });
});
