// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 33: parsing pasted
 * authorization inputs (round trip with `state`)
 *
 * **Validates: Requirements 3.3, 6.13, 6.14**
 *
 * For every code `c` from the provider alphabet, every expected `state` `s`,
 * every pasted `state` `s'` and every redirect URI
 * `r = http://127.0.0.1:<port>`: `parsePastedInput(buildRedirectUrl(r, c,
 * s'), {state: s, redirectUri: r})` returns `{kind: "code", code:
 * c}` exactly when `s == s'`, otherwise `state-mismatch`. This also holds with
 * surrounding whitespace or quotes and arbitrarily reordered or additional
 * query parameters. Every URL with an `error` parameter yields `provider-error`,
 * every URL with a different origin or path than `r`, or without `code`, yields
 * an error. With `allowBareCode` every bare code `c` (without a scheme) yields `c`.
 * No result of type `code` arises from an input with a wrong
 * `state`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildRedirectUrl, parsePastedInput } from "../../src/index.js";

/** Provider alphabet for codes (URL safe, as Google/Dropbox deliver). */
const PROVIDER_CODE = /^[A-Za-z0-9_-]{8,64}$/;
/** States like base64url(32 bytes), plus occasionally shorter values. */
const STATE = /^[A-Za-z0-9_-]{16,64}$/;

const redirectUriArb = fc
  .integer({ min: 1, max: 65535 })
  .map((port) => `http://127.0.0.1:${port}`);

/** Surrounding whitespace and optionally a pair of quotes. */
const wrapArb = fc.record({
  before: fc.constantFrom("", " ", "\n", " \t ", "\r\n"),
  quote: fc.constantFrom("", '"', "'"),
  after: fc.constantFrom("", " ", "\n", " \t ", "\r\n"),
});

function wrap(value: string, w: { before: string; quote: string; after: string }): string {
  return w.before + w.quote + value + w.quote + w.after;
}

/** Build a URL with reordered/additional parameters (code/state stay). */
function shuffledRedirectUrl(
  r: string,
  code: string,
  state: string,
  extraKey: string,
  extraValue: string,
  stateFirst: boolean,
): string {
  const base = new URL(r);
  const params = stateFirst
    ? `state=${encodeURIComponent(state)}&${extraKey}=${encodeURIComponent(extraValue)}&code=${encodeURIComponent(code)}`
    : `${extraKey}=${encodeURIComponent(extraValue)}&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  return `${base.origin}${base.pathname}?${params}`;
}

describe("Property 33: parsing pasted authorization inputs", () => {
  it(
    "round trip: code exactly when the state matches",
    () => {
      fc.assert(
        fc.property(
          fc.stringMatching(PROVIDER_CODE),
          fc.stringMatching(STATE),
          fc.stringMatching(STATE),
          redirectUriArb,
          wrapArb,
          (code, state, pastedState, redirectUri, wrapper) => {
            const input = wrap(buildRedirectUrl(redirectUri, code, pastedState), wrapper);
            const result = parsePastedInput(input, {
              state,
              redirectUri,
              allowBareCode: true,
            });
            if (state === pastedState) {
              expect(result).toEqual({ kind: "code", code });
            } else {
              expect(result).toEqual({ kind: "error", reason: "state-mismatch" });
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "reordered and additional query parameters do not change the result",
    () => {
      fc.assert(
        fc.property(
          fc.stringMatching(PROVIDER_CODE),
          fc.stringMatching(STATE),
          redirectUriArb,
          fc.stringMatching(/^[a-z]{1,8}$/),
          fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
          fc.boolean(),
          wrapArb,
          (code, state, redirectUri, extraKey, extraValue, stateFirst, wrapper) => {
            fc.pre(extraKey !== "code" && extraKey !== "state" && extraKey !== "error");
            const url = shuffledRedirectUrl(redirectUri, code, state, extraKey, extraValue, stateFirst);
            const result = parsePastedInput(wrap(url, wrapper), {
              state,
              redirectUri,
              allowBareCode: true,
            });
            expect(result).toEqual({ kind: "code", code });
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "an error parameter yields provider-error, a wrong origin/path or missing code yields an error",
    () => {
      fc.assert(
        fc.property(
          fc.stringMatching(PROVIDER_CODE),
          fc.stringMatching(STATE),
          redirectUriArb,
          fc.constantFrom(
            "access_denied",
            "consent_required",
            "invalid_request",
            "server_error",
          ) as fc.Arbitrary<string>,
          (code, state, redirectUri, providerError) => {
            const url = `${redirectUri}/?error=${encodeURIComponent(providerError)}&state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;
            const result = parsePastedInput(url, { state, redirectUri, allowBareCode: true });
            expect(result.kind).toBe("error");
            if (result.kind === "error") {
              expect(result.reason).toBe("provider-error");
            }

            // Different origin → error, never a code.
            const foreign = buildRedirectUrl("http://127.0.0.2:9999", code, state);
            const foreignResult = parsePastedInput(foreign, {
              state,
              redirectUri,
              allowBareCode: true,
            });
            expect(foreignResult.kind).toBe("error");

            // Different path → error.
            const otherPath = buildRedirectUrl(`${redirectUri}/callback`, code, state);
            const pathResult = parsePastedInput(otherPath, {
              state,
              redirectUri,
              allowBareCode: true,
            });
            expect(pathResult.kind).toBe("error");

            // URL without a code parameter → error.
            const noCode = `${redirectUri}/?state=${encodeURIComponent(state)}`;
            const noCodeResult = parsePastedInput(noCode, {
              state,
              redirectUri,
              allowBareCode: true,
            });
            expect(noCodeResult).toEqual({ kind: "error", reason: "missing-code" });
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "bare code with allowBareCode; never a code with a wrong state",
    () => {
      fc.assert(
        fc.property(
          fc.stringMatching(PROVIDER_CODE),
          fc.stringMatching(STATE),
          redirectUriArb,
          (code, state, redirectUri) => {
            const bare = parsePastedInput(code, { state, redirectUri, allowBareCode: true });
            expect(bare).toEqual({ kind: "code", code });

            // With a wrong state in a URL a code never arises.
            const wrong = buildRedirectUrl(redirectUri, code, `${state}x`);
            const wrongResult = parsePastedInput(wrong, {
              state,
              redirectUri,
              allowBareCode: true,
            });
            expect(wrongResult.kind).not.toBe("code");
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
