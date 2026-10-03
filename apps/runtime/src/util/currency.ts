// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Display currency for every cost figure the system renders
 * (`src/util/currency.ts`).
 *
 * The whole system works in exactly ONE fixed currency, selected via the
 * `CURRENCY` environment variable (default `EUR`). Cost values are only
 * *labelled* with the configured currency — they are never converted
 * between currencies. The pricing table numbers
 * (`observability/cost.ts`) are simply interpreted as being denominated in
 * the configured currency.
 *
 * The value is read lazily from `process.env` and validated once; an
 * unknown code falls back to the default with a warning. The env schema
 * (`config/schema.ts`) validates `CURRENCY` at startup as well, so a
 * misconfiguration fails fast in the normal boot path.
 */

export type Currency = "EUR" | "USD" | "CHF" | "GBP";

/** Currency used when `CURRENCY` is unset or invalid. */
export const DEFAULT_CURRENCY: Currency = "EUR";

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  EUR: "\u20ac", // €
  USD: "$",
  CHF: "CHF",
  GBP: "\u00a3", // £
};

/** Normalises a raw env value to a supported currency, defaulting to EUR. */
export function parseCurrency(raw: string | undefined): Currency {
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
    const raw = process.env["CURRENCY"];
    cached = parseCurrency(raw);
    if (raw !== undefined && raw.trim() !== "" && cached === DEFAULT_CURRENCY && raw.trim().toUpperCase() !== cached) {
      console.warn(
        `[currency] Unknown CURRENCY "${raw}" — falling back to ${DEFAULT_CURRENCY}.`,
      );
    }
  }
  return cached;
}

/** The symbol for the active (or an explicitly given) currency. */
export function currencySymbol(currency: Currency = activeCurrency()): string {
  return CURRENCY_SYMBOLS[currency];
}

/**
 * Formats a cost value for display with the configured currency symbol —
 * no conversion, the number is shown as-is.
 */
export function formatCostWithCurrency(
  value: number,
  digits = 6,
  currency: Currency = activeCurrency(),
): string {
  return `${currencySymbol(currency)}${value.toFixed(digits)}`;
}

/** Test seam: reset the cached currency so env changes take effect again. */
export function _resetCurrencyCacheForTests(): void {
  cached = undefined;
}
