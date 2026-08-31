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
  signApprovalLinkToken,
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
