// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Locale-aware formatting (Req 9.7, Task 13.6).
 *
 * All number, date and currency output of Control goes through these
 * helpers; they accept an optional locale and fall back to the English
 * format (`en-US`) so server-side rendering and tests stay deterministic.
 * Components bind the active locale via `useI18n()`.
 */

import { activeCurrency, type Currency } from "../currency";
import { DEFAULT_LOCALE, intlLocale, type Locale } from "./locales";

/** Option types of the Intl formatters Control uses. */
export type NumberFormatOptions = Intl.NumberFormatOptions;
export type DateTimeFormatOptions = Intl.DateTimeFormatOptions;

/** Complete formatter facade bound to a locale. */
export interface Formatters {
  /** BCP 47 tag of the underlying locale, e.g. `de-DE`. */
  readonly intlTag: string;
  /** Dezimalzahl mit locale-gerechtem Trennzeichen, z. B. `1.234` / `1,234`. */
  formatNumber: (value: number, options?: NumberFormatOptions) => string;
  /** Datum + Uhrzeit (kurzes Datum, Zeit mit Sekunden). */
  formatDateTime: (value: string | number | Date, options?: DateTimeFormatOptions) => string;
  /** Nur Datum (Kurzform). */
  formatDate: (value: string | number | Date, options?: DateTimeFormatOptions) => string;
  /** Time only (with seconds). */
  formatTime: (value: string | number | Date, options?: DateTimeFormatOptions) => string;
  /** Money amount in the active display currency, formatted for the locale. */
  formatCurrency: (
    value: number,
    digits?: number,
    currency?: Currency,
  ) => string;
}

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Creates the formatters for a locale. Instances are cached per locale and
 * options key because frequently creating `Intl.NumberFormat`/`DateTimeFormat`
 * has a measurable cost.
 */
export function createFormatters(locale: Locale): Formatters {
  const tag = intlLocale(locale);

  const numberCache = new Map<string, Intl.NumberFormat>();
  const dateTimeCache = new Map<string, Intl.DateTimeFormat>();

  const numberFormatter = (options?: NumberFormatOptions): Intl.NumberFormat => {
    const key = JSON.stringify(options ?? {});
    let f = numberCache.get(key);
    if (!f) {
      f = new Intl.NumberFormat(tag, options);
      numberCache.set(key, f);
    }
    return f;
  };

  const dateFormatter = (options?: DateTimeFormatOptions): Intl.DateTimeFormat => {
    const key = JSON.stringify(options ?? {});
    let f = dateTimeCache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(tag, options);
      dateTimeCache.set(key, f);
    }
    return f;
  };

  return {
    intlTag: tag,
    formatNumber: (value, options) => numberFormatter(options).format(value),
    formatDateTime: (value, options) =>
      dateFormatter(options ?? { dateStyle: "short", timeStyle: "medium" }).format(
        toDate(value),
      ),
    formatDate: (value, options) => dateFormatter(options).format(toDate(value)),
    formatTime: (value, options) =>
      dateFormatter(options ?? { timeStyle: "medium" }).format(toDate(value)),
    formatCurrency: (value, digits = 6, currency = activeCurrency()) =>
      numberFormatter({
        style: "currency",
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value),
  };
}

// ---------------------------------------------------------------------------
// Aktive Locale (Singleton) + globale Helfer
// ---------------------------------------------------------------------------

/**
 * `LocaleProvider` sets the active language here; all components format
 * through the global helpers below without passing the context through the
 * component tree. Without a provider (tests, server code) `DEFAULT_LOCALE`
 * applies, so formatting results stay deterministic.
 *
 * A language switch remounts the provider's children (key) so already
 * rendered numbers/dates appear in the new locale immediately.
 */
let activeLocale: Locale = DEFAULT_LOCALE;

/** Setzt die aktive Locale (von `LocaleProvider` aufgerufen). */
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

/** Die aktuell aktive Locale. */
export function getActiveLocale(): Locale {
  return activeLocale;
}

const FORMATTERS: Partial<Record<Locale, Formatters>> = {};

/** Formatters of the active locale (cached per locale). */
export function formatters(locale: Locale = activeLocale): Formatters {
  let f = FORMATTERS[locale];
  if (!f) {
    f = createFormatters(locale);
    FORMATTERS[locale] = f;
  }
  return f;
}

/** Format a number in the active (or given) locale. */
export function formatNumber(
  value: number,
  options?: NumberFormatOptions,
  locale: Locale = activeLocale,
): string {
  return formatters(locale).formatNumber(value, options);
}

/** Date + time in the active locale, `—` for invalid values. */
export function formatDateTime(
  value: string | number | Date,
  options?: DateTimeFormatOptions,
  locale: Locale = activeLocale,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return formatters(locale).formatDateTime(date, options);
}

/** Date only in the active locale, `—` for invalid values. */
export function formatDate(
  value: string | number | Date,
  options?: DateTimeFormatOptions,
  locale: Locale = activeLocale,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return formatters(locale).formatDate(date, options);
}

/** Time only in the active locale, `—` for invalid values. */
export function formatTime(
  value: string | number | Date,
  options?: DateTimeFormatOptions,
  locale: Locale = activeLocale,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return formatters(locale).formatTime(date, options);
}

/** Money amount in the active locale and display currency. */
export function formatCurrency(
  value: number,
  digits = 6,
  currency: Currency = activeCurrency(),
  locale: Locale = activeLocale,
): string {
  return formatters(locale).formatCurrency(value, digits, currency);
}
