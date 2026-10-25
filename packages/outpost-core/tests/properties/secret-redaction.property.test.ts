// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 6: no disclosure of secrets.
 *
 * For any configuration carrying arbitrary secret values and any arbitrarily
 * nested log object containing them, no secret appears as a substring of the
 * serialized configuration file or of the redacted log output.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createLogger,
  serializeConfig,
  validateConfig,
  SecretRedactor,
} from "../../src/index.js";

/** Arbitrary secret value: alphanumeric, long enough to be meaningful. */
const secretArb = fc
  .stringMatching(/^[A-Za-z0-9]{12,40}$/);

/** Arbitrarily nested log-object shape with the secret at a random depth. */
const nestedWithSecret = (secret: string, depth: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { value: secret };
  for (let i = 0; i < depth; i++) {
    node = { ctx: { step: i, inner: node } };
  }
  return node;
};

// Feature: extract-outpost, Property 6: no disclosure of secrets
describe("Property 6: no secret disclosure", () => {
  it("secrets never appear in the serialized configuration", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        secretArb,
        fc.string({ minLength: 1, maxLength: 16 }),
        async (apiToken, clientSecret, sourceId) => {
          // A config object with secrets smuggled in under plausible names:
          // validation must strip them, and the serialized file must not
          // contain them (secrets live only the store).
          const result = validateConfig({
            extractUrl: "https://extract.example.com",
            collection: "documents",
            syncIntervalSec: 900,
            mirrorDelete: true,
            deleteThresholdPercent: 50,
            resumableThresholdBytes: 33_554_432,
            maxConcurrentUploads: 4,
            health: { bind: "127.0.0.1", port: 8787 },
            cloudOAuth: {},
            sources: [{ type: "local", id: "docs", path: "/srv/docs" }],
            apiToken,
            clientSecret,
            oidc: { issuer: "https://id.example.com", clientId: "outpost", clientSecret },
            sourcesExtra: [{ id: sourceId, refreshToken: apiToken }],
          });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const text = serializeConfig(result.value);
          expect(text).not.toContain(apiToken);
          expect(text).not.toContain(clientSecret);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("registered secrets never appear in redacted log output", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        secretArb,
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        async (token, clientSecret, depth, underKnownKey) => {
          const chunks: string[] = [];
          const { logger, redactor } = createLogger(
            "info",
            {
              write: (c: string) => {
                chunks.push(c);
                return true;
              },
            } as unknown as NodeJS.WritableStream,
          );
          redactor.register(token);
          redactor.register(clientSecret);

          // Place the secrets either under a key pino redacts by path
          // (`token`, `client_secret`) or under arbitrary key names, nested
          // to a random depth.
          const payload = underKnownKey
            ? nestedWithSecret(token, depth)
            : { details: nestedWithSecret(token, depth), auth: { client_secret: clientSecret } };
          logger.info(payload, "sync step");

          const out = chunks.join("");
          expect(out).not.toContain(token);
          expect(out).not.toContain(clientSecret);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("the redactor replaces every occurrence, at any position", async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, fc.integer({ min: 1, max: 5 }), async (secret, repeats) => {
        const redactor = new SecretRedactor();
        redactor.register(secret);
        const text = `${"prefix-".repeat(repeats)}${secret}${secret}${"-suffix".repeat(repeats)}`;
        const out = redactor.redact(text);
        expect(out).not.toContain(secret);
        // Non-secret parts survive.
        expect(out).toContain("prefix-");
        expect(out).toContain("-suffix");
      }),
      { numRuns: 100 },
    );
  });
});
