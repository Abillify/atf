// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  TransactionFabric,
  MemoryInvocationLedger,
  RedisInvocationLedger,
  currentTransactionContext,
  transactionConfigFromEnv,
  type TransactionEnvelope,
} from "../../src/transaction/fabric.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const secret = "transaction-test-secret-with-enough-entropy";
const baseConfig = {
  enforcement: "required" as const,
  secret,
  issuer: "aiperator",
  audience: "mcpgate",
  clockToleranceSec: 0,
  maxTtlSec: 300,
};

function envelope(overrides: Partial<TransactionEnvelope> = {}): TransactionEnvelope {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: "v1",
    iss: "aiperator",
    aud: "mcpgate",
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    invocationId: crypto.randomUUID(),
    scopes: ["tool:run"],
    groups: [],
    budget: {},
    delegationChain: [],
    trace: {},
    ...overrides,
  };
}

async function token(claims: TransactionEnvelope, key = secret): Promise<string> {
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(key));
}

const ok = { content: [{ type: "text" as const, text: "ok" }] };
const execute = (
  fabric: TransactionFabric,
  jwt: unknown,
  args: Record<string, unknown>,
  run = async () => ok,
) =>
  fabric.execute({
    token: jwt,
    tool: "write_order",
    args,
    requiredScopes: ["tool:run"],
    access: "write",
    run,
  });

describe("Agent Transaction Fabric v1", () => {
  it("rejects tampered, expired, and wrong-audience tokens", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const valid = await token(envelope());
    const parts = valid.split(".");
    const signature = parts[2] ?? "";
    parts[2] = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    const tampered = parts.join(".");
    expect((await execute(fabric, tampered, {})).structuredContent).toMatchObject({
      error: { code: "TRANSACTION_TOKEN_INVALID" },
    });
    expect(
      (await execute(fabric, await token(envelope({ exp: Math.floor(Date.now() / 1000) - 1 })), {}))
        .structuredContent,
    ).toMatchObject({ error: { code: "TRANSACTION_TOKEN_INVALID" } });
    expect(
      (await execute(fabric, await token(envelope({ aud: "other" })), {})).structuredContent,
    ).toMatchObject({ error: { code: "TRANSACTION_TOKEN_INVALID" } });
  });

  it("verifies RS256, ES256, and EdDSA through a local remote JWKS", async () => {
    const cases = [
      { alg: "RS256" as const, keyType: "RS256" as const },
      { alg: "ES256" as const, keyType: "ES256" as const },
      { alg: "EdDSA" as const, keyType: "EdDSA" as const },
    ];
    for (const { alg, keyType } of cases) {
      const { privateKey, publicKey } = await generateKeyPair(keyType);
      const jwk = await exportJWK(publicKey);
      const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ keys: [{ ...jwk, kid: `key-${alg}`, alg, use: "sig" }] }),
      });
      try {
        const fabric = new TransactionFabric({
          ...baseConfig,
          secret: undefined,
          jwksUri: `${server.url}jwks`,
          algorithms: [alg],
        });
        const jwt = await new SignJWT(envelope() as unknown as Record<string, unknown>)
          .setProtectedHeader({ alg, kid: `key-${alg}` })
          .sign(privateKey);
        expect((await execute(fabric, jwt, {})).isError).toBeFalsy();
        expect(fabric.capabilityDocument()).toMatchObject({ signingAlgorithms: [alg] });
      } finally {
        server.stop(true);
      }
    }
  });

  it("enforces asymmetric algorithm, issuer, and audience configuration", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const { privateKey: pssPrivateKey } = await generateKeyPair("PS256");
    const jwk = await exportJWK(publicKey);
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [{ ...jwk, kid: "rsa", alg: "RS256" }] }),
    });
    try {
      const fabric = new TransactionFabric({
        ...baseConfig,
        secret: undefined,
        jwksUri: `${server.url}jwks`,
        algorithms: ["RS256"],
      });
      const sign = (claims: TransactionEnvelope) =>
        new SignJWT(claims as unknown as Record<string, unknown>)
          .setProtectedHeader({ alg: "RS256", kid: "rsa" })
          .sign(privateKey);
      const disallowed = new SignJWT(envelope() as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: "PS256", kid: "rsa" })
        .sign(pssPrivateKey);
      expect(
        (await execute(fabric, await sign(envelope({ iss: "other" })), {})).structuredContent,
      ).toMatchObject({ error: { code: "TRANSACTION_TOKEN_INVALID" } });
      expect(
        (await execute(fabric, await sign(envelope({ aud: "other" })), {})).structuredContent,
      ).toMatchObject({ error: { code: "TRANSACTION_TOKEN_INVALID" } });
      expect((await execute(fabric, await disallowed, {})).structuredContent).toMatchObject({
        error: { code: "TRANSACTION_TOKEN_INVALID" },
      });
    } finally {
      server.stop(true);
    }
  });

  it("accepts HS256 and EdDSA side by side so issuers can switch one at a time", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const jwk = await exportJWK(publicKey);
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [{ ...jwk, kid: "runtime", alg: "EdDSA", use: "sig" }] }),
    });
    try {
      const both = new TransactionFabric({
        ...baseConfig,
        jwksUri: `${server.url}jwks`,
        algorithms: ["HS256", "EdDSA"],
      });
      const eddsa = () =>
        new SignJWT(envelope() as unknown as Record<string, unknown>)
          .setProtectedHeader({ alg: "EdDSA", kid: "runtime" })
          .sign(privateKey);
      expect((await execute(both, await token(envelope()), {})).isError).toBeFalsy();
      expect((await execute(both, await eddsa(), {})).isError).toBeFalsy();
      expect(both.capabilityDocument()).toMatchObject({ signingAlgorithms: ["HS256", "EdDSA"] });
      // Step two of the migration: the secret is withdrawn, only the runtime's key counts.
      const asymmetricOnly = new TransactionFabric({
        ...baseConfig,
        secret: undefined,
        jwksUri: `${server.url}jwks`,
        algorithms: ["EdDSA"],
      });
      expect((await execute(asymmetricOnly, await eddsa(), {})).isError).toBeFalsy();
      expect((await execute(asymmetricOnly, await token(envelope()), {})).structuredContent).toMatchObject({
        error: { code: "TRANSACTION_TOKEN_INVALID" },
      });
    } finally {
      server.stop(true);
    }
  });
  it("keeps a token minted for one Gate out of another (one audience per Gate)", async () => {
    const taiga = new TransactionFabric({ ...baseConfig, audience: "mcpgate-taiga" });
    const erp = new TransactionFabric({ ...baseConfig, audience: "mcpgate-erp" });
    const forTaiga = await token(envelope({ aud: "mcpgate-taiga" }));
    expect((await execute(taiga, forTaiga, {})).isError).toBeFalsy();
    expect((await execute(erp, forTaiga, {})).structuredContent).toMatchObject({
      error: { code: "TRANSACTION_TOKEN_INVALID" },
    });
  });
  it("accepts either verification source and validates configured algorithms", () => {
    expect(
      () =>
        new TransactionFabric({
          ...baseConfig,
          secret: undefined,
          jwksUri: "https://issuer.example/jwks",
          algorithms: ["RS256"],
        }),
    ).not.toThrow();
    expect(() => new TransactionFabric({ ...baseConfig, secret: undefined })).toThrow(
      "HS256_SECRET or MCPGATE_TRANSACTION_JWKS_URI",
    );
    expect(() =>
      transactionConfigFromEnv({
        MCPGATE_TRANSACTION_JWKS_URI: "https://issuer.example/jwks",
        MCPGATE_TRANSACTION_ALGORITHMS: "RS256,none",
      }),
    ).toThrow("must contain only");
    expect(
      transactionConfigFromEnv({ MCPGATE_TRANSACTION_JWKS_URI: "https://issuer.example/jwks" }),
    ).toMatchObject({ algorithms: ["RS256", "ES256", "EdDSA"] });
  });

  it("replays a committed result and rejects payload conflicts", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const jwt = await token(envelope());
    let calls = 0;
    const run = async () => {
      calls++;
      return ok;
    };
    expect((await execute(fabric, jwt, { id: 1 }, run)).isError).toBeFalsy();
    expect((await execute(fabric, jwt, { id: 1 }, run)).isError).toBeFalsy();
    expect(calls).toBe(1);
    expect((await execute(fabric, jwt, { id: 2 }, run)).structuredContent).toMatchObject({
      error: { code: "INVOCATION_CONFLICT" },
    });
  });

  it("rejects cross-principal replay of a committed result", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const jwt = await token(envelope());
    const auth = (subject: string): AuthContext => ({
      method: "oauth",
      subject,
      username: subject,
      scopes: ["tool:run"],
      rawToken: `secret-${subject}`,
      claims: { sub: subject, tenant: "acme", groups: ["users"] },
      headers: {},
      sessionId: `session-${subject}`,
    });
    let calls = 0;
    const invoke = (authContext: AuthContext) =>
      fabric.execute({
        token: jwt,
        tool: "write_order",
        args: { id: 1 },
        requiredScopes: ["tool:run"],
        access: "write",
        authContext,
        run: async () => {
          calls++;
          return { content: [{ type: "text", text: "alice-result" }] };
        },
      });

    expect((await invoke(auth("alice"))).content[0]?.text).toBe("alice-result");
    expect((await invoke(auth("bob"))).structuredContent).toMatchObject({
      error: { code: "INVOCATION_CONFLICT" },
    });
    expect(calls).toBe(1);
  });

  it("rejects elapsed deadlines before execution", async () => {
    const fabric = new TransactionFabric(baseConfig);
    let called = false;
    const jwt = await token(
      envelope({ trace: { deadlineAt: new Date(Date.now() - 1_000).toISOString() } }),
    );
    const result = await execute(fabric, jwt, {}, async () => {
      called = true;
      return ok;
    });
    expect(called).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { code: "TRANSACTION_DEADLINE_EXCEEDED" },
    });
  });

  it("allows legacy calls in optional mode and fails closed in required mode", async () => {
    const optional = new TransactionFabric({ ...baseConfig, enforcement: "optional" });
    expect((await execute(optional, undefined, {})).isError).toBeFalsy();
    const required = new TransactionFabric(baseConfig);
    expect((await execute(required, undefined, {})).structuredContent).toMatchObject({
      error: { code: "TRANSACTION_TOKEN_REQUIRED" },
    });
  });

  it("binds invocationId and exposes a separate AsyncLocalStorage context", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const claims = envelope();
    const jwt = await token(claims);
    let observed: string | undefined;
    await execute(fabric, jwt, {}, async () => {
      observed = currentTransactionContext()?.envelope.invocationId;
      return ok;
    });
    expect(observed).toBe(claims.invocationId);
    expect(currentTransactionContext()).toBeUndefined();
  });

  it("accepts the shared aiperator v1 wire contract and exposes all security bindings", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const claims = envelope({
      jti: "task-8-contract-jti",
      invocationId: "task-8-invocation",
      userId: "alice",
      budget: { maxRetrievalDocuments: 7 },
      trace: { deadlineAt: Date.now() + 10_000 },
    });
    const jwt = await token(claims);
    let observed: TransactionEnvelope | undefined;
    const result = await execute(fabric, jwt, {}, async () => {
      observed = currentTransactionContext()?.envelope;
      return ok;
    });
    expect(result.isError).toBeFalsy();
    expect(observed).toMatchObject({
      version: "v1",
      iss: "aiperator",
      aud: "mcpgate",
      jti: "task-8-contract-jti",
      invocationId: "task-8-invocation",
      budget: { maxRetrievalDocuments: 7 },
    });
  });

  it("rejects elapsed epoch-ms deadlines before execution", async () => {
    const fabric = new TransactionFabric(baseConfig);
    let called = false;
    const jwt = await token(envelope({ trace: { deadlineAt: Date.now() - 1 } }));
    const result = await execute(fabric, jwt, {}, async () => {
      called = true;
      return ok;
    });
    expect(called).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { code: "TRANSACTION_DEADLINE_EXCEEDED" },
    });
  });

  it("times out bounded execution and records an ambiguous write outcome", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const jwt = await token(envelope({ budget: { maxDurationMs: 5 } }));
    const result = await execute(fabric, jwt, {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return ok;
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVOCATION_OUTCOME_UNKNOWN", outcome: "outcome_unknown" },
    });
  });

  it("keeps replay deduplication bounded to one execution under load", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const jwt = await token(envelope());
    let calls = 0;
    const run = async () => {
      calls++;
      return ok;
    };
    for (let i = 0; i < 2_000; i++) {
      expect((await execute(fabric, jwt, { stable: true }, run)).isError).toBeFalsy();
    }
    expect(calls).toBe(1);
  });

  it("advertises only enforced per-invocation admission budgets", () => {
    expect(new TransactionFabric(baseConfig).capabilityDocument()).toMatchObject({
      version: "v1",
      tokenMetaKey: "transaction/token",
      tokenMetaAliases: ["aiperator/transactionToken"],
      signingAlgorithms: ["HS256"],
      idempotency: { replayCommittedResults: true },
      budgets: {
        semantics: "per-invocation admission",
        enforced: ["maxDurationMs", "maxToolCalls"],
      },
    });
    expect(JSON.stringify(new TransactionFabric(baseConfig).capabilityDocument())).not.toMatch(
      /maxCostUsd|maxTokens|maxRetrievalDocuments/,
    );
  });

  it("binds optional envelope identity fields to authenticated claims and rejects mismatches", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const auth: AuthContext = {
      method: "oauth",
      subject: "alice",
      username: "alice",
      scopes: ["tool:run"],
      rawToken: "auth",
      claims: { sub: "alice", tenant: "acme", groups: ["ops", "users"], sid: "session-1" },
      tenantId: "acme",
      headers: {},
      // Transport/request id set by McpToolDispatcher — never an IdP session.
      sessionId: "mcp-request-7",
    };
    const good = await token(
      envelope({ userId: "alice", tenantId: "acme", groups: ["ops"], sessionId: "session-1" }),
    );
    const result = await fabric.execute({
      token: good,
      tool: "write_order",
      args: {},
      requiredScopes: ["tool:run"],
      access: "write",
      authContext: auth,
      run: async () => ok,
    });
    expect(result.isError).toBeFalsy();
    for (const claims of [
      envelope({ userId: "mallory" }),
      envelope({ tenantId: "other" }),
      envelope({ groups: ["admins"] }),
      envelope({ sessionId: "other" }),
      // The transport id must not be accepted as an authenticated session.
      envelope({ sessionId: "mcp-request-7" }),
    ]) {
      const denied = await fabric.execute({
        token: await token(claims),
        tool: "write_order",
        args: {},
        requiredScopes: ["tool:run"],
        authContext: auth,
        run: async () => ok,
      });
      expect(denied.structuredContent).toMatchObject({
        error: { code: "TRANSACTION_TOKEN_INVALID" },
      });
    }
    const absentOptionalClaims = await fabric.execute({
      token: await token(envelope()),
      tool: "write_order",
      args: {},
      requiredScopes: ["tool:run"],
      authContext: auth,
      run: async () => ok,
    });
    expect(absentOptionalClaims.isError).toBeFalsy();
  });

  it("does not treat the MCP transport id as an authenticated session", async () => {
    // Production shape: the runtime binds the OIDC `sid`, the
    // exchanged bearer carries no session claim, and the dispatcher sets
    // `sessionId` to its request id. That must not produce a mismatch.
    const fabric = new TransactionFabric(baseConfig);
    const auth: AuthContext = {
      method: "oauth",
      subject: "alice",
      username: "alice",
      scopes: ["tool:run"],
      rawToken: "auth",
      claims: { sub: "alice", tenant: "acme" },
      tenantId: "acme",
      headers: {},
      sessionId: "mcp-request-42",
    };
    const result = await fabric.execute({
      token: await token(envelope({ sessionId: "oidc-sid-123" })),
      tool: "availability",
      args: {},
      requiredScopes: ["tool:run"],
      authContext: auth,
      run: async () => ok,
    });
    expect(result.isError).toBeFalsy();
  });

  it("supports configurable user claim semantics", async () => {
    const fabric = new TransactionFabric({ ...baseConfig, userClaims: ["actor_id"] });
    const auth: AuthContext = {
      method: "oauth",
      subject: "opaque-subject",
      username: "alice",
      scopes: [],
      rawToken: "auth",
      claims: { actor_id: "alice" },
      headers: {},
    };
    const result = await fabric.execute({
      token: await token(envelope({ userId: "alice" })),
      tool: "read",
      args: {},
      requiredScopes: [],
      authContext: auth,
      run: async () => ok,
    });
    expect(result.isError).toBeFalsy();
  });

  it("atomically reserves one invocation in the memory compatibility store", async () => {
    const ledger = new MemoryInvocationLedger();
    const reservations = await Promise.all(
      Array.from({ length: 100 }, () => ledger.reserve("one", "fingerprint")),
    );
    expect(reservations.filter((r) => r.kind === "acquired")).toHaveLength(1);
    expect(reservations.filter((r) => r.kind === "in_flight")).toHaveLength(99);
  });

  it("retains active memory records past the terminal retention TTL", async () => {
    let now = 1_000;
    const ledger = new MemoryInvocationLedger({ ttlSec: 1, now: () => now });
    await ledger.reserve("expiring", "fingerprint");
    now += 1_000;
    expect(await ledger.get("expiring")).toMatchObject({ state: "pending" });
    await ledger.transition("expiring", "committed", ok);
    now += 1_000;
    expect(await ledger.get("expiring")).toBeUndefined();
    expect((await ledger.reserve("expiring", "fingerprint")).kind).toBe("acquired");
  });

  it("bounds terminal memory records without silently evicting protected states", async () => {
    let now = 1_000;
    const ledger = new MemoryInvocationLedger({ ttlSec: 60, maxEntries: 2, now: () => now });
    await ledger.reserve("old", "fingerprint");
    await ledger.transition("old", "committed", ok);
    now++;
    await ledger.reserve("newer", "fingerprint");
    await ledger.transition("newer", "failed");
    now++;
    await ledger.reserve("active", "fingerprint");
    expect(await ledger.get("old")).toBeUndefined();
    expect(await ledger.get("newer")).toBeDefined();
    expect(await ledger.get("active")).toMatchObject({ state: "pending" });

    const protectedLedger = new MemoryInvocationLedger({
      ttlSec: 60,
      maxEntries: 1,
      now: () => now,
    });
    await protectedLedger.reserve("pending", "one");
    await protectedLedger.reserve("unknown", "two");
    await protectedLedger.transition("unknown", "outcome_unknown");
    expect(await protectedLedger.get("pending")).toBeDefined();
    expect(await protectedLedger.get("unknown")).toBeDefined();
  });

  it("sets and renews Redis TTL atomically in Lua calls", async () => {
    const calls: Array<{ script: string; options: { keys: string[]; arguments: string[] } }> = [];
    const client = {
      connect: async () => undefined,
      get: async () => null,
      ping: async () => "PONG",
      quit: async () => undefined,
      eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
        calls.push({ script, options });
        return calls.length === 1
          ? [
              "acquired",
              JSON.stringify({
                invocationId: "id",
                fingerprint: "fp",
                state: "pending",
                updatedAt: 1,
              }),
            ]
          : 1;
      },
    };
    const ledger = new RedisInvocationLedger(client, "prefix:", 42);
    await ledger.reserve("id", "fp");
    await ledger.transition("id", "committed", ok);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.script).toContain("'PERSIST', KEYS[1]");
    expect(calls[0]?.script).toContain("'PEXPIRE', KEYS[1], ARGV[4]");
    expect(calls[0]?.options.keys).toEqual(["prefix:id"]);
    expect(calls[0]?.options.arguments.slice(0, 2)).toEqual(["id", "fp"]);
    expect(calls[0]?.options.arguments[3]).toBe("42000");
    expect(calls[1]?.script).toContain("'PX', ARGV[4]");
    expect(calls[1]?.options.arguments[0]).toBe("committed");
    expect(calls[1]?.options.arguments[3]).toBe("42000");
  });

  it("reads and advertises ledger retention configuration", () => {
    const config = transactionConfigFromEnv({
      MCPGATE_TRANSACTION_RETENTION_TTL_SEC: "123",
      MCPGATE_TRANSACTION_MEMORY_MAX_ENTRIES: "456",
    });
    expect(config).toMatchObject({ retentionTtlSec: 123, memoryMaxEntries: 456 });
    expect(
      new TransactionFabric({
        ...baseConfig,
        ...config,
        enforcement: "required",
        secret,
        issuer: "issuer",
        audience: "audience",
      }).capabilityDocument(),
    ).toMatchObject({
      idempotency: {
        retention: {
          ttlSec: 123,
          maxEntries: 456,
          protectedStates: expect.arrayContaining(["pending", "running", "outcome_unknown"]),
        },
      },
    });
    expect(() => transactionConfigFromEnv({ MCPGATE_TRANSACTION_RETENTION_TTL_SEC: "0" })).toThrow(
      "positive integer",
    );
    expect(() =>
      transactionConfigFromEnv({ MCPGATE_TRANSACTION_MEMORY_MAX_ENTRIES: "1.5" }),
    ).toThrow("positive integer");
  });

  it("requests cooperative abort and reports timeout completion as unknown", async () => {
    const fabric = new TransactionFabric(baseConfig);
    let aborted = false;
    const result = await fabric.execute({
      token: await token(envelope({ budget: { maxDurationMs: 5 } })),
      tool: "write",
      args: {},
      requiredScopes: [],
      access: "write",
      run: async (signal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
          setTimeout(() => resolve(ok), 100).unref?.();
        }),
    });
    expect(aborted).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVOCATION_OUTCOME_UNKNOWN", retryable: false, outcome: "outcome_unknown" },
    });
    expect(result.content[0]?.text).toContain("completion is not confirmed");
  });

  it("marks an ambiguous write failure outcome_unknown and refuses retry", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const claims = envelope();
    const jwt = await token(claims);
    const first = await execute(fabric, jwt, {}, async () => {
      throw new Error("connection lost");
    });
    expect(first.structuredContent).toMatchObject({ error: { outcome: "outcome_unknown" } });
    const retry = await execute(fabric, jwt, {});
    expect(retry.structuredContent).toMatchObject({
      error: { code: "INVOCATION_OUTCOME_UNKNOWN" },
    });
  });
});


describe("Evidence-Bound Transaction Fabric", () => {
  it("rejects a metadata contract that is not bound into the signed transaction token", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const claims = envelope({ evidenceContractHash: "a".repeat(64) });
    const result = await fabric.execute({
      token: await token(claims),
      tool: "write_order",
      args: { id: 1 },
      evidenceContractHash: "b".repeat(64),
      requiredScopes: ["tool:run"],
      access: "write",
      run: async () => ok,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: "EVIDENCE_CONTRACT_MISMATCH" },
    });
  });
});


describe("Transaction runtime deadlines and hash canonicalization", () => {
  it("aborts a running action at its deadline even without maxDurationMs", async () => {
    const fabric = new TransactionFabric(baseConfig);
    let abortReason = "";
    // The deadline is part of the signed token, so it cannot be computed after
    // signing. The headroom keeps token signing and verification under load
    // from consuming the whole window before run() starts; the action timer
    // stays well beyond the deadline so only the deadline can abort it.
    const result = await fabric.execute({
      token: await token(envelope({ trace: { deadlineAt: Date.now() + 250 } })),
      tool: "write",
      args: {},
      requiredScopes: [],
      access: "write",
      run: async (signal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              abortReason = String(signal.reason);
              reject(signal.reason);
            },
            { once: true },
          );
          setTimeout(() => resolve(ok), 2000).unref?.();
        }),
    });
    expect(abortReason).toContain("Transaction deadline exceeded");
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVOCATION_OUTCOME_UNKNOWN", outcome: "outcome_unknown" },
    });
  });

  it("compares hash aliases case-insensitively and exposes lowercase effective hashes", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const digest = "a".repeat(64);
    let observed: TransactionEnvelope | undefined;
    const result = await fabric.execute({
      token: await token(
        envelope({
          actionContractHash: digest.toUpperCase(),
          evidenceContractHash: digest,
        }),
      ),
      tool: "write_order",
      args: {},
      actionContractHash: digest.toUpperCase(),
      evidenceContractHash: digest,
      requiredScopes: [],
      run: async () => {
        observed = currentTransactionContext()?.envelope;
        return ok;
      },
    });
    expect(result.isError).toBeFalsy();
    expect(observed?.actionContractHash).toBe(digest);
    expect(observed?.evidenceContractHash).toBe(digest);
  });

  it("documents and enforces evidencePackHash only as response metadata", async () => {
    const fabric = new TransactionFabric(baseConfig);
    const capability = fabric.capabilityDocument();
    expect(capability).toMatchObject({
      evidenceActionContract: {
        metaKeys: expect.arrayContaining([
          "evidence/actionContractHash",
          "evidence/evidenceContractHash",
          "evidence/evidencePackHash",
        ]),
        canonicalHashEncoding: "lowercase",
      },
    });
    expect(capability.envelopeFields).not.toContain("evidencePackHash?");

    let called = false;
    const claims = {
      ...envelope(),
      evidencePackHash: "b".repeat(64),
    } as TransactionEnvelope;
    const result = await fabric.execute({
      token: await token(claims),
      tool: "write_order",
      args: {},
      requiredScopes: [],
      run: async () => {
        called = true;
        return ok;
      },
    });
    expect(called).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { code: "TRANSACTION_TOKEN_INVALID" },
    });
  });
});
