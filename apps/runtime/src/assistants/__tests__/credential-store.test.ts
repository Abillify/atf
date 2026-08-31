// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the assistant delegation credential store
 * (`src/assistants/credential-store.ts`), focused on the AAD-binding
 * regression: a refresh-token ciphertext must never decrypt successfully
 * under a DIFFERENT assistant scope than the one it was granted for.
 */

import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import {
  InMemoryCredentialStore,
  DelegationEncryptionUnavailableError,
  DelegationConsentError,
  type DelegationGrantInput,
} from "../credential-store.js";
import { SecretCipher } from "../../graph/secret-cipher.js";
import type { AssistantScope } from "../types.js";
import type { FetchLike as TestFetchLike } from "../token-minter.js";

const cipher = () => new SecretCipher(crypto.randomBytes(32));

const scopeA: AssistantScope = {
  tenantId: "tenant-a",
  userId: "user-1",
  assistantId: "assistant-1",
};
const scopeB: AssistantScope = {
  tenantId: "tenant-b",
  userId: "user-2",
  assistantId: "assistant-2",
};

function grantFor(scope: AssistantScope): DelegationGrantInput {
  return {
    scope,
    issuer: "https://idp.example.com",
    refreshToken: "rt-secret-value",
    consentedScope: "offline_access profile",
    grantedBy: scope.userId,
  };
}

describe("AuthorityResolver.invalidateDelegatedToken", () => {
  it("drops the cached token so a subsequent resolve cannot reuse it", async () => {
    // Local import to avoid a top-level cycle risk between the two modules'
    // test files; both are leaf modules so this is purely style.
    const { AuthorityResolver } = await import("../authority-resolver.js");
    const { DelegatedTokenMinter } = await import("../token-minter.js");

    const store = new InMemoryCredentialStore(cipher());
    await store.grant(grantFor(scopeA));
    const issuer = "https://idp.example.com";

    let mintCalls = 0;
    const fetchImpl: TestFetchLike = async () => {
      mintCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `at-${mintCalls}`,
          expires_in: 3600,
        }),
        text: async () => "",
      };
    };
    const minter = new DelegatedTokenMinter({
      credentials: store,
      clientId: "client",
      clientSecret: "secret",
      resolveTokenEndpoint: async () => ({
        token_endpoint: "https://idp.example.com/token",
      }),
      fetchImpl,
    });

    const resolver = new AuthorityResolver({
      credentials: store,
      minter,
      issuer,
    });

    const first = await resolver.resolve({
      scope: scopeA,
      trigger: "schedule",
      autonomy: "autonomous",
      status: "active",
      requiresToolAuthority: true,
    });
    expect(first.kind).toBe("delegated");
    expect(mintCalls).toBe(1);

    // A second resolve within the token's lifetime reuses the cache — no new mint.
    const second = await resolver.resolve({
      scope: scopeA,
      trigger: "schedule",
      autonomy: "autonomous",
      status: "active",
      requiresToolAuthority: true,
    });
    expect(second.kind).toBe("delegated");
    expect(mintCalls).toBe(1);

    // Revoking must invalidate the cache — this is the call the operator-plane
    // revoke route makes alongside CredentialStore.revoke().
    resolver.invalidateDelegatedToken(scopeA, issuer);
    await store.revoke(scopeA, issuer);

    const third = await resolver.resolve({
      scope: scopeA,
      trigger: "schedule",
      autonomy: "autonomous",
      status: "active",
      requiresToolAuthority: true,
    });
    // The grant is now revoked, so no authority is returned — proving the
    // cached token was NOT reused (it would have returned "delegated" with
    // the old cached token otherwise, since resolve() checks the cache before
    // re-reading delegation state in some paths).
    expect(third.kind).toBe("none");
  });

  it("is a safe no-op when no minter is configured", () => {
    const store = new InMemoryCredentialStore(cipher());
    const resolverModulePromise = import("../authority-resolver.js");
    return resolverModulePromise.then(({ AuthorityResolver }) => {
      const resolver = new AuthorityResolver({ credentials: store });
      expect(() =>
        resolver.invalidateDelegatedToken(scopeA, "https://idp.example.com"),
      ).not.toThrow();
    });
  });
});

describe("InMemoryCredentialStore", () => {
  it("requires an encryption key to grant delegation", async () => {
    const store = new InMemoryCredentialStore(); // no cipher
    await expect(store.grant(grantFor(scopeA))).rejects.toBeInstanceOf(
      DelegationEncryptionUnavailableError,
    );
  });

  it("requires the consenting user to be the assistant's own user", async () => {
    const store = new InMemoryCredentialStore(cipher());
    await expect(
      store.grant({ ...grantFor(scopeA), grantedBy: "someone-else" }),
    ).rejects.toBeInstanceOf(DelegationConsentError);
  });

  it("round-trips a granted refresh token through the cipher", async () => {
    const store = new InMemoryCredentialStore(cipher());
    await store.grant(grantFor(scopeA));
    const read = await store.read(scopeA, "https://idp.example.com");
    expect(read?.refreshToken).toBe("rt-secret-value");
  });

  it("scopes grants and reads to the correct assistant", async () => {
    const store = new InMemoryCredentialStore(cipher());
    await store.grant(grantFor(scopeA));
    await store.grant(grantFor(scopeB));
    expect(
      (await store.read(scopeA, "https://idp.example.com"))?.refreshToken,
    ).toBe("rt-secret-value");
    expect(
      (await store.read(scopeB, "https://idp.example.com"))?.refreshToken,
    ).toBe("rt-secret-value");
    // Each scope's row is independent — listing one never returns the other.
    expect((await store.list(scopeA)).map((s) => s.scope)).toEqual([scopeA]);
  });

  it("rotates the refresh token on recordRefreshSuccess without losing the AAD binding", async () => {
    const store = new InMemoryCredentialStore(cipher());
    await store.grant(grantFor(scopeA));
    await store.recordRefreshSuccess({
      scope: scopeA,
      issuer: "https://idp.example.com",
      rotatedRefreshToken: "rt-rotated-value",
    });
    const read = await store.read(scopeA, "https://idp.example.com");
    expect(read?.refreshToken).toBe("rt-rotated-value");
    expect(read?.refreshFailures).toBe(0);
  });

  // ---------------------------------------------------------------------
  // AAD binding: exercised directly against the shared SecretCipher, since
  // InMemoryCredentialStore round-trips through decrypt() immediately (it
  // never stores a ciphertext meant for scope A under scope B's key). The
  // property under test is the one that protects PostgresCredentialStore:
  // a ciphertext bound to scope A's AAD must not decrypt under scope B's.
  // ---------------------------------------------------------------------
  describe("AAD binding (cross-assistant regression)", () => {
    it("a refresh-token ciphertext encrypted for one assistant scope does not decrypt under another's AAD", () => {
      const c = cipher();
      const aadFor = (scope: AssistantScope, issuer: string) =>
        `assistant-cred:${scope.tenantId}:${scope.userId}:${scope.assistantId}:${issuer}`;
      const issuer = "https://idp.example.com";
      const sealed = c.encrypt("rt-secret-value", aadFor(scopeA, issuer));

      // Simulates copying the encrypted_refresh_token column from scope A's
      // row into scope B's row (SQL-injection / backup-restore / insider
      // access) and attempting to decrypt it as scope B's credential.
      expect(() => c.decrypt(sealed, aadFor(scopeB, issuer))).toThrow();
      // The correct scope still decrypts it.
      expect(c.decrypt(sealed, aadFor(scopeA, issuer))).toBe(
        "rt-secret-value",
      );
    });
  });

  // ---------------------------------------------------------------------
  // listForOperator — the Revocation Console's data source
  // ---------------------------------------------------------------------
  describe("listForOperator (cross-scope, Identity Broker Revocation Console)", () => {
    it("spans every scope and never exposes a refresh token", async () => {
      const store = new InMemoryCredentialStore(cipher());
      await store.grant(grantFor(scopeA));
      await store.grant(grantFor(scopeB));
      const page = await store.listForOperator();
      expect(page.total).toBe(2);
      expect(page.delegations).toHaveLength(2);
      for (const d of page.delegations) {
        expect((d as unknown as { refreshToken?: unknown }).refreshToken).toBeUndefined();
      }
    });

    it("filters by tenantId, userId and assistantId", async () => {
      const store = new InMemoryCredentialStore(cipher());
      await store.grant(grantFor(scopeA));
      await store.grant(grantFor(scopeB));

      const byTenant = await store.listForOperator({ tenantId: scopeB.tenantId });
      expect(byTenant.total).toBe(1);
      expect(byTenant.delegations[0]?.scope).toEqual(scopeB);

      const byUser = await store.listForOperator({ userId: scopeA.userId });
      expect(byUser.total).toBe(1);
      expect(byUser.delegations[0]?.scope).toEqual(scopeA);

      const byAssistant = await store.listForOperator({
        assistantId: scopeB.assistantId,
      });
      expect(byAssistant.total).toBe(1);
      expect(byAssistant.delegations[0]?.scope).toEqual(scopeB);
    });

    it("filters by derived state", async () => {
      const store = new InMemoryCredentialStore(cipher());
      await store.grant(grantFor(scopeA));
      await store.grant(grantFor(scopeB));
      await store.revoke(scopeB, "https://idp.example.com");

      const usable = await store.listForOperator({ state: "usable" });
      expect(usable.total).toBe(1);
      expect(usable.delegations[0]?.scope).toEqual(scopeA);

      const revoked = await store.listForOperator({ state: "revoked" });
      expect(revoked.total).toBe(1);
      expect(revoked.delegations[0]?.scope).toEqual(scopeB);
    });

    it("bounds and pages the result, reporting the unpaged total", async () => {
      const store = new InMemoryCredentialStore(cipher());
      for (let i = 0; i < 5; i++) {
        await store.grant(
          grantFor({ tenantId: "t", userId: `u${i}`, assistantId: "a" }),
        );
      }
      const page = await store.listForOperator({ limit: 2, offset: 1 });
      expect(page.total).toBe(5);
      expect(page.delegations).toHaveLength(2);

      const past = await store.listForOperator({ offset: 999 });
      expect(past.delegations).toHaveLength(0);
      expect(past.total).toBe(5);
    });
  });
});
