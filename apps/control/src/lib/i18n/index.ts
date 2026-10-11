// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * i18n barrel (Req 9.7, Task 13.6): provider/hook, locale registry,
 * format helpers and catalog types.
 */

export { LocaleProvider, useI18n } from "./LocaleProvider";
export type { LocaleContextValue, LocaleProviderProps } from "./LocaleProvider";
export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  intlLocale,
  parseLocale,
  readLocaleFromDocument,
  writeLocaleCookie,
} from "./locales";
export type { Locale } from "./locales";
export {
  createFormatters,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  formatters,
  getActiveLocale,
  setActiveLocale,
} from "./format";
export type {
  DateTimeFormatOptions,
  Formatters,
  NumberFormatOptions,
} from "./format";
export { en } from "./catalogs/en";
export type { Catalog, MessageKey } from "./catalogs/en";
export { de } from "./catalogs/de";
