// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The approval message catalog is the single source for both the chat text and
 * the in-chat widget, so a deployment shows one interaction in one language.
 * These tests guard the two properties that make that true: both locales cover
 * exactly the same keys, and an unsupported locale degrades to English instead
 * of failing to render a security-relevant decision.
 */

import { describe, test, expect } from "bun:test";
import {
  APPROVAL_MESSAGE_LOCALES,
  APPROVAL_MESSAGES,
  DEFAULT_APPROVAL_MESSAGE_LOCALE,
  approvalMessages,
  formatMessage,
} from "../approval-messages.js";

/** The keys the approval flow needs, per the review follow-up (task A4). */
const REQUIRED_KEYS = [
  "approvalRequired",
  "noArguments",
  "arguments",
  "approve",
  "deny",
  "approved",
  "denied",
  "timedOut",
  "confirmApprove",
  "confirmDeny",
  "back",
] as const;

describe("approval message catalog", () => {
  test("every locale provides every required key", () => {
    for (const locale of APPROVAL_MESSAGE_LOCALES) {
      for (const key of REQUIRED_KEYS) {
        const value = APPROVAL_MESSAGES[locale][key];
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  test("the locales have identical key sets — none may ship in one language only", () => {
    const [first, ...rest] = APPROVAL_MESSAGE_LOCALES;
    if (first === undefined) throw new Error("expected at least one locale");
    const expected = Object.keys(APPROVAL_MESSAGES[first]).sort();
    expect(expected.length).toBeGreaterThan(REQUIRED_KEYS.length);
    for (const locale of rest) {
      expect(Object.keys(APPROVAL_MESSAGES[locale]).sort()).toEqual(expected);
    }
  });

  test("no value is left untranslated (English values must not leak into de)", () => {
    const en = APPROVAL_MESSAGES.en;
    const de = APPROVAL_MESSAGES.de;
    // Strings shared by design: they are identifiers or symbols, not prose.
    const shared = new Set(["lang"]);
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      if (shared.has(key)) continue;
      expect(de[key], `de/${key} duplicates the English value`).not.toBe(en[key]);
    }
  });

  test("approvalMessages resolves a known locale and falls back for the rest", () => {
    expect(approvalMessages("de").approve).toBe(
      APPROVAL_MESSAGES.de.approve,
    );
    expect(approvalMessages("en").approve).toBe(
      APPROVAL_MESSAGES.en.approve,
    );
    expect(approvalMessages(undefined).lang).toBe(
      DEFAULT_APPROVAL_MESSAGE_LOCALE,
    );
    // A typo must never leave the approval UI without text.
    expect(approvalMessages("fr").lang).toBe(DEFAULT_APPROVAL_MESSAGE_LOCALE);
    expect(approvalMessages("").lang).toBe(DEFAULT_APPROVAL_MESSAGE_LOCALE);
  });

  test("formatMessage substitutes tokens and leaves unknown ones alone", () => {
    expect(formatMessage("Approve {tool}?", { tool: "pay" })).toBe(
      "Approve pay?",
    );
    expect(formatMessage("{a} {b}", { a: "x" })).toBe("x {b}");
    expect(formatMessage("no tokens", { a: "x" })).toBe("no tokens");
  });

  test("the placeholder names of a key match across locales", () => {
    const tokens = (template: string): string[] =>
      [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    for (const key of Object.keys(
      APPROVAL_MESSAGES.en,
    ) as (keyof typeof APPROVAL_MESSAGES.en)[]) {
      for (const locale of APPROVAL_MESSAGE_LOCALES) {
        expect(tokens(APPROVAL_MESSAGES[locale][key]), `${locale}/${key}`).toEqual(
          tokens(APPROVAL_MESSAGES.en[key]),
        );
      }
    }
  });
});
