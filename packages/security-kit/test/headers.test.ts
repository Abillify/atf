// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Header-Utils contract (Req 11.1/11.2): the three-state boolean parse, the
 * `base64:` prefix decoding, list splitting and control-character stripping
 * the ATF services shared previously as per-app copies.
 */

import { describe, expect, test } from "bun:test";
import {
  decodeIfBase64,
  parseBooleanHeader,
  readHeader,
  readListHeader,
  sanitizeHeaderValue,
} from "../src/index.js";

function reqWith(headers: Record<string, string | string[] | undefined>) {
  return { headers };
}

describe("parseBooleanHeader", () => {
  test("absent or empty yields undefined (use the default)", () => {
    expect(parseBooleanHeader(undefined)).toBeUndefined();
    expect(parseBooleanHeader("")).toBeUndefined();
    expect(parseBooleanHeader("   ")).toBeUndefined();
  });

  test("recognised truthy and falsy values, case-insensitive", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "Yes", " ON "]) {
      expect(parseBooleanHeader(value)).toBe(true);
    }
    for (const value of ["0", "false", "no", "off", "FALSE", "No", " OFF "]) {
      expect(parseBooleanHeader(value)).toBe(false);
    }
  });

  test("unrecognised yields null (caller returns 400)", () => {
    expect(parseBooleanHeader("maybe")).toBeNull();
    expect(parseBooleanHeader("2")).toBeNull();
  });
});

describe("readHeader / decodeIfBase64", () => {
  test("plain value passes through", () => {
    expect(readHeader(reqWith({ "x-title": "Betrieb" }), "x-title")).toBe("Betrieb");
  });

  test("base64: prefix is decoded as UTF-8", () => {
    const encoded = Buffer.from("Übersicht Größe — Umlaute", "utf-8").toString("base64");
    expect(readHeader(reqWith({ "x-title": `base64:${encoded}` }), "x-title")).toBe(
      "Übersicht Größe — Umlaute",
    );
  });

  test("prefix is case-insensitive", () => {
    const encoded = Buffer.from("test", "utf-8").toString("base64");
    expect(readHeader(reqWith({ "x-title": `BASE64:${encoded}` }), "x-title")).toBe("test");
  });

  test("array header uses the first entry", () => {
    expect(readHeader(reqWith({ "x-title": ["first", "second"] }), "x-title")).toBe("first");
  });

  test("absent header yields undefined", () => {
    expect(readHeader(reqWith({}), "x-title")).toBeUndefined();
  });

  test("invalid base64 after the prefix decodes leniently, never throws", () => {
    // Buffer's base64 decoder ignores invalid characters rather than throwing,
    // so the defensive catch in decodeIfBase64 stays unreachable in practice.
    // Pinned so a future stricter decoder is a deliberate, visible change.
    expect(() => decodeIfBase64("base64:@@@not-valid-base64")).not.toThrow();
    expect(decodeIfBase64("base64:T3M=")).toBe("Os");
  });
});

describe("readListHeader", () => {
  test("splits, trims and drops empty entries", () => {
    expect(readListHeader(reqWith({ "x-scopes": " a , ,b,c " }), "x-scopes")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("absent header yields an empty list", () => {
    expect(readListHeader(reqWith({}), "x-scopes")).toEqual([]);
  });

  test("base64-encoded list is decoded before splitting", () => {
    const encoded = Buffer.from("read,write", "utf-8").toString("base64");
    expect(readListHeader(reqWith({ "x-scopes": `base64:${encoded}` }), "x-scopes")).toEqual([
      "read",
      "write",
    ]);
  });
});

describe("sanitizeHeaderValue", () => {
  test("strips CR/LF and other control characters", () => {
    expect(sanitizeHeaderValue("ok\r\nSet-Cookie: evil")).toBe("okSet-Cookie: evil");
    expect(sanitizeHeaderValue("a\x00b\x1fc\x7fd")).toBe("abcd");
  });

  test("leaves normal and non-ASCII text untouched", () => {
    expect(sanitizeHeaderValue("Grüße — OK")).toBe("Grüße — OK");
  });
});
