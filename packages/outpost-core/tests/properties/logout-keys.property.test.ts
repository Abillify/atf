// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 37: Logout lässt Cloud-Tokens unangetastet.
 *
 * For any store content over the `auth:extract:*` and `source:*` namespaces,
 * after `logout()` no `EXTRACT_AUTH_KEYS` entry remains, every `source:*`
 * entry is unchanged, and `delete` was never called with a key outside
 * `EXTRACT_AUTH_KEYS`.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AuthManager,
  EXTRACT_AUTH_KEYS,
  MemoryCredentialStore,
  type CredentialStore,
} from "../../src/index.js";
import { FakeIdP } from "../fakes/fake-idp.js";
import { testLogger } from "../fakes/test-logger.js";

/** Wraps a store and records every delete call. */
class RecordingStore implements CredentialStore {
  readonly deletes: string[] = [];
  constructor(private readonly inner: MemoryCredentialStore) {}
  get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }
  set(key: string, value: string): Promise<void> {
    return this.inner.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    await this.inner.delete(key);
  }
}

// Feature: extract-outpost, Property 37: Logout lässt Cloud-Tokens unangetastet
// **Validates: Requirements 3.5, 3.9**
describe("Property 37: logout leaves cloud tokens untouched", () => {
  const sourceIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
  const suffixArb = fc.constantFrom(
    "oauth-refresh",
    "gdrive-sa",
    "s3-access-key",
    "s3-secret-key",
  );
  const valueArb = fc.string({ minLength: 1, maxLength: 24 });

  const storeContentArb = fc.record({
    auth: fc.dictionary(
      fc.constantFrom(...EXTRACT_AUTH_KEYS),
      valueArb,
    ),
    sources: fc.array(
      fc.tuple(sourceIdArb, suffixArb, valueArb),
      { maxLength: 6 },
    ),
  });

  it("removes only EXTRACT_AUTH_KEYS and never deletes a source key", async () => {
    await fc.assert(
      fc.asyncProperty(storeContentArb, async (content) => {
        const inner = new MemoryCredentialStore();
        for (const [key, value] of Object.entries(content.auth)) {
          await inner.set(key, value);
        }
        const sourceSnapshot = new Map<string, string>();
        for (const [id, suffix, value] of content.sources) {
          const key = `source:${id}:${suffix}`;
          await inner.set(key, value);
          sourceSnapshot.set(key, value);
        }

        const store = new RecordingStore(inner);
        const manager = new AuthManager({
          method: "device-code",
          oidc: { issuer: "https://idp.example.com", clientId: "outpost" },
          store,
          logger: testLogger(),
          fetchImpl: new FakeIdP().fetchImpl,
        });

        await manager.logout();

        // No EXTRACT_AUTH_KEYS entry remains.
        for (const key of EXTRACT_AUTH_KEYS) {
          expect(await store.get(key)).toBeNull();
        }
        // Every source key survives unchanged.
        for (const [key, value] of sourceSnapshot) {
          expect(await store.get(key)).toBe(value);
        }
        // delete was never called outside EXTRACT_AUTH_KEYS.
        for (const deleted of store.deletes) {
          expect(EXTRACT_AUTH_KEYS).toContain(deleted);
        }
      }),
      { numRuns: 100 },
    );
  });
});
