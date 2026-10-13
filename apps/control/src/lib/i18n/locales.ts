// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Locale registry for the Control i18n layer (Req 9.7, Task 13.6).
 *
 * The Control supports exactly two UI languages, `de` and `en`. The active
 * locale is chosen by the `LocaleProvider` and persisted in the
 * `NEXT_LOCALE` cookie so the server-side root layout can render
 * `<html lang>` dynamically on the very first request (no flash of the
 * wrong language, no hydration mismatch — the root layout already carries
 * `suppressHydrationWarning`).
 */

export const LOCALES = ["de", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/** Fallback used when no cookie is set or the cookie value is invalid. */
export const DEFAULT_LOCALE: Locale = "en";

/** Cookie name Next.js conventionally uses for the UI locale. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Cookie lifetime: one year; the value is non-sensitive UI state. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Normalises an arbitrary string (cookie, query) to a supported locale. */
export function parseLocale(raw: string | undefined | null): Locale {
  const lower = (raw ?? "").trim().toLowerCase().split("-")[0];
  return LOCALES.includes(lower as Locale) ? (lower as Locale) : DEFAULT_LOCALE;
}

/** Reads the locale from `document.cookie` (client only). */
export function readLocaleFromDocument(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${LOCALE_COOKIE}=`));
  return parseLocale(match ? decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1)) : undefined);
}

/** Writes the locale cookie (client only; same-origin, non-sensitive). */
export function writeLocaleCookie(locale: Locale): void {
  if (typeof document === "undefined") return;
  // biome-ignore lint/suspicious/noDocumentCookie: locale preference is a non-sensitive, same-origin display setting
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)};path=/;max-age=${LOCALE_COOKIE_MAX_AGE_SECONDS};samesite=lax`;
}

/** BCP-47 tag used for Intl formatting and the `lang` attribute. */
export function intlLocale(locale: Locale): string {
  return locale === "de" ? "de-DE" : "en-US";
}
