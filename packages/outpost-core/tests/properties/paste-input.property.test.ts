// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 33: Parsen eingefügter
 * Autorisierungseingaben (Round-Trip mit `state`)
 *
 * **Validates: Requirements 3.3, 6.13, 6.14**
 *
 * Für jeden Code `c` aus dem Anbieter-Alphabet, jeden erwarteten `state` `s`,
 * jeden eingefügten `state` `s'` und jede Redirect-URI
 * `r = http://127.0.0.1:<port>` gilt: `parsePastedInput(buildRedirectUrl(r, c,
 * s'), {state: s, redirectUri: r})` liefert genau dann `{kind: "code", code:
 * c}`, wenn `s == s'`, sonst `state-mismatch`. Das gilt auch mit umgebendem
 * Leerraum oder Anführungszeichen und beliebig umsortierten bzw. zusätzlichen
 * Query-Parametern. Jede URL mit Parameter `error` ergibt `provider-error`,
 * jede URL mit anderem Origin oder Pfad als `r` bzw. ohne `code` ergibt einen
 * Fehler. Bei `allowBareCode` ergibt jeder nackte Code `c` (ohne Schema) `c`.
 * Kein Ergebnis vom Typ `code` entsteht aus einer Eingabe mit falschem
 * `state`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildRedirectUrl, parsePastedInput } from "../../src/index.js";

/** Anbieter-Alphabet für Codes (URL-sicher, wie Google/Dropbox liefern). */
const PROVIDER_CODE = /^[A-Za-z0-9_-]{8,64}$/;
/** States wie base64url(32 Byte), plus gelegentlich kürzere Werte. */
const STATE = /^[A-Za-z0-9_-]{16,64}$/;

const redirectUriArb = fc
  .integer({ min: 1, max: 65535 })
  .map((port) => `http://127.0.0.1:${port}`);

/** Umgebender Leerraum und optional ein Paar Anführungszeichen. */
const wrapArb = fc.record({
  before: fc.constantFrom("", " ", "\n", " \t ", "\r\n"),
  quote: fc.constantFrom("", '"', "'"),
  after: fc.constantFrom("", " ", "\n", " \t ", "\r\n"),
});

function wrap(value: string, w: { before: string; quote: string; after: string }): string {
  return w.before + w.quote + value + w.quote + w.after;
}

/** URL mit umsortierten/zusätzlichen Parametern bauen (code/state bleiben). */
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

describe("Property 33: Parsen eingefügter Autorisierungseingaben", () => {
  it(
    "Round-Trip: code genau dann, wenn state übereinstimmt",
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
    "umsortierte und zusätzliche Query-Parameter ändern das Ergebnis nicht",
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
    "error-Parameter ergibt provider-error, falscher Origin/Pfad oder fehlender code ergibt Fehler",
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

            // Anderer Origin → Fehler, niemals code.
            const foreign = buildRedirectUrl("http://127.0.0.2:9999", code, state);
            const foreignResult = parsePastedInput(foreign, {
              state,
              redirectUri,
              allowBareCode: true,
            });
            expect(foreignResult.kind).toBe("error");

            // Anderer Pfad → Fehler.
            const otherPath = buildRedirectUrl(`${redirectUri}/callback`, code, state);
            const pathResult = parsePastedInput(otherPath, {
              state,
              redirectUri,
              allowBareCode: true,
            });
            expect(pathResult.kind).toBe("error");

            // URL ohne code-Parameter → Fehler.
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
    "nackter Code bei allowBareCode; nie code bei falschem state",
    () => {
      fc.assert(
        fc.property(
          fc.stringMatching(PROVIDER_CODE),
          fc.stringMatching(STATE),
          redirectUriArb,
          (code, state, redirectUri) => {
            const bare = parsePastedInput(code, { state, redirectUri, allowBareCode: true });
            expect(bare).toEqual({ kind: "code", code });

            // Mit falschem state in einer URL entsteht niemals ein code.
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
