// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 34: structure of the cloud authorization URL
 *
 * **Validates: Requirements 6.9, 6.13, 6.14, 6.20, 15.2**
 *
 * For every provider (Dropbox, GDrive), every client ID, every
 * `code_challenge` and every `state`, the URL produced by `buildAuthorizeUrl`
 * contains exactly the read scopes defined for the provider
 * (Dropbox: `files.metadata.read`, `files.content.read`; GDrive:
 * `drive.readonly`) and no further scope, the offline parameter
 * (`token_access_type=offline` or `access_type=offline`),
 * `code_challenge_method=S256`, the unchanged `code_challenge` and the
 * `state`. For Dropbox in Docker mode it contains no `redirect_uri`. For
 * GDrive `redirectUri` is always a URL with scheme `http`, host `127.0.0.1`
 * and a port in 1–65535.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  DROPBOX_SCOPE,
  GDRIVE_SCOPE,
  PROVIDERS,
} from "../../src/index.js";

const CLIENT_ID = /^[A-Za-z0-9_-]{4,40}(\.apps\.googleusercontent\.com)?$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const STATE = /^[A-Za-z0-9_-]{16,64}$/;

const loopbackArb = fc
  .integer({ min: 1, max: 65535 })
  .map((port) => `http://127.0.0.1:${port}`);

describe("Property 34: structure of the cloud authorization URL", () => {
  it(
    "Dropbox: exakt die lesenden Scopes, token_access_type=offline, S256",
    () => {
      fc.assert(
        fc.property(fc.stringMatching(CLIENT_ID), fc.stringMatching(CHALLENGE), fc.stringMatching(STATE), (clientId, challenge, state) => {
          const url = buildAuthorizeUrl("dropbox", {
            clientId,
            codeChallenge: challenge,
            state,
          });
          const p = url.searchParams;
          expect(url.origin + url.pathname).toBe(PROVIDERS.dropbox.authorizeEndpoint);
          expect(p.get("scope")).toBe(DROPBOX_SCOPE);
          // Only the two read scopes, nothing else.
          expect(p.get("scope")?.split(" ").sort()).toEqual([
            "files.content.read",
            "files.metadata.read",
          ]);
          expect(p.get("token_access_type")).toBe("offline");
          expect(p.get("code_challenge_method")).toBe("S256");
          expect(p.get("code_challenge")).toBe(challenge);
          expect(p.get("state")).toBe(state);
          expect(p.get("response_type")).toBe("code");
          expect(p.get("client_id")).toBe(clientId);
          // Docker no-redirect: no redirect_uri.
          expect(p.has("redirect_uri")).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "GDrive: drive.readonly, access_type=offline + prompt=consent, S256",
    () => {
      fc.assert(
        fc.property(
          fc.stringMatching(CLIENT_ID),
          fc.stringMatching(CHALLENGE),
          fc.stringMatching(STATE),
          loopbackArb,
          (clientId, challenge, state, redirectUri) => {
            const url = buildAuthorizeUrl("gdrive", {
              clientId,
              codeChallenge: challenge,
              state,
              redirectUri,
            });
            const p = url.searchParams;
            expect(url.origin + url.pathname).toBe(PROVIDERS.gdrive.authorizeEndpoint);
            expect(p.get("scope")).toBe(GDRIVE_SCOPE);
            // Exactly one scope: the drive.readonly URL, nothing else.
            expect(p.get("scope")?.split(" ")).toEqual([
              "https://www.googleapis.com/auth/drive.readonly",
            ]);
            expect(p.get("access_type")).toBe("offline");
            expect(p.get("prompt")).toBe("consent");
            expect(p.get("code_challenge_method")).toBe("S256");
            expect(p.get("code_challenge")).toBe(challenge);
            expect(p.get("state")).toBe(state);
            expect(p.get("response_type")).toBe("code");
            expect(p.get("client_id")).toBe(clientId);
            // GDrive always redirects to the loopback http://127.0.0.1:<port>.
            const sent = new URL(p.get("redirect_uri") ?? "");
            expect(sent.protocol).toBe("http:");
            expect(sent.hostname).toBe("127.0.0.1");
            const port = Number(sent.port);
            expect(port).toBeGreaterThanOrEqual(1);
            expect(port).toBeLessThanOrEqual(65535);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "Dropbox with loopback (desktop) sets redirect_uri unchanged",
    () => {
      fc.assert(
        fc.property(
          fc.stringMatching(CLIENT_ID),
          fc.stringMatching(CHALLENGE),
          fc.stringMatching(STATE),
          loopbackArb,
          (clientId, challenge, state, redirectUri) => {
            const url = buildAuthorizeUrl("dropbox", {
              clientId,
              codeChallenge: challenge,
              state,
              redirectUri,
            });
            expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
            expect(url.searchParams.get("token_access_type")).toBe("offline");
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
