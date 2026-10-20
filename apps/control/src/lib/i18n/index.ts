// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * i18n barrel (Req 9.7, Task 13.6): provider/hook, locale registry,
 * format helpers and catalog types.
 *
 * `translate`/`interpolate` come from ./translate — NOT through the
 * "use client" LocaleProvider: server components (loading boundaries,
 * not-found, control-api) import them from here, and a client-module
 * re-export would turn them into throwing client references.
 */

export { LocaleProvider, useI18n } from "./LocaleProvider";
export type { LocaleContextValue, LocaleProviderProps } from "./LocaleProvider";
export { interpolate, translate } from "./translate";
export type { MessageParams } from "./translate";
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
