// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * translate: server-safe translation helpers.
 *
 * Lives OUTSIDE the `"use client"` LocaleProvider module on purpose: server
 * components (loading boundaries, not-found, BFF route handlers via
 * control-api) import `translate` directly. If it lived in a client module,
 * Next.js would replace it with a throwing client reference ("Attempted to
 * call translate() from the server but translate is on the client").
 *
 * On the server the active locale is the module global from ./format, which
 * only LocaleProvider sets during (client) rendering — so server-rendered
 * strings fall back to `DEFAULT_LOCALE` unless a render already set it.
 */

import { de } from "./catalogs/de";
import { en, type MessageKey } from "./catalogs/en";
import { getActiveLocale } from "./format";
import type { Locale } from "./locales";

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

/**
 * Translates a key in the active locale without the hook — the counterpart of
 * the global formatting helpers in ./format for components that render
 * outside a provider (tests) or on the server (loading boundaries). A
 * language switch remounts the tree under the provider (see `key={locale}`
 * in LocaleProvider), so client callers pick up the new language.
 */
export function translate(key: MessageKey, params?: MessageParams, locale?: Locale): string {
  return interpolate(CATALOGS[locale ?? getActiveLocale()][key] ?? en[key] ?? key, params);
}
