"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LocaleProvider: the i18n context of Control (Req 9.7, Task 13.6).
 *
 * Holds the active UI language (`de`/`en`), provides the translation
 * function `t` and locale-aware formatters (`useI18n()`) and sets
 * `document.documentElement.lang` dynamically. The choice is persisted in
 * the `NEXT_LOCALE` cookie so the server renders `<html lang>` correctly on
 * the very first request (the root layout reads the cookie; the provider
 * takes over after hydration and on changes).
 *
 * Decision (Task 13.6): an in-house thin layer instead of a library. Control
 * only needs two static languages without plural/gender rules; a library
 * (e.g. next-intl) would mean a routing rework (locale prefixes) or
 * client-only translation, with no added value at this scope.
 */

import type React from "react";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { de } from "./catalogs/de";
import { en, type MessageKey } from "./catalogs/en";
import {
  createFormatters,
  getActiveLocale,
  setActiveLocale,
  type Formatters,
} from "./format";
import {
  DEFAULT_LOCALE,
  parseLocale,
  readLocaleFromDocument,
  writeLocaleCookie,
  type Locale,
} from "./locales";

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, de };

/** Values for `{name}` placeholders in a message. */
export type MessageParams = Record<string, string | number | boolean | null | undefined>;

/**
 * Fills `{name}` placeholders. A missing value leaves the placeholder visible
 * rather than rendering "undefined", so a wrong call site is noticed.
 */
export function interpolate(message: string, params?: MessageParams): string {
  if (params === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

export interface LocaleContextValue {
  /** Active UI language. */
  locale: Locale;
  /** Sets the language, persists it in the cookie and updates `lang`. */
  setLocale: (locale: Locale) => void;
  /**
   * Translates a catalog key into the active language; `{name}` placeholders
   * in the message are filled from `params`.
   */
  t: (key: MessageKey, params?: MessageParams) => string;
  /** Locale-aware number/date/currency formatters. */
  formatters: Formatters;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export interface LocaleProviderProps {
  children: React.ReactNode;
  /**
   * Initial value determined on the server (from the NEXT_LOCALE cookie).
   * When it is missing, the provider reads the cookie in the browser on mount.
   */
  initialLocale?: Locale;
}

export function LocaleProvider({
  children,
  initialLocale,
}: LocaleProviderProps): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(
    initialLocale ?? DEFAULT_LOCALE,
  );

  // Synchronous (in the render body, idempotent): the server renders with the
  // cookie value; the global helpers from ./format would otherwise still format
  // in the default locale until the effect runs -> hydration mismatch.
  setActiveLocale(locale);

  // After the first mount: take over the cookie value if it differs from the
  // server props (e.g. static export or a stale cache).
  useEffect(() => {
    if (initialLocale === undefined) {
      setLocaleState(readLocaleFromDocument());
    }
  }, [initialLocale]);

  // Keep <html lang> dynamic (Req 9.7): the root layout renders the initial
  // value, every client-side change follows here. Also sync the global
  // formatting locale for the helpers from ./format.
  useEffect(() => {
    document.documentElement.lang = locale;
    setActiveLocale(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    const parsed = parseLocale(next);
    setLocaleState(parsed);
    writeLocaleCookie(parsed);
  }, []);

  const value = useMemo<LocaleContextValue>(() => {
    const catalog = CATALOGS[locale];
    return {
      locale,
      setLocale,
      t: (key: MessageKey, params?: MessageParams) =>
        interpolate(catalog[key] ?? en[key] ?? key, params),
      formatters: createFormatters(locale),
    };
  }, [locale, setLocale]);

  return (
    // key={locale}: a language switch remounts the children so pages that
    // format through the global helpers from ./format also show their
    // numbers/dates in the new locale immediately. The switch is a rare
    // user action; TanStack Query does not force a refetch, the data stays
    // in the cache.
    <LocaleContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleContext.Provider>
  );
}

/**
 * Translates a key in the active locale without the hook — the counterpart of
 * the global formatting helpers in ./format for components that render
 * outside a provider in tests. A language switch remounts the tree under the
 * provider (see `key={locale}` above), so callers pick up the new language.
 */
export function translate(key: MessageKey, params?: MessageParams): string {
  return interpolate(CATALOGS[getActiveLocale()][key] ?? en[key] ?? key, params);
}

/** Access to the language, `t()` and formatters. Throws without a provider. */
export function useI18n(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useI18n() must be used inside <LocaleProvider>");
  }
  return ctx;
}
