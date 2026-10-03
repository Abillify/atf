// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Display currency for every cost figure the Control UI renders.
 *
 * The whole system works in exactly ONE fixed currency, selected via
 * `NEXT_PUBLIC_CURRENCY` (default `EUR`) — mirroring the runtime's `CURRENCY`
 * variable. Cost values are only *labelled* with the configured currency;
 * they are never converted between currencies.
 *
 * NOTE: like every NEXT_PUBLIC_* variable, the value is frozen into the
 * client bundle at build time by Next.js — change it in the environment the
 * Control app is built (or the dev server started) with.
 */

export type Currency = "EUR" | "USD" | "CHF" | "GBP";

/** Currency used when `NEXT_PUBLIC_CURRENCY` is unset or invalid. */
export const DEFAULT_CURRENCY: Currency = "EUR";

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  EUR: "\u20ac", // €
  USD: "$",
  CHF: "CHF",
  GBP: "\u00a3", // £
};

function parseCurrency(raw: string | undefined): Currency {
  const upper = (raw ?? "").trim().toUpperCase();
  if (upper === "EUR" || upper === "USD" || upper === "CHF" || upper === "GBP") {
    return upper;
  }
  return DEFAULT_CURRENCY;
}

let cached: Currency | undefined;

/** The active display currency (cached after first read). */
export function activeCurrency(): Currency {
  if (cached === undefined) {
    cached = parseCurrency(
      typeof process !== "undefined"
        ? process.env["NEXT_PUBLIC_CURRENCY"]
        : undefined,
    );
  }
  return cached;
}

/** The symbol for the active (or an explicitly given) currency. */
export function currencySymbol(currency: Currency = activeCurrency()): string {
  return CURRENCY_SYMBOLS[currency];
}

/**
 * Prefixes an already-formatted cost number with the configured currency
 * symbol — no conversion, the number is shown as-is.
 */
export function withCurrency(
  formatted: string | number,
  currency: Currency = activeCurrency(),
): string {
  return `${currencySymbol(currency)}${formatted}`;
}

/** Formats a cost value with the configured currency symbol and fixed decimals. */
export function formatCost(
  value: number,
  digits = 6,
  currency: Currency = activeCurrency(),
): string {
  return withCurrency(value.toFixed(digits), currency);
}
