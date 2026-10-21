// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for `checkCompliancePolicy` (chat/metering.ts) — the admission
 * check that wires the declarative compliance policy (ADR-0009) into
 * POST /v1/chat/completions before GraphEngineService.executeFlow runs.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { checkCompliancePolicy } from "../metering.js";
import type { CompliancePolicy } from "../../../compliance/policy-schema.js";
import type { CompliancePolicyLoader } from "../../../compliance/policy-loader.js";
import type { RequestContext } from "../../../types/monitoring.js";
import type { FlowDefinition } from "../../../types/flow.js";
import type { AuditLog, AuditEntry } from "../../../observability/audit-log.js";

function loaderWith(policy: CompliancePolicy | undefined): Pick<CompliancePolicyLoader, "policy"> {
  return { policy };
}

const BASE_REQUEST_CTX: RequestContext = {
  ssoToken: "test-token",
  executionId: "exec-1",
};

const FLOW_BLOCKED_MODEL: FlowDefinition = {
  id: "f1",
  name: "F1",
  nodes: [{ id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-3.5-turbo" } }],
  edges: [],
};

const FLOW_ALLOWED_MODEL: FlowDefinition = {
  id: "f1",
  name: "F1",
  nodes: [{ id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } }],
  edges: [],
};

const POLICY: CompliancePolicy = {
  version: "1",
  failClosed: true,
  modelRules: [
    { tenant: "*", blockedModels: [{ provider: "openai", model: "gpt-3*" }] },
  ],
};

describe("checkCompliancePolicy", () => {
  it("rejects with 503 while the policy file is invalid and none is loaded", async () => {
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: { policy: undefined, enforcementBlocked: true },
        flow: FLOW_ALLOWED_MODEL,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return result.rejected ? result.response : c.json({ ok: true });
    });
    const res = await app.request("/");
    expect(result?.rejected).toBe(true);
    expect(res.status).toBe(503);
  });

  it("does not reject when no policy is loaded", async () => {
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(undefined),
        flow: FLOW_BLOCKED_MODEL,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    expect(result?.rejected).toBe(false);
  });

  it("does not reject a flow whose declared model complies with the policy", async () => {
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(POLICY),
        flow: FLOW_ALLOWED_MODEL,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    expect(result?.rejected).toBe(false);
  });

  it("rejects with a 403 response when the flow's model is blocked", async () => {
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(POLICY),
        flow: FLOW_BLOCKED_MODEL,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    if (result?.rejected !== true) throw new Error("expected rejected");
    expect(result.response.status).toBe(403);
    const body = (await result.response.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("permission_error");
    expect(body.error.message).toContain("gpt-3.5-turbo");
  });

  it("records a denied audit entry and a rejection metric on deny", async () => {
    const recorded: AuditEntry[] = [];
    const auditLog: Pick<AuditLog, "record"> = {
      record: (entry) => {
        recorded.push(entry);
      },
    };
    const rejectedReasons: string[] = [];
    const metrics = {
      recordRejected: (reason: string) => {
        rejectedReasons.push(reason);
      },
    } as unknown as import("../../../observability/metrics.js").Metrics;

    const app = new Hono();
    app.get("/", async (c) => {
      await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(POLICY),
        flow: FLOW_BLOCKED_MODEL,
        flowId: "f1",
        requestCtx: {
          ...BASE_REQUEST_CTX,
          clientId: "tenant-a",
          userId: "u-42",
          userEmail: "jane.doe@example.com",
        },
        auditLog: auditLog as AuditLog,
        metrics,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");

    expect(rejectedReasons).toEqual(["compliance_policy"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.action).toBe("compliance.policy.deny");
    expect(recorded[0]?.outcome).toBe("denied");
    expect(recorded[0]?.target).toBe("f1");
    // The e-mail is personal data and must never be the audit actor.
    expect(recorded[0]?.actor).toBe("u-42");
    expect(JSON.stringify(recorded[0])).not.toContain("jane.doe@example.com");
  });

  it("denies when ANY node's model in a multi-model flow violates the policy", async () => {
    const multiModelFlow: FlowDefinition = {
      id: "f1",
      name: "F1",
      nodes: [
        { id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
        { id: "n2", type: "llm", llm: { provider: "openai", model: "gpt-3.5-turbo" } },
      ],
      edges: [],
    };
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(POLICY),
        flow: multiModelFlow,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    expect(result?.rejected).toBe(true);
  });
});

describe("checkCompliancePolicy — dataRules via FlowDefinition.dataClasses", () => {
  const DATA_POLICY: CompliancePolicy = {
    version: "1",
    failClosed: true,
    dataRules: [
      {
        dataClass: "personal",
        allowedProviders: [{ provider: "ollama" }],
      },
    ],
  };

  it("does not reject a flow with no declared dataClasses (dataRules stay a no-op)", async () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      nodes: [{ id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } }],
      edges: [],
      // no dataClasses declared
    };
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(DATA_POLICY),
        flow,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    expect(result?.rejected).toBe(false);
  });

  it("rejects a flow that declares a data class not permitted for its provider", async () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      dataClasses: ["personal"],
      nodes: [{ id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } }],
      edges: [],
    };
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(DATA_POLICY),
        flow,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    if (result?.rejected !== true) throw new Error("expected rejected");
    const body = (await result.response.json()) as {
      error: { message: string };
    };
    expect(body.error.message).toContain("personal");
  });

  it("admits a flow whose declared dataClasses ARE permitted for its provider", async () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      dataClasses: ["personal"],
      nodes: [{ id: "n1", type: "llm", llm: { provider: "ollama", model: "llama3" } }],
      edges: [],
    };
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(DATA_POLICY),
        flow,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    expect(result?.rejected).toBe(false);
  });

  it("checks the declared data class against EVERY node's model in a multi-model flow", async () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      dataClasses: ["personal"],
      nodes: [
        { id: "n1", type: "llm", llm: { provider: "ollama", model: "llama3" } },
        { id: "n2", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
      ],
      edges: [],
    };
    const app = new Hono();
    let result: Awaited<ReturnType<typeof checkCompliancePolicy>> | undefined;
    app.get("/", async (c) => {
      result = await checkCompliancePolicy({
        compliancePolicyLoader: loaderWith(DATA_POLICY),
        flow,
        flowId: "f1",
        requestCtx: BASE_REQUEST_CTX,
        ctx: c,
      });
      return c.json({ ok: true });
    });
    await app.request("/");
    // n2's openai node is not on the allowed-provider list for "personal".
    expect(result?.rejected).toBe(true);
  });
});
