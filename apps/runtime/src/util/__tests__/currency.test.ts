// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the display-currency helper (src/util/currency.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  activeCurrency,
  currencySymbol,
  DEFAULT_CURRENCY,
  formatCostWithCurrency,
  parseCurrency,
  _resetCurrencyCacheForTests,
} from "../currency.js";

describe("parseCurrency", () => {
  test("defaults to EUR when unset or blank", () => {
    expect(parseCurrency(undefined)).toBe("EUR");
    expect(parseCurrency("")).toBe("EUR");
    expect(parseCurrency("   ")).toBe("EUR");
  });

  test("accepts the supported codes case-insensitively", () => {
    expect(parseCurrency("eur")).toBe("EUR");
    expect(parseCurrency("USD")).toBe("USD");
    expect(parseCurrency(" chf ")).toBe("CHF");
    expect(parseCurrency("GBP")).toBe("GBP");
  });

  test("falls back to EUR for an unknown code", () => {
    expect(parseCurrency("BTC")).toBe(DEFAULT_CURRENCY);
  });
});

describe("activeCurrency / symbol", () => {
  afterEach(() => {
    delete process.env["CURRENCY"];
    _resetCurrencyCacheForTests();
  });

  test("reads CURRENCY from the environment", () => {
    process.env["CURRENCY"] = "USD";
    _resetCurrencyCacheForTests();
    expect(activeCurrency()).toBe("USD");
    expect(currencySymbol()).toBe("$");
  });

  test("defaults to EUR (€) when CURRENCY is unset", () => {
    _resetCurrencyCacheForTests();
    expect(activeCurrency()).toBe("EUR");
    expect(currencySymbol()).toBe("\u20ac");
  });
});

describe("formatCostWithCurrency", () => {
  afterEach(() => {
    delete process.env["CURRENCY"];
    _resetCurrencyCacheForTests();
  });

  test("labels the value with the configured symbol — never converts", () => {
    process.env["CURRENCY"] = "EUR";
    _resetCurrencyCacheForTests();
    expect(formatCostWithCurrency(0.5, 4)).toBe("\u20ac0.5000");
  });

  test("honours an explicit currency argument", () => {
    expect(formatCostWithCurrency(1, 2, "USD")).toBe("$1.00");
    expect(formatCostWithCurrency(1, 2, "CHF")).toBe("CHF1.00");
    expect(formatCostWithCurrency(1, 2, "GBP")).toBe("\u00a31.00");
  });
});
