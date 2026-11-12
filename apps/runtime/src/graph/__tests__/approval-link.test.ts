// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the per-approval capability tokens used by the in-chat approval
 * widget/links (`src/graph/approval-link.ts`). These tokens let the end user's
 * browser (which holds no operator bearer) authorize exactly one approval id
 * on the operator-gated `/monitoring/approvals/:id/{widget,decide}` endpoints.
 */

import { describe, test, expect } from "bun:test";
import {
  APPROVAL_CONFIRM_TTL_MS,
  APPROVAL_LINK_GRACE_MS,
  checkApprovalLinkToken,
  signApprovalConfirmToken,
  signApprovalLinkToken,
  verifyApprovalConfirmToken,
  verifyApprovalLinkToken,
} from "../approval-link.js";

const SECRET = "test-secret-at-least-32-chars-long-000";
const OTHER_SECRET = "another-secret-at-least-32-chars-xxxxx";
const ID = "11111111-2222-3333-4444-555555555555";

describe("approval-link capability token", () => {
  test("a freshly minted token verifies for its id and secret", () => {
    const token = signApprovalLinkToken(ID, SECRET, Date.now() + 60_000);
    expect(verifyApprovalLinkToken(token, ID, SECRET)).toBe(true);
  });

  test("token is bound to the approval id — a different id is rejected", () => {
    const token = signApprovalLinkToken(ID, SECRET, Date.now() + 60_000);
    expect(
      verifyApprovalLinkToken(
        token,
        "00000000-0000-0000-0000-000000000000",
        SECRET,
      ),
    ).toBe(false);
  });

  test("a token signed with a different secret is rejected", () => {
    const token = signApprovalLinkToken(ID, SECRET, Date.now() + 60_000);
    expect(verifyApprovalLinkToken(token, ID, OTHER_SECRET)).toBe(false);
  });

  test("an expired token is rejected", () => {
    const token = signApprovalLinkToken(ID, SECRET, Date.now() - 1);
    expect(verifyApprovalLinkToken(token, ID, SECRET)).toBe(false);
  });

  test("expiry is evaluated against the provided `now`", () => {
    const exp = 10_000;
    const token = signApprovalLinkToken(ID, SECRET, exp);
    expect(verifyApprovalLinkToken(token, ID, SECRET, exp - 1)).toBe(true);
    expect(verifyApprovalLinkToken(token, ID, SECRET, exp)).toBe(true);
    expect(verifyApprovalLinkToken(token, ID, SECRET, exp + 1)).toBe(false);
  });

  test("a tampered payload (different embedded id) fails the signature check", () => {
    const token = signApprovalLinkToken(ID, SECRET, Date.now() + 60_000);
    const [, sig] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ id: "forged-id", exp: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    const forged = `${forgedPayload}.${sig}`;
    // Even asking for the forged id must fail — the signature covers the payload.
    expect(verifyApprovalLinkToken(forged, "forged-id", SECRET)).toBe(false);
  });

  test("malformed / empty tokens are rejected, not thrown", () => {
    expect(verifyApprovalLinkToken(undefined, ID, SECRET)).toBe(false);
    expect(verifyApprovalLinkToken("", ID, SECRET)).toBe(false);
    expect(verifyApprovalLinkToken("no-separator", ID, SECRET)).toBe(false);
    expect(verifyApprovalLinkToken(".sigonly", ID, SECRET)).toBe(false);
    expect(verifyApprovalLinkToken("payloadonly.", ID, SECRET)).toBe(false);
    expect(verifyApprovalLinkToken("not.base64url!!", ID, SECRET)).toBe(false);
  });

  test("tokens are URL-safe (base64url, no reserved query characters)", () => {
    const token = signApprovalLinkToken(ID, SECRET, Date.now() + 60_000);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });
});

/**
 * Second-step confirmation tokens (`confirm=`): an HMAC over
 * `id:decision:linkExpiry` so that a prefetched first click cannot resolve an
 * approval and a confirmation minted for one decision cannot be reused for the
 * other.
 */
describe("approval-link confirm token", () => {
  const LINK_EXP = 2_000_000_000_000;

  test("a freshly minted confirm token verifies for its id, decision and expiry", () => {
    const token = signApprovalConfirmToken(ID, "approved", LINK_EXP, SECRET);
    expect(
      verifyApprovalConfirmToken(token, ID, "approved", LINK_EXP, SECRET),
    ).toBe(true);
  });

  test("a confirm token minted for 'approved' is rejected for 'denied'", () => {
    const token = signApprovalConfirmToken(ID, "approved", LINK_EXP, SECRET);
    expect(
      verifyApprovalConfirmToken(token, ID, "denied", LINK_EXP, SECRET),
    ).toBe(false);
  });

  test("a confirm token is bound to the approval id", () => {
    const token = signApprovalConfirmToken(ID, "approved", LINK_EXP, SECRET);
    expect(
      verifyApprovalConfirmToken(
        token,
        "other-approval",
        "approved",
        LINK_EXP,
        SECRET,
      ),
    ).toBe(false);
  });

  test("a confirm token is bound to the link expiry it was minted for", () => {
    const token = signApprovalConfirmToken(ID, "approved", LINK_EXP, SECRET);
    expect(
      verifyApprovalConfirmToken(token, ID, "approved", LINK_EXP + 1, SECRET),
    ).toBe(false);
  });

  test("a confirm token signed with a different secret is rejected", () => {
    const token = signApprovalConfirmToken(ID, "approved", LINK_EXP, SECRET);
    expect(
      verifyApprovalConfirmToken(token, ID, "approved", LINK_EXP, OTHER_SECRET),
    ).toBe(false);
  });

  test("a confirm token expires after APPROVAL_CONFIRM_TTL_MS", () => {
    const now = LINK_EXP - 1_000;
    const token = signApprovalConfirmToken(
      ID,
      "approved",
      LINK_EXP,
      SECRET,
      now,
    );
    expect(
      verifyApprovalConfirmToken(
        token,
        ID,
        "approved",
        LINK_EXP,
        SECRET,
        now + APPROVAL_CONFIRM_TTL_MS - 1,
      ),
    ).toBe(true);
    expect(
      verifyApprovalConfirmToken(
        token,
        ID,
        "approved",
        LINK_EXP,
        SECRET,
        now + APPROVAL_CONFIRM_TTL_MS + 1,
      ),
    ).toBe(false);
  });

  test("malformed confirm tokens are rejected, not thrown", () => {
    const args = [ID, "approved", LINK_EXP, SECRET] as const;
    expect(verifyApprovalConfirmToken(undefined, ...args)).toBe(false);
    expect(verifyApprovalConfirmToken("", ...args)).toBe(false);
    expect(verifyApprovalConfirmToken("no-separator", ...args)).toBe(false);
    expect(verifyApprovalConfirmToken(".sigonly", ...args)).toBe(false);
    expect(verifyApprovalConfirmToken("payloadonly.", ...args)).toBe(false);
    expect(verifyApprovalConfirmToken("not.base64url!!", ...args)).toBe(false);
  });

  test("confirm tokens are URL-safe", () => {
    const token = signApprovalConfirmToken(ID, "approved", LINK_EXP, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  test("a confirm token is not accepted as a link capability token", () => {
    const confirm = signApprovalConfirmToken(ID, "approved", LINK_EXP, SECRET);
    expect(verifyApprovalLinkToken(confirm, ID, SECRET)).toBe(false);
  });
});

/**
 * The tri-state check behind the read-only widget rendering: an expired token
 * must stay distinguishable from a forged one, because the former only reveals
 * the outcome of the approval it was minted for while the latter reveals
 * nothing and must stay a rejection.
 */
describe("approval-link token status", () => {
  test("a valid token reports 'valid'", () => {
    const token = signApprovalLinkToken(ID, SECRET, Date.now() + 60_000);
    expect(checkApprovalLinkToken(token, ID, SECRET)).toBe("valid");
  });

  test("a genuine token past its expiry reports 'expired', not 'invalid'", () => {
    const token = signApprovalLinkToken(ID, SECRET, 10_000);
    expect(checkApprovalLinkToken(token, ID, SECRET, 10_001)).toBe("expired");
  });

  test("a foreign id or wrong secret stays 'invalid' even when expired", () => {
    const token = signApprovalLinkToken(ID, SECRET, 10_000);
    expect(
      checkApprovalLinkToken(token, "other-approval", SECRET, 20_000),
    ).toBe("invalid");
    expect(checkApprovalLinkToken(token, ID, OTHER_SECRET, 20_000)).toBe(
      "invalid",
    );
  });

  test("malformed tokens report 'invalid', never thrown", () => {
    expect(checkApprovalLinkToken(undefined, ID, SECRET)).toBe("invalid");
    expect(checkApprovalLinkToken("", ID, SECRET)).toBe("invalid");
    expect(checkApprovalLinkToken("no-separator", ID, SECRET)).toBe("invalid");
    expect(checkApprovalLinkToken("not.base64url!!", ID, SECRET)).toBe(
      "invalid",
    );
  });

  test("the link grace is shorter than the confirm TTL is irrelevant: it is a positive slack", () => {
    expect(APPROVAL_LINK_GRACE_MS).toBeGreaterThan(0);
    expect(APPROVAL_LINK_GRACE_MS).toBeLessThan(3_600_000);
  });
});
