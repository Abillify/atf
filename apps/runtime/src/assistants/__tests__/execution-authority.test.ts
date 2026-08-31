// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Execution authority — the rule that decides whose credentials a run carries.
 *
 * This is the security boundary of the whole assistant subsystem, so the tests
 * assert the ORDER of the checks as well as their outcomes: an inactive assistant
 * refused before anything else, the user's own token preferred over delegation,
 * and no path that yields authority without either a request token or a usable
 * grant.
 */
import { describe, expect, test } from "bun:test";
import {
  ACCESS_TOKEN_EXPIRY_MARGIN_MS,
  authorityPromptNotice,
  authorityToken,
  autonomyAllowsBackgroundAuthority,
  decideExecutionAuthority,
  delegationMintFailure,
  isAccessTokenFresh,
  isInteractiveTrigger,
  type AuthorityDecisionInput,
} from "../execution-authority.js";

const NOW = 1_700_000_000_000;

function input(overrides: Partial<AuthorityDecisionInput> = {}): AuthorityDecisionInput {
  return {
    trigger: "user",
    autonomy: "supervised",
    assistantActive: true,
    delegation: { status: "absent" },
    now: NOW,
    requiresToolAuthority: true,
    ...overrides,
  };
}

describe("interactive authority", () => {
  test("a request token is used directly", () => {
    const decision = decideExecutionAuthority(input({ requestToken: "user-jwt" }));
    expect(decision.mintDelegated).toBe(false);
    if (decision.mintDelegated) throw new Error("unreachable");
    expect(decision.authority).toEqual({
      kind: "interactive",
      token: "user-jwt",
    });
  });

  test("the user's own token wins over an available delegation", () => {
    const decision = decideExecutionAuthority(
      input({
        requestToken: "user-jwt",
        autonomy: "autonomous",
        delegation: { status: "usable", scope: "openid profile" },
      }),
    );
    if (decision.mintDelegated) throw new Error("should not mint");
    // Delegation is a fallback for absence, never an upgrade — otherwise a run
    // could act with wider scopes than the present user has.
    expect(decision.authority.kind).toBe("interactive");
  });

  test("a blank request token is not a token", () => {
    const decision = decideExecutionAuthority(input({ requestToken: "   " }));
    if (decision.mintDelegated) throw new Error("should not mint");
    expect(decision.authority.kind).toBe("none");
  });
});

describe("refusal precedence", () => {
  test("an inactive assistant is refused even with a request token", () => {
    const decision = decideExecutionAuthority(
      input({ assistantActive: false, requestToken: "user-jwt" }),
    );
    if (decision.mintDelegated) throw new Error("should not mint");
    expect(decision.authority).toMatchObject({
      kind: "none",
      reason: "assistant-inactive",
    });
  });

  test("a run needing no authority short-circuits before any credential work", () => {
    const decision = decideExecutionAuthority(
      input({
        requiresToolAuthority: false,
        requestToken: "user-jwt",
        delegation: { status: "usable", scope: "openid" },
      }),
    );
    if (decision.mintDelegated) throw new Error("should not mint");
    expect(decision.authority).toMatchObject({
      kind: "none",
      reason: "not-required",
    });
  });
});

describe("background authority", () => {
  test("supervised autonomy forbids background tool use", () => {
    const decision = decideExecutionAuthority(
      input({
        trigger: "schedule",
        autonomy: "supervised",
        delegation: { status: "usable", scope: "openid" },
      }),
    );
    if (decision.mintDelegated) throw new Error("should not mint");
    // The safe default must actually be safe: a freshly provisioned assistant
    // cannot call protected tools unattended even if a grant exists.
    expect(decision.authority).toMatchObject({
      kind: "none",
      reason: "autonomy-forbids-background",
    });
  });

  test("a user-initiated trusted-channel message may use delegation while supervised", () => {
    const decision = decideExecutionAuthority(
      input({
        trigger: "message",
        autonomy: "supervised",
        userInitiated: true,
        delegation: { status: "usable", scope: "openid tools:read" },
      }),
    );
    expect(decision.mintDelegated).toBe(true);
  });

  test("an untrusted message does not turn supervised autonomy into background access", () => {
    const decision = decideExecutionAuthority(
      input({
        trigger: "message",
        autonomy: "supervised",
        delegation: { status: "usable", scope: "openid tools:read" },
      }),
    );
    if (decision.mintDelegated) throw new Error("should not mint");
    expect(decision.authority).toMatchObject({
      kind: "none",
      reason: "autonomy-forbids-background",
    });
  });

  test.each(["assisted", "autonomous"] as const)(
    "%s autonomy mints when a grant is usable",
    (autonomy) => {
      const decision = decideExecutionAuthority(
        input({
          trigger: "schedule",
          autonomy,
          delegation: { status: "usable", scope: "openid offline_access" },
        }),
      );
      expect(decision.mintDelegated).toBe(true);
      if (!decision.mintDelegated) throw new Error("should mint");
      expect(decision.scope).toBe("openid offline_access");
    },
  );

  test.each([
    [{ status: "absent" } as const, "no-delegation-grant"],
    [{ status: "revoked" } as const, "grant-revoked"],
    [{ status: "broken", failures: 3 } as const, "grant-broken"],
  ])("delegation %p yields %s", (delegation, reason) => {
    const decision = decideExecutionAuthority(
      input({ trigger: "schedule", autonomy: "autonomous", delegation }),
    );
    if (decision.mintDelegated) throw new Error("should not mint");
    expect(decision.authority).toMatchObject({ kind: "none", reason });
  });

  test("a broken grant is distinguishable from an absent one", () => {
    // The remedies differ: re-consent vs. investigate the IdP. Collapsing them
    // would send the operator looking in the wrong place.
    const broken = decideExecutionAuthority(
      input({
        trigger: "schedule",
        autonomy: "autonomous",
        delegation: { status: "broken", failures: 4 },
      }),
    );
    if (broken.mintDelegated) throw new Error("should not mint");
    expect(broken.authority.kind === "none" && broken.authority.detail).toContain(
      "4 consecutive refresh failures",
    );
  });
});

describe("access token freshness", () => {
  test("a fresh cached token is reused without minting", () => {
    const decision = decideExecutionAuthority(
      input({
        trigger: "schedule",
        autonomy: "autonomous",
        delegation: { status: "usable", scope: "openid" },
        cachedAccessToken: {
          token: "cached",
          scope: "openid",
          expiresAt: NOW + 10 * 60_000,
        },
      }),
    );
    if (decision.mintDelegated) throw new Error("should reuse cache");
    expect(decision.authority).toMatchObject({
      kind: "delegated",
      token: "cached",
    });
  });

  test("a token inside the safety margin is not reused", () => {
    const decision = decideExecutionAuthority(
      input({
        trigger: "schedule",
        autonomy: "autonomous",
        delegation: { status: "usable", scope: "openid" },
        cachedAccessToken: {
          token: "almost-expired",
          scope: "openid",
          expiresAt: NOW + ACCESS_TOKEN_EXPIRY_MARGIN_MS - 1,
        },
      }),
    );
    // Reusing it would authorise a call that may outlive the token, producing a
    // failure that reads as a permission problem.
    expect(decision.mintDelegated).toBe(true);
  });

  test("freshness accounts for the margin", () => {
    expect(
      isAccessTokenFresh(
        { token: "t", scope: "s", expiresAt: NOW + ACCESS_TOKEN_EXPIRY_MARGIN_MS + 1 },
        NOW,
      ),
    ).toBe(true);
    expect(isAccessTokenFresh({ token: "t", scope: "s", expiresAt: NOW }, NOW)).toBe(false);
  });
});

describe("projection onto the request context", () => {
  test("no authority projects to an empty token, not a placeholder", () => {
    // An empty token makes the MCP wrapper refuse locally with a clear message.
    // A placeholder like `scheduled:<id>` reaches the IdP and fails confusingly —
    // the exact defect this replaces.
    const authority = delegationMintFailure("the IdP said no.");
    expect(authorityToken(authority)).toBe("");
  });

  test("a delegated authority projects its minted token", () => {
    expect(
      authorityToken({
        kind: "delegated",
        token: "minted",
        scope: "openid",
        expiresAt: NOW,
      }),
    ).toBe("minted");
  });

  test("the prompt notice explains the absence and forbids retrying", () => {
    const notice = authorityPromptNotice({
      kind: "none",
      reason: "no-delegation-grant",
      detail: "No user is present.",
    });
    expect(notice).toContain("No user is present.");
    expect(notice).toContain("Do not attempt those tools");
  });

  test("no notice is emitted when authority was never wanted", () => {
    // A learning pass does not need to be told it has no credentials.
    expect(
      authorityPromptNotice({
        kind: "none",
        reason: "not-required",
        detail: "n/a",
      }),
    ).toBeUndefined();
  });

  test("no notice is emitted when authority exists", () => {
    expect(authorityPromptNotice({ kind: "interactive", token: "t" })).toBeUndefined();
  });
});

describe("trigger and autonomy classification", () => {
  test.each([
    ["user", true],
    ["api", true],
    ["schedule", false],
    ["message", false],
    ["learning", false],
  ] as const)("%s is interactive: %p", (trigger, expected) => {
    expect(isInteractiveTrigger(trigger)).toBe(expected);
  });

  test.each([
    ["supervised", false],
    ["assisted", true],
    ["autonomous", true],
  ] as const)("%s allows background authority: %p", (autonomy, expected) => {
    expect(autonomyAllowsBackgroundAuthority(autonomy)).toBe(expected);
  });
});
