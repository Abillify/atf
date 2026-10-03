// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import {
  activeCurrency,
  currencySymbol,
  formatCost,
  withCurrency,
} from "../lib/currency";

describe("currency (Control display helper)", () => {
  test("defaults to EUR without NEXT_PUBLIC_CURRENCY", () => {
    expect(activeCurrency()).toBe("EUR");
    expect(currencySymbol()).toBe("\u20ac");
  });

  test("withCurrency prefixes the formatted number unchanged", () => {
    expect(withCurrency("0.5000")).toBe("\u20ac0.5000");
    expect(withCurrency(1.5)).toBe("\u20ac1.5");
  });

  test("formatCost uses fixed decimals and the configured symbol", () => {
    expect(formatCost(0.001234, 6)).toBe("\u20ac0.001234");
    expect(formatCost(1.23456, 4)).toBe("\u20ac1.2346");
  });

  test("honours an explicit currency argument — no conversion", () => {
    expect(formatCost(1, 2, "USD")).toBe("$1.00");
    expect(formatCost(1, 2, "CHF")).toBe("CHF1.00");
    expect(formatCost(1, 2, "GBP")).toBe("\u00a31.00");
  });
});
